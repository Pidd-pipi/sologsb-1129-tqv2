import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import EmptyState from '../components/common/EmptyState';
import { useCaseStore } from '../stores/caseStore';
import { useLoanEditor } from '../hooks/useLoanEditor';
import { LoanVersionConflictError, useLoanStore } from '../stores/loanStore';
import { useMatrixStore } from '../stores/matrixStore';
import { useUiStore } from '../stores/uiStore';
import { describeCapacity } from '../types/case';
import type { LoanItem } from '../types/loan';
import { formatDate, formatStamp } from '../utils/format';
import { rcKey } from '../utils/layout';

/** `/loans/:id` 批次详情：目标格位编排、乐观锁版本冲突提示、完成 / 取消 / 复核 */
export default function LoanDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const loans = useLoanStore((s) => s.loans);
  const loaded = useLoanStore((s) => s.loaded);
  const loadLoans = useLoanStore((s) => s.load);
  const cancelLoan = useLoanStore((s) => s.cancelLoan);
  const resolveReview = useLoanStore((s) => s.resolveReview);
  const cases = useCaseStore((s) => s.cases);
  const loadCases = useCaseStore((s) => s.load);
  const loadMatrices = useMatrixStore((s) => s.load);
  const matrices = useMatrixStore((s) => s.matrices);
  const pushToast = useUiStore((s) => s.pushToast);

  useEffect(() => {
    void loadLoans();
    void loadCases();
    void loadMatrices();
  }, [loadLoans, loadCases, loadMatrices]);

  const batch = loans.find((l) => l.id === id);

  if (!batch) {
    return (
      <EmptyState
        title={loaded ? '没有找到这个批次' : '正在读取借调批次…'}
        description={loaded ? '该批次可能已被删除，可返回批次列表。' : '请稍候。'}
        action={<Link className="mt-btn" to="/loans">返回批次列表</Link>}
        testId="loan-not-found"
      />
    );
  }

  return (
    <LoanDetailInner
      key={batch.id}
      batch={batch}
      cases={cases}
      matrices={matrices}
      onCancel={async () => {
        try {
          await cancelLoan(batch.id, batch.version);
          pushToast('批次已取消，字模恢复原可用性', 'warn');
        } catch (err) {
          pushToast(err instanceof LoanVersionConflictError ? err.message : err instanceof Error ? err.message : '取消失败', 'error');
        }
      }}
      onResolve={async () => {
        try {
          await resolveReview(batch.id);
          pushToast('复核通过，批次恢复为进行中');
        } catch (err) {
          pushToast(err instanceof Error ? err.message : '复核失败', 'error');
        }
      }}
      pushToast={pushToast}
    />
  );
}

function LoanDetailInner({
  batch,
  cases,
  matrices,
  onCancel,
  onResolve,
  pushToast,
}: {
  batch: import('../types/loan').LoanBatch;
  cases: import('../types/case').TypeCase[];
  matrices: import('../types/matrix').TypeMatrix[];
  onCancel: () => void;
  onResolve: () => void;
  pushToast: ReturnType<typeof useUiStore.getState>['pushToast'];
}) {
  const editor = useLoanEditor(batch);
  const [activeCaseId, setActiveCaseId] = useState(editor.items[0]?.targetCaseId || cases[0]?.id || '');
  /** 当前在目标网格上分配格位的明细 */
  const [activeMatrixId, setActiveMatrixId] = useState(editor.items[0]?.matrixId ?? '');
  const readOnly = batch.status !== '进行中';

  const caseMap = useMemo(() => new Map(cases.map((c) => [c.id, c])), [cases]);
  const problemMatrixIds = useMemo(() => new Set(editor.problems.map((p) => p.matrixId)), [editor.problems]);
  const problemByMatrix = useMemo(
    () => new Map(editor.problems.map((p) => [p.matrixId, p.message])),
    [editor.problems],
  );

  const handleSave = async () => {
    const r = await editor.save();
    if (r.ok) pushToast(`批次已保存（版本 v${r.batch.version}）`);
    else if (!r.conflict) pushToast(r.message, 'error');
  };
  const handleComplete = async () => {
    const r = await editor.complete();
    if (r.ok) {
      pushToast(`批次 ${r.batch.code} 已完成：目标字盘已落位，原格位已取出，字模与统计已同步`);
    } else if (!r.conflict) {
      pushToast(r.message, 'error');
    }
  };

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="mt-title" data-testid="loan-detail-title">
            借调批次 · {batch.code}
          </h2>
          <p className="mt-sub">{batch.exhibition} · 经办人 {batch.operator}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mt-chip" data-testid="loan-detail-status">{batch.status}</span>
          <span className="mt-chip" data-testid="loan-detail-version">库版本 v{batch.version}（本页基于 v{editor.baseVersion}）</span>
          <Link className="mt-btn" to="/loans" data-testid="loan-detail-back">返回列表</Link>
        </div>
      </section>

      {editor.conflictMessage ? (
        <div className="rounded border border-seal/50 bg-seal-pale px-4 py-3 text-sm text-seal" data-testid="loan-conflict-banner">
          <p className="font-semibold">版本冲突：{editor.conflictMessage}</p>
          <p className="mt-1 text-xs">
            另一标签页已保存到 v{editor.newerVersion}。为避免覆盖对方结果，本页保存已被拒绝。
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className="mt-btn" data-testid="loan-adopt-latest" onClick={editor.adoptLatest}>
              放弃本页改动，载入最新版本
            </button>
          </div>
        </div>
      ) : null}

      {batch.status === '待复核' ? (
        <div className="rounded border border-seal/50 bg-seal-pale px-4 py-3 text-sm text-seal" data-testid="loan-review-banner">
          该批次由旧版数据升级而来，缺少版本字段，已进入待复核且不会自动完成。
          {batch.reviewReason ? `原因：${batch.reviewReason}` : ''}
          核对下方原格位引用无误后可「复核通过」；引用已失效则取消批次重建。
        </div>
      ) : null}

      <section className="mt-panel">
        <div className="mt-panel-head">
          <h3 className="font-song text-sm font-semibold text-ink">批次信息</h3>
          <span className="mt-sub">出库 {formatDate(batch.outboundDate)} · 归还 {formatDate(batch.expectedReturnDate)}</span>
        </div>
        <div className="grid grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className="mt-label">巡展名称</label>
            <input className="mt-input" data-testid="loan-edit-exhibition" disabled={readOnly}
              value={editor.draft.exhibition}
              onChange={(e) => editor.patchHeader({ exhibition: e.target.value })} />
          </div>
          <div>
            <label className="mt-label">经办人</label>
            <input className="mt-input" data-testid="loan-edit-operator" disabled={readOnly}
              value={editor.draft.operator}
              onChange={(e) => editor.patchHeader({ operator: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mt-label">出库日期</label>
              <input type="date" className="mt-input" disabled={readOnly}
                value={editor.draft.outboundDate}
                onChange={(e) => editor.patchHeader({ outboundDate: e.target.value })} />
            </div>
            <div>
              <label className="mt-label">计划归还</label>
              <input type="date" className="mt-input" disabled={readOnly}
                value={editor.draft.expectedReturnDate}
                onChange={(e) => editor.patchHeader({ expectedReturnDate: e.target.value })} />
            </div>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <label className="mt-label">备注</label>
            <input className="mt-input" disabled={readOnly} value={editor.draft.note}
              onChange={(e) => editor.patchHeader({ note: e.target.value })} />
          </div>
        </div>
      </section>

      <section className="mt-panel">
        <div className="mt-panel-head">
          <div>
            <h3 className="font-song text-sm font-semibold text-ink">目标格位编排</h3>
            <p className="mt-sub">
              已安排 {batch.items.length - editor.unassigned.length}/{batch.items.length} 枚 ·
              容量越界与格位冲突会阻止保存 / 完成，整批校验失败不落任何半成品
            </p>
          </div>
          <select
            className="mt-input max-w-xs"
            data-testid="loan-target-case-switch"
            value={activeCaseId}
            onChange={(e) => setActiveCaseId(e.target.value)}
          >
            {cases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} · {describeCapacity(c.rows, c.cols)} · 现存 {c.slots.length} 格
              </option>
            ))}
          </select>
        </div>

        {editor.capacityMessages.length > 0 ? (
          <div className="border-b border-seal/30 bg-seal-pale/60 px-4 py-2 text-xs text-seal" data-testid="loan-capacity-warning">
            {editor.capacityMessages.join('；')}
          </div>
        ) : null}

        <TargetGrid
          items={editor.items}
          cases={cases}
          activeCaseId={activeCaseId}
          activeMatrixId={activeMatrixId}
          readOnly={readOnly}
          problemMatrixIds={problemMatrixIds}
          onPickCell={(row, col) => {
            const plannedHere = editor.items.find(
              (it) => it.targetCaseId === activeCaseId && it.targetRow === row && it.targetCol === col,
            );
            // 再点一次已分配格位：直接取消该分配
            if (plannedHere) {
              editor.setAssignment(plannedHere.matrixId, {
                targetCaseId: activeCaseId,
                targetRow: null,
                targetCol: null,
              });
              return;
            }
            if (!activeMatrixId) {
              pushToast('请先在下方明细表选中一枚字模', 'warn');
              return;
            }
            const occupiedByOther = editor.items.some(
              (it) =>
                it.matrixId !== activeMatrixId &&
                it.targetCaseId === activeCaseId &&
                it.targetRow === row &&
                it.targetCol === col,
            );
            if (occupiedByOther) {
              pushToast('该格位已分配给本批次另一枚字模', 'warn');
              return;
            }
            editor.setAssignment(activeMatrixId, {
              targetCaseId: activeCaseId,
              targetRow: row,
              targetCol: col,
            });
          }}
        />
      </section>

      <section className="mt-panel">
        <div className="mt-panel-head">
          <h3 className="font-song text-sm font-semibold text-ink">借调明细与原格位追溯</h3>
          <span className="mt-sub">原格位在批次未结束前持续冻结，总览可追溯</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs" data-testid="loan-items-table">
            <thead>
              <tr className="border-b border-paper-line text-ink-mute">
                <th className="mt-th">字模</th>
                <th className="mt-th">原字盘格位</th>
                <th className="mt-th">目标字盘</th>
                <th className="mt-th">目标格位</th>
                <th className="mt-th">校验</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-line">
              {editor.items.map((item) => (
                <ItemRow
                  key={item.matrixId}
                  item={item}
                  cases={cases}
                  readOnly={readOnly}
                  active={item.matrixId === activeMatrixId}
                  problem={problemByMatrix.get(item.matrixId)}
                  onSelect={() => setActiveMatrixId(item.matrixId)}
                  onChangeTargetCase={(targetCaseId) => {
                    setActiveMatrixId(item.matrixId);
                    editor.setAssignment(item.matrixId, { targetCaseId, targetRow: null, targetCol: null });
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {editor.errorMessage ? (
        <div className="rounded border border-seal/40 bg-seal-pale px-3 py-2 text-sm text-seal" data-testid="loan-save-error">
          {editor.errorMessage}
        </div>
      ) : null}

      <section className="flex flex-wrap items-center justify-between gap-2">
        <span className="mt-hint" data-testid="loan-timestamps">
          建批 {formatStamp(batch.createdAt)} · 最近更新 {formatStamp(batch.updatedAt)}
          {batch.completedAt ? ` · 完成 ${formatStamp(batch.completedAt)}` : ''}
        </span>
        <div className="flex flex-wrap gap-2">
          {batch.status === '待复核' ? (
            <button type="button" className="mt-btn mt-btn-primary" data-testid="loan-detail-resolve" onClick={onResolve}>
              复核通过，恢复进行中
            </button>
          ) : null}
          {batch.status === '进行中' ? (
            <>
              <button type="button" className="mt-btn" data-testid="loan-detail-save" disabled={editor.saving || !editor.dirty} onClick={handleSave}>
                {editor.saving ? '保存中…' : editor.dirty ? '保存编排（有改动）' : '保存编排'}
              </button>
              <button
                type="button"
                className="mt-btn mt-btn-primary"
                data-testid="loan-detail-complete"
                disabled={editor.completing || editor.unassigned.length > 0 || editor.problems.length > 0 || editor.capacityMessages.length > 0}
                onClick={handleComplete}
                title={
                  editor.unassigned.length > 0
                    ? '还有字模未安排目标格位'
                    : editor.problems.length > 0
                      ? '存在格位冲突'
                      : ''
                }
              >
                {editor.completing ? '完成中…' : '完成批次并落位'}
              </button>
            </>
          ) : null}
          {batch.status === '进行中' || batch.status === '待复核' ? (
            <button type="button" className="mt-btn" data-testid="loan-detail-cancel" onClick={onCancel}>
              取消批次
            </button>
          ) : null}
        </div>
      </section>

      <p className="text-[11px] text-ink-mute">
        本页每次保存都会校验乐观锁版本；两个标签页同时修改时，后保存者会看到版本冲突，不会覆盖先保存的结果。
        当前字模库共 {matrices.length} 枚，字盘 {cases.length} 个。
      </p>
    </div>
  );
}

function TargetGrid({
  items,
  cases,
  activeCaseId,
  activeMatrixId,
  readOnly,
  problemMatrixIds,
  onPickCell,
}: {
  items: LoanItem[];
  cases: import('../types/case').TypeCase[];
  activeCaseId: string;
  activeMatrixId: string;
  readOnly: boolean;
  problemMatrixIds: Set<string>;
  onPickCell: (row: number, col: number) => void;
}) {
  const typeCase = cases.find((c) => c.id === activeCaseId);
  const itemsOnCase = items.filter((it) => it.targetCaseId === activeCaseId);
  if (!typeCase) return <p className="px-4 py-4 text-sm text-ink-mute">请先选择目标字盘。</p>;

  const assignmentAt = (row: number, col: number) =>
    itemsOnCase.find((it) => it.targetRow === row && it.targetCol === col);
  // 现存（非本批）落位
  const incomingKeys = new Set(itemsOnCase.map((it) => rcKey(it.targetRow ?? -1, it.targetCol ?? -1)));
  const existingSlots = typeCase.slots.filter((s) => !incomingKeys.has(rcKey(s.row, s.col)));
  const existingAt = (row: number, col: number) => existingSlots.find((s) => s.row === row && s.col === col);

  return (
    <div className="overflow-x-auto px-4 py-3">
      <div className="inline-block min-w-full">
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: `28px repeat(${typeCase.cols}, minmax(44px, 1fr))` }}
          data-testid="loan-target-grid"
        >
          <div />
          {Array.from({ length: typeCase.cols }, (_, c) => (
            <div key={`h-${c}`} className="text-center text-[10px] text-ink-mute">{c + 1}</div>
          ))}
          {Array.from({ length: typeCase.rows }, (_, r) => (
            <div key={`r-${r}`} className="contents">
              <div className="flex h-11 items-center justify-center text-[11px] text-ink-mute">
                {'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[r]}
              </div>
              {Array.from({ length: typeCase.cols }, (_, c) => {
                const planned = assignmentAt(r, c);
                const existing = existingAt(r, c);
                const isProblem = planned ? problemMatrixIds.has(planned.matrixId) : false;
                const blocked = Boolean(existing) && !planned;
                return (
                  <button
                    key={`${r}-${c}`}
                    type="button"
                    disabled={readOnly}
                    data-testid={`loan-target-cell-${r}-${c}`}
                    data-planned={planned ? planned.matrixId : ''}
                    data-blocked={blocked ? '1' : '0'}
                    onClick={() => {
                      if (blocked) return;
                      onPickCell(r, c);
                    }}
                    className={`flex h-11 flex-col items-center justify-center rounded border text-center transition ${
                      planned
                        ? isProblem
                          ? 'border-seal bg-seal-pale text-seal'
                          : planned.matrixId === activeMatrixId
                            ? 'border-seal bg-brass-pale text-ink ring-1 ring-seal'
                            : 'border-brass bg-brass-pale text-ink'
                        : existing
                          ? 'cursor-not-allowed border-paper-line bg-paper-deep/70 text-ink-mute/60'
                          : 'border-dashed border-paper-line bg-paper/50 text-ink-mute/60'
                    } ${!readOnly && !blocked ? 'cursor-pointer hover:border-seal' : ''}`}
                    title={
                      planned
                        ? `本批分配：${planned.character}（再次点击取消）`
                        : existing
                          ? `现存：${existing.character}（不能覆盖）`
                          : '空格'
                    }
                  >
                    <span className="font-song text-lg leading-none">{planned?.character ?? existing?.character ?? ''}</span>
                    <span className="text-[9px] leading-none text-ink-mute">
                      {planned ? '本批' : existing ? '现存' : `${r + 1}·${c + 1}`}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 text-[11px] text-ink-mute">
        先在下方明细表选中一条字模，再点此网格分配格位；点已分配格位可取消。白格为字盘现存字模，不能覆盖。
      </p>
    </div>
  );
}

function ItemRow({
  item,
  cases,
  readOnly,
  active,
  problem,
  onSelect,
  onChangeTargetCase,
}: {
  item: LoanItem;
  cases: import('../types/case').TypeCase[];
  readOnly: boolean;
  active: boolean;
  problem?: string;
  onSelect: () => void;
  onChangeTargetCase: (caseId: string) => void;
}) {
  const sourceCase = cases.find((c) => c.id === item.sourceCaseId);
  const assigned = item.targetRow !== null && item.targetCol !== null;
  return (
    <tr data-testid={`loan-item-${item.matrixId}`} data-problem={problem ? '1' : '0'} className={active ? 'bg-brass-pale/40' : ''}>
      <td className="mt-td">
        <button
          type="button"
          disabled={readOnly}
          onClick={onSelect}
          className={`font-song text-sm underline-offset-2 hover:underline ${active ? 'text-seal' : 'text-ink'}`}
          data-testid={`loan-select-matrix-${item.matrixId}`}
          title="选中后在上方目标网格分配格位"
        >
          {item.character}
        </button>
        <span className="ml-1 text-[11px] text-ink-mute">{item.matrixCode}</span>
        {active ? <span className="ml-1 text-[10px] text-seal">● 当前分配</span> : null}
      </td>
      <td className="mt-td text-ink-soft">
        {item.sourceCaseCode} <span className="text-seal">{rcKey(item.sourceRow, item.sourceCol)}</span>
        {!sourceCase ? <span className="ml-1 text-seal">（原字盘缺失）</span> : null}
      </td>
      <td className="mt-td">
        <select
          className="mt-input max-w-[180px]"
          disabled={readOnly}
          data-testid={`loan-item-case-${item.matrixId}`}
          value={item.targetCaseId}
          onChange={(e) => onChangeTargetCase(e.target.value)}
        >
          <option value="">未选目标字盘</option>
          {cases.map((c) => (
            <option key={c.id} value={c.id}>{c.code}</option>
          ))}
        </select>
      </td>
      <td className="mt-td">
        {assigned ? (
          <span className="text-brass">{item.targetCaseCode} {rcKey(item.targetRow ?? 0, item.targetCol ?? 0)}</span>
        ) : (
          <span className="text-ink-mute">未安排（选中后点上方网格）</span>
        )}
      </td>
      <td className="mt-td">
        {problem ? (
          <span className="text-[11px] text-seal" data-testid={`loan-item-problem-${item.matrixId}`}>{problem}</span>
        ) : assigned ? (
          <span className="text-[11px] text-jade">校验通过</span>
        ) : (
          <span className="text-[11px] text-ink-mute">待安排</span>
        )}
      </td>
    </tr>
  );
}
