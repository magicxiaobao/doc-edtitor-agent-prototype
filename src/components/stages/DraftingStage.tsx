import React, { useState, useEffect, useRef } from 'react';
import { 
  Task, 
  ParagraphBlock, 
  DraftVersion, 
  UserRole, 
  EvidenceSnippet,
  SnapshotMetadata 
} from '../../types';
import { 
  generateDraftFromFactsAndOutline, 
  generateParagraphRevision, 
  RevisionAction, 
  RevisionSuggestion,
  computeContentHash
} from '../../services/mockDraftService';
import { 
  checkPermission, 
  canEditDraft, 
  canRestoreVersion 
} from '../../services/permissionService';
import { applyDraftContentChange } from '../../services/draftLifecycleService';
import { 
  PenTool, 
  Sparkles, 
  Save, 
  History, 
  FileText, 
  ChevronLeft, 
  ChevronRight, 
  Check, 
  X, 
  RotateCcw, 
  ExternalLink, 
  AlertCircle, 
  ArrowRight,
  ShieldAlert,
  Edit3
} from 'lucide-react';

interface DraftingStageProps {
  task: Task;
  onUpdateTask: (updated: Partial<Task>) => void;
  onViewSnippet: (snippet: EvidenceSnippet) => void;
  onProceedToNextStage: () => void;
  activeRole: UserRole;
}

function computeDraftBlocksHash(blocks: ParagraphBlock[] = []): string {
  const combined = blocks.map((b) => `${b.id}::${b.sectionId}::${b.content}`).join('||');
  return computeContentHash(combined);
}

interface DraftCandidate {
  taskId: string;
  runId: string;
  baseDraftId: string;
  baseDraftContentHash: string; // Hash of currentDraft blocks at generation start to detect subsequent manual edits
  upstreamApprovalVersion: {
    factSnapshotConfirmedAt?: string;
    factSnapshotHash?: string;
    styleConfirmedAt?: string;
    styleHash?: string;
    outlineConfirmedAt?: string;
    outlineHash?: string;
  };
  blocks: ParagraphBlock[];
  snapshotMetadata: SnapshotMetadata;
  generatedAt: string;
}

export const DraftingStage: React.FC<DraftingStageProps> = ({
  task,
  onUpdateTask,
  onViewSnippet,
  onProceedToNextStage,
  activeRole,
}) => {
  // Active draft version
  const currentDraft = task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];

  // Collapsible panels
  const [showLeftNav, setShowLeftNav] = useState(true);
  const [showRightInspector, setShowRightInspector] = useState(true);

  // Selected block for editing / inspection
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

  // Generation state & strict isolation refs
  const [isGenerating, setIsGenerating] = useState(false);
  const [pendingCandidate, setPendingCandidate] = useState<DraftCandidate | null>(null);
  const draftCancelledRef = useRef(false);
  const [activeDraftRunId, setActiveDraftRunId] = useState<string | null>(null);
  const activeDraftRunIdRef = useRef<string | null>(null);
  const currentTaskIdRef = useRef<string>(task.id);
  const isUnmountedRef = useRef(false);
  const generateTimerRef = useRef<any>(null);

  // Local revision state
  const [revisionSuggestion, setRevisionSuggestion] = useState<RevisionSuggestion | null>(null);

  // Manual Version Save Modal
  const [showSaveVersionModal, setShowSaveVersionModal] = useState(false);
  const [versionSummary, setVersionSummary] = useState('');

  // Version History Drawer
  const [showVersionHistory, setShowVersionHistory] = useState(false);

  // Cancel generation and clear isolated results if task changes
  useEffect(() => {
    currentTaskIdRef.current = task.id;
    activeDraftRunIdRef.current = null;
    draftCancelledRef.current = true;
    if (generateTimerRef.current) {
      clearTimeout(generateTimerRef.current);
      generateTimerRef.current = null;
    }
    setIsGenerating(false);
    setActiveDraftRunId(null);
    setPendingCandidate(null);
    setRevisionSuggestion(null);
  }, [task.id]);

  // Component unmount cleanup
  useEffect(() => {
    isUnmountedRef.current = false;
    return () => {
      isUnmountedRef.current = true;
      activeDraftRunIdRef.current = null;
      if (generateTimerRef.current) {
        clearTimeout(generateTimerRef.current);
        generateTimerRef.current = null;
      }
    };
  }, []);

  // Check role permission
  const canUserEdit = canEditDraft(activeRole);
  const isReviewerOnly = activeRole === '审阅乙' || activeRole === '审阅丁';
  const isSupplierOnly = activeRole === '供稿丙';

  // Prerequisite check: facts, style, outline must all be confirmed
  const isPrerequisiteMet = task.outlineConfirmed && !!task.factSnapshot && task.styleConfirmed;

  // Selected block object
  const activeBlock = currentDraft?.blocks.find((b) => b.id === selectedBlockId) || currentDraft?.blocks[0];

  // Total word count of current draft
  const currentWordCount = currentDraft?.blocks.reduce((acc, b) => acc + b.content.length, 0) || 0;

  // Identify blocks whose referenced facts have changed, been revoked, or are unconfirmed
  const blocksNeedingReview = (currentDraft?.blocks || []).filter((block) => {
    return block.referencedFactIds.some((fId) => {
      const fact = task.facts.find((f) => f.id === fId);
      if (!fact) return true;
      if (fact.status !== 'confirmed') return true;
      if (fact.isHistoricOnly) return true;
      if (task.factSnapshot) {
        const snapItem = task.factSnapshot.items?.find((item) => item.factId === fId);
        if (snapItem && (snapItem.value !== fact.value || snapItem.unit !== fact.unit)) {
          return true;
        }
      }
      return false;
    });
  });

  // Handle Generate / Regenerate
  const handleStartGenerate = () => {
    const perm = checkPermission(activeRole, 'generate_draft');
    if (!perm.allowed) {
      alert(perm.reason || '当前身份无权起草正文');
      return;
    }

    if (!task.outlineConfirmed || !task.factSnapshot || !task.styleConfirmed) {
      alert('前序事实清单未确认/已失效、文风未核准或大纲批准已失效，无法生成正文。请先前往前序阶段重新核准。现有文稿已保留浏览，未自动覆盖旧稿。');
      return;
    }

    const runId = `DRAFT-RUN-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const startingTaskId = task.id;
    const baseDraftId = currentDraft?.id || '';
    const baseDraftContentHash = currentDraft ? computeDraftBlocksHash(currentDraft.blocks) : '';
    const upstreamApprovalVersion = {
      factSnapshotConfirmedAt: task.factSnapshot?.confirmedAt,
      factSnapshotHash: task.factSnapshot?.hash,
      styleConfirmedAt: task.styleSnapshot?.confirmedAt,
      styleHash: task.styleSnapshot?.hash,
      outlineConfirmedAt: task.outlineSnapshot?.confirmedAt,
      outlineHash: task.outlineSnapshot?.hash,
    };
    const capturedSnapshotMeta: SnapshotMetadata = {
      taskTitle: task.title,
      startDate: task.startDate,
      endDate: task.endDate,
      targetWordCount: task.targetWordCount,
      factSnapshot: task.factSnapshot ? JSON.parse(JSON.stringify(task.factSnapshot)) : undefined,
      styleSnapshot: task.styleSnapshot ? JSON.parse(JSON.stringify(task.styleSnapshot)) : undefined,
      outlineSnapshot: task.outlineSnapshot ? JSON.parse(JSON.stringify(task.outlineSnapshot)) : undefined,
      outlineSections: JSON.parse(JSON.stringify(task.outline)),
    };

    activeDraftRunIdRef.current = runId;
    draftCancelledRef.current = false;
    setActiveDraftRunId(runId);
    setIsGenerating(true);

    if (generateTimerRef.current) {
      clearTimeout(generateTimerRef.current);
    }

    generateTimerRef.current = setTimeout(() => {
      // Strict unmount, cancel, runId, and taskId isolation checks
      if (
        isUnmountedRef.current ||
        draftCancelledRef.current ||
        activeDraftRunIdRef.current !== runId ||
        currentTaskIdRef.current !== startingTaskId
      ) {
        setIsGenerating(false);
        return;
      }

      const generatedBlocks = generateDraftFromFactsAndOutline(task);
      if (task.drafts.length === 0) {
        // Direct initial draft
        const initialDraft: DraftVersion = {
          id: `DRAFT-${Date.now()}`,
          versionNumber: 'v1.0 (初稿)',
          createdAt: new Date().toISOString(),
          author: activeRole,
          summary: '系统根据已确认事实及大纲生成的首个完整初稿版本',
          blocks: generatedBlocks,
          snapshotMetadata: capturedSnapshotMeta,
        };
        onUpdateTask({
          drafts: [initialDraft],
          currentDraftId: initialDraft.id,
          status: '起草中',
        });
      } else {
        // Offer candidate blocks for comparison with captured snapshot metadata
        setPendingCandidate({
          taskId: startingTaskId,
          runId,
          baseDraftId,
          baseDraftContentHash,
          upstreamApprovalVersion,
          blocks: generatedBlocks,
          snapshotMetadata: capturedSnapshotMeta,
          generatedAt: new Date().toISOString(),
        });
      }
      setIsGenerating(false);
    }, 600);
  };

  const handleCancelGenerate = () => {
    draftCancelledRef.current = true;
    activeDraftRunIdRef.current = null;
    if (generateTimerRef.current) {
      clearTimeout(generateTimerRef.current);
      generateTimerRef.current = null;
    }
    setIsGenerating(false);
    setActiveDraftRunId(null);
  };

  const handleAcceptCandidate = () => {
    const perm = checkPermission(activeRole, 'edit_draft');
    if (!perm.allowed) {
      alert(perm.reason || '当前身份无权采纳新候选稿');
      return;
    }
    if (!pendingCandidate) return;

    // Strict validation: candidate must match current task
    if (pendingCandidate.taskId !== task.id) {
      alert('安全隔离拦截：候选稿生成自其他任务，禁止跨任务采纳！');
      setPendingCandidate(null);
      return;
    }

    // Run ID validation: must not be invalidated by cancel or another run
    if (activeDraftRunIdRef.current && pendingCandidate.runId !== activeDraftRunIdRef.current) {
      alert('生成运行已失效：该候选生成自已取消或过期的运行！');
      setPendingCandidate(null);
      return;
    }

    // Baseline validation: check if draft changed (ID mismatch)
    if (currentDraft && pendingCandidate.baseDraftId && currentDraft.id !== pendingCandidate.baseDraftId) {
      alert('基准冲突：当前草稿版本已发生变更，旧生成候选已失效！请重新生成。');
      setPendingCandidate(null);
      return;
    }

    // Baseline validation: check if draft content was manually modified after generation started!
    if (currentDraft && pendingCandidate.baseDraftContentHash) {
      const currentHash = computeDraftBlocksHash(currentDraft.blocks);
      if (currentHash !== pendingCandidate.baseDraftContentHash) {
        alert('基准正文已变更：在此候选生成后，正文已被人工编辑修改，采纳旧候选将覆盖人工修改！候选已失效，请重新生成或先保存快照。');
        setPendingCandidate(null);
        return;
      }
    }

    // Upstream approvals validation: verify upstream approvals are still valid and have not been invalidated or changed
    const isUpstreamStillApproved =
      task.outlineConfirmed === true &&
      task.styleConfirmed === true &&
      !!task.factSnapshot;

    if (!isUpstreamStillApproved) {
      alert('上游依据审批状态已失效（事实快照缺失、文风未核准或大纲审批已撤销），旧候选已失效！');
      setPendingCandidate(null);
      return;
    }

    const curFactTime = task.factSnapshot?.confirmedAt || '';
    const candFactTime = pendingCandidate.upstreamApprovalVersion?.factSnapshotConfirmedAt || '';
    const curFactHash = task.factSnapshot?.hash || '';
    const candFactHash = pendingCandidate.upstreamApprovalVersion?.factSnapshotHash || '';
    if (curFactTime !== candFactTime || (curFactHash && candFactHash && curFactHash !== candFactHash)) {
      alert('上游事实依据版本已变更：事实快照已更新，候选稿依据已失效，请重新生成！');
      setPendingCandidate(null);
      return;
    }

    const curStyleTime = task.styleSnapshot?.confirmedAt || '';
    const candStyleTime = pendingCandidate.upstreamApprovalVersion?.styleConfirmedAt || '';
    if (curStyleTime !== candStyleTime) {
      alert('上游文风依据版本已变更：文风规范已重新核准，候选稿依据已失效，请重新生成！');
      setPendingCandidate(null);
      return;
    }

    const curOutlineTime = task.outlineSnapshot?.confirmedAt || '';
    const candOutlineTime = pendingCandidate.upstreamApprovalVersion?.outlineConfirmedAt || '';
    if (curOutlineTime !== candOutlineTime) {
      alert('上游大纲依据版本已变更：大纲结构已重新核准，候选稿依据已失效，请重新生成！');
      setPendingCandidate(null);
      return;
    }

    try {
      // Pass the candidate's atomically captured snapshotMetadata!
      const { updatedTask, workingDraft } = applyDraftContentChange(
        task,
        currentDraft?.id,
        () => pendingCandidate.blocks,
        '采纳重新起草候选稿',
        activeRole,
        pendingCandidate.snapshotMetadata
      );
      onUpdateTask({
        drafts: updatedTask.drafts,
        currentDraftId: workingDraft.id,
        isFinalized: updatedTask.isFinalized,
        status: updatedTask.status,
      });
      setPendingCandidate(null);
    } catch (err: any) {
      alert(err.message || '采纳候选稿失败');
    }
  };

  const handleUpdateBlockContent = (blockId: string, newContent: string) => {
    const perm = checkPermission(activeRole, 'edit_draft');
    if (!perm.allowed) {
      alert(perm.reason || '当前身份无权修改正文');
      return;
    }

    if (!currentDraft) return;

    try {
      const { updatedTask, workingDraft } = applyDraftContentChange(
        task,
        currentDraft.id,
        (blocks) =>
          blocks.map((b) =>
            b.id === blockId ? { ...b, content: newContent, updatedAt: new Date().toISOString() } : b
          ),
        '手工编辑修改段落',
        activeRole
      );
      onUpdateTask({
        drafts: updatedTask.drafts,
        currentDraftId: workingDraft.id,
        isFinalized: updatedTask.isFinalized,
        status: updatedTask.status,
      });
    } catch (err: any) {
      alert(err.message || '正文修改失败');
    }
  };

  // Local revision action
  const handleRequestRevision = (action: RevisionAction) => {
    if (!activeBlock) return;
    const runId = `REV-RUN-${Date.now().toString(36)}`;
    const suggestion = generateParagraphRevision(activeBlock, action, task.id, currentDraft?.id, runId);
    setRevisionSuggestion(suggestion);
  };

  const handleAdoptRevision = () => {
    if (!revisionSuggestion || !currentDraft) return;

    const perm = checkPermission(activeRole, 'adopt_revision');
    if (!perm.allowed) {
      alert(perm.reason || '当前身份无权采纳修改建议');
      return;
    }

    // Task boundary verification
    if (revisionSuggestion.taskId && revisionSuggestion.taskId !== task.id) {
      alert('建议失效：该修改建议属于其他公文任务，不可跨任务采纳。');
      setRevisionSuggestion(null);
      return;
    }

    // Version boundary verification
    if (revisionSuggestion.sourceDraftId && revisionSuggestion.sourceDraftId !== currentDraft.id) {
      alert('建议失效：该修改建议基于历史草稿版本生成，当前工作版本已变更，不可直接采纳。');
      setRevisionSuggestion(null);
      return;
    }

    // CRITICAL: Verify against original target block by targetBlockId, NEVER activeBlock!
    const targetBlock = currentDraft.blocks.find((b) => b.id === revisionSuggestion.targetBlockId);
    if (!targetBlock) {
      alert('建议失效：未在当前版本找到该建议的目标段落，可能已被删除或重构。');
      setRevisionSuggestion(null);
      return;
    }

    // CRITICAL: Base content modification conflict check
    if (targetBlock.content !== revisionSuggestion.baseContent) {
      alert('采纳冲突：检测到目标段落自建议生成后已被人工编辑修改，基准内容已变动。为防止直接覆盖人工文本，建议已失效，请重新基于当前内容生成建议。');
      return;
    }

    try {
      const { updatedTask, workingDraft } = applyDraftContentChange(
        task,
        currentDraft.id,
        (blocks) =>
          blocks.map((b) =>
            b.id === revisionSuggestion.targetBlockId
              ? { ...b, content: revisionSuggestion.suggestedText, updatedAt: new Date().toISOString() }
              : b
          ),
        `采纳局部修改建议（${revisionSuggestion.action}）`,
        activeRole
      );
      onUpdateTask({
        drafts: updatedTask.drafts,
        currentDraftId: workingDraft.id,
        isFinalized: updatedTask.isFinalized,
        status: updatedTask.status,
      });
      setRevisionSuggestion(null);
    } catch (err: any) {
      alert(err.message || '采纳建议失败');
    }
  };

  // Save version snapshot
  const handleSaveVersion = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentDraft) return;

    const perm = checkPermission(activeRole, 'edit_draft');
    if (!perm.allowed) {
      alert(perm.reason || '当前身份无权手动保存版本快照');
      return;
    }

    // Requirement 1 & 10: Saving snapshot MUST set read-only immutable semantics!
    const snapshotVersion: DraftVersion = {
      id: `DRAFT-${Date.now()}`,
      versionNumber: `v1.${task.drafts.length} (${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })})`,
      createdAt: new Date().toISOString(),
      author: activeRole,
      summary: versionSummary.trim() || '主笔手动保存的只读稿件快照',
      blocks: JSON.parse(JSON.stringify(currentDraft.blocks)),
      isFinal: false,
      isHistoricalSnapshot: true, // Read-only immutable
      isWorkingDraft: false,      // Not a working draft
      snapshotMetadata: currentDraft.snapshotMetadata,
      auditRecords: currentDraft.auditRecords ? JSON.parse(JSON.stringify(currentDraft.auditRecords)) : [],
      frozenReviewComments: JSON.parse(JSON.stringify(task.reviewComments)), // 冻结保存时刻的审阅意见快照
    };

    onUpdateTask({
      drafts: [snapshotVersion, ...task.drafts],
      currentDraftId: snapshotVersion.id,
    });

    setShowSaveVersionModal(false);
    setVersionSummary('');
  };

  // Restore history draft (Problem 3 fix: explicitly create new working draft with deep-copied snapshot metadata)
  const handleRestoreDraft = (version: DraftVersion) => {
    const perm = checkPermission(activeRole, 'restore_version');
    if (!perm.allowed) {
      alert(perm.reason || '当前身份无权恢复历史版本');
      return;
    }

    try {
      const nextVersionNumber = `v${(task.drafts.length + 1).toFixed(1)} (工作草稿·恢复自${version.versionNumber})`;
      const restoredDraft: DraftVersion = {
        id: `DRAFT-WORK-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
        versionNumber: nextVersionNumber,
        createdAt: new Date().toISOString(),
        author: activeRole,
        summary: `基于历史版本【${version.versionNumber}】恢复生成的新工作草稿`,
        blocks: JSON.parse(JSON.stringify(version.blocks)),
        isFinal: false,
        isHistoricalSnapshot: false,
        isWorkingDraft: true,
        sourceDraftId: version.id, // 明确记录恢复来源ID
        snapshotMetadata: version.snapshotMetadata ? JSON.parse(JSON.stringify(version.snapshotMetadata)) : undefined, // 完整深拷贝历史依据快照
        auditRecords: version.auditRecords ? JSON.parse(JSON.stringify(version.auditRecords)) : [],
      };

      onUpdateTask({
        drafts: [restoredDraft, ...task.drafts],
        currentDraftId: restoredDraft.id,
        isFinalized: false,
        status: '起草中',
      });
      setShowVersionHistory(false);
    } catch (err: any) {
      alert(err.message || '恢复历史版本失败');
    }
  };

  return (
    <div className="space-y-4">
      {/* Top Banner */}
      <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-blue-50 text-blue-700 flex items-center justify-center">
            <PenTool className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-slate-800">
                阶段04：正文起草与依据追溯工作台
              </h2>
              {currentDraft && (
                <span className="text-[11px] bg-blue-100 text-blue-800 px-2 py-0.5 rounded font-mono">
                  {currentDraft.versionNumber}
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-500">
              白色文稿为视觉核心 · 结构化段落与事实紧密绑定 · 支持局部扩写/压缩及出处反查
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isReviewerOnly && (
            <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded flex items-center gap-1 font-medium">
              <ShieldAlert className="w-3.5 h-3.5 text-amber-600" />
              当前为审阅身份（只读/批注模式）
            </span>
          )}
          {isSupplierOnly && (
            <span className="text-xs text-purple-700 bg-purple-50 border border-purple-200 px-2.5 py-1 rounded flex items-center gap-1 font-medium">
              <ShieldAlert className="w-3.5 h-3.5 text-purple-600" />
              当前为供稿身份（只读正文）
            </span>
          )}
          {task.isFinalized && (
            <span className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-300 px-2.5 py-1 rounded flex items-center gap-1 font-semibold">
              <Check className="w-3.5 h-3.5 text-emerald-600" />
              已正式定稿（编辑将创建新工作稿）
            </span>
          )}

          {isGenerating && (
            <button
              onClick={handleCancelGenerate}
              className="px-2.5 py-1.5 bg-rose-50 text-rose-700 border border-rose-300 rounded text-xs hover:bg-rose-100 cursor-pointer font-medium"
              title="取消当前起草生成并保持现有内容"
            >
              取消起草
            </button>
          )}

          {task.drafts.length === 0 ? (
            <button
              onClick={handleStartGenerate}
              disabled={isGenerating || !isPrerequisiteMet || !canUserEdit}
              className={`px-4 py-2 rounded text-xs font-semibold shadow-xs flex items-center gap-1.5 transition-colors ${
                !isPrerequisiteMet || isGenerating || !canUserEdit
                  ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  : 'bg-blue-700 hover:bg-blue-800 text-white cursor-pointer'
              }`}
              title={
                !canUserEdit
                  ? `权限受限：当前身份为【${activeRole}】，仅主笔甲可生成正文`
                  : !isPrerequisiteMet
                  ? '前序事实未确认/文风未核准/大纲批准失效，无法起草'
                  : '生成首轮初稿'
              }
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{isGenerating ? '起草生成中...' : '生成首轮初稿'}</span>
            </button>
          ) : (
            <>
              <button
                onClick={() => setShowSaveVersionModal(true)}
                disabled={!canUserEdit}
                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded text-xs font-medium flex items-center gap-1 cursor-pointer disabled:opacity-40"
                title={!canUserEdit ? `权限受限：当前身份为【${activeRole}】，仅主笔甲可保存版本` : '保存新版本快照'}
              >
                <Save className="w-3.5 h-3.5 text-slate-500" />
                <span>保存新版本</span>
              </button>

              <button
                onClick={() => setShowVersionHistory(true)}
                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded text-xs font-medium flex items-center gap-1 cursor-pointer"
              >
                <History className="w-3.5 h-3.5 text-slate-500" />
                <span>版本历史 ({task.drafts.length})</span>
              </button>

              <button
                onClick={handleStartGenerate}
                disabled={isGenerating || !canUserEdit || !isPrerequisiteMet}
                className={`px-3 py-1.5 border rounded text-xs font-medium flex items-center gap-1 transition-colors ${
                  !isPrerequisiteMet || !canUserEdit || isGenerating
                    ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                    : 'bg-blue-50 text-blue-800 hover:bg-blue-100 border-blue-200 cursor-pointer'
                }`}
                title={
                  !canUserEdit
                    ? `权限受限：当前身份为【${activeRole}】，仅主笔甲可起草正文`
                    : !isPrerequisiteMet
                    ? '前序事实或大纲审批已失效，无法重新生成。请先前往前序阶段核准。'
                    : '重新生成候选稿'
                }
              >
                <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                <span>重新生成候选稿</span>
              </button>

              <button
                onClick={onProceedToNextStage}
                className="px-4 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold shadow-xs flex items-center gap-1 cursor-pointer"
              >
                <span>下一步：审阅修改</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Review & Invalidation Alert Banner when upstream approvals changed */}
      {!isPrerequisiteMet && currentDraft && (
        <div className="p-4 bg-amber-50 border-l-4 border-amber-500 rounded-r text-xs text-amber-900 space-y-2">
          <div className="flex items-center gap-2 font-bold text-amber-900">
            <AlertCircle className="w-4 h-4 text-amber-600" />
            <span>流程复核提示：前序事实已撤销/变更、文风未核准或大纲批准已失效</span>
          </div>
          <p className="text-amber-800">
            检测到上游决策状态发生变动，下游起草批准已失效。系统已保护现有文稿，<strong>未自动覆盖旧稿</strong>，支持继续浏览与手动修订。文风未确认或事实快照无效时不能重新生成正文。
          </p>
          {blocksNeedingReview.length > 0 ? (
            <div className="mt-1 pt-1 border-t border-amber-200/80">
              <span className="font-semibold text-amber-900">以下正文段落引用的事实已失效或撤销，需主笔重点复核：</span>
              <ul className="list-disc list-inside mt-1 space-y-0.5 text-[11px] text-amber-800">
                {blocksNeedingReview.map((b) => {
                  const changedFact = task.facts.find((f) => b.referencedFactIds.includes(f.id));
                  return (
                    <li key={b.id}>
                      第 {b.order} 段：引用事实“{changedFact?.metric || '已删除事实'}”当前状态为【
                      {changedFact?.status === 'pending'
                        ? '待核定（已从confirmed撤销）'
                        : changedFact?.status === 'excluded'
                        ? '已明确排除'
                        : changedFact ? '口径已变动' : '已不存在'}
                      】
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <p className="text-[11px] text-amber-700">
              当前文稿暂无受影响的事实段落，但重新起草需先返回前序阶段重新确认大纲。
            </p>
          )}
        </div>
      )}

      {/* Candidate comparison banner if present */}
      {pendingCandidate && (
        <div className="bg-amber-50 border-2 border-amber-300 p-4 rounded-lg flex items-center justify-between shadow-xs">
          <div>
            <h4 className="font-bold text-xs text-amber-900 flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-amber-600" />
              已生成新一轮候选文稿（基于最新已确认事实）
            </h4>
            <p className="text-[11px] text-amber-800 mt-0.5">
              请主笔审阅是否采纳替换现有文稿。替换后现有版本将自动归档入历史记录。
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setPendingCandidate(null)}
              className="px-3 py-1.5 bg-white border border-slate-300 text-slate-700 rounded text-xs hover:bg-slate-50 cursor-pointer"
            >
              放弃候选稿
            </button>
            <button
              onClick={handleAcceptCandidate}
              className="px-4 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded text-xs font-semibold shadow-xs cursor-pointer"
            >
              采纳并替换为新版本
            </button>
          </div>
        </div>
      )}

      {/* 3-Column Document Workspace */}
      <div className="grid grid-cols-12 gap-4 items-start min-h-[640px]">
        {/* Left: Collapsible Outline Navigation */}
        {showLeftNav ? (
          <div className="col-span-12 lg:col-span-3 bg-white rounded-lg border border-slate-200 shadow-2xs p-4 space-y-3 sticky top-18 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <span className="font-bold text-xs text-slate-800 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-blue-700" />
                文稿章节大纲
              </span>
              <button
                onClick={() => setShowLeftNav(false)}
                className="text-slate-400 hover:text-slate-600 p-0.5 cursor-pointer"
                title="折叠导航栏"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2">
              {task.outline.map((sec) => (
                <div
                  key={sec.id}
                  className="p-2.5 rounded bg-slate-50 hover:bg-blue-50/60 border border-slate-200/60 transition-colors cursor-pointer text-xs"
                >
                  <div className="font-semibold text-slate-800 line-clamp-1">{sec.title}</div>
                  <div className="text-[11px] text-slate-500 mt-1 flex justify-between">
                    <span>建议：{sec.suggestedWordCount}字</span>
                    <span>{sec.assignedFactIds.length}项依据</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="pt-2 border-t border-slate-100 text-[11px] text-slate-500 space-y-1">
              <div>当前正文字数：<strong className="text-slate-800 font-mono">{currentWordCount}</strong> 字</div>
              <div>目标字数：<strong className="text-slate-800 font-mono">{task.targetWordCount}</strong> 字</div>
            </div>
          </div>
        ) : (
          <div className="col-span-1 hidden lg:block">
            <button
              onClick={() => setShowLeftNav(true)}
              className="p-2 bg-white border border-slate-200 rounded shadow-xs text-slate-600 hover:text-slate-900 cursor-pointer"
              title="展开章节导航"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Center: White Document Editor Canvas */}
        <div
          className={`${
            showLeftNav && showRightInspector
              ? 'col-span-12 lg:col-span-6'
              : !showLeftNav && showRightInspector
              ? 'col-span-12 lg:col-span-8'
              : showLeftNav && !showRightInspector
              ? 'col-span-12 lg:col-span-9'
              : 'col-span-12'
          } bg-white rounded-lg border border-slate-200 shadow-sm p-6 sm:p-10 min-h-[640px] flex flex-col justify-between`}
        >
          {currentDraft ? (
            <div className="space-y-6">
              {/* Document Header */}
              <div className="text-center pb-6 border-b border-slate-200 space-y-2">
                <h1 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight font-serif">
                  {task.title}
                </h1>
                <div className="text-xs text-slate-500 space-y-0.5">
                  <p>统计期间：{task.startDate} 至 {task.endDate} · 汇报对象：{task.audience}</p>
                  <p className="text-[11px] text-slate-400">
                    拟稿人：{currentDraft.author} · 统计字数：{currentWordCount}字 · 版本：{currentDraft.versionNumber}
                  </p>
                </div>
              </div>

              {/* Document Paragraph Blocks */}
              <div className="space-y-6">
                {currentDraft.blocks.map((block, idx) => {
                  const isSelected = selectedBlockId === block.id || (!selectedBlockId && idx === 0);
                  const section = task.outline.find((s) => s.id === block.sectionId);
                  const isSectionFirstBlock = idx === 0 || currentDraft.blocks[idx - 1]?.sectionId !== block.sectionId;

                  return (
                    <div key={block.id} className="space-y-2">
                      {/* Section Title if First Block */}
                      {isSectionFirstBlock && section && (
                        <h2 className="text-base font-bold text-slate-800 pt-3 pb-1 border-b border-slate-100 flex items-center justify-between">
                          <span>{section.title}</span>
                          <span className="text-[11px] text-slate-400 font-normal">
                            建议 {section.suggestedWordCount} 字
                          </span>
                        </h2>
                      )}

                      {/* Block Container */}
                      <div
                        onClick={() => setSelectedBlockId(block.id)}
                        className={`group relative p-3 rounded-md transition-all cursor-text ${
                          isSelected
                            ? 'bg-blue-50/40 border-2 border-blue-600 shadow-xs ring-2 ring-blue-100'
                            : 'hover:bg-slate-50/80 border border-transparent'
                        }`}
                      >
                        {/* Paragraph content (editable) */}
                        <textarea
                          rows={Math.max(2, Math.ceil(block.content.length / 38))}
                          value={block.content}
                          disabled={isReviewerOnly}
                          onChange={(e) => handleUpdateBlockContent(block.id, e.target.value)}
                          className="w-full bg-transparent resize-none focus:outline-hidden text-slate-800 text-[15px] leading-relaxed text-justify indent-8 font-normal font-sans"
                        />

                        {/* Block metadata & facts pill */}
                        <div className="mt-2 flex flex-wrap items-center justify-between text-[11px] text-slate-400 pt-1.5 border-t border-slate-100/70">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-mono text-[10px] text-slate-400">第{block.order || idx + 1}段</span>
                            {blocksNeedingReview.some((b) => b.id === block.id) && (
                              <span className="inline-flex items-center gap-1 text-[10px] bg-rose-50 text-rose-700 border border-rose-200 px-1.5 py-0.2 rounded font-medium">
                                <AlertCircle className="w-3 h-3 text-rose-600" />
                                引用事实已变动/待复核
                              </span>
                            )}
                            {block.referencedFactIds.map((factId) => {
                              const fact = task.facts.find((f) => f.id === factId);
                              if (!fact) return null;
                              return (
                                <button
                                  key={fact.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const snippet = task.snippets.find((s) => s.id === fact.primaryEvidenceId);
                                    if (snippet) onViewSnippet(snippet);
                                  }}
                                  className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded bg-blue-100/80 text-blue-800 hover:bg-blue-200 font-medium cursor-pointer"
                                  title={`点击追溯出处：${fact.metric}`}
                                >
                                  <span>{fact.metric}: {fact.value}{fact.unit}</span>
                                  <ExternalLink className="w-2.5 h-2.5" />
                                </button>
                              );
                            })}
                          </div>

                          <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <span className="text-[10px] text-slate-400">点击选中段落查看AI修改建议</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="py-24 text-center space-y-4">
              <FileText className="w-12 h-12 text-slate-300 mx-auto" />
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-slate-700">当前任务尚未生成正文草稿</h3>
                <p className="text-xs text-slate-400">
                  前序阶段已确认事实与大纲。点击上方“生成首轮初稿”按钮，系统将根据已确认指标进行确定性起草。
                </p>
              </div>
              <button
                onClick={handleStartGenerate}
                disabled={isGenerating}
                className="px-5 py-2.5 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold shadow-xs inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Sparkles className="w-4 h-4" />
                <span>立即生成初稿</span>
              </button>
            </div>
          )}
        </div>

        {/* Right: Collapsible Inspector / AI Revision Assistant */}
        {showRightInspector ? (
          <div className="col-span-12 lg:col-span-3 bg-white rounded-lg border border-slate-200 shadow-2xs p-4 space-y-4 sticky top-18 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <span className="font-bold text-xs text-slate-800 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-blue-700" />
                段落修改与依据追溯
              </span>
              <button
                onClick={() => setShowRightInspector(false)}
                className="text-slate-400 hover:text-slate-600 p-0.5 cursor-pointer"
                title="折叠辅助面板"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            {/* Currently Focused Block Info */}
            {activeBlock ? (
              <div className="space-y-3">
                <div className="p-2.5 bg-slate-50 rounded border border-slate-200/80 text-xs">
                  <div className="font-semibold text-slate-700">当前定位段落：第{activeBlock.order}段</div>
                  <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
                    “{activeBlock.content}”
                  </p>
                </div>

                {/* Local AI Revision Tools */}
                <div className="space-y-2">
                  <span className="text-[11px] font-bold text-slate-600 block">段落精修操作：</span>
                  <div className="grid grid-cols-2 gap-1.5 text-xs">
                    <button
                      onClick={() => handleRequestRevision('compress')}
                      className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-center transition-colors cursor-pointer font-medium"
                      title="精简压缩篇幅，保留16场、800人次等核心事实"
                    >
                      压缩精炼
                    </button>
                    <button
                      onClick={() => handleRequestRevision('expand')}
                      className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-center transition-colors cursor-pointer font-medium"
                      title="扩充细节举措与制度闭环"
                    >
                      举措扩写
                    </button>
                    <button
                      onClick={() => handleRequestRevision('formal')}
                      className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-center transition-colors cursor-pointer font-medium"
                      title="转换为标准庄重公文句式"
                    >
                      正式文风
                    </button>
                    <button
                      onClick={() => handleRequestRevision('highlight')}
                      className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-center transition-colors cursor-pointer font-medium"
                      title="突出核心成效与突破亮点"
                    >
                      突出重点
                    </button>
                  </div>
                </div>

                {/* Revision Diff Comparison Box */}
                {revisionSuggestion && (() => {
                  const targetBlock = currentDraft?.blocks.find((b) => b.id === revisionSuggestion.targetBlockId);
                  const isModifiedAfter = targetBlock && targetBlock.content !== revisionSuggestion.baseContent;
                  const isDifferentBlockSelected = activeBlock && activeBlock.id !== revisionSuggestion.targetBlockId;

                  return (
                    <div className="p-3 bg-blue-50/70 border border-blue-200 rounded-lg space-y-2 text-xs">
                      <div className="font-bold text-blue-900 flex items-center justify-between">
                        <span>修改建议预览</span>
                        <span className="text-[10px] bg-blue-200 text-blue-800 px-1.5 py-0.2 rounded font-mono">
                          {revisionSuggestion.action}
                        </span>
                      </div>

                      <div className="text-[11px] text-slate-600 bg-white/80 p-1.5 rounded border border-blue-100 flex items-center justify-between">
                        <span>建议绑定目标：<strong>第{targetBlock?.order || '?'}段</strong> ({revisionSuggestion.targetBlockId})</span>
                        <span className="font-mono text-[10px] text-slate-400" title={`基准内容指纹：${revisionSuggestion.baseContentHash}`}>
                          指纹:{revisionSuggestion.baseContentHash.slice(0, 10)}
                        </span>
                      </div>

                      {isDifferentBlockSelected && (
                        <div className="p-1.5 bg-amber-50 border border-amber-200 rounded text-[10px] text-amber-800">
                          提示：当前光标聚焦于第<strong>{activeBlock?.order}段</strong>，采纳修改将准确更新原目标<strong>第{targetBlock?.order}段</strong>，不会误覆盖当前聚焦段落。
                        </div>
                      )}

                      {isModifiedAfter && (
                        <div className="p-1.5 bg-rose-50 border border-rose-300 rounded text-[10px] text-rose-800 font-semibold">
                          ⚠️ 基准变动：目标段落已被编辑修改，直接采纳已锁定，防止覆盖人工文本。请重新生成建议。
                        </div>
                      )}

                      <div className="p-2 bg-white rounded border border-blue-100 text-slate-800 text-[11px] leading-relaxed">
                        {revisionSuggestion.suggestedText}
                      </div>

                      <div className="text-[10px] text-blue-800 leading-normal">
                        <strong>事实考量：</strong>{revisionSuggestion.diffExplanation}
                      </div>

                      <div className="pt-1 flex justify-end gap-1.5">
                        <button
                          onClick={() => setRevisionSuggestion(null)}
                          className="px-2.5 py-1 bg-white border border-slate-300 text-slate-600 rounded text-[11px] hover:bg-slate-50 cursor-pointer"
                        >
                          放弃建议
                        </button>
                        <button
                          onClick={handleAdoptRevision}
                          disabled={Boolean(isModifiedAfter) || !canUserEdit}
                          className={`px-3 py-1 rounded text-[11px] font-semibold shadow-xs ${
                            isModifiedAfter || !canUserEdit
                              ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                              : 'bg-blue-700 hover:bg-blue-800 text-white cursor-pointer'
                          }`}
                          title={
                            !canUserEdit
                              ? `权限受限：当前身份为【${activeRole}】，仅主笔甲可采纳建议`
                              : isModifiedAfter
                              ? '目标段落自建议生成后已被修改，禁止直接覆盖'
                              : '采纳替换原目标段落'
                          }
                        >
                          采纳替换原段
                        </button>
                      </div>
                    </div>
                  );
                })()}

                {/* Traced Facts in this Block */}
                <div className="space-y-2 pt-2 border-t border-slate-100">
                  <span className="text-[11px] font-bold text-slate-600 block">本段关联事实依据：</span>
                  {activeBlock.referencedFactIds.length > 0 ? (
                    activeBlock.referencedFactIds.map((factId) => {
                      const fact = task.facts.find((f) => f.id === factId);
                      const snippet = task.snippets.find((s) => s.id === fact?.primaryEvidenceId);
                      if (!fact) return null;

                      return (
                        <div key={fact.id} className="p-2 bg-slate-50 rounded border border-slate-200 text-xs space-y-1">
                          <div className="font-bold text-slate-800">{fact.metric}</div>
                          <div className="text-[11px] text-blue-700 font-semibold">
                            确认值：{fact.value} {fact.unit}
                          </div>
                          {snippet && (
                            <button
                              onClick={() => onViewSnippet(snippet)}
                              className="text-[11px] text-blue-600 hover:underline flex items-center gap-1 cursor-pointer"
                            >
                              <span>来源：{snippet.docName} ({snippet.location})</span>
                              <ExternalLink className="w-2.5 h-2.5" />
                            </button>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <p className="text-[11px] text-slate-400 italic">本段暂未绑定量化事实依据</p>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-400">点击文稿中的段落以查看依据与修改建议</p>
            )}
          </div>
        ) : (
          <div className="col-span-1 hidden lg:block">
            <button
              onClick={() => setShowRightInspector(true)}
              className="p-2 bg-white border border-slate-200 rounded shadow-xs text-slate-600 hover:text-slate-900 cursor-pointer"
              title="展开辅助面板"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {/* Save Version Snapshot Modal */}
      {showSaveVersionModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="font-bold text-sm text-slate-800">保存正文历史版本快照</h3>
              <button
                onClick={() => setShowSaveVersionModal(false)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <form onSubmit={handleSaveVersion} className="p-5 space-y-3 text-xs">
              <div className="space-y-1">
                <label className="font-semibold text-slate-700">版本变更说明 / 摘要</label>
                <textarea
                  rows={3}
                  placeholder="例如：主笔手动调整第一部分重点指标表述，精炼培训成效段落"
                  value={versionSummary}
                  onChange={(e) => setVersionSummary(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowSaveVersionModal(false)}
                  className="px-3 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded font-medium shadow-xs cursor-pointer"
                >
                  确认保存快照
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Version History Drawer */}
      {showVersionHistory && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-slate-900/40 backdrop-blur-xs flex justify-end">
          <div className="w-full max-w-md bg-white h-full shadow-2xl flex flex-col border-l border-slate-200">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <h3 className="font-bold text-sm text-slate-800 flex items-center gap-1.5">
                <History className="w-4 h-4 text-blue-700" />
                文稿历史版本归档
              </h3>
              <button
                onClick={() => setShowVersionHistory(false)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {task.drafts.map((ver) => {
                const isCurrent = ver.id === currentDraft?.id;
                return (
                  <div
                    key={ver.id}
                    className={`p-3.5 rounded-lg border text-xs space-y-2 ${
                      isCurrent
                        ? 'border-blue-600 bg-blue-50/50'
                        : 'border-slate-200 hover:border-slate-300 bg-white'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-900">{ver.versionNumber}</span>
                      <span className="text-[11px] text-slate-400">
                        {new Date(ver.createdAt).toLocaleTimeString('zh-CN')}
                      </span>
                    </div>

                    <p className="text-slate-600 text-[11px]">{ver.summary}</p>
                    <div className="text-[10px] text-slate-400">保存人：{ver.author}</div>

                    <div className="pt-1 flex justify-end gap-2">
                      {!isCurrent && (
                        <button
                          onClick={() => handleRestoreDraft(ver)}
                          disabled={!canUserEdit}
                          className={`px-2.5 py-1 border rounded text-[11px] font-medium transition-colors ${
                            !canUserEdit
                              ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                              : 'text-blue-700 hover:bg-blue-50 border-blue-200 cursor-pointer'
                          }`}
                          title={!canUserEdit ? `权限受限：当前身份为【${activeRole}】，仅主笔甲可恢复历史版本` : '恢复至此版本 (生成新版本)'}
                        >
                          恢复至此版本 (生成新版本)
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
