/** 借调批次（LoanBatch）：一批字模从原字盘格位借往巡展目标字盘的整体调拨记录 */

import type { CaseSlot, TypeCase } from './case';
import { capacityOf } from './case';
import type { MatrixAvailability, TypeMatrix } from './matrix';
import { isWithinBounds, rcKey } from '../utils/layout';

/** 批次状态：进行中 / 已完成（巡展归还落位）/ 待复核（旧数据升级无版本号）/ 已取消 */
export const LOAN_STATUSES = ['进行中', '待复核', '已完成', '已取消'] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

/** 未结束批次：仍占用原格位与字模 */
export const OPEN_LOAN_STATUSES: LoanStatus[] = ['进行中', '待复核'];

/** 借调条目中的目标格位（0 基行列）；未安排格位时 targetRow/targetCol 为 null */
export interface LoanTargetSlot {
  row: number | null;
  col: number | null;
}

/** 批次中的一条借调明细：一枚字模的原格位、目标字盘与目标格位 */
export interface LoanItem {
  matrixId: string;
  character: string;
  matrixCode: string;
  /** 借出前的可用性，完成 / 取消时据此恢复 */
  priorAvailability: MatrixAvailability;
  /** 原所在字盘 */
  sourceCaseId: string;
  sourceCaseCode: string;
  sourceRow: number;
  sourceCol: number;
  /** 目标字盘（建批时可为空，编排阶段补选） */
  targetCaseId: string;
  targetCaseCode: string;
  targetRow: number | null;
  targetCol: number | null;
  assignedAt: string;
}

export interface LoanBatch {
  id: string;
  /** 批次编号，例：JZ-20261004-01 */
  code: string;
  /** 巡展名称 */
  exhibition: string;
  /** 借调经办人 */
  operator: string;
  /** 计划出库日期 YYYY-MM-DD */
  outboundDate: string;
  /** 计划归还日期 YYYY-MM-DD */
  expectedReturnDate: string;
  note: string;
  status: LoanStatus;
  items: LoanItem[];
  /**
   * 批次内字模 id 集合（多值索引，顶层冗余，便于按字模反查未结束批次）。
   * 与 items 中的 matrixId 保持一致，由批次操作自动维护。
   */
  matrixIds: string[];
  /**
   * 乐观锁版本号：每次保存 +1。
   * 两个标签页同时编辑时，后保存者若携带的版本与库中不一致即报版本冲突。
   * v4 之前的旧批次没有该字段，升级后进入「待复核」而不是自动完成。
   */
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
  /** 待复核原因（旧数据迁移 / 引用校验异常） */
  reviewReason: string;
}

export interface LoanBatchInput {
  code: string;
  exhibition: string;
  operator: string;
  outboundDate: string;
  expectedReturnDate: string;
  note: string;
}

/** 批次头信息校验 */
export function validateLoanInput(input: Partial<LoanBatchInput>): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!(input.code || '').trim()) errors.code = '批次编号不能为空';
  if (!(input.exhibition || '').trim()) errors.exhibition = '请填写巡展名称';
  if (!(input.operator || '').trim()) errors.operator = '请填写经办人';
  if (!(input.outboundDate || '').trim()) errors.outboundDate = '请选择出库日期';
  if (!(input.expectedReturnDate || '').trim()) {
    errors.expectedReturnDate = '请选择计划归还日期';
  } else if (input.outboundDate && input.expectedReturnDate && input.expectedReturnDate < input.outboundDate) {
    errors.expectedReturnDate = '归还日期不能早于出库日期';
  }
  return errors;
}

export interface LoanTargetProblem {
  matrixId: string;
  row: number;
  col: number;
  /** 冲突类型：未选目标字盘 / 越界 / 同批次格位重复 / 目标盘被占 / 引用不符 */
  kind: 'noCase' | 'outOfRange' | 'duplicate' | 'occupied' | 'staleRef';
  message: string;
}

/**
 * 目标格位编排的纯校验：容量边界、同批次内不重复、目标字盘现有格位引用关系。
 * items 本身不要求全部已安排（targetRow 为 null 的条目跳过），
 * 完成批次前用 {@link findUnassigned} 确认没有遗漏。
 */
export function validateLoanTargets(
  items: LoanItem[],
  targetCases: Map<string, TypeCase>,
): { problems: LoanTargetProblem[]; valid: boolean } {
  const problems: LoanTargetProblem[] = [];
  const seenKeys = new Map<string, string>(); // `${caseId}:r-c` → matrixId

  for (const item of items) {
    if (item.targetRow === null || item.targetCol === null) continue;
    const row = item.targetRow;
    const col = item.targetCol;
    const targetCase = targetCases.get(item.targetCaseId);
    if (!item.targetCaseId || !targetCase) {
      problems.push({ matrixId: item.matrixId, row, col, kind: 'noCase', message: `${item.matrixCode} 尚未选择目标字盘` });
      continue;
    }
    if (!isWithinBounds(row, col, targetCase.rows, targetCase.cols)) {
      problems.push({
        matrixId: item.matrixId,
        row,
        col,
        kind: 'outOfRange',
        message: `${item.matrixCode} 的目标格位 ${rcKey(row, col)} 超出 ${targetCase.code} 边界（${targetCase.rows} 行 × ${targetCase.cols} 列）`,
      });
      continue;
    }
    const key = `${item.targetCaseId}:${rcKey(row, col)}`;
    const prev = seenKeys.get(key);
    if (prev && prev !== item.matrixId) {
      problems.push({
        matrixId: item.matrixId,
        row,
        col,
        kind: 'duplicate',
        message: `${item.matrixCode} 与本批次另一枚字模争抢 ${targetCase.code} 的同一格位 ${rcKey(row, col)}`,
      });
    } else {
      seenKeys.set(key, item.matrixId);
    }
    const occupant = targetCase.slots.find((s) => s.row === row && s.col === col);
    // 同盘借调时，目标格若是本批正在腾出的原格位（格上现存字模属于批内另一条目），
    // 它会在同一事务里先取出，允许落位，不算引用冲突。
    const freedByBatch =
      occupant &&
      items.some(
        (it) =>
          it.sourceCaseId === item.targetCaseId &&
          it.sourceRow === row &&
          it.sourceCol === col &&
          it.matrixId === occupant.matrixId,
      );
    if (occupant && occupant.matrixId !== item.matrixId && !freedByBatch) {
      problems.push({
        matrixId: item.matrixId,
        row,
        col,
        kind: 'occupied',
        message: `${targetCase.code} 的 ${rcKey(row, col)} 已落位「${occupant.character}」（${occupant.matrixId}），不能重复落位`,
      });
    }
    // 引用关系：该格若已挂着同一字模，也必须与现有引用一致
    if (occupant && occupant.matrixId === item.matrixId && occupant.character !== item.character) {
      problems.push({
        matrixId: item.matrixId,
        row,
        col,
        kind: 'staleRef',
        message: `${targetCase.code} 的 ${rcKey(row, col)} 现存引用与字模 ${item.matrixCode} 不符`,
      });
    }
  }
  return { problems, valid: problems.length === 0 };
}

/** 尚未安排目标格位（或未选目标字盘）的条目 */
export function findUnassigned(items: LoanItem[]): LoanItem[] {
  return items.filter((it) => !it.targetCaseId || it.targetRow === null || it.targetCol === null);
}

/**
 * 容量复核：完成时目标字盘的最终落位数（现存 + 本批新增）不能超过容量。
 * 返回超容的目标字盘说明。
 */
export function checkTargetCapacity(
  items: LoanItem[],
  targetCases: Map<string, TypeCase>,
): string[] {
  const perCase = new Map<string, number>();
  for (const item of items) {
    if (!item.targetCaseId || item.targetRow === null) continue;
    perCase.set(item.targetCaseId, (perCase.get(item.targetCaseId) ?? 0) + 1);
  }
  const messages: string[] = [];
  perCase.forEach((added, caseId) => {
    const typeCase = targetCases.get(caseId);
    if (!typeCase) return;
    const incomingKeys = new Set(
      items
        .filter((it) => it.targetCaseId === caseId && it.targetRow !== null)
        .map((it) => rcKey(it.targetRow as number, it.targetCol as number)),
    );
    // 同盘借调时，本批从该盘取出的原格位也要腾出（按字模 id 去重，避免重复落位场景误算）
    const outgoingMatrixIds = new Set(
      items.filter((it) => it.sourceCaseId === caseId).map((it) => it.matrixId),
    );
    const keptExisting = typeCase.slots.filter((s) => {
      if (incomingKeys.has(rcKey(s.row, s.col))) return false;
      if (outgoingMatrixIds.has(s.matrixId)) return false;
      return true;
    }).length;
    const finalCount = keptExisting + incomingKeys.size;
    const cap = capacityOf(typeCase.rows, typeCase.cols);
    if (finalCount > cap) {
      messages.push(
        `${typeCase.code} 完成后将落位 ${finalCount} 格，超出容量 ${cap} 格（现存 ${typeCase.slots.length} 格，本批新增 ${added} 格）`,
      );
    }
  });
  return messages;
}

/** 建批候选：一枚字模当前的落位（取第一处作为原格位；多处落位给出提示由调用方决定） */
export function sourceSlotsOf(
  matrix: TypeMatrix,
  cases: TypeCase[],
): Array<{ typeCase: TypeCase; slot: CaseSlot }> {
  const out: Array<{ typeCase: TypeCase; slot: CaseSlot }> = [];
  for (const typeCase of cases) {
    for (const slot of typeCase.slots) {
      if (slot.matrixId === matrix.id) out.push({ typeCase, slot });
    }
  }
  return out;
}

/** 批次是否处于占用原格位 / 字模的状态 */
export function isOpenLoan(status: LoanStatus): boolean {
  return OPEN_LOAN_STATUSES.includes(status);
}

/** 批次是否允许编辑（待复核批次必须先取消或由复核处理，不允许直接改动） */
export function isEditableLoan(status: LoanStatus): boolean {
  return status === '进行中';
}

/** 批次明细数量 */
export function loanItemCount(batch: LoanBatch): number {
  return batch.items.length;
}

/** 已安排目标格位的明细数量 */
export function assignedCount(batch: LoanBatch): number {
  return batch.items.filter((it) => it.targetCaseId && it.targetRow !== null && it.targetCol !== null).length;
}
