/* eslint-disable no-console */
/**
 * 借调批次核心规则的无头验证（fake-indexeddb，不启动浏览器）：
 * 1. 建批后字模→借调中、原格位冻结；同一字模不能进两个未结束批次
 * 2. 乐观锁：两个标签页（两份编辑草稿）后保存者收到版本冲突，不覆盖
 * 3. 目标格位容量 / 引用冲突 → 完成事务整体回滚，无半成品
 * 4. 完成后：目标字盘落位、原格位取出、字模恢复可用、批次已完成
 * 5. 取消批次：字模恢复可用
 * 6. v4 升级：缺 version 的旧活动批次 → 待复核，不自动完成
 */
import 'fake-indexeddb/auto';
import { db, ensureSeed } from '../src/db/index.ts';
import { useLoanStore, LoanVersionConflictError } from '../src/stores/loanStore.ts';
import { useCaseStore } from '../src/stores/caseStore.ts';
import { useMatrixStore } from '../src/stores/matrixStore.ts';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function resetDb() {
  await db.delete();
  await db.open();
  await ensureSeed();
}

const loanInput = () => ({
  code: `JZ-TEST-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  exhibition: '测试巡展',
  operator: '测试员',
  outboundDate: '2026-10-04',
  expectedReturnDate: '2026-11-04',
  note: '',
});

async function main() {
  // ---- 场景 1：建批冻结、唯一占用 ----
  await resetDb();
  await Promise.all([useMatrixStore.getState().load(), useCaseStore.getState().load(), useLoanStore.getState().load()]);
  const cases = useCaseStore.getState().cases;
  const matrices = useMatrixStore.getState().matrices;
  const caseA = cases.find((c) => c.id === 'case-1001')!;
  const m1001 = matrices.find((m) => m.id === 'm-1001')!; // 活 @ A1
  const m1002 = matrices.find((m) => m.id === 'm-1002')!; // 字 @ A2
  const m1003 = matrices.find((m) => m.id === 'm-1003')!; // 印 @ A3
  const caseB = cases.find((c) => c.id === 'case-1002')!;

  const batch1 = await useLoanStore.getState().createLoan({
    input: loanInput(),
    selections: [
      { matrix: m1001, sourceCaseId: caseA.id, sourceRow: 0, sourceCol: 0 },
      { matrix: m1002, sourceCaseId: caseA.id, sourceRow: 0, sourceCol: 1 },
    ],
  });
  await useMatrixStore.getState().load();
  const after1 = useMatrixStore.getState().matrices.find((m) => m.id === 'm-1001')!;
  assert(after1.availability === '借调中', '建批后字模转为借调中', after1.availability);
  assert(batch1.version === 1 && batch1.status === '进行中', '新批次 version=1、进行中');

  // 重复占用
  let dupError: unknown = null;
  try {
    await useLoanStore.getState().createLoan({
      input: loanInput(),
      selections: [{ matrix: m1001, sourceCaseId: caseA.id, sourceRow: 0, sourceCol: 0 }],
    });
  } catch (e) {
    dupError = e;
  }
  assert(dupError instanceof Error && /未结束批次/.test(dupError.message), '同一字模不能进入第二个未结束批次', (dupError as Error)?.message);

  // 停用字模不能借调（m-1008 为停用）
  const m1008 = useMatrixStore.getState().matrices.find((m) => m.id === 'm-1008')!;
  let disabledError: unknown = null;
  try {
    await useLoanStore.getState().createLoan({
      input: loanInput(),
      selections: [{ matrix: m1008, sourceCaseId: caseA.id, sourceRow: 0, sourceCol: 0 }],
    });
  } catch (e) {
    disabledError = e;
  }
  assert(disabledError instanceof Error, '停用字模不能借调');

  // ---- 场景 2：乐观锁版本冲突 ----
  // 标签页 A、B 都基于 v1 打开
  // A 先保存：给 m1001 安排到 caseB A1（0,0 现存「匠」m-1015！会冲突），改用空槽 B3 (2,0)?
  // caseB 4x6，现存 m-1015@(0,0) m-1016@(0,1)；用 (1,0) 与 (1,1)
  const itemsV2 = batch1.items.map((it) =>
    it.matrixId === 'm-1001'
      ? { ...it, targetCaseId: caseB.id, targetCaseCode: caseB.code, targetRow: 1, targetCol: 0, assignedAt: new Date().toISOString() }
      : { ...it, targetCaseId: caseB.id, targetCaseCode: caseB.code, targetRow: 1, targetCol: 1, assignedAt: new Date().toISOString() },
  );
  const header = {
    exhibition: batch1.exhibition,
    operator: batch1.operator,
    outboundDate: batch1.outboundDate,
    expectedReturnDate: batch1.expectedReturnDate,
    note: batch1.note,
  };
  const savedA = await useLoanStore.getState().saveLoan(batch1.id, { ...header, items: itemsV2 }, 1);
  assert(savedA.version === 2, '标签页 A 保存成功，版本推进到 v2');

  let conflictError: unknown = null;
  try {
    // B 仍持版本 1 保存
    const itemsB = batch1.items.map((it) => ({ ...it, targetCaseId: caseB.id, targetCaseCode: caseB.code, targetRow: 2, targetCol: 0, assignedAt: new Date().toISOString() }));
    await useLoanStore.getState().saveLoan(batch1.id, { ...header, items: itemsB }, 1);
  } catch (e) {
    conflictError = e;
  }
  assert(conflictError instanceof LoanVersionConflictError, '标签页 B 后保存收到版本冲突');
  const dbAfterConflict = await db.loans.get(batch1.id);
  assert(
    dbAfterConflict.items.find((i) => i.matrixId === 'm-1001')!.targetRow === 1,
    '冲突后库内保留 A 的结果（m1001 在第1行），未被 B 覆盖',
  );

  // ---- 场景 3：容量/引用冲突导致完成回滚 ----
  // 制造同批格位重复：直接构造非法 items 调 complete（版本 2）
  const badItems = savedA.items.map((it, idx) =>
    idx === 1 ? { ...it, targetRow: 1, targetCol: 0 } : it, // 两条都放到 (1,0)
  );
  let conflict2: unknown = null;
  try {
    await useLoanStore.getState().completeLoan(batch1.id, { ...header, items: badItems }, 2);
  } catch (e) {
    conflict2 = e;
  }
  assert(conflict2 instanceof Error && /同一格位/.test((conflict2 as Error).message), '同批格位重复时完成被拒', (conflict2 as Error)?.message);

  // 验证无半成品：批次仍进行中 v2、字盘未变、字模仍借调中
  const afterBad = await db.loans.get(batch1.id);
  const caseBAfterBad = await db.cases.get(caseB.id);
  const m1001AfterBad = await db.matrices.get('m-1001');
  assert(afterBad.status === '进行中' && afterBad.version === 2, '冲突后批次仍为进行中 v2');
  assert(caseBAfterBad.slots.length === 2, '冲突后目标字盘没有半成品落位（仍 2 格）', `实际 ${caseBAfterBad.slots.length}`);
  assert(m1001AfterBad.availability === '借调中', '冲突后字模仍为借调中');

  // 越界格位
  const oorItems = savedA.items.map((it) =>
    it.matrixId === 'm-1001' ? { ...it, targetRow: 99, targetCol: 0 } : it,
  );
  let oorError: unknown = null;
  try {
    await useLoanStore.getState().completeLoan(batch1.id, { ...header, items: oorItems }, 2);
  } catch (e) {
    oorError = e;
  }
  assert(oorError instanceof Error && /超出/.test((oorError as Error).message), '越界格位完成被拒');

  // 引用冲突：目标格位已有别的现存字模（m1015 在 caseB 0,0）
  const occItems = savedA.items.map((it) =>
    it.matrixId === 'm-1001' ? { ...it, targetRow: 0, targetCol: 0 } : it,
  );
  let occError: unknown = null;
  try {
    await useLoanStore.getState().completeLoan(batch1.id, { ...header, items: occItems }, 2);
  } catch (e) {
    occError = e;
  }
  assert(occError instanceof Error && /已落位/.test((occError as Error).message), '目标格位被现存字模占用时完成被拒');

  // ---- 场景 4：正常完成，四处同步 ----
  const completed = await useLoanStore.getState().completeLoan(batch1.id, { ...header, items: savedA.items }, 2);
  assert(completed.status === '已完成' && completed.version === 3, '完成后批次已完成 v3');
  await Promise.all([useCaseStore.getState().load(), useMatrixStore.getState().load()]);
  const caseAFinal = useCaseStore.getState().cases.find((c) => c.id === caseA.id)!;
  const caseBFinal = useCaseStore.getState().cases.find((c) => c.id === caseB.id)!;
  assert(!caseAFinal.slots.some((s) => s.matrixId === 'm-1001' || s.matrixId === 'm-1002'), '完成后原格位已取出');
  assert(
    caseBFinal.slots.some((s) => s.matrixId === 'm-1001' && s.row === 1 && s.col === 0) &&
      caseBFinal.slots.some((s) => s.matrixId === 'm-1002' && s.row === 1 && s.col === 1),
    '完成后目标字盘正确落位',
  );
  assert(
    caseBFinal.slots.length === 4 && caseBFinal.matrixId.length === 4,
    '目标字盘现存 2 格 + 新到 2 格，matrixId 索引同步',
    `实际 slots=${caseBFinal.slots.length} idx=${caseBFinal.matrixId.length}`,
  );
  const m1001Final = useMatrixStore.getState().matrices.find((m) => m.id === 'm-1001')!;
  assert(m1001Final.availability === '可用', '完成后字模恢复可用');

  // 已完成批次可再建批同一字模
  const batch2 = await useLoanStore.getState().createLoan({
    input: loanInput(),
    selections: [{ matrix: m1001Final, sourceCaseId: caseB.id, sourceRow: 1, sourceCol: 0 }],
  });
  assert(batch2.status === '进行中', '完成后同一字模可再次借调');

  // ---- 场景 5：取消批次恢复可用性 ----
  await useLoanStore.getState().cancelLoan(batch2.id, batch2.version);
  await useMatrixStore.getState().load();
  const m1001Cancelled = useMatrixStore.getState().matrices.find((m) => m.id === 'm-1001')!;
  assert(m1001Cancelled.availability === '可用', '取消批次后字模恢复可用');
  const cancelledRow = await db.loans.get(batch2.id);
  assert(cancelledRow.status === '已取消', '批次状态为已取消');

  // ---- 场景 5b：同盘借调（原字盘即目标字盘）容量与搬移正确 ----
  const m1004 = useMatrixStore.getState().matrices.find((m) => m.id === 'm-1004')!; // 刷 @ A4 (0,3)
  const batch3 = await useLoanStore.getState().createLoan({
    input: loanInput(),
    selections: [{ matrix: m1004, sourceCaseId: caseA.id, sourceRow: 0, sourceCol: 3 }],
  });
  // caseA 为 6x8，现存已被前面完成操作改动，找一个空格落位
  const caseANow = await db.cases.get(caseA.id);
  const empty = caseANow.slots;
  let targetR = -1;
  let targetC = -1;
  outer: for (let r = 0; r < caseANow.rows; r += 1) {
    for (let c = 0; c < caseANow.cols; c += 1) {
      if (!empty.some((s) => s.row === r && s.col === c)) {
        targetR = r;
        targetC = c;
        break outer;
      }
    }
  }
  const items3 = batch3.items.map((it) => ({
    ...it,
    targetCaseId: caseA.id,
    targetCaseCode: caseA.code,
    targetRow: targetR,
    targetCol: targetC,
    assignedAt: new Date().toISOString(),
  }));
  const header3 = {
    exhibition: batch3.exhibition,
    operator: batch3.operator,
    outboundDate: batch3.outboundDate,
    expectedReturnDate: batch3.expectedReturnDate,
    note: batch3.note,
  };
  const done3 = await useLoanStore.getState().completeLoan(batch3.id, { ...header3, items: items3 }, 1);
  assert(done3.status === '已完成', '同盘借调可正常完成');
  const caseA3 = await db.cases.get(caseA.id);
  assert(!caseA3.slots.some((s) => s.row === 0 && s.col === 3), '同盘完成后原格位 (0,3) 已取出');
  assert(caseA3.slots.some((s) => s.matrixId === 'm-1004' && s.row === targetR && s.col === targetC), '同盘完成后落到新格位');
  const m1004Final = await db.matrices.get('m-1004');
  assert(m1004Final.availability === '可用', '同盘完成后字模恢复可用');

  // ---- 场景 6：v4 迁移，旧活动批次缺 version → 待复核 ----
  const MIG_DB = 'gbmovabletype-test-migrate';
  // 以 v3 schema 建独立库，塞入旧风格批次（无 version 字段，v3 也没有 loans 表，
  // 但 Dexie 允许往未声明表 add？不允许；所以直接声明 v3 + loans 表但不含新字段）
  const DexieMod = (await import('dexie')).default;
  await new DexieMod(MIG_DB).delete();
  const preDb = new DexieMod(MIG_DB);
  preDb.version(3).stores({
    matrices: 'id, code, character, font, sizeName, material, availability',
    cases: 'id, code, kind, workStation, *matrixId',
    defects: 'id, matrixId, defectType, severity, availability, foundDate',
    proofs: 'id, matrixId, sampleNo, clarity, proofDate',
    // 模拟旧版本曾经非正式地带过 loans 表（但记录缺少乐观锁字段）
    loans: 'id, code, status, updatedAt',
  });
  await preDb.open();
  // 借用当前主库的示例字盘 / 字盘数据
  await preDb.table('matrices').bulkPut(await db.matrices.toArray());
  await preDb.table('cases').bulkPut(await db.cases.toArray());
  await preDb.table('defects').bulkPut(await db.defects.toArray());
  await preDb.table('proofs').bulkPut(await db.proofs.toArray());
  await preDb.table('loans').add({
    id: 'loan-legacy-1',
    code: 'JZ-LEGACY-01',
    exhibition: '旧巡展',
    operator: '旧系统',
    outboundDate: '2026-09-01',
    expectedReturnDate: '2026-10-01',
    note: '',
    status: '进行中',
    items: [
      {
        matrixId: 'm-1003',
        character: '印',
        matrixCode: 'ZM-1978-003',
        sourceCaseId: 'case-1001',
        sourceCaseCode: 'ZP-A-01',
        sourceRow: 0,
        sourceCol: 2,
        targetCaseId: '',
        targetCaseCode: '',
        targetRow: null,
        targetCol: null,
      },
    ],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  });
  await preDb.close();

  // 用当前代码以 v4 重新打开 → 触发 upgrade
  const { MovableTypeDb } = await import('../src/db/index.ts');
  const migrated = new MovableTypeDb(MIG_DB);
  await migrated.open();
  const legacyRow = await migrated.loans.get('loan-legacy-1');
  assert(legacyRow?.status === '待复核', '旧活动批次升级后进入待复核，不自动完成', legacyRow?.status);
  assert(typeof legacyRow?.version === 'number', '升级补齐版本字段');
  assert(Array.isArray(legacyRow?.matrixIds) && legacyRow.matrixIds[0] === 'm-1003', '升级补齐 matrixIds 多值索引');
  assert(
    legacyRow.items[0].priorAvailability === '可用',
    '升级为明细补齐 priorAvailability',
  );
  assert(/版本字段/.test(legacyRow?.reviewReason ?? ''), '待复核原因已写入');
  await migrated.close();
  await new DexieMod(MIG_DB).delete();

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
