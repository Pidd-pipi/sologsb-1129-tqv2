import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import type { LoanBatch, LoanBatchInput, LoanItem, LoanStatus } from '../types/loan';
import type { TypeCase } from '../types/case';
import type { TypeMatrix } from '../types/matrix';
import { capacityOf } from '../types/case';
import { makeId, toPlain, todayStr } from '../utils/format';
import { isWithinBounds, slotAt } from '../utils/layout';
import { matrixIdsOf } from '../utils/layout';
import { useCaseStore } from './caseStore';
import { useMatrixStore } from './matrixStore';

/** 版本冲突错误：后保存者遇到版本不一致时抛出 */
export class LoanConflictError extends Error {
  constructor(
    message: string,
    public readonly currentVersion: number,
    public readonly expectedVersion: number,
  ) {
    super(message);
    this.name = 'LoanConflictError';
  }
}

interface LoanState {
  loans: LoanBatch[];
  loaded: boolean;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  createBatch: (input: LoanBatchInput) => Promise<LoanBatch>;
  updateBatch: (id: string, patch: Partial<LoanBatch>, expectedVersion: number) => Promise<void>;
  allocateSlots: (
    id: string,
    allocations: Array<{ matrixId: string; toRow: number; toCol: number }>,
    expectedVersion: number,
  ) => Promise<void>;
  completeBatch: (id: string, expectedVersion: number) => Promise<void>;
  cancelBatch: (id: string, expectedVersion: number) => Promise<void>;
  confirmBatch: (id: string, expectedVersion: number) => Promise<void>;
  /** 判断字模是否在某个未结束批次中 */
  isMatrixOnLoan: (matrixId: string) => boolean;
  /** 找出字模所在的未结束批次 */
  activeLoanOfMatrix: (matrixId: string) => LoanBatch | undefined;
}

const ACTIVE_STATUSES: LoanStatus[] = ['待复核', '进行中'];

const byUpdatedDesc = (a: LoanBatch, b: LoanBatch) => (a.updatedAt < b.updatedAt ? 1 : -1);

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
      set({ loading: false, error: err instanceof Error ? err.message : '借调档案读取失败' });
    }
  },

  createBatch: async (input) => {
    const now = new Date().toISOString();
    const matrices = await db.matrices.toArray();
    const cases = await db.cases.toArray();
    const activeLoans = await db.loans.where('status').anyOf(ACTIVE_STATUSES).toArray();
    const activeMatrixIds = new Set(activeLoans.flatMap((l) => l.items.map((i) => i.matrixId)));

    // 校验：字模存在、可用、未在其他未结束批次中
    const items: LoanItem[] = [];
    for (const itemInput of input.items) {
      const matrix = matrices.find((m) => m.id === itemInput.matrixId);
      if (!matrix) throw new Error(`未找到字模 ${itemInput.matrixId}`);
      if (matrix.availability === '借出') {
        throw new Error(`字模「${matrix.character}」（${matrix.code}）已在借调批次中，不能重复借调`);
      }
      if (activeMatrixIds.has(matrix.id)) {
        throw new Error(`字模「${matrix.character}」（${matrix.code}）已在未结束批次中，不能重复借调`);
      }
      const toCase = cases.find((c) => c.id === itemInput.toCaseId);
      if (!toCase) throw new Error(`未找到目标字盘 ${itemInput.toCaseId}`);

      // 找原格位
      const fromSlot = findMatrixSlot(cases, matrix.id);
      if (!fromSlot) {
        throw new Error(`字模「${matrix.character}」（${matrix.code}）未落在任何字盘格位上，无法借调`);
      }
      const fromCase = cases.find((c) => c.id === fromSlot.caseId);
      if (!fromCase) throw new Error(`未找到原字盘 ${fromSlot.caseId}`);

      items.push({
        matrixId: matrix.id,
        character: matrix.character,
        matrixCode: matrix.code,
        fromCaseId: fromCase.id,
        fromCaseCode: fromCase.code,
        fromRow: fromSlot.row,
        fromCol: fromSlot.col,
        toCaseId: toCase.id,
        toCaseCode: toCase.code,
        toRow: null,
        toCol: null,
        availabilitySnapshot: matrix.availability,
      });
    }

    // 校验：目标字盘容量（已落位数 + 借调件数 ≤ 容量）
    const toCaseCounts = new Map<string, number>();
    for (const item of items) {
      toCaseCounts.set(item.toCaseId, (toCaseCounts.get(item.toCaseId) ?? 0) + 1);
    }
    for (const [caseId, count] of toCaseCounts) {
      const toCase = cases.find((c) => c.id === caseId);
      if (!toCase) continue;
      const capacity = capacityOf(toCase.rows, toCase.cols);
      const filled = toCase.slots.length;
      if (filled + count > capacity) {
        throw new Error(
          `目标字盘 ${toCase.code} 容量不足：已落位 ${filled} 格，借调 ${count} 件，容量 ${capacity} 格`,
        );
      }
    }

    const seq = (await db.loans.count()) + 1;
    const row: LoanBatch = toPlain({
      id: makeId('loan'),
      code: `LOAN-${new Date().getFullYear()}-${`${seq}`.padStart(3, '0')}`,
      exhibitionName: input.exhibitionName.trim(),
      loanDate: input.loanDate || todayStr(),
      expectedReturnDate: input.expectedReturnDate,
      status: '进行中' as LoanStatus,
      items,
      version: 1,
      operator: input.operator.trim(),
      note: (input.note ?? '').trim(),
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });

    // 原子操作：写入批次 + 更新字模可用性为借出
    await db.transaction('rw', db.loans, db.matrices, async () => {
      await db.loans.add(row);
      for (const item of items) {
        await db.matrices.update(item.matrixId, {
          availability: '借出' as const,
          updatedAt: now,
        });
      }
    });

    set((s) => ({ loans: [row, ...s.loans].sort(byUpdatedDesc) }));
    return row;
  },

  updateBatch: async (id, patch, expectedVersion) => {
    const current = await db.loans.get(id);
    if (!current) throw new Error('未找到借调批次');
    if (current.version !== expectedVersion) {
      throw new LoanConflictError(
        `版本冲突：该批次已被其他标签页修改（当前版本 ${current.version}，期望版本 ${expectedVersion}），请刷新后重试`,
        current.version,
        expectedVersion,
      );
    }
    const now = new Date().toISOString();
    const next: Partial<LoanBatch> = {
      ...toPlain(patch),
      version: current.version + 1,
      updatedAt: now,
    };
    await db.loans.update(id, next);
    set((s) => ({
      loans: s.loans.map((l) => (l.id === id ? { ...l, ...next } : l)).sort(byUpdatedDesc),
    }));
  },

  allocateSlots: async (id, allocations, expectedVersion) => {
    const current = await db.loans.get(id);
    if (!current) throw new Error('未找到借调批次');
    if (current.version !== expectedVersion) {
      throw new LoanConflictError(
        `版本冲突：该批次已被其他标签页修改（当前版本 ${current.version}，期望版本 ${expectedVersion}），请刷新后重试`,
        current.version,
        expectedVersion,
      );
    }
    if (current.status !== '进行中') {
      throw new Error(`批次 ${current.code} 当前状态为「${current.status}」，不能分配格位`);
    }

    const cases = await db.cases.toArray();
    const now = new Date().toISOString();

    // 校验：目标格位合法、不越界、不重复、不与已有落位冲突
    const targetCase = cases.find((c) => c.id === current.items[0]?.toCaseId);
    if (!targetCase) throw new Error('未找到目标字盘');

    const allocatedKeys = new Set<string>();
    for (const alloc of allocations) {
      const item = current.items.find((i) => i.matrixId === alloc.matrixId);
      if (!item) throw new Error(`批次中未找到字模 ${alloc.matrixId}`);
      if (item.toCaseId !== targetCase.id) {
        throw new Error(`字模 ${item.character} 的目标字盘不一致`);
      }
      if (!isWithinBounds(alloc.toRow, alloc.toCol, targetCase.rows, targetCase.cols)) {
        throw new Error(`格位 ${alloc.toRow + 1}-${alloc.toCol + 1} 越界`);
      }
      const key = `${alloc.toRow}-${alloc.toCol}`;
      if (allocatedKeys.has(key)) {
        throw new Error(`格位 ${alloc.toRow + 1}-${alloc.toCol + 1} 被重复分配`);
      }
      allocatedKeys.add(key);
      // 检查是否与目标字盘已有落位冲突
      const existing = slotAt(targetCase.slots, alloc.toRow, alloc.toCol);
      if (existing && existing.matrixId !== alloc.matrixId) {
        throw new Error(
          `格位 ${alloc.toRow + 1}-${alloc.toCol + 1} 已被字模 ${existing.character}（${existing.matrixId}）占用`,
        );
      }
    }

    // 原子操作：更新批次明细的目标格位 + 版本号
    const updatedItems = current.items.map((item) => {
      const alloc = allocations.find((a) => a.matrixId === item.matrixId);
      if (alloc) {
        return { ...item, toRow: alloc.toRow, toCol: alloc.toCol };
      }
      return item;
    });

    const next: Partial<LoanBatch> = {
      items: updatedItems,
      version: current.version + 1,
      updatedAt: now,
    };
    await db.loans.update(id, next);
    set((s) => ({
      loans: s.loans.map((l) => (l.id === id ? { ...l, ...next } : l)).sort(byUpdatedDesc),
    }));
  },

  completeBatch: async (id, expectedVersion) => {
    const current = await db.loans.get(id);
    if (!current) throw new Error('未找到借调批次');
    if (current.version !== expectedVersion) {
      throw new LoanConflictError(
        `版本冲突：该批次已被其他标签页修改（当前版本 ${current.version}，期望版本 ${expectedVersion}），请刷新后重试`,
        current.version,
        expectedVersion,
      );
    }
    if (current.status !== '进行中') {
      throw new Error(`批次 ${current.code} 当前状态为「${current.status}」，不能完成`);
    }

    // 校验：所有明细都已分配目标格位
    for (const item of current.items) {
      if (item.toRow === null || item.toCol === null) {
        throw new Error(`字模「${item.character}」尚未分配目标格位，不能完成批次`);
      }
    }

    const cases = await db.cases.toArray();
    const now = new Date().toISOString();

    // 原子操作：移动字模（原盘取出 + 目标盘放入）+ 更新可用性 + 更新批次状态
    await db.transaction('rw', db.loans, db.matrices, db.cases, async () => {
      for (const item of current.items) {
        const fromCase = cases.find((c) => c.id === item.fromCaseId);
        const toCase = cases.find((c) => c.id === item.toCaseId);
        if (!fromCase || !toCase) throw new Error('字盘档案异常');

        // 从原盘取出
        const fromSlots = fromCase.slots.filter(
          (s) => !(s.row === item.fromRow && s.col === item.fromCol && s.matrixId === item.matrixId),
        );
        // 放入目标盘
        const toSlots = [
          ...toCase.slots.filter((s) => !(s.row === item.toRow && s.col === item.toCol)),
          {
            row: item.toRow!,
            col: item.toCol!,
            character: item.character,
            matrixId: item.matrixId,
            placedAt: now,
          },
        ].sort((a, b) => a.row - b.row || a.col - b.col);

        await db.cases.update(fromCase.id, {
          slots: fromSlots,
          matrixId: matrixIdsOf(fromSlots),
          updatedAt: now,
        });
        await db.cases.update(toCase.id, {
          slots: toSlots,
          matrixId: matrixIdsOf(toSlots),
          updatedAt: now,
        });

        // 恢复字模可用性
        await db.matrices.update(item.matrixId, {
          availability: item.availabilitySnapshot,
          updatedAt: now,
        });
      }

      await db.loans.update(id, {
        status: '已完成' as LoanStatus,
        version: current.version + 1,
        updatedAt: now,
        completedAt: now,
      });
    });

    // 重新读入最新状态
    const [loans, matrices, cases2] = await Promise.all([
      db.loans.toArray(),
      db.matrices.toArray(),
      db.cases.toArray(),
    ]);
    set({ loans: loans.sort(byUpdatedDesc) });
    useMatrixStore.setState({
      matrices: matrices.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    });
    useCaseStore.setState({ cases: cases2.sort((a, b) => (a.code < b.code ? -1 : 1)) });
  },

  cancelBatch: async (id, expectedVersion) => {
    const current = await db.loans.get(id);
    if (!current) throw new Error('未找到借调批次');
    if (current.version !== expectedVersion) {
      throw new LoanConflictError(
        `版本冲突：该批次已被其他标签页修改（当前版本 ${current.version}，期望版本 ${expectedVersion}），请刷新后重试`,
        current.version,
        expectedVersion,
      );
    }
    if (current.status !== '进行中' && current.status !== '待复核') {
      throw new Error(`批次 ${current.code} 当前状态为「${current.status}」，不能取消`);
    }

    const now = new Date().toISOString();

    // 原子操作：恢复字模可用性 + 更新批次状态
    await db.transaction('rw', db.loans, db.matrices, async () => {
      for (const item of current.items) {
        await db.matrices.update(item.matrixId, {
          availability: item.availabilitySnapshot,
          updatedAt: now,
        });
      }
      await db.loans.update(id, {
        status: '已取消' as LoanStatus,
        version: current.version + 1,
        updatedAt: now,
      });
    });

    set((s) => ({
      loans: s.loans
        .map((l) =>
          l.id === id
            ? { ...l, status: '已取消' as LoanStatus, version: current.version + 1, updatedAt: now }
            : l,
        )
        .sort(byUpdatedDesc),
    }));
  },

  confirmBatch: async (id, expectedVersion) => {
    const current = await db.loans.get(id);
    if (!current) throw new Error('未找到借调批次');
    if (current.version !== expectedVersion) {
      throw new LoanConflictError(
        `版本冲突：该批次已被其他标签页修改（当前版本 ${current.version}，期望版本 ${expectedVersion}），请刷新后重试`,
        current.version,
        expectedVersion,
      );
    }
    if (current.status !== '待复核') {
      throw new Error(`批次 ${current.code} 当前状态为「${current.status}」，无需复核`);
    }
    const now = new Date().toISOString();
    await db.loans.update(id, {
      status: '进行中' as LoanStatus,
      version: current.version + 1,
      updatedAt: now,
    });
    set((s) => ({
      loans: s.loans
        .map((l) =>
          l.id === id
            ? { ...l, status: '进行中' as LoanStatus, version: current.version + 1, updatedAt: now }
            : l,
        )
        .sort(byUpdatedDesc),
    }));
  },

  isMatrixOnLoan: (matrixId) => {
    return get().loans.some(
      (l) => ACTIVE_STATUSES.includes(l.status) && l.items.some((i) => i.matrixId === matrixId),
    );
  },

  activeLoanOfMatrix: (matrixId) => {
    return get().loans.find(
      (l) => ACTIVE_STATUSES.includes(l.status) && l.items.some((i) => i.matrixId === matrixId),
    );
  },
}));

/** 找出字模当前所在的字盘与格位 */
function findMatrixSlot(
  cases: TypeCase[],
  matrixId: string,
): { caseId: string; row: number; col: number } | null {
  for (const c of cases) {
    const slot = c.slots.find((s) => s.matrixId === matrixId);
    if (slot) return { caseId: c.id, row: slot.row, col: slot.col };
  }
  return null;
}
