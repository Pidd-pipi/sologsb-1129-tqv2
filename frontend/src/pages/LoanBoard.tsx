import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import EmptyState from '../components/common/EmptyState';
import LayoutGrid from '../components/common/LayoutGrid';
import { useCaseStore } from '../stores/caseStore';
import { useLoanStore, LoanConflictError } from '../stores/loanStore';
import { useMatrixStore } from '../stores/matrixStore';
import { useUiStore } from '../stores/uiStore';
import {
  LOAN_STATUS_STYLE,
  validateLoanBatchInput,
  type LoanBatch,
  type LoanBatchInput,
  type LoanItem,
  type LoanStatus,
} from '../types/loan';
import { capacityOf } from '../types/case';
import { dash, formatStamp, todayStr } from '../utils/format';

/** `/loans` 借调批次：选入字模、记录原格位与目标字盘、分配目标格位、完成批次同步 */
export default function LoanBoard() {
  const loans = useLoanStore((s) => s.loans);
  const loaded = useLoanStore((s) => s.loaded);
  const load = useLoanStore((s) => s.load);
  const error = useLoanStore((s) => s.error);
  const createBatch = useLoanStore((s) => s.createBatch);
  const completeBatch = useLoanStore((s) => s.completeBatch);
  const cancelBatch = useLoanStore((s) => s.cancelBatch);
  const confirmBatch = useLoanStore((s) => s.confirmBatch);
  const matrices = useMatrixStore((s) => s.matrices);
  const cases = useCaseStore((s) => s.cases);
  const pushToast = useUiStore((s) => s.pushToast);

  const [showCreate, setShowCreate] = useState(false);
  const [selectedLoanId, setSelectedLoanId] = useState<string>('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    void load();
  }, [load]);

  const selectedLoan = useMemo(
    () => loans.find((l) => l.id === selectedLoanId) ?? loans[0],
    [loans, selectedLoanId],
  );

  const activeLoans = loans.filter((l) => l.status === '进行中' || l.status === '待复核');
  const finishedLoans = loans.filter((l) => l.status === '已完成' || l.status === '已取消');

  const handleCreate = async (input: Partial<LoanBatchInput>) => {
    const next = validateLoanBatchInput(input);
    setErrors(next);
    if (Object.keys(next).length > 0) {
      pushToast('借调批次未通过校验，请按提示修正', 'warn');
      return;
    }
    try {
      const row = await createBatch(input as LoanBatchInput);
      pushToast(`已创建借调批次 ${row.code}（${row.items.length} 枚字模）`);
      setShowCreate(false);
      setSelectedLoanId(row.id);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '创建借调批次失败', 'error');
    }
  };

  const handleComplete = async (loan: LoanBatch) => {
    try {
      await completeBatch(loan.id, loan.version);
      pushToast(`批次 ${loan.code} 已完成，字模已调入目标字盘`);
    } catch (err) {
      if (err instanceof LoanConflictError) {
        pushToast(err.message, 'error');
        void load();
      } else {
        pushToast(err instanceof Error ? err.message : '完成批次失败', 'error');
      }
    }
  };

  const handleCancel = async (loan: LoanBatch) => {
    try {
      await cancelBatch(loan.id, loan.version);
      pushToast(`批次 ${loan.code} 已取消，字模恢复可用`, 'warn');
    } catch (err) {
      if (err instanceof LoanConflictError) {
        pushToast(err.message, 'error');
        void load();
      } else {
        pushToast(err instanceof Error ? err.message : '取消批次失败', 'error');
      }
    }
  };

  const handleConfirm = async (loan: LoanBatch) => {
    try {
      await confirmBatch(loan.id, loan.version);
      pushToast(`批次 ${loan.code} 已确认复核，转为进行中`);
    } catch (err) {
      if (err instanceof LoanConflictError) {
        pushToast(err.message, 'error');
        void load();
      } else {
        pushToast(err instanceof Error ? err.message : '确认复核失败', 'error');
      }
    }
  };

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="mt-title" data-testid="loan-board-title">
            借调批次
          </h2>
          <p className="mt-sub">
            选入多枚字模并记录原格位与目标字盘；建批后原格位不再算可用，同一字模不能同时留在两个未结束批次。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="mt-chip" data-testid="loan-active-count">
            进行中 {activeLoans.length}
          </span>
          <span className="mt-chip border-jade/40 text-jade" data-testid="loan-finished-count">
            已结束 {finishedLoans.length}
          </span>
          <button
            type="button"
            className="mt-btn mt-btn-primary"
            data-testid="loan-create-toggle"
            onClick={() => setShowCreate((v) => !v)}
          >
            {showCreate ? '收起新建表单' : '新建借调批次'}
          </button>
        </div>
      </section>

      {showCreate ? (
        <CreateLoanForm
          matrices={matrices}
          cases={cases}
          errors={errors}
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
        />
      ) : null}

      {error ? (
        <div className="rounded border border-seal/40 bg-seal-pale px-3 py-2 text-sm text-seal" data-testid="loan-error">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[320px_1fr]">
        <aside className="space-y-3">
          <div className="mt-panel">
            <div className="mt-panel-head">
              <h3 className="font-song text-sm font-semibold text-ink">批次清单</h3>
            </div>
            <ul className="divide-y divide-paper-line" data-testid="loan-list">
              {loans.length === 0 ? (
                <li className="px-4 py-3 text-xs text-ink-mute">
                  {loaded ? '暂无借调批次，请新建。' : '正在读取借调档案…'}
                </li>
              ) : (
                loans.map((loan) => (
                  <li key={loan.id}>
                    <button
                      type="button"
                      data-testid={`loan-item-${loan.id}`}
                      onClick={() => setSelectedLoanId(loan.id)}
                      className={`flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left transition hover:bg-paper-deep/60 ${
                        selectedLoan?.id === loan.id ? 'bg-seal-pale/70' : ''
                      }`}
                    >
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="font-song text-sm text-ink">{loan.code}</span>
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10px] ${LOAN_STATUS_STYLE[loan.status]}`}
                        >
                          {loan.status}
                        </span>
                      </span>
                      <span className="text-[11px] text-ink-mute">
                        {loan.exhibitionName} · {loan.items.length} 枚 · {loan.loanDate}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </aside>

        {selectedLoan ? (
          <LoanDetail
            key={selectedLoan.id}
            loan={selectedLoan}
            cases={cases}
            onComplete={() => handleComplete(selectedLoan)}
            onCancel={() => handleCancel(selectedLoan)}
            onConfirm={() => handleConfirm(selectedLoan)}
          />
        ) : (
          <EmptyState
            title="尚未选择借调批次"
            description="在左侧清单中选择一个批次查看详情，或新建一个借调批次。"
            testId="loan-empty"
          />
        )}
      </div>
    </div>
  );
}

interface CreateLoanFormProps {
  matrices: ReturnType<typeof useMatrixStore.getState>['matrices'];
  cases: ReturnType<typeof useCaseStore.getState>['cases'];
  errors: Record<string, string>;
  onSubmit: (input: Partial<LoanBatchInput>) => void;
  onCancel: () => void;
}

function CreateLoanForm({ matrices, cases, errors, onSubmit, onCancel }: CreateLoanFormProps) {
  const [exhibitionName, setExhibitionName] = useState('');
  const [loanDate, setLoanDate] = useState(todayStr());
  const [expectedReturnDate, setExpectedReturnDate] = useState('');
  const [operator, setOperator] = useState('');
  const [note, setNote] = useState('');
  const [selectedMatrixIds, setSelectedMatrixIds] = useState<Set<string>>(new Set());
  const [targetCaseId, setTargetCaseId] = useState('');

  const availableMatrices = useMemo(
    () => matrices.filter((m) => m.availability === '可用'),
    [matrices],
  );

  const toggleMatrix = (id: string) => {
    setSelectedMatrixIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (selectedMatrixIds.size === 0) {
      onSubmit({ exhibitionName, loanDate, expectedReturnDate, operator, note, items: [] });
      return;
    }
    if (!targetCaseId) {
      onSubmit({ exhibitionName, loanDate, expectedReturnDate, operator, note, items: [] });
      return;
    }
    const items = Array.from(selectedMatrixIds).map((matrixId) => ({
      matrixId,
      toCaseId: targetCaseId,
    }));
    onSubmit({ exhibitionName, loanDate, expectedReturnDate, operator, note, items });
  };

  return (
    <form className="mt-panel space-y-3 px-4 py-4" onSubmit={handleSubmit} data-testid="loan-create-form">
      <h3 className="font-song text-sm font-semibold text-ink">新建借调批次</h3>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="mt-label" htmlFor="loan-exhibition">
            展览名称
          </label>
          <input
            id="loan-exhibition"
            data-testid="loan-exhibition"
            className="mt-input"
            placeholder="例：活字印刷文化展"
            value={exhibitionName}
            onChange={(e) => setExhibitionName(e.target.value)}
          />
          {errors.exhibitionName ? <p className="mt-error">{errors.exhibitionName}</p> : null}
        </div>
        <div>
          <label className="mt-label" htmlFor="loan-operator">
            登记人
          </label>
          <input
            id="loan-operator"
            data-testid="loan-operator"
            className="mt-input"
            placeholder="例：陈之安"
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
          />
          {errors.operator ? <p className="mt-error">{errors.operator}</p> : null}
        </div>
        <div>
          <label className="mt-label" htmlFor="loan-date">
            借出日期
          </label>
          <input
            id="loan-date"
            data-testid="loan-date"
            type="date"
            className="mt-input"
            value={loanDate}
            onChange={(e) => setLoanDate(e.target.value)}
          />
          {errors.loanDate ? <p className="mt-error">{errors.loanDate}</p> : null}
        </div>
        <div>
          <label className="mt-label" htmlFor="loan-return-date">
            预计归还日期
          </label>
          <input
            id="loan-return-date"
            data-testid="loan-return-date"
            type="date"
            className="mt-input"
            value={expectedReturnDate}
            onChange={(e) => setExpectedReturnDate(e.target.value)}
          />
          {errors.expectedReturnDate ? <p className="mt-error">{errors.expectedReturnDate}</p> : null}
        </div>
      </div>

      <div>
        <label className="mt-label">选入字模（已选 {selectedMatrixIds.size} 枚）</label>
        {errors.items ? <p className="mt-error">{errors.items}</p> : null}
        <div className="mt-1 max-h-48 overflow-y-auto rounded border border-paper-line bg-paper/40 p-2">
          {availableMatrices.length === 0 ? (
            <p className="text-[11px] text-ink-mute">当前没有可用字模。</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {availableMatrices.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  data-testid={`loan-matrix-option-${m.id}`}
                  onClick={() => toggleMatrix(m.id)}
                  className={`rounded border px-2 py-1 text-[11px] transition ${
                    selectedMatrixIds.has(m.id)
                      ? 'border-seal bg-seal text-paper'
                      : 'border-paper-line bg-white text-ink-soft hover:border-seal'
                  }`}
                >
                  {m.character} · {m.code} · {m.sizeName}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div>
        <label className="mt-label" htmlFor="loan-target-case">
          目标字盘
        </label>
        <select
          id="loan-target-case"
          data-testid="loan-target-case"
          className="mt-input"
          value={targetCaseId}
          onChange={(e) => setTargetCaseId(e.target.value)}
        >
          <option value="">请选择目标字盘</option>
          {cases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} · {c.kind} · 容量 {capacityOf(c.rows, c.cols)} 格 · 已落位 {c.slots.length} 格
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mt-label" htmlFor="loan-note">
          备注
        </label>
        <input
          id="loan-note"
          data-testid="loan-note"
          className="mt-input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="submit" className="mt-btn mt-btn-primary" data-testid="loan-create-submit">
          创建批次
        </button>
        <button type="button" className="mt-btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

interface LoanDetailProps {
  loan: LoanBatch;
  cases: ReturnType<typeof useCaseStore.getState>['cases'];
  onComplete: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function LoanDetail({ loan, cases, onComplete, onCancel, onConfirm }: LoanDetailProps) {
  const allocateSlots = useLoanStore((s) => s.allocateSlots);
  const pushToast = useUiStore((s) => s.pushToast);
  const [allocations, setAllocations] = useState<Record<string, { row: number; col: number }>>(() => {
    const init: Record<string, { row: number; col: number }> = {};
    for (const item of loan.items) {
      if (item.toRow !== null && item.toCol !== null) {
        init[item.matrixId] = { row: item.toRow, col: item.toCol };
      }
    }
    return init;
  });
  const [saving, setSaving] = useState(false);

  const targetCase = cases.find((c) => c.id === loan.items[0]?.toCaseId);
  const canAllocate = loan.status === '进行中' && targetCase;
  const allAllocated = loan.items.every(
    (i) => i.toRow !== null && i.toCol !== null,
  );

  const handleSlotClick = (row: number, col: number) => {
    if (!canAllocate) return;
    // 找到第一个未分配的字模
    const unallocated = loan.items.find((i) => !(i.matrixId in allocations));
    if (!unallocated) {
      pushToast('所有字模已分配格位', 'warn');
      return;
    }
    // 检查该格位是否已被分配
    const existing = Object.entries(allocations).find(
      ([, pos]) => pos.row === row && pos.col === col,
    );
    if (existing) {
      pushToast('该格位已被分配', 'warn');
      return;
    }
    setAllocations((prev) => ({
      ...prev,
      [unallocated.matrixId]: { row, col },
    }));
  };

  const handleSaveAllocations = async () => {
    if (!canAllocate) return;
    const allocationList = Object.entries(allocations).map(([matrixId, pos]) => ({
      matrixId,
      toRow: pos.row,
      toCol: pos.col,
    }));
    setSaving(true);
    try {
      await allocateSlots(loan.id, allocationList, loan.version);
      pushToast('目标格位已保存');
    } catch (err) {
      if (err instanceof LoanConflictError) {
        pushToast(err.message, 'error');
        void useLoanStore.getState().load();
      } else {
        pushToast(err instanceof Error ? err.message : '保存格位失败', 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  // 构建目标字盘的预览 slots（含已分配的借调字模）
  const previewSlots = useMemo(() => {
    if (!targetCase) return [];
    const slots = [...targetCase.slots];
    for (const item of loan.items) {
      const pos = allocations[item.matrixId];
      if (pos) {
        // 移除该格位已有内容（如果是同一字模）
        const idx = slots.findIndex((s) => s.row === pos.row && s.col === pos.col);
        if (idx >= 0 && slots[idx].matrixId === item.matrixId) {
          slots[idx] = { ...slots[idx], character: item.character };
        } else if (idx < 0) {
          slots.push({
            row: pos.row,
            col: pos.col,
            character: item.character,
            matrixId: item.matrixId,
            placedAt: '',
          });
        }
      }
    }
    return slots.sort((a, b) => a.row - b.row || a.col - b.col);
  }, [targetCase, loan.items, allocations]);

  return (
    <section className="space-y-3">
      <div className="mt-panel">
        <div className="mt-panel-head">
          <div>
            <h3 className="font-song text-sm font-semibold text-ink">
              {loan.code} · {loan.exhibitionName}
            </h3>
            <p className="mt-sub">
              借出 {loan.loanDate} · 预计归还 {loan.expectedReturnDate} · 登记人 {dash(loan.operator)} ·
              版本 {loan.version}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2 py-0.5 text-[11px] ${LOAN_STATUS_STYLE[loan.status]}`}>
              {loan.status}
            </span>
            {loan.status === '待复核' ? (
              <>
                <button
                  type="button"
                  className="mt-btn mt-btn-primary"
                  data-testid="loan-confirm-btn"
                  onClick={onConfirm}
                >
                  确认复核
                </button>
                <button type="button" className="mt-btn" data-testid="loan-cancel-btn" onClick={onCancel}>
                  取消批次
                </button>
              </>
            ) : null}
            {loan.status === '进行中' ? (
              <>
                <button
                  type="button"
                  className="mt-btn mt-btn-primary"
                  data-testid="loan-complete-btn"
                  onClick={onComplete}
                  disabled={!allAllocated}
                >
                  完成批次
                </button>
                <button type="button" className="mt-btn" data-testid="loan-cancel-btn" onClick={onCancel}>
                  取消批次
                </button>
              </>
            ) : null}
          </div>
        </div>

        {loan.note ? (
          <div className="border-b border-paper-line px-4 py-2 text-xs text-ink-mute">
            备注：{loan.note}
          </div>
        ) : null}

        <div className="px-4 py-3">
          <h4 className="mb-2 font-song text-sm font-semibold text-ink">借调明细（{loan.items.length} 枚）</h4>
          <div className="overflow-x-auto">
            <table className="min-w-full" data-testid="loan-items-table">
              <thead className="border-b border-paper-line bg-paper/60">
                <tr>
                  <th className="mt-th">字模</th>
                  <th className="mt-th">原格位</th>
                  <th className="mt-th">原字盘</th>
                  <th className="mt-th">目标字盘</th>
                  <th className="mt-th">目标格位</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-paper-line">
                {loan.items.map((item) => (
                  <LoanItemRow key={item.matrixId} item={item} cases={cases} />
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {canAllocate && targetCase ? (
          <div className="border-t border-paper-line px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="font-song text-sm font-semibold text-ink">分配目标格位</h4>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="mt-btn mt-btn-primary"
                  data-testid="loan-save-slots-btn"
                  onClick={handleSaveAllocations}
                  disabled={saving}
                >
                  {saving ? '保存中…' : '保存格位分配'}
                </button>
              </div>
            </div>
            <p className="mb-2 text-[11px] text-ink-mute">
              点击下方网格为字模分配目标格位（按顺序分配）。目标字盘：{targetCase.code}（容量{' '}
              {capacityOf(targetCase.rows, targetCase.cols)} 格）
            </p>
            <LayoutGrid
              rows={targetCase.rows}
              cols={targetCase.cols}
              slots={previewSlots}
              onSlotClick={handleSlotClick}
              testIdPrefix="loan-target-slot"
            />
            <div className="mt-2 flex flex-wrap gap-1">
              {loan.items.map((item) => {
                const pos = allocations[item.matrixId];
                return (
                  <span
                    key={item.matrixId}
                    className={`rounded border px-2 py-0.5 text-[10px] ${
                      pos
                        ? 'border-jade/40 bg-jade-pale text-jade'
                        : 'border-paper-line bg-paper text-ink-mute'
                    }`}
                  >
                    {item.character}
                    {pos ? ` → ${pos.row + 1}-${pos.col + 1}` : ' 未分配'}
                  </span>
                );
              })}
            </div>
          </div>
        ) : null}

        {loan.status === '已完成' && loan.completedAt ? (
          <div className="border-t border-paper-line px-4 py-2 text-[11px] text-ink-mute">
            完成时间：{formatStamp(loan.completedAt)}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function LoanItemRow({ item, cases }: { item: LoanItem; cases: ReturnType<typeof useCaseStore.getState>['cases'] }) {
  const fromCase = cases.find((c) => c.id === item.fromCaseId);
  return (
    <tr data-testid={`loan-item-${item.matrixId}`}>
      <td className="mt-td">
        <Link className="font-song text-base text-ink hover:text-seal" to={`/matrices/${item.matrixId}`}>
          {item.character}
        </Link>
        <div className="text-[11px] text-ink-mute">{item.matrixCode}</div>
      </td>
      <td className="mt-td">
        {String.fromCharCode(65 + item.fromRow)}
        {item.fromCol + 1}
      </td>
      <td className="mt-td">{fromCase?.code ?? item.fromCaseCode}</td>
      <td className="mt-td">{item.toCaseCode}</td>
      <td className="mt-td">
        {item.toRow !== null && item.toCol !== null
          ? `${String.fromCharCode(65 + item.toRow)}${item.toCol + 1}`
          : '未分配'}
      </td>
    </tr>
  );
}
