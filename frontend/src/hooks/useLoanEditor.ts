import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LoanAssignmentError,
  LoanVersionConflictError,
  useLoanStore,
} from '../stores/loanStore';
import { useCaseStore } from '../stores/caseStore';
import type { LoanBatch, LoanItem } from '../types/loan';
import {
  checkTargetCapacity,
  findUnassigned,
  validateLoanTargets,
} from '../types/loan';
import { useLocalDraft } from './useLocalDraft';

export interface LoanDraft {
  exhibition: string;
  operator: string;
  outboundDate: string;
  expectedReturnDate: string;
  note: string;
  /** 目标编排：matrixId → 目标字盘 / 格位 */
  assignments: Record<string, { targetCaseId: string; targetRow: number | null; targetCol: number | null }>;
}

export type LoanSaveOutcome =
  | { ok: true; batch: LoanBatch }
  | { ok: false; conflict: true; current: LoanBatch; message: string }
  | { ok: false; conflict: false; message: string };

function draftFromBatch(batch: LoanBatch): LoanDraft {
  const assignments: LoanDraft['assignments'] = {};
  for (const item of batch.items) {
    assignments[item.matrixId] = {
      targetCaseId: item.targetCaseId,
      targetRow: item.targetRow,
      targetCol: item.targetCol,
    };
  }
  return {
    exhibition: batch.exhibition,
    operator: batch.operator,
    outboundDate: batch.outboundDate,
    expectedReturnDate: batch.expectedReturnDate,
    note: batch.note,
    assignments,
  };
}

function applyDraft(batch: LoanBatch, draft: LoanDraft, cases: Map<string, { code: string }>): LoanItem[] {
  return batch.items.map((item) => {
    const a = draft.assignments[item.matrixId];
    const targetCase = a ? cases.get(a.targetCaseId) : undefined;
    return {
      ...item,
      targetCaseId: a?.targetCaseId ?? '',
      targetCaseCode: targetCase?.code ?? '',
      targetRow: a?.targetRow ?? null,
      targetCol: a?.targetCol ?? null,
      assignedAt: a && a.targetRow !== null && a.targetCol !== null ? item.assignedAt || new Date().toISOString() : '',
    };
  });
}

/**
 * 借调批次编辑：
 * - 未完成批次关闭页面后仍可继续（localStorage 草稿 + 批次本身落库）；
 * - 保存携带乐观锁版本，两个标签页同时改时后保存者收到版本冲突而不是静默覆盖；
 * - 完成前统一校验目标格位边界 / 容量 / 引用关系。
 */
export function useLoanEditor(batch: LoanBatch | undefined) {
  const cases = useCaseStore((s) => s.cases);
  const saveLoan = useLoanStore((s) => s.saveLoan);
  const completeLoan = useLoanStore((s) => s.completeLoan);

  const { draft, patch, replace } = useLocalDraft<LoanDraft>(
    `loan-${batch?.id ?? 'none'}`,
    batch ? draftFromBatch(batch) : {
      exhibition: '',
      operator: '',
      outboundDate: '',
      expectedReturnDate: '',
      note: '',
      assignments: {},
    },
  );

  /** 打开时锁定的库版本；若期间批次被其它标签页保存，则本页版本过期 */
  const [baseVersion, setBaseVersion] = useState(batch?.version ?? 0);
  const [newerVersion, setNewerVersion] = useState<number | null>(null);
  const [conflictMessage, setConflictMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const baseRef = useRef(batch);
  baseRef.current = batch;

  // 库中批次被其它标签页改动（storage 事件触发 reload）时：
  // - 本页没有未保存改动：静默跟上最新版本（复核通过等场景也由此恢复编辑）
  // - 本页有改动：标记版本过期，保存时会收到乐观锁冲突而不是静默覆盖
  // 首次挂载只记录基线，不用库版本覆盖 localStorage 里可能已存在的草稿。
  const seenDbVersion = useRef(batch?.version ?? 0);
  const dirtyRef = useRef(false);
  dirtyRef.current = JSON.stringify(draft) !== JSON.stringify(batch ? draftFromBatch(batch) : null);
  useEffect(() => {
    if (!batch) return;
    if (seenDbVersion.current === batch.version) return;
    const prev = seenDbVersion.current;
    seenDbVersion.current = batch.version;
    if (batch.version < prev) return;
    if (!dirtyRef.current) {
      setBaseVersion(batch.version);
      setNewerVersion(null);
      setConflictMessage('');
      replace(draftFromBatch(batch));
    } else {
      setNewerVersion(batch.version);
      setConflictMessage('该批次已在另一个标签页保存过，当前页面是旧版本，保存将被拒绝。');
    }
  }, [batch, replace]);

  const caseMap = useMemo(() => new Map(cases.map((c) => [c.id, c])), [cases]);
  const caseCodeMap = useMemo(() => new Map(cases.map((c) => [c.id, { code: c.code }])), [cases]);

  const items = useMemo(
    () => (batch ? applyDraft(batch, draft, caseCodeMap) : []),
    [batch, draft, caseCodeMap],
  );

  const problems = useMemo(() => {
    if (!batch) return [];
    return validateLoanTargets(items, caseMap).problems;
  }, [batch, items, caseMap]);

  const capacityMessages = useMemo(
    () => (batch ? checkTargetCapacity(items, caseMap) : []),
    [batch, items, caseMap],
  );

  const unassigned = useMemo(() => findUnassigned(items), [items]);

  const dirty = useMemo(() => {
    if (!batch) return false;
    const persisted = draftFromBatch(batch);
    return JSON.stringify(draft) !== JSON.stringify(persisted);
  }, [batch, draft]);

  const setAssignment = useCallback(
    (matrixId: string, next: Partial<LoanDraft['assignments'][string]>) => {
      setConflictMessage('');
      const prev = draft.assignments[matrixId] ?? { targetCaseId: '', targetRow: null, targetCol: null };
      patch({
        assignments: {
          ...draft.assignments,
          [matrixId]: {
            targetCaseId: next.targetCaseId ?? prev.targetCaseId,
            targetRow: next.targetRow !== undefined ? next.targetRow : prev.targetRow,
            targetCol: next.targetCol !== undefined ? next.targetCol : prev.targetCol,
          },
        },
      });
    },
    [draft.assignments, patch],
  );

  const patchHeader = useCallback(
    (next: Partial<Pick<LoanDraft, 'exhibition' | 'operator' | 'outboundDate' | 'expectedReturnDate' | 'note'>>) => {
      setConflictMessage('');
      patch(next);
    },
    [patch],
  );

  const runSave = useCallback(
    async (mode: 'save' | 'complete'): Promise<LoanSaveOutcome> => {
      const current = baseRef.current;
      if (!current) return { ok: false, conflict: false, message: '未找到批次' };
      const apply = mode === 'save' ? setSaving : setCompleting;
      apply(true);
      setErrorMessage('');
      try {
        const payload = {
          items,
          exhibition: draft.exhibition,
          operator: draft.operator,
          outboundDate: draft.outboundDate,
          expectedReturnDate: draft.expectedReturnDate,
          note: draft.note,
        };
        const saved = mode === 'save'
          ? await saveLoan(current.id, payload, baseVersion)
          : await completeLoan(current.id, payload, baseVersion);
        setBaseVersion(saved.version);
        seenDbVersion.current = saved.version;
        setNewerVersion(null);
        setConflictMessage('');
        replace(draftFromBatch(saved));
        return { ok: true, batch: saved };
      } catch (err) {
        if (err instanceof LoanVersionConflictError) {
          setNewerVersion(err.current.version);
          const message = err.message;
          setConflictMessage(message);
          return { ok: false, conflict: true, current: err.current, message };
        }
        const message = err instanceof LoanAssignmentError || err instanceof Error
          ? err.message
          : '保存失败';
        setErrorMessage(message);
        return { ok: false, conflict: false, message };
      } finally {
        apply(false);
      }
    },
    [items, draft, saveLoan, completeLoan, baseVersion, replace],
  );

  const save = useCallback(() => runSave('save'), [runSave]);
  const complete = useCallback(() => runSave('complete'), [runSave]);

  /** 放弃本地草稿并以库中最新版本为准（版本冲突解除） */
  const adoptLatest = useCallback(() => {
    const current = baseRef.current;
    if (!current) return;
    seenDbVersion.current = current.version;
    setBaseVersion(current.version);
    setNewerVersion(null);
    setConflictMessage('');
    replace(draftFromBatch(current));
  }, [replace]);

  return {
    draft,
    items,
    problems,
    capacityMessages,
    unassigned,
    dirty,
    saving,
    completing,
    baseVersion,
    newerVersion,
    conflictMessage,
    errorMessage,
    setAssignment,
    patchHeader,
    save,
    complete,
    adoptLatest,
  };
}
