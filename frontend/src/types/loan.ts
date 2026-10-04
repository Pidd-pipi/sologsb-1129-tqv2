/** 借调批次（LoanBatch）：一批字模借去巡展的借调记录 */

import type { MatrixAvailability } from './matrix';

/** 借调状态 */
export const LOAN_STATUSES = ['待复核', '进行中', '已完成', '已取消'] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

/** 借调明细：一枚字模的借调信息 */
export interface LoanItem {
  /** 字模 id */
  matrixId: string;
  /** 字符（冗余，便于展示） */
  character: string;
  /** 字模编号（冗余） */
  matrixCode: string;
  /** 原字盘 id */
  fromCaseId: string;
  /** 原字盘编号（冗余） */
  fromCaseCode: string;
  /** 原格位行（0 基） */
  fromRow: number;
  /** 原格位列（0 基） */
  fromCol: number;
  /** 目标字盘 id */
  toCaseId: string;
  /** 目标字盘编号（冗余） */
  toCaseCode: string;
  /** 目标格位行（分配后填写，0 基） */
  toRow: number | null;
  /** 目标格位列（分配后填写，0 基） */
  toCol: number | null;
  /** 借出时字模的可用性快照（取消时恢复） */
  availabilitySnapshot: MatrixAvailability;
}

export interface LoanBatch {
  id: string;
  /** 批次编号，例：LOAN-2026-001 */
  code: string;
  /** 展览名称 */
  exhibitionName: string;
  /** 借出日期 YYYY-MM-DD */
  loanDate: string;
  /** 预计归还日期 YYYY-MM-DD */
  expectedReturnDate: string;
  /** 状态：待复核 / 进行中 / 已完成 / 已取消 */
  status: LoanStatus;
  /** 借调明细 */
  items: LoanItem[];
  /** 版本号（乐观锁，防止多标签页同时修改覆盖） */
  version: number;
  /** 登记人 */
  operator: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  /** 完成时间 */
  completedAt: string | null;
}

export interface LoanItemInput {
  matrixId: string;
  toCaseId: string;
}

export interface LoanBatchInput {
  exhibitionName: string;
  loanDate: string;
  expectedReturnDate: string;
  operator: string;
  note?: string;
  items: LoanItemInput[];
}

/** 借调批次表单校验 */
export function validateLoanBatchInput(input: Partial<LoanBatchInput>): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!(input.exhibitionName || '').trim()) errors.exhibitionName = '请填写展览名称';
  const loanDate = (input.loanDate || '').trim();
  if (!loanDate) errors.loanDate = '请填写借出日期';
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(loanDate)) errors.loanDate = '日期格式需为 YYYY-MM-DD';
  const returnDate = (input.expectedReturnDate || '').trim();
  if (!returnDate) errors.expectedReturnDate = '请填写预计归还日期';
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(returnDate))
    errors.expectedReturnDate = '日期格式需为 YYYY-MM-DD';
  if (!(input.operator || '').trim()) errors.operator = '请填写登记人';
  if (!input.items || input.items.length === 0) errors.items = '请至少选入一枚字模';
  return errors;
}

/** 生成借调批次编号建议，例：LOAN-2026-001 */
export function suggestLoanCode(year: number, seq: number): string {
  return `LOAN-${year}-${`${seq}`.padStart(3, '0')}`;
}

/** 借调状态对应的样式（用于标签） */
export const LOAN_STATUS_STYLE: Record<LoanStatus, string> = {
  待复核: 'border-brass/50 bg-brass-pale text-brass',
  进行中: 'border-seal/50 bg-seal-pale text-seal',
  已完成: 'border-jade/50 bg-jade-pale text-jade',
  已取消: 'border-paper-line bg-paper text-ink-mute',
};
