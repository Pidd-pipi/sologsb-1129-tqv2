import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import EmptyState from '../components/common/EmptyState';
import LoanCreateWizard from '../components/loan/LoanCreateWizard';
import {
  LoanAssignmentError,
  countLoanedOut,
  useLoanStore,
} from '../stores/loanStore';
import { useUiStore } from '../stores/uiStore';
import type { LoanBatch, LoanStatus } from '../types/loan';
import { LOAN_STATUSES } from '../types/loan';
import { formatDate, formatStamp } from '../utils/format';
import { rcKey } from '../utils/layout';

/** `/loans` 借调批次：总览统计 + 批次清单 + 建批入口 */
export default function LoanBoard() {
  const loans = useLoanStore((s) => s.loans);
  const loaded = useLoanStore((s) => s.loaded);
  const loading = useLoanStore((s) => s.loading);
  const loadLoans = useLoanStore((s) => s.load);
  const cancelLoan = useLoanStore((s) => s.cancelLoan);
  const resolveReview = useLoanStore((s) => s.resolveReview);
  const pushToast = useUiStore((s) => s.pushToast);

  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState<LoanStatus | ''>('');

  useEffect(() => {
    void loadLoans();
  }, [loadLoans]);

  const loanedOut = countLoanedOut(loans);
  const activeCount = loans.filter((l) => l.status === '进行中').length;
  const reviewCount = loans.filter((l) => l.status === '待复核').length;
  const finishedCount = loans.filter((l) => l.status === '已完成').length;

  const visible = useMemo(
    () => (statusFilter ? loans.filter((l) => l.status === statusFilter) : loans),
    [loans, statusFilter],
  );

  const handleCancel = async (id: string, version: number, code: string) => {
    try {
      await cancelLoan(id, version);
      pushToast(`批次 ${code} 已取消，字模恢复原可用性`, 'warn');
    } catch (err) {
      pushToast(err instanceof LoanAssignmentError || err instanceof Error ? err.message : '取消失败', 'error');
    }
  };

  const handleResolve = async (id: string, code: string) => {
    try {
      await resolveReview(id);
      pushToast(`批次 ${code} 复核通过，已恢复为进行中`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '复核失败', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="mt-title" data-testid="loan-title">
            巡展借调批次
          </h2>
          <p className="mt-sub">
            选入多枚字模建批，记录原格位与目标字盘；未结束批次的原格位不再算可用，同一字模不能同时留在两个批次。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2" data-testid="loan-stats">
          <span className="mt-chip border-brass/40 text-brass" data-testid="stat-loan-out">
            出库中 {loanedOut}
          </span>
          <span className="mt-chip" data-testid="stat-loan-active">
            进行中 {activeCount}
          </span>
          <span className="mt-chip border-seal/40 text-seal" data-testid="stat-loan-review">
            待复核 {reviewCount}
          </span>
          <span className="mt-chip border-jade/40 text-jade" data-testid="stat-loan-done">
            已完成 {finishedCount}
          </span>
          <button
            type="button"
            className="mt-btn mt-btn-primary"
            data-testid="loan-create-open"
            onClick={() => setShowCreate(true)}
          >
            新增借调批次
          </button>
        </div>
      </section>

      <section className="flex flex-wrap items-center gap-2" data-testid="loan-filter">
        <button
          type="button"
          className={`mt-btn ${statusFilter === '' ? 'border-seal text-seal' : ''}`}
          data-testid="loan-filter-all"
          onClick={() => setStatusFilter('')}
        >
          全部 {loans.length}
        </button>
        {LOAN_STATUSES.map((st) => (
          <button
            key={st}
            type="button"
            className={`mt-btn ${statusFilter === st ? 'border-seal text-seal' : ''}`}
            data-testid={`loan-filter-${st}`}
            onClick={() => setStatusFilter(st)}
          >
            {st} {loans.filter((l) => l.status === st).length}
          </button>
        ))}
      </section>

      {loading && !loaded ? (
        <div className="mt-panel px-4 py-6 text-sm text-ink-mute" data-testid="loan-loading">
          正在读取借调批次…
        </div>
      ) : null}

      {!loading && visible.length === 0 ? (
        <EmptyState
          title={loans.length === 0 ? '还没有借调批次' : '该状态下暂无批次'}
          description={
            loans.length === 0
              ? '点「新增借调批次」，从字盘格位选入字模，登记巡展与目标字盘。关页后未完成批次仍可继续编辑。'
              : '切换其它状态筛选查看。'
          }
          action={
            loans.length === 0 ? (
              <button type="button" className="mt-btn mt-btn-primary" onClick={() => setShowCreate(true)}>
                新增借调批次
              </button>
            ) : undefined
          }
          testId="loan-empty"
        />
      ) : (
        <section className="space-y-3" data-testid="loan-list">
          {visible.map((loan) => (
            <LoanCard
              key={loan.id}
              loan={loan}
              onCancel={() => handleCancel(loan.id, loan.version, loan.code)}
              onResolve={() => handleResolve(loan.id, loan.code)}
            />
          ))}
        </section>
      )}

      {showCreate ? <LoanCreateWizard onClose={() => setShowCreate(false)} /> : null}
    </div>
  );
}

const STATUS_STYLE: Record<LoanStatus, string> = {
  进行中: 'border-brass/50 bg-brass-pale text-brass',
  待复核: 'border-seal/50 bg-seal-pale text-seal',
  已完成: 'border-jade/50 bg-jade-pale text-jade',
  已取消: 'border-paper-line bg-paper/60 text-ink-mute',
};

function LoanCard({
  loan,
  onCancel,
  onResolve,
}: {
  loan: LoanBatch;
  onCancel: () => void;
  onResolve: () => void;
}) {
  const open = loan.status === '进行中' || loan.status === '待复核';
  const assigned = loan.items.filter((it) => it.targetCaseId && it.targetRow !== null).length;
  return (
    <article className="mt-panel" data-testid={`loan-card-${loan.id}`}>
      <div className="mt-panel-head">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-song text-sm font-semibold text-ink" data-testid={`loan-code-${loan.id}`}>
            {loan.code}
          </span>
          <span className={`mt-chip ${STATUS_STYLE[loan.status]}`} data-testid={`loan-status-${loan.id}`}>
            {loan.status}
          </span>
          <span className="text-xs text-ink-mute">{loan.exhibition}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mt-sub" data-testid={`loan-version-${loan.id}`}>
            版本 v{loan.version}
          </span>
          {open ? (
            <Link className="mt-btn mt-btn-primary" to={`/loans/${loan.id}`} data-testid={`loan-edit-${loan.id}`}>
              {loan.status === '待复核' ? '查看 / 复核' : '继续编排'}
            </Link>
          ) : (
            <Link className="mt-btn" to={`/loans/${loan.id}`} data-testid={`loan-view-${loan.id}`}>
              查看明细
            </Link>
          )}
          {loan.status === '待复核' ? (
            <button type="button" className="mt-btn" data-testid={`loan-resolve-${loan.id}`} onClick={onResolve}>
              复核通过
            </button>
          ) : null}
          {open ? (
            <button type="button" className="mt-btn" data-testid={`loan-cancel-${loan.id}`} onClick={onCancel}>
              取消批次
            </button>
          ) : null}
        </div>
      </div>

      {loan.status === '待复核' ? (
        <div className="border-b border-seal/30 bg-seal-pale/60 px-4 py-2 text-xs text-seal" data-testid={`loan-review-reason-${loan.id}`}>
          旧数据升级后缺少版本字段，批次已进入待复核，不会自动完成。请核对原格位与字模引用后点「复核通过」，或取消批次重建。
          {loan.reviewReason ? `（${loan.reviewReason}）` : ''}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 px-4 py-3 text-xs text-ink-soft md:grid-cols-3">
        <p>经办人：{loan.operator}</p>
        <p>
          出库 {formatDate(loan.outboundDate)} · 计划归还 {formatDate(loan.expectedReturnDate)}
        </p>
        <p>
          字模 {loan.items.length} 枚 · 已排目标格位 {assigned}/{loan.items.length}
        </p>
        <p className="md:col-span-2">
          原格位：
          {loan.items.slice(0, 4).map((it) => `${it.sourceCaseCode} ${rcKey(it.sourceRow, it.sourceCol)}`).join('、')}
          {loan.items.length > 4 ? ' 等' : ''}
        </p>
        <p>
          {loan.completedAt ? `完成于 ${formatStamp(loan.completedAt)}` : `更新于 ${formatStamp(loan.updatedAt)}`}
        </p>
        {loan.note ? <p className="md:col-span-3 text-ink-mute">备注：{loan.note}</p> : null}
      </div>
    </article>
  );
}
