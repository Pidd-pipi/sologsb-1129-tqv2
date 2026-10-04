import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import { useCaseStore } from './caseStore';
import { useMatrixStore } from './matrixStore';
import type { TypeCase } from '../types/case';
import type { TypeMatrix } from '../types/matrix';
import {
  checkTargetCapacity,
  findUnassigned,
  isOpenLoan,
  validateLoanTargets,
  type LoanBatch,
  type LoanBatchInput,
  type LoanItem,
} from '../types/loan';
import { makeId, toPlain } from '../utils/format';
import { matrixIdsOf } from '../utils/layout';

/** 版本冲突：两个标签页同时改同一批次，后保存者持有的版本已过期 */
export class LoanVersionConflictError extends Error {
  current: LoanBatch;
  constructor(current: LoanBatch) {
    super('该批次已在其他标签页 / 窗口中被修改保存，请刷新查看最新版本后再合并改动');
    this.name = 'LoanVersionConflictError';
    this.current = current;
  }
}

/** 完成批次前的编排错误（容量、格位冲突等） */
export class LoanAssignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoanAssignmentError';
  }
}

interface CreateLoanRequest {
  input: LoanBatchInput;
  /** 选中的字模 id → 原格位（由页面快照保证引用关系） */
  selections: Array<{
    matrix: TypeMatrix;
    sourceCaseId: string;
    sourceRow: number;
    sourceCol: number;
  }>;
}

interface LoanState {
  loans: LoanBatch[];
  loaded: boolean;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  /** 建批：原子校验 + 落库。原格位自此不再算可用，但不动字盘数据，靠批次追溯 */
  createLoan: (request: CreateLoanRequest) => Promise<LoanBatch>;
  /**
   * 乐观锁保存：expectedVersion 必须与库中一致，否则抛 LoanVersionConflictError。
   * 只允许「进行中」批次保存；「待复核」批次需先复核处理。
   */
  saveLoan: (
    id: string,
    patch: Pick<LoanBatch, 'items' | 'exhibition' | 'operator' | 'outboundDate' | 'expectedReturnDate' | 'note'>,
    expectedVersion: number,
  ) => Promise<LoanBatch>;
  /** 复核确认：待复核批次经人工核对后恢复为进行中（版本号归一） */
  resolveReview: (id: string) => Promise<void>;
  /**
   * 完成批次：在一个事务内同步目标字盘落位、原格位取出、字模可用性与批次状态。
   * 与保存一样携带编辑内容与乐观锁版本；任一格位 / 容量校验失败，整个事务回滚，
   * 不会留下「编排已保存但完成失败」的半成品。
   */
  completeLoan: (
    id: string,
    patch: Pick<LoanBatch, 'items' | 'exhibition' | 'operator' | 'outboundDate' | 'expectedReturnDate' | 'note'>,
    expectedVersion: number,
  ) => Promise<LoanBatch>;
  /** 取消未结束批次：事务内还原原格位占用关系（若已发生临时变动）并解除占用标记 */
  cancelLoan: (id: string, expectedVersion: number) => Promise<void>;
  removeLoan: (id: string) => Promise<void>;
}

const byUpdatedDesc = (a: LoanBatch, b: LoanBatch) => (a.updatedAt < b.updatedAt ? 1 : -1);

/** 借调操作会改动字盘与字模，提交后重新拉齐其它 store 的内存快照 */
function syncRelatedStores(): void {
  void useCaseStore.getState().load();
  void useMatrixStore.getState().load();
}

/**
 * 借调批次被任何一个标签页改动后广播版本戳。
 * 其它标签页据此重新读库：正在编辑的批次若版本已变，保存时会收到乐观锁冲突，
 * 未打开的列表则静默刷新到最新。
 */
const LOAN_CHANGED_KEY = 'gbmovabletype-loan-changed';

function notifyLoansChanged(): void {
  try {
    localStorage.setItem(LOAN_CHANGED_KEY, JSON.stringify({ at: Date.now() }));
  } catch {
    /* localStorage 不可用时退化为仅当前标签页生效 */
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== LOAN_CHANGED_KEY) return;
    const state = useLoanStore.getState();
    if (state.loaded) void state.load();
    syncRelatedStores();
  });
}

/** 同一字模不能同时留在两个未结束批次：检查 id 是否被其它进行中批次占用 */
function idsHeldByOtherOpenLoans(all: LoanBatch[], selfId: string, ids: string[]): Set<string> {
  const held = new Set<string>();
  for (const loan of all) {
    if (loan.id === selfId) continue;
    if (!isOpenLoan(loan.status)) continue;
    for (const item of loan.items) held.add(item.matrixId);
  }
  return new Set(ids.filter((id) => held.has(id)));
}

export const useLoanStore = create<LoanState>((set, get) => ({
  loans: [],
  loaded: false,
  loading: false,
  error: '',

  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      const loans = await db.loans.toArray();
      set({ loans: loans.sort(byUpdatedDesc), loaded: true, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '借调批次读取失败' });
    }
  },

  createLoan: async ({ input, selections }) => {
    if (selections.length === 0) throw new Error('请至少选入一枚字模');
    const state = get();
    // 同一字模不能同时留在两个未结束批次
    const dup = idsHeldByOtherOpenLoans(
      state.loans,
      '',
      selections.map((s) => s.matrix.id),
    );
    if (dup.size > 0) {
      const codes = selections
        .filter((s) => dup.has(s.matrix.id))
        .map((s) => `${s.matrix.character}（${s.matrix.code}）`);
      throw new LoanAssignmentError(`以下字模已在其它未结束批次中，不能重复借调：${codes.join('、')}`);
    }

    // 读库核对原格位引用关系（不能只信内存，可能被别的标签页改过）
    const cases = await db.cases.toArray();
    const caseById = new Map(cases.map((c) => [c.id, c]));
    const nowIso = new Date().toISOString();
    const items: LoanItem[] = [];
    const seenMatrix = new Set<string>();
    for (const sel of selections) {
      if (seenMatrix.has(sel.matrix.id)) {
        throw new LoanAssignmentError(`字模 ${sel.matrix.code} 在本批次中重复选入`);
      }
      seenMatrix.add(sel.matrix.id);
      if (sel.matrix.availability === '借调中') {
        throw new LoanAssignmentError(`字模 ${sel.matrix.code} 已随其它批次借出，不能重复借调`);
      }
      if (sel.matrix.availability !== '可用') {
        throw new LoanAssignmentError(
          `字模 ${sel.matrix.code} 当前为「${sel.matrix.availability}」，需恢复可用后才能借调巡展`,
        );
      }
      const sourceCase = caseById.get(sel.sourceCaseId);
      if (!sourceCase) throw new LoanAssignmentError(`原字盘 ${sel.sourceCaseId} 已不存在，原格位无法追溯`);
      const slot = sourceCase.slots.find((s) => s.row === sel.sourceRow && s.col === sel.sourceCol);
      if (!slot) {
        throw new LoanAssignmentError(
          `${sourceCase.code} 的原格位 ${sel.sourceRow}-${sel.sourceCol} 已被改动，字模 ${sel.matrix.code} 的原格位引用失效`,
        );
      }
      if (slot.matrixId !== sel.matrix.id) {
        throw new LoanAssignmentError(
          `${sourceCase.code} 的 ${sel.sourceRow}-${sel.sourceCol} 现在是「${slot.character}」，与选入的 ${sel.matrix.code} 不一致`,
        );
      }
      items.push({
        matrixId: sel.matrix.id,
        character: sel.matrix.character,
        matrixCode: sel.matrix.code,
        priorAvailability: sel.matrix.availability,
        sourceCaseId: sourceCase.id,
        sourceCaseCode: sourceCase.code,
        sourceRow: sel.sourceRow,
        sourceCol: sel.sourceCol,
        targetCaseId: '',
        targetCaseCode: '',
        targetRow: null,
        targetCol: null,
        assignedAt: '',
      });
    }

    const row: LoanBatch = toPlain({
      id: makeId('loan'),
      code: input.code.trim(),
      exhibition: input.exhibition.trim(),
      operator: input.operator.trim(),
      outboundDate: input.outboundDate,
      expectedReturnDate: input.expectedReturnDate,
      note: input.note.trim(),
      status: '进行中',
      items,
      matrixIds: items.map((it) => it.matrixId),
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: '',
      reviewReason: '',
    });

    // 编号唯一性、原格位引用、字模可用性与批次落库放在同一事务内，任一失败全部回滚
    await db.transaction('rw', db.loans, db.matrices, async () => {
      const existed = await db.loans.where('code').equals(row.code).count();
      if (existed > 0) throw new LoanAssignmentError(`批次编号 ${row.code} 已存在，请更换`);
      await db.matrices
        .where('id')
        .anyOf(items.map((it) => it.matrixId))
        .modify((m: TypeMatrix) => {
          // 事务内二次确认，避免两个标签页同时建批把同一字模借出两次
          if (m.availability !== '可用') {
            throw new LoanAssignmentError(`字模 ${m.code} 当前为「${m.availability}」，不能借调`);
          }
          m.availability = '借调中';
          m.updatedAt = nowIso;
        });
      await db.loans.add(row);
    });
    set((s) => ({ loans: [row, ...s.loans].sort(byUpdatedDesc) }));
    syncRelatedStores();
    notifyLoansChanged();
    return row;
  },

  saveLoan: async (id, patch, expectedVersion) => {
    const result = await db.transaction('rw', db.loans, db.cases, async () => {
      const current = await db.loans.get(id);
      if (!current) throw new LoanAssignmentError('未找到借调批次');
      if (current.status === '待复核') {
        throw new LoanAssignmentError('该批次为旧数据升级后的待复核批次，请先完成人工复核再修改');
      }
      if (current.status !== '进行中') {
        throw new LoanAssignmentError(`批次已${current.status}，不能再修改`);
      }
      if (current.version !== expectedVersion) throw new LoanVersionConflictError(current);

      // 字模不能被挪入其它未结束批次
      const all = await db.loans.toArray();
      const dup = idsHeldByOtherOpenLoans(all, id, patch.items.map((it) => it.matrixId));
      if (dup.size > 0) {
        throw new LoanAssignmentError(`字模 ${Array.from(dup).join('、')} 已在其它未结束批次中`);
      }

      // 引用关系 + 容量 + 同盘格位重复：编排只校验不写盘，完成时才真正落位
      const cases = await db.cases.toArray();
      const caseMap = new Map(cases.map((c) => [c.id, c]));
      const { problems, valid } = validateLoanTargets(patch.items, caseMap);
      if (!valid) throw new LoanAssignmentError(problems.map((p) => p.message).join('；'));
      const overCapacity = checkTargetCapacity(patch.items, caseMap);
      if (overCapacity.length > 0) throw new LoanAssignmentError(overCapacity.join('；'));

      // 原格位引用仍然有效
      for (const item of patch.items) {
        const sourceCase = caseMap.get(item.sourceCaseId);
        if (!sourceCase) throw new LoanAssignmentError(`原字盘 ${item.sourceCaseCode} 已不存在，无法追溯原格位`);
        const slot = sourceCase.slots.find((s) => s.row === item.sourceRow && s.col === item.sourceCol);
        if (!slot || slot.matrixId !== item.matrixId) {
          throw new LoanAssignmentError(
            `原格位 ${item.sourceCaseCode} ${item.sourceRow}-${item.sourceCol} 的现存字模与 ${item.matrixCode} 不一致，原格位引用已失效`,
          );
        }
      }

      const next: LoanBatch = {
        ...current,
        exhibition: patch.exhibition.trim(),
        operator: patch.operator.trim(),
        outboundDate: patch.outboundDate,
        expectedReturnDate: patch.expectedReturnDate,
        note: patch.note.trim(),
        items: toPlain(patch.items),
        matrixIds: Array.from(new Set(patch.items.map((it) => it.matrixId))),
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
        reviewReason: '',
      };
      await db.loans.put(next);
      return next;
    });
    set((s) => ({ loans: s.loans.map((l) => (l.id === id ? result : l)).sort(byUpdatedDesc) }));
    notifyLoansChanged();
    return result;
  },

  resolveReview: async (id) => {
    await db.transaction('rw', db.loans, db.cases, db.matrices, async () => {
      const current = await db.loans.get(id);
      if (!current) throw new LoanAssignmentError('未找到借调批次');
      if (current.status !== '待复核') throw new LoanAssignmentError('该批次不在待复核状态');
      const cases = await db.cases.toArray();
      const caseMap = new Map(cases.map((c) => [c.id, c]));
      // 复核通过的最低条件：原格位引用仍在
      for (const item of current.items) {
        const sourceCase = caseMap.get(item.sourceCaseId);
        const slot = sourceCase?.slots.find((s) => s.row === item.sourceRow && s.col === item.sourceCol);
        if (!sourceCase || !slot || slot.matrixId !== item.matrixId) {
          throw new LoanAssignmentError(
            `原格位 ${item.sourceCaseCode} ${item.sourceRow}-${item.sourceCol} 已无法对应 ${item.matrixCode}，请取消该批次重建`,
          );
        }
      }
      const next: LoanBatch = {
        ...current,
        status: '进行中',
        reviewReason: '',
        version: Math.max(1, current.version),
        updatedAt: new Date().toISOString(),
      };
      await db.loans.put(next);
      // 复核通过即恢复占用：当前仍为可用的成员字模转为借调中
      const nowIso = next.updatedAt;
      for (const item of current.items) {
        const m = await db.matrices.get(item.matrixId);
        if (m && m.availability === '可用') {
          await db.matrices.update(m.id, { availability: '借调中', updatedAt: nowIso });
        }
      }
    });
    const updated = await db.loans.get(id);
    if (updated) set((s) => ({ loans: s.loans.map((l) => (l.id === id ? updated : l)).sort(byUpdatedDesc) }));
    syncRelatedStores();
    notifyLoansChanged();
  },

  completeLoan: async (id, patch, expectedVersion) => {
    const result = await db.transaction('rw', db.loans, db.cases, db.matrices, async () => {
      const current = await db.loans.get(id);
      if (!current) throw new LoanAssignmentError('未找到借调批次');
      if (current.status === '待复核') {
        throw new LoanAssignmentError('待复核批次需先人工复核确认，不能直接完成');
      }
      if (current.status !== '进行中') throw new LoanAssignmentError(`批次已${current.status}，无需重复完成`);
      if (current.version !== expectedVersion) throw new LoanVersionConflictError(current);

      const cases = await db.cases.toArray();
      const caseMap = new Map(cases.map((c) => [c.id, c]));

      // 与保存一致的前置校验：字模占用、原格位引用、头信息随编排一并提交
      const dup = idsHeldByOtherOpenLoans(await db.loans.toArray(), id, patch.items.map((it) => it.matrixId));
      if (dup.size > 0) {
        throw new LoanAssignmentError(`字模 ${Array.from(dup).join('、')} 已在其它未结束批次中`);
      }

      // 1) 所有明细必须已安排目标字盘与格位
      const unassigned = findUnassigned(patch.items);
      if (unassigned.length > 0) {
        throw new LoanAssignmentError(
          `还有 ${unassigned.length} 枚字模未安排目标格位：${unassigned.map((it) => it.matrixCode).join('、')}`,
        );
      }
      // 2) 目标格位：边界、同批重复、现存引用
      const { problems, valid } = validateLoanTargets(patch.items, caseMap);
      if (!valid) throw new LoanAssignmentError(problems.map((p) => p.message).join('；'));
      // 3) 容量
      const overCapacity = checkTargetCapacity(patch.items, caseMap);
      if (overCapacity.length > 0) throw new LoanAssignmentError(overCapacity.join('；'));
      // 4) 原格位引用必须仍指向本批字模
      for (const item of patch.items) {
        const sourceCase = caseMap.get(item.sourceCaseId);
        const slot = sourceCase?.slots.find((s) => s.row === item.sourceRow && s.col === item.sourceCol);
        if (!sourceCase || !slot || slot.matrixId !== item.matrixId) {
          throw new LoanAssignmentError(
            `原格位 ${item.sourceCaseCode} ${item.sourceRow}-${item.sourceCol} 的现存字模与 ${item.matrixCode} 不一致，已中止完成`,
          );
        }
      }

      const nowIso = new Date().toISOString();

      // 5) 改字盘：原格位取出、目标格位落位（同盘时合并处理），重建 matrixId 索引
      const touchedCaseIds = new Set<string>();
      patch.items.forEach((it) => {
        touchedCaseIds.add(it.sourceCaseId);
        touchedCaseIds.add(it.targetCaseId);
      });
      for (const caseId of touchedCaseIds) {
        const typeCase = caseMap.get(caseId);
        if (!typeCase) continue;
        let slots = typeCase.slots.map((s) => ({ ...s }));
        const incoming = patch.items.filter((it) => it.targetCaseId === caseId);
        const outgoing = patch.items.filter((it) => it.sourceCaseId === caseId);
        // 取出原格位
        for (const out of outgoing) {
          slots = slots.filter((s) => !(s.row === out.sourceRow && s.col === out.sourceCol));
        }
        // 落入目标格位（同格覆盖防御）
        for (const inc of incoming) {
          slots = slots.filter((s) => !(s.row === inc.targetRow && s.col === inc.targetCol));
          slots.push({
            row: inc.targetRow as number,
            col: inc.targetCol as number,
            character: inc.character,
            matrixId: inc.matrixId,
            placedAt: nowIso,
          });
        }
        slots.sort((a, b) => a.row - b.row || a.col - b.col);
        const nextCase: TypeCase = {
          ...typeCase,
          slots,
          matrixId: matrixIdsOf(slots),
          updatedAt: nowIso,
        };
        await db.cases.put(nextCase);
      }

      // 6) 字模可用性同步：巡展落位完成，按借出前状态恢复（借出前为停用 / 待补刻的照旧）
      const matrixIds = patch.items.map((it) => it.matrixId);
      const matrixById = new Map((await db.matrices.bulkGet(matrixIds)).filter(Boolean).map((m) => [m!.id, m!]));
      for (const item of patch.items) {
        const m = matrixById.get(item.matrixId);
        if (!m) continue;
        const restoreTo: TypeMatrix['availability'] =
          item.priorAvailability === '借调中' ? '可用' : item.priorAvailability || '可用';
        await db.matrices.update(m.id, { availability: restoreTo, updatedAt: nowIso });
      }

      const next: LoanBatch = {
        ...current,
        exhibition: patch.exhibition.trim(),
        operator: patch.operator.trim(),
        outboundDate: patch.outboundDate,
        expectedReturnDate: patch.expectedReturnDate,
        note: patch.note.trim(),
        items: toPlain(patch.items),
        matrixIds: Array.from(new Set(patch.items.map((it) => it.matrixId))),
        status: '已完成',
        version: current.version + 1,
        updatedAt: nowIso,
        completedAt: nowIso,
        reviewReason: '',
      };
      await db.loans.put(next);
      return { batch: next, touchedCaseIds };
    });

    // 事务提交后再刷新内存（cases / matrices 由各自 store 持有的内存需要同步）
    set((s) => ({ loans: s.loans.map((l) => (l.id === id ? result.batch : l)).sort(byUpdatedDesc) }));
    syncRelatedStores();
    notifyLoansChanged();
    return result.batch;
  },

  cancelLoan: async (id, expectedVersion) => {
    const nowIso = new Date().toISOString();
    await db.transaction('rw', db.loans, db.matrices, async () => {
      const current = await db.loans.get(id);
      if (!current) throw new LoanAssignmentError('未找到借调批次');
      if (!isOpenLoan(current.status)) throw new LoanAssignmentError(`批次已${current.status}，无需取消`);
      if (current.status === '进行中' && current.version !== expectedVersion) {
        throw new LoanVersionConflictError(current);
      }
      // 解除字模占用：恢复为借出前可用性（原格位未被改动，字盘数据无需回写）
      for (const item of current.items) {
        const m = await db.matrices.get(item.matrixId);
        if (!m || m.availability !== '借调中') continue;
        const restoreTo: TypeMatrix['availability'] =
          item.priorAvailability === '借调中' ? '可用' : item.priorAvailability || '可用';
        await db.matrices.update(m.id, { availability: restoreTo, updatedAt: nowIso });
      }
      const next: LoanBatch = {
        ...current,
        status: '已取消',
        version: current.version + 1,
        updatedAt: nowIso,
      };
      await db.loans.put(next);
    });
    const updated = await db.loans.get(id);
    if (updated) set((s) => ({ loans: s.loans.map((l) => (l.id === id ? updated : l)).sort(byUpdatedDesc) }));
    syncRelatedStores();
    notifyLoansChanged();
  },

  removeLoan: async (id) => {
    await db.loans.delete(id);
    set((s) => ({ loans: s.loans.filter((l) => l.id !== id) }));
  },
}));

/** 选出当前占用某枚字模的未结束批次（同一字模不能同时留在两个未结束批次） */
export function selectOpenLoanForMatrix(loans: LoanBatch[], matrixId: string): LoanBatch | undefined {
  return loans
    .filter((l) => isOpenLoan(l.status))
    .find((l) => l.items.some((it) => it.matrixId === matrixId));
}

/** 占用某原格位的未结束批次（原格位不再算可用） */
export function selectOpenLoanForSlot(
  loans: LoanBatch[],
  caseId: string,
  row: number,
  col: number,
): LoanBatch | undefined {
  return loans
    .filter((l) => isOpenLoan(l.status))
    .find((l) =>
      l.items.some((it) => it.sourceCaseId === caseId && it.sourceRow === row && it.sourceCol === col),
    );
}

/** 统计未结束批次占用的字模数量 */
export function countLoanedOut(loans: LoanBatch[]): number {
  const ids = new Set<string>();
  for (const loan of loans) {
    if (!isOpenLoan(loan.status)) continue;
    for (const item of loan.items) ids.add(item.matrixId);
  }
  return ids.size;
}
