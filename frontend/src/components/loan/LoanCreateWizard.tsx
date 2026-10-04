import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCaseStore } from '../../stores/caseStore';
import { LoanAssignmentError, useLoanStore } from '../../stores/loanStore';
import { useMatrixStore } from '../../stores/matrixStore';
import { useUiStore } from '../../stores/uiStore';
import type { LoanBatchInput } from '../../types/loan';
import { validateLoanInput } from '../../types/loan';
import { describeCapacity } from '../../types/case';
import { rcKey, slotAt } from '../../utils/layout';
import { addDays, suggestLoanCode, todayStr } from '../../utils/format';

interface PickedSelection {
  matrixId: string;
  sourceCaseId: string;
  sourceRow: number;
  sourceCol: number;
}

/** 建批向导：先填批次头信息，再按字盘格位点选字模（原格位由所点格位确定） */
export default function LoanCreateWizard({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const pushToast = useUiStore((s) => s.pushToast);
  const cases = useCaseStore((s) => s.cases);
  const matrices = useMatrixStore((s) => s.matrices);
  const loans = useLoanStore((s) => s.loans);
  const createLoan = useLoanStore((s) => s.createLoan);

  const [step, setStep] = useState<1 | 2>(1);
  const [selectedCaseId, setSelectedCaseId] = useState(cases[0]?.id ?? '');
  const [picked, setPicked] = useState<PickedSelection[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState({
    code: suggestLoanCode(todayStr(), 1),
    exhibition: '',
    operator: '',
    outboundDate: todayStr(),
    expectedReturnDate: addDays(todayStr(), 30),
    note: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!selectedCaseId && cases.length > 0) setSelectedCaseId(cases[0].id);
  }, [cases, selectedCaseId]);

  const selectedCase = useMemo(
    () => cases.find((c) => c.id === selectedCaseId) ?? cases[0],
    [cases, selectedCaseId],
  );

  const matrixById = useMemo(() => new Map(matrices.map((m) => [m.id, m])), [matrices]);
  const pickedMatrixIds = useMemo(() => new Set(picked.map((p) => p.matrixId)), [picked]);

  /** 已被其它未结束批次占用的格位（原格位不算可用，不能重复选） */
  const heldKeysByCase = useMemo(() => {
    const map = new Map<string, Set<string>>();
    loans
      .filter((l) => l.status === '进行中' || l.status === '待复核')
      .forEach((l) => {
        l.items.forEach((it) => {
          const set = map.get(it.sourceCaseId) ?? new Set<string>();
          set.add(rcKey(it.sourceRow, it.sourceCol));
          map.set(it.sourceCaseId, set);
        });
      });
    return map;
  }, [loans]);

  const togglePick = (row: number, col: number) => {
    if (!selectedCase) return;
    const slot = slotAt(selectedCase.slots, row, col);
    if (!slot) {
      pushToast('空格位无字模可选', 'warn');
      return;
    }
    const matrix = matrixById.get(slot.matrixId);
    const already = picked.find(
      (p) => p.sourceCaseId === selectedCase.id && p.sourceRow === row && p.sourceCol === col,
    );
    if (already) {
      setPicked((cur) => cur.filter((p) => p !== already));
      return;
    }
    if (pickedMatrixIds.has(slot.matrixId)) {
      pushToast(`字模 ${matrix?.code ?? slot.matrixId} 已在本批次选入`, 'warn');
      return;
    }
    if (matrix && matrix.availability !== '可用') {
      pushToast(`「${slot.character}」当前为${matrix.availability}，不能借调`, 'warn');
      return;
    }
    const held = heldKeysByCase.get(selectedCase.id);
    if (held?.has(rcKey(row, col))) {
      pushToast('该原格位已在其它未结束批次中借出', 'warn');
      return;
    }
    setPicked((cur) => [...cur, { matrixId: slot.matrixId, sourceCaseId: selectedCase.id, sourceRow: row, sourceCol: col }]);
  };

  const goStepTwo = (e: FormEvent) => {
    e.preventDefault();
    const next = validateLoanInput(form);
    setErrors(next);
    if (Object.keys(next).length > 0) {
      pushToast('批次信息未通过校验，请按提示修正', 'warn');
      return;
    }
    setStep(2);
  };

  const handleSubmit = async () => {
    if (picked.length === 0) {
      pushToast('请至少点选一枚字模', 'warn');
      return;
    }
    setSubmitting(true);
    try {
      const input: LoanBatchInput = { ...form };
      const selections = picked
        .map((p) => {
          const matrix = matrixById.get(p.matrixId);
          if (!matrix) return null;
          return { matrix, sourceCaseId: p.sourceCaseId, sourceRow: p.sourceRow, sourceCol: p.sourceCol };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      const row = await createLoan({ input, selections });
      pushToast(`批次 ${row.code} 已建立，${row.items.length} 枚字模原格位已冻结`);
      onClose();
      navigate(`/loans/${row.id}`);
    } catch (err) {
      pushToast(err instanceof LoanAssignmentError || err instanceof Error ? err.message : '建批失败', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink/40 p-4"
      data-testid="loan-create-modal"
      role="dialog"
      aria-modal="true"
    >
      <div className="mt-6 w-full max-w-4xl rounded-lg bg-paper shadow-card">
        <div className="flex items-center justify-between border-b border-paper-line px-5 py-3">
          <h3 className="font-song text-base font-semibold text-ink" data-testid="loan-wizard-title">
            新增借调批次 · 第 {step} / 2 步{step === 1 ? '：批次信息' : '：从字盘格位选入字模'}
          </h3>
          <button type="button" className="mt-btn-ghost" data-testid="loan-wizard-close" onClick={onClose}>
            ✕
          </button>
        </div>

        {step === 1 ? (
          <form className="grid grid-cols-1 gap-3 px-5 py-4 sm:grid-cols-2" onSubmit={goStepTwo}>
            <div>
              <label className="mt-label" htmlFor="loan-code">批次编号</label>
              <input
                id="loan-code"
                data-testid="loan-input-code"
                className="mt-input"
                value={form.code}
                onChange={(e) => setForm((p) => ({ ...p, code: e.target.value }))}
              />
              {errors.code ? <p className="mt-error">{errors.code}</p> : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="loan-exhibition">巡展名称</label>
              <input
                id="loan-exhibition"
                data-testid="loan-input-exhibition"
                className="mt-input"
                placeholder="例：活字千年巡展 · 江南站"
                value={form.exhibition}
                onChange={(e) => setForm((p) => ({ ...p, exhibition: e.target.value }))}
              />
              {errors.exhibition ? <p className="mt-error">{errors.exhibition}</p> : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="loan-operator">经办人</label>
              <input
                id="loan-operator"
                data-testid="loan-input-operator"
                className="mt-input"
                value={form.operator}
                onChange={(e) => setForm((p) => ({ ...p, operator: e.target.value }))}
              />
              {errors.operator ? <p className="mt-error">{errors.operator}</p> : null}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mt-label" htmlFor="loan-outbound">出库日期</label>
                <input
                  id="loan-outbound"
                  data-testid="loan-input-outbound"
                  type="date"
                  className="mt-input"
                  value={form.outboundDate}
                  onChange={(e) => setForm((p) => ({ ...p, outboundDate: e.target.value }))}
                />
                {errors.outboundDate ? <p className="mt-error">{errors.outboundDate}</p> : null}
              </div>
              <div>
                <label className="mt-label" htmlFor="loan-return">计划归还</label>
                <input
                  id="loan-return"
                  data-testid="loan-input-return"
                  type="date"
                  className="mt-input"
                  value={form.expectedReturnDate}
                  onChange={(e) => setForm((p) => ({ ...p, expectedReturnDate: e.target.value }))}
                />
                {errors.expectedReturnDate ? <p className="mt-error">{errors.expectedReturnDate}</p> : null}
              </div>
            </div>
            <div className="sm:col-span-2">
              <label className="mt-label" htmlFor="loan-note">备注</label>
              <input
                id="loan-note"
                data-testid="loan-input-note"
                className="mt-input"
                value={form.note}
                onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))}
              />
            </div>
            <div className="flex justify-end gap-2 sm:col-span-2">
              <button type="button" className="mt-btn" onClick={onClose}>取消</button>
              <button type="submit" className="mt-btn mt-btn-primary" data-testid="loan-to-step2">
                下一步：选字模
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-3 px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="mt-input max-w-xs"
                data-testid="loan-pick-case"
                value={selectedCase?.id ?? ''}
                onChange={(e) => setSelectedCaseId(e.target.value)}
              >
                {cases.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {c.kind} · {describeCapacity(c.rows, c.cols)} · 已落位 {c.slots.length}
                  </option>
                ))}
              </select>
              <span className="mt-chip border-brass/40 text-brass" data-testid="loan-pick-count">
                已选 {picked.length} 枚
              </span>
              <span className="mt-hint">点击格位加入 / 移出本批次；停用、待补刻与已借出的格位不可选</span>
            </div>

            {selectedCase ? (
              <div className="overflow-x-auto rounded border border-paper-line bg-white/60 p-3">
                <div
                  className="grid gap-1"
                  style={{ gridTemplateColumns: `28px repeat(${selectedCase.cols}, minmax(40px, 1fr))` }}
                  data-testid="loan-pick-grid"
                >
                  <div />
                  {Array.from({ length: selectedCase.cols }, (_, c) => (
                    <div key={`h-${c}`} className="text-center text-[10px] text-ink-mute">{c + 1}</div>
                  ))}
                  {Array.from({ length: selectedCase.rows }, (_, r) => (
                    <div key={`r-${r}`} className="contents">
                      <div className="flex h-10 items-center justify-center text-[11px] text-ink-mute">
                        {'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[r]}
                      </div>
                      {Array.from({ length: selectedCase.cols }, (_, c) => {
                        const slot = slotAt(selectedCase.slots, r, c);
                        const inBatch = picked.some(
                          (p) => p.sourceCaseId === selectedCase.id && p.sourceRow === r && p.sourceCol === c,
                        );
                        const m = slot ? matrixById.get(slot.matrixId) : undefined;
                        const unavailable = Boolean(m && m.availability !== '可用');
                        const held = heldKeysByCase.get(selectedCase.id)?.has(rcKey(r, c));
                        const selectable = Boolean(slot) && !unavailable && !held;
                        return (
                          <button
                            key={`${r}-${c}`}
                            type="button"
                            disabled={!selectable && !inBatch}
                            data-testid={`loan-pick-cell-${r}-${c}`}
                            data-filled={slot ? '1' : '0'}
                            data-picked={inBatch ? '1' : '0'}
                            title={
                              slot
                                ? `${slot.character} ${m?.code ?? ''}${m ? ` · ${m.availability}` : ''}${held ? ' · 已借出' : ''}`
                                : '空格'
                            }
                            onClick={() => togglePick(r, c)}
                            className={`flex h-10 flex-col items-center justify-center rounded border text-xs transition ${
                              inBatch
                                ? 'border-seal bg-seal text-paper'
                                : slot
                                  ? unavailable || held
                                    ? 'border-dashed border-paper-line bg-paper-deep/60 text-ink-mute'
                                    : 'border-ink/25 bg-white hover:border-seal'
                                  : 'border-dashed border-paper-line bg-paper/40 text-ink-mute/50'
                            }`}
                          >
                            <span className="font-song text-base leading-none">{slot?.character ?? '·'}</span>
                            {held && !inBatch ? <span className="text-[8px]">借出</span> : null}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-ink-mute">暂无字盘，请先到「字盘布局」建立字盘并落位。</p>
            )}

            {picked.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5" data-testid="loan-pick-list">
                {picked.map((p) => {
                  const m = matrixById.get(p.matrixId);
                  const c = cases.find((x) => x.id === p.sourceCaseId);
                  return (
                    <li key={`${p.sourceCaseId}-${rcKey(p.sourceRow, p.sourceCol)}`}>
                      <button
                        type="button"
                        className="mt-chip border-seal/50 text-seal"
                        title="点击移出"
                        onClick={() => setPicked((cur) => cur.filter((x) => x !== p))}
                      >
                        {m?.character} · {c?.code} {rcKey(p.sourceRow, p.sourceCol)} ✕
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}

            <div className="flex justify-between gap-2 border-t border-paper-line pt-3">
              <button type="button" className="mt-btn" onClick={() => setStep(1)}>
                上一步
              </button>
              <div className="flex gap-2">
                <button type="button" className="mt-btn" onClick={onClose}>取消</button>
                <button
                  type="button"
                  className="mt-btn mt-btn-primary"
                  data-testid="loan-submit-create"
                  disabled={submitting || picked.length === 0}
                  onClick={handleSubmit}
                >
                  {submitting ? '建批中…' : `建立批次（${picked.length} 枚）`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
