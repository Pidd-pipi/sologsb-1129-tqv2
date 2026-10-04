import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCaseStore } from '../stores/caseStore';
import { useLoanStore } from '../stores/loanStore';
import type { CaseSlot, TypeCase } from '../types/case';
import type { TypeMatrix } from '../types/matrix';
import {
  detectConflicts,
  emptySlots,
  fillRate,
  placeSlot,
  removeSlot,
  swapSlots,
  validateCapacity,
  type RCCell,
  type SlotConflicts,
} from '../utils/layout';

export interface CaseSlotsApi {
  /** 当前编辑中的格位布局（可能尚未保存） */
  slots: CaseSlot[];
  /** 与本机落库版本是否有差异 */
  dirty: boolean;
  saving: boolean;
  conflicts: SlotConflicts;
  capacity: ReturnType<typeof validateCapacity>;
  fillPercent: number;
  emptyCells: RCCell[];
  /** 未结束借调批次冻结的原格位键集合 */
  frozenKeys: Set<string>;
  isFrozen: (row: number, col: number) => boolean;
  /** 落位：把一枚可用字模放到指定格位 */
  place: (matrix: TypeMatrix, row: number, col: number) => void;
  /** 取出格位上的字模 */
  take: (row: number, col: number) => void;
  /** 调换两个格位（目标为空时视为移动） */
  swap: (a: RCCell, b: RCCell) => void;
  clear: () => void;
  replaceAll: (next: CaseSlot[]) => void;
  /** 保存到 IndexedDB（并刷新 matrixId 多值索引） */
  save: () => Promise<void>;
  /** 放弃未保存改动，回到落库版本 */
  revert: () => void;
}

/**
 * 字盘格位编辑：落位 / 取出 / 调换，实时给出空格与重复落位提示。
 * 被字盘布局编辑器（`/cases`）与字模详情页（`/matrices/:id`）复用。
 */
export function useCaseSlots(typeCase: TypeCase | undefined): CaseSlotsApi {
  const saveSlots = useCaseStore((s) => s.saveSlots);
  const loans = useLoanStore((s) => s.loans);
  const [slots, setSlots] = useState<CaseSlot[]>(typeCase?.slots ?? []);
  const [saving, setSaving] = useState(false);

  const version = `${typeCase?.id ?? ''}#${typeCase?.updatedAt ?? ''}`;
  useEffect(() => {
    setSlots(typeCase?.slots ?? []);
    // 仅在切换字盘或落库版本变化时同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const rows = typeCase?.rows ?? 0;
  const cols = typeCase?.cols ?? 0;

  /** 借调批次冻结的原格位：未结束批次期间不能落位 / 取出 / 调换 */
  const frozenKeys = useMemo(() => {
    const set = new Set<string>();
    if (!typeCase) return set;
    for (const loan of loans) {
      for (const item of loan.items) {
        if (item.sourceCaseId === typeCase.id) set.add(`${item.sourceRow}-${item.sourceCol}`);
      }
    }
    return set;
  }, [loans, typeCase]);

  const isFrozen = useCallback(
    (row: number, col: number) => frozenKeys.has(`${row}-${col}`),
    [frozenKeys],
  );

  const persisted = typeCase?.slots ?? [];
  const dirty = useMemo(
    () => JSON.stringify(slots) !== JSON.stringify(persisted),
    [slots, persisted],
  );

  const conflicts = useMemo(() => detectConflicts(rows, cols, slots), [rows, cols, slots]);
  const capacity = useMemo(() => validateCapacity(rows, cols, slots), [rows, cols, slots]);
  const fillPercent = useMemo(() => fillRate(slots, rows, cols), [slots, rows, cols]);
  const emptyCells = useMemo(() => emptySlots(rows, cols, slots), [rows, cols, slots]);

  const place = useCallback((matrix: TypeMatrix, row: number, col: number) => {
    if (frozenKeys.has(`${row}-${col}`)) return;
    const slot: CaseSlot = {
      row,
      col,
      character: matrix.character,
      matrixId: matrix.id,
      placedAt: new Date().toISOString(),
    };
    setSlots((cur) => placeSlot(cur, slot));
  }, [frozenKeys]);

  const take = useCallback((row: number, col: number) => {
    if (frozenKeys.has(`${row}-${col}`)) return;
    setSlots((cur) => removeSlot(cur, row, col));
  }, [frozenKeys]);

  const swap = useCallback((a: RCCell, b: RCCell) => {
    if (frozenKeys.has(`${a.row}-${a.col}`) || frozenKeys.has(`${b.row}-${b.col}`)) return;
    setSlots((cur) => swapSlots(cur, a, b));
  }, [frozenKeys]);

  const clear = useCallback(() => setSlots([]), []);
  const replaceAll = useCallback((next: CaseSlot[]) => setSlots(next), []);
  const revert = useCallback(() => setSlots(typeCase?.slots ?? []), [typeCase?.slots]);

  const save = useCallback(async () => {
    if (!typeCase) return;
    // 冻结格位（未结束借调批次的原格位）不允许通过布局保存被改动
    for (const key of frozenKeys) {
      const [r, c] = key.split('-').map(Number);
      const before = typeCase.slots.find((s) => s.row === r && s.col === c);
      const after = slots.find((s) => s.row === r && s.col === c);
      if (!before || !after || before.matrixId !== after.matrixId) {
        throw new Error(`格位 ${key} 的字模已随借调批次出库，原格位冻结，不能改动`);
      }
    }
    setSaving(true);
    try {
      await saveSlots(typeCase.id, slots);
    } finally {
      setSaving(false);
    }
  }, [saveSlots, slots, typeCase, frozenKeys]);

  return {
    slots,
    dirty,
    saving,
    conflicts,
    capacity,
    fillPercent,
    emptyCells,
    frozenKeys,
    isFrozen,
    place,
    take,
    swap,
    clear,
    replaceAll,
    save,
    revert,
  };
}
