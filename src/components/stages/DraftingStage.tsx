import React, { useState, useEffect, useRef } from 'react';
import { 
  Task, 
  ParagraphBlock, 
  DraftVersion, 
  UserRole, 
  EvidenceSnippet, 
  SnapshotMetadata, 
  DraftCandidate,
  RevisionAction, 
  RevisionSuggestion 
} from '../../types';
import { 
  generateDraftFromFactsAndOutline, 
  computeContentHash 
} from '../../services/mockDraftService';
import { 
  requestParagraphRevisionAsync 
} from '../../services/paragraphRevisionAdapter';
import { 
  checkPermission, 
  canEditDraft 
} from '../../services/permissionService';
import { 
  applyDraftContentChange, 
  computeDraftBlocksHash, 
  validateCandidateAcceptance, 
  acceptDraftCandidate 
} from '../../services/draftLifecycleService';
import { 
  computeTextDiff 
} from '../../services/diffService';
import { 
  getStorageError 
} from '../../services/storageService';
import { 
  isValidAuthenticCase, 
  getAuthenticCaseCandidates 
} from '../../services/reviewCoordinationService';
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
  Edit3, 
  Copy, 
  CheckCircle2, 
  RefreshCw, 
  AlertTriangle, 
  CornerDownRight, 
  Tag, 
  Lock,
  Layers
} from 'lucide-react';

interface DraftingStageProps {
  task: Task;
  onUpdateTask: (updated: Partial<Task>) => void;
  onViewSnippet: (snippet: EvidenceSnippet) => void;
  onProceedToNextStage: () => void;
  activeRole: UserRole;
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

  // Inspector tab: 'ai_suggestions' | 'material_evidence'
  const [inspectorTab, setInspectorTab] = useState<'ai_suggestions' | 'material_evidence'>('ai_suggestions');

  // Selected block for editing / inspection
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

  // Draft regeneration / candidate state & strict isolation refs
  const [isGenerating, setIsGenerating] = useState(false);
  const [pendingCandidate, setPendingCandidate] = useState<DraftCandidate | null>(null);
  const draftCancelledRef = useRef(false);
  const [activeDraftRunId, setActiveDraftRunId] = useState<string | null>(null);
  const activeDraftRunIdRef = useRef<string | null>(null);
  const completedCandidateRunIdRef = useRef<string | null>(null);
  const currentTaskIdRef = useRef<string>(task.id);
  const isUnmountedRef = useRef(false);
  const generateTimerRef = useRef<any>(null);

  // Local paragraph revision state
  const [revisionSuggestion, setRevisionSuggestion] = useState<RevisionSuggestion | null>(null);
  const [isRevisionGenerating, setIsRevisionGenerating] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [revisionTargetOrder, setRevisionTargetOrder] = useState<number | null>(null);
  const [customPromptInput, setCustomPromptInput] = useState<string>('');
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  // Refs for revision abort & retry
  const revisionAbortControllerRef = useRef<AbortController | null>(null);
  const lastRevisionRequestRef = useRef<{
    block: ParagraphBlock;
    action: RevisionAction;
    customPrompt?: string;
  } | null>(null);

  // Manual Version Save Modal
  const [showSaveVersionModal, setShowSaveVersionModal] = useState(false);
  const [versionSummary, setVersionSummary] = useState('');

  // Version History Drawer
  const [showVersionHistory, setShowVersionHistory] = useState(false);

  // Cancel generation and clear isolated results if task changes
  useEffect(() => {
    currentTaskIdRef.current = task.id;
    activeDraftRunIdRef.current = null;
    completedCandidateRunIdRef.current = null;
    draftCancelledRef.current = true;
    if (generateTimerRef.current) {
      clearTimeout(generateTimerRef.current);
      generateTimerRef.current = null;
    }
    if (revisionAbortControllerRef.current) {
      revisionAbortControllerRef.current.abort();
      revisionAbortControllerRef.current = null;
    }
    setIsGenerating(false);
    setIsRevisionGenerating(false);
    setRevisionError(null);
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
      if (revisionAbortControllerRef.current) {
        revisionAbortControllerRef.current.abort();
        revisionAbortControllerRef.current = null;
      }
    };
  }, []);

  // Check role permission
  const canUserEdit = canEditDraft(activeRole);
  const isReviewerOnly = activeRole === '审阅乙' || activeRole === '审阅丁';
  const isSupplierOnly = activeRole === '供稿丙';

  // Check if current draft is an immutable snapshot (historical snapshot or finalized)
  const isCurrentDraftImmutable = Boolean(currentDraft?.isHistoricalSnapshot || currentDraft?.isFinal);

  // Prerequisite check: facts, style, outline must all be confirmed
  const isPrerequisiteMet = task.outlineConfirmed && !!task.factSnapshot && task.styleConfirmed;

  // Selected block object
  const activeBlock = currentDraft?.blocks.find((b) => b.id === selectedBlockId) || currentDraft?.blocks[0];

  // Total word count of current draft
  const currentWordCount = currentDraft?.blocks.reduce((acc, b) => acc + b.content.length, 0) || 0;

  // Storage error status
  const currentStorageError = getStorageError();
  const lastSavedTimeStr = task.updatedAt
    ? new Date(task.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '刚刚';

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

  // Handle Generate / Regenerate Whole Draft
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

    setPendingCandidate(null);
    completedCandidateRunIdRef.current = null;
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
          isWorkingDraft: true,
          isHistoricalSnapshot: false,
          isFinal: false,
        };
        onUpdateTask({
          drafts: [initialDraft],
          currentDraftId: initialDraft.id,
          status: '起草中',
        });
      } else {
        // Offer candidate blocks for comparison with captured snapshot metadata
        completedCandidateRunIdRef.current = runId;
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
    completedCandidateRunIdRef.current = null;
    if (generateTimerRef.current) {
      clearTimeout(generateTimerRef.current);
      generateTimerRef.current = null;
    }
    setIsGenerating(false);
    setActiveDraftRunId(null);
    setPendingCandidate(null);
  };

  const handleAcceptCandidate = () => {
    if (!pendingCandidate) return;

    const validation = validateCandidateAcceptance(
      task,
      currentDraft,
      pendingCandidate,
      completedCandidateRunIdRef.current,
      activeRole
    );

    if (!validation.valid) {
      alert(validation.reason || '候选稿校验失败，无法采纳！');
      setPendingCandidate(null);
      completedCandidateRunIdRef.current = null;
      return;
    }

    try {
      // 采纳前自动归档旧稿为只读历史快照，并创建新工作稿
      const { updatedTask, workingDraft } = acceptDraftCandidate(
        task,
        currentDraft,
        pendingCandidate,
        activeRole
      );
      onUpdateTask({
        drafts: updatedTask.drafts,
        currentDraftId: workingDraft.id,
        isFinalized: updatedTask.isFinalized,
        status: updatedTask.status,
      });
      setPendingCandidate(null);
      completedCandidateRunIdRef.current = null;
    } catch (err: any) {
      alert(err.message || '采纳候选稿失败');
    }
  };

  // Direct manual block editing
  const handleUpdateBlockContent = (blockId: string, newContent: string) => {
    const perm = checkPermission(activeRole, 'edit_draft');
    if (!perm.allowed) {
      alert(perm.reason || '当前身份无权修改正文');
      return;
    }

    if (!currentDraft) return;

    if (isCurrentDraftImmutable) {
      alert('当前版本属于只读历史快照或已定稿，不可直接修改。请点击顶部“基于此稿继续编辑”创建新工作稿后再行修改。');
      return;
    }

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

  // Fork a new working draft from immutable snapshot/final
  const handleForkWorkingDraftFromImmutable = () => {
    const perm = checkPermission(activeRole, 'edit_draft');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可创建工作草稿');
      return;
    }

    if (!currentDraft) return;

    try {
      const { updatedTask, workingDraft } = applyDraftContentChange(
        task,
        currentDraft.id,
        (blocks) => blocks,
        '基于只读快照继续编辑创建工作草稿',
        activeRole
      );
      onUpdateTask({
        drafts: updatedTask.drafts,
        currentDraftId: workingDraft.id,
        isFinalized: updatedTask.isFinalized,
        status: updatedTask.status,
      });
    } catch (err: any) {
      alert(err.message || '创建新工作草稿失败');
    }
  };

  // Local AI paragraph revision request (cancellable, async adapter, explicit target binding)
  const executeRevisionRequest = async (
    targetBlock: ParagraphBlock,
    action: RevisionAction,
    customPrompt?: string
  ) => {
    if (!currentDraft) return;

    // Abort previous running revision request if any
    if (revisionAbortControllerRef.current) {
      revisionAbortControllerRef.current.abort();
    }
    const abortController = new AbortController();
    revisionAbortControllerRef.current = abortController;

    // Record last request for retry
    lastRevisionRequestRef.current = {
      block: targetBlock,
      action,
      customPrompt,
    };

    const runId = `REV-RUN-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    setIsRevisionGenerating(true);
    setRevisionError(null);
    setRevisionTargetOrder(targetBlock.order);

    // Make sure inspector is visible and switched to suggestions tab
    setShowRightInspector(true);
    setInspectorTab('ai_suggestions');

    try {
      const suggestion = await requestParagraphRevisionAsync({
        block: targetBlock,
        action,
        customPrompt,
        task,
        currentDraft,
        runId,
        signal: abortController.signal,
        delayMs: 350,
      });

      // Strict validation against current task boundary
      if (currentTaskIdRef.current !== task.id) {
        return;
      }

      setRevisionSuggestion(suggestion);
      setIsRevisionGenerating(false);
      revisionAbortControllerRef.current = null;
    } catch (err: any) {
      if (err.name === 'AbortError' || err.message?.includes('取消')) {
        // Cleanly aborted by user, no error banner
        setIsRevisionGenerating(false);
        return;
      }
      setRevisionError(err.message || '生成修改建议失败，请重试');
      setIsRevisionGenerating(false);
    }
  };

  // Trigger shortcut revision
  const handleRequestRevision = (action: RevisionAction) => {
    if (!activeBlock) return;
    executeRevisionRequest(activeBlock, action);
  };

  // Trigger custom prompt revision
  const handleRequestCustomRevision = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!activeBlock) return;
    const prompt = customPromptInput.trim();
    if (!prompt) {
      alert('请输入您想怎样修改这一段的指令，或点击下方示例指令快速填入。');
      return;
    }
    executeRevisionRequest(activeBlock, 'custom', prompt);
  };

  // Cancel in-flight revision request
  const handleCancelRevision = () => {
    if (revisionAbortControllerRef.current) {
      revisionAbortControllerRef.current.abort();
      revisionAbortControllerRef.current = null;
    }
    setIsRevisionGenerating(false);
    setRevisionError(null);
  };

  // Retry failed revision request
  const handleRetryRevision = () => {
    if (lastRevisionRequestRef.current) {
      const { block, action, customPrompt } = lastRevisionRequestRef.current;
      executeRevisionRequest(block, action, customPrompt);
    }
  };

  // Re-generate suggestion based on current content
  const handleRegenerateRevision = () => {
    if (!revisionSuggestion || !currentDraft) return;
    const targetBlock = currentDraft.blocks.find((b) => b.id === revisionSuggestion.targetBlockId);
    if (!targetBlock) {
      alert('未找到原目标段落，无法重新生成。');
      return;
    }
    executeRevisionRequest(targetBlock, revisionSuggestion.action, revisionSuggestion.customPrompt);
  };

  // Adopt revision into target block
  const handleAdoptRevision = () => {
    if (!revisionSuggestion || !currentDraft) return;

    const perm = checkPermission(activeRole, 'adopt_revision');
    if (!perm.allowed) {
      alert(perm.reason || '当前身份无权采纳修改建议');
      return;
    }

    if (revisionSuggestion.isUnsupportedPrompt) {
      alert('当前建议属于未支持的自定义指令，无法采纳至正文。');
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
      alert('建议失效：该修改建议基于其他草稿版本生成，当前工作版本已变更，不可直接采纳。');
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
      const actionName =
        revisionSuggestion.action === 'custom'
          ? `执行自定义改写【${revisionSuggestion.customPrompt}】`
          : `采纳局部修改建议（${revisionSuggestion.action}）`;

      const { updatedTask, workingDraft } = applyDraftContentChange(
        task,
        currentDraft.id,
        (blocks) =>
          blocks.map((b) =>
            b.id === revisionSuggestion.targetBlockId
              ? { ...b, content: revisionSuggestion.suggestedText, updatedAt: new Date().toISOString() }
              : b
          ),
        actionName,
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

  // Discard suggestion
  const handleDiscardRevision = () => {
    setRevisionSuggestion(null);
  };

  // Copy suggestion text only to clipboard (does not modify draft)
  const handleCopyRevision = () => {
    if (!revisionSuggestion) return;
    try {
      if (navigator?.clipboard?.writeText) {
        navigator.clipboard.writeText(revisionSuggestion.suggestedText);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = revisionSuggestion.suggestedText;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopyFeedback('已复制建议文本到剪贴板！');
      setTimeout(() => setCopyFeedback(null), 2500);
    } catch (err) {
      setCopyFeedback('复制失败，请手动选中文本复制');
      setTimeout(() => setCopyFeedback(null), 2500);
    }
  };

  // Jump/scroll back to original target block
  const handleJumpToTargetBlock = (targetBlockId: string) => {
    setSelectedBlockId(targetBlockId);
    const el = document.getElementById(`block-card-${targetBlockId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      frozenReviewComments: JSON.parse(JSON.stringify(task.reviewComments || [])), // 冻结保存时刻的审阅意见快照
    };

    onUpdateTask({
      drafts: [snapshotVersion, ...task.drafts],
      currentDraftId: snapshotVersion.id,
    });

    setShowSaveVersionModal(false);
    setVersionSummary('');
  };

  // Restore history draft (creates new working draft with deep-copied snapshot metadata)
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

  // Section outline metadata helper
  const activeSection = task.outline.find((s) => s.id === activeBlock?.sectionId);

  return (
    <div className="space-y-4">
      {/* 1. Top Workspace Banner: Document info, Real Save status, Version tag, Main actions */}
      <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-2xs flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="flex items-start sm:items-center gap-3">
          <div className="w-9 h-9 rounded bg-blue-50 text-blue-700 flex items-center justify-center shrink-0 border border-blue-100">
            <PenTool className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-bold text-slate-900 tracking-tight">
                {task.title || '公文起草与依据追溯工作台'}
              </h2>
              {currentDraft && (
                <span
                  className={`text-[11px] px-2.5 py-0.5 rounded font-mono font-medium flex items-center gap-1 ${
                    currentDraft.isFinal
                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                      : currentDraft.isHistoricalSnapshot
                      ? 'bg-amber-100 text-amber-800 border border-amber-300'
                      : 'bg-blue-100 text-blue-800 border border-blue-200'
                  }`}
                  title={
                    currentDraft.isFinal
                      ? '已正式定稿归档（只读不可篡改）'
                      : currentDraft.isHistoricalSnapshot
                      ? '历史快照版本（只读不可篡改）'
                      : '当前可编辑工作稿'
                  }
                >
                  {currentDraft.isFinal ? <Lock className="w-3 h-3" /> : currentDraft.isHistoricalSnapshot ? <History className="w-3 h-3" /> : <Edit3 className="w-3 h-3" />}
                  <span>{currentDraft.versionNumber}</span>
                  <span className="text-[10px] opacity-75">
                    {currentDraft.isFinal ? '· 定稿快照' : currentDraft.isHistoricalSnapshot ? '· 历史快照' : '· 工作稿'}
                  </span>
                </span>
              )}
            </div>

            {/* Word count & Real save status */}
            <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-500 flex-wrap">
              <span>
                统计字数：<strong className="text-slate-800 font-mono font-semibold">{currentWordCount}</strong> / 目标 <span className="font-mono">{task.targetWordCount}</span> 字
              </span>
              <span className="text-slate-300">|</span>

              {/* Real Local Storage Save Status */}
              <div className="flex items-center gap-1.5 font-medium">
                {currentStorageError ? (
                  <span className="text-rose-700 bg-rose-50 px-2 py-0.5 rounded border border-rose-200 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3 text-rose-600" />
                    <span>自动保存异常（本地配额不足）</span>
                  </span>
                ) : (
                  <span className="text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                    <span>工作稿已实时存盘（{lastSavedTimeStr}）</span>
                  </span>
                )}
                <span className="text-slate-400 text-[10px]">（工作稿自动存盘 · 里程碑可保存快照）</span>
              </div>
            </div>
          </div>
        </div>

        {/* Top Action Buttons */}
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {isReviewerOnly && (
            <span className="text-xs text-amber-800 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded flex items-center gap-1 font-medium">
              <ShieldAlert className="w-3.5 h-3.5 text-amber-600" />
              <span>审阅身份（只读浏览/意见模式）</span>
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
                  ? `权限受限：当前身份为【${activeRole}】，仅主笔甲可起草正文`
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
              {/* If on immutable draft, offer "Fork new working draft" */}
              {isCurrentDraftImmutable && (
                <button
                  onClick={handleForkWorkingDraftFromImmutable}
                  disabled={!canUserEdit}
                  className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded text-xs font-medium flex items-center gap-1 shadow-xs cursor-pointer disabled:opacity-40"
                  title="以此只读快照为基准，创建新的可编辑工作草稿"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>基于此稿继续编辑</span>
                </button>
              )}

              <button
                onClick={() => setShowSaveVersionModal(true)}
                disabled={!canUserEdit || isCurrentDraftImmutable}
                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded text-xs font-medium flex items-center gap-1 cursor-pointer disabled:opacity-40"
                title={
                  !canUserEdit
                    ? `权限受限：当前身份为【${activeRole}】，仅主笔甲可保存版本`
                    : isCurrentDraftImmutable
                    ? '当前已是只读快照版本，无需重复保存快照'
                    : '将当前工作稿保存为只读历史版本快照'
                }
              >
                <Save className="w-3.5 h-3.5 text-slate-500" />
                <span>保存版本快照</span>
              </button>

              <button
                onClick={() => setShowVersionHistory(true)}
                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded text-xs font-medium flex items-center gap-1 cursor-pointer"
                title="查看与恢复历史版本快照"
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
                    : '重新生成整稿候选稿'
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

      {/* Immutable Draft Alert Notice */}
      {isCurrentDraftImmutable && currentDraft && (
        <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg text-xs text-amber-900 flex flex-col sm:flex-row sm:items-center justify-between gap-2 shadow-2xs">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-amber-600 shrink-0" />
            <div>
              <span className="font-bold">只读快照保护：</span>
              <span>
                当前查看的是【{currentDraft.versionNumber}】（{currentDraft.isFinal ? '正式定稿归档' : '历史快照'}），内容只读不可直接修改。
              </span>
            </div>
          </div>
          {canUserEdit && (
            <button
              onClick={handleForkWorkingDraftFromImmutable}
              className="px-3 py-1 bg-amber-700 hover:bg-amber-800 text-white rounded text-xs font-semibold flex items-center gap-1 cursor-pointer shrink-0 self-start sm:self-auto"
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>基于此稿继续编辑（创建新工作稿）</span>
            </button>
          )}
        </div>
      )}

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
        <div className="bg-amber-50 border-2 border-amber-300 p-4 rounded-lg flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-xs">
          <div>
            <h4 className="font-bold text-xs text-amber-900 flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-amber-600" />
              已生成新一轮候选文稿（基于最新已确认事实）
            </h4>
            <p className="text-[11px] text-amber-800 mt-0.5">
              请主笔审阅是否采纳替换现有文稿。采纳后旧工作稿将自动归档为只读历史快照，并生成新工作稿。
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
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
          <div className="col-span-12 lg:col-span-3 bg-white rounded-lg border border-slate-200 shadow-2xs p-4 space-y-3 sticky top-18 max-h-[82vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <span className="font-bold text-xs text-slate-800 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-blue-700" />
                章节大纲导航
              </span>
              <button
                onClick={() => setShowLeftNav(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded hover:bg-slate-100 cursor-pointer"
                title="折叠导航栏"
                aria-label="折叠导航栏"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-1.5">
              {task.outline.map((sec, idx) => {
                const firstBlockOfSec = currentDraft?.blocks.find((b) => b.sectionId === sec.id);
                const isCurrentSecActive = activeBlock?.sectionId === sec.id;

                return (
                  <div
                    key={sec.id}
                    onClick={() => {
                      if (firstBlockOfSec) {
                        setSelectedBlockId(firstBlockOfSec.id);
                        const el = document.getElementById(`block-card-${firstBlockOfSec.id}`);
                        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      }
                    }}
                    className={`p-2.5 rounded border transition-colors cursor-pointer text-xs ${
                      isCurrentSecActive
                        ? 'bg-blue-50/80 border-blue-300 text-blue-900 font-medium'
                        : 'bg-slate-50 hover:bg-slate-100 border-slate-200/70 text-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="line-clamp-1 font-semibold">
                        {idx + 1}. {sec.title}
                      </span>
                      {isCurrentSecActive && (
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-600 shrink-0" />
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-1 flex justify-between">
                      <span>建议：{sec.suggestedWordCount}字</span>
                      <span>{sec.assignedFactIds.length}项依据</span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="pt-2 border-t border-slate-100 text-[11px] text-slate-500 space-y-1">
              <div>当前正文字数：<strong className="text-slate-800 font-mono">{currentWordCount}</strong> 字</div>
              <div>目标总字数：<strong className="text-slate-800 font-mono">{task.targetWordCount}</strong> 字</div>
            </div>
          </div>
        ) : (
          <div className="col-span-1 hidden lg:block">
            <button
              onClick={() => setShowLeftNav(true)}
              className="p-2 bg-white border border-slate-200 rounded shadow-xs text-slate-600 hover:text-slate-900 cursor-pointer"
              title="展开章节导航"
              aria-label="展开章节导航"
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
                <h1 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight font-serif leading-snug">
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
                  const isRevisionTarget = revisionSuggestion?.targetBlockId === block.id;
                  const section = task.outline.find((s) => s.id === block.sectionId);
                  const isSectionFirstBlock = idx === 0 || currentDraft.blocks[idx - 1]?.sectionId !== block.sectionId;

                  return (
                    <div key={block.id} id={`block-card-${block.id}`} className="space-y-2">
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
                        className={`group relative p-3.5 rounded-lg transition-all cursor-text ${
                          isSelected
                            ? 'bg-blue-50/30 border-2 border-blue-600 shadow-xs ring-2 ring-blue-100'
                            : isRevisionTarget
                            ? 'bg-amber-50/30 border-2 border-amber-400 shadow-2xs'
                            : 'hover:bg-slate-50/80 border border-slate-200/80'
                        }`}
                      >
                        {/* Status badge when targeted by pending suggestion */}
                        {isRevisionTarget && (
                          <div className="absolute top-2 right-2 flex items-center gap-1 text-[10px] bg-amber-100 text-amber-800 border border-amber-300 px-2 py-0.5 rounded font-medium">
                            <Sparkles className="w-3 h-3 text-amber-600" />
                            <span>AI建议修改目标段落</span>
                          </div>
                        )}

                        {/* Paragraph content (editable in working draft, readonly in snapshot/reviewer) */}
                        <textarea
                          rows={Math.max(2, Math.ceil(block.content.length / 36))}
                          value={block.content}
                          readOnly={isCurrentDraftImmutable || !canUserEdit}
                          disabled={!canUserEdit && !isReviewerOnly}
                          onChange={(e) => handleUpdateBlockContent(block.id, e.target.value)}
                          className={`w-full bg-transparent resize-none focus:outline-hidden text-slate-900 text-base leading-relaxed text-justify indent-8 font-normal font-sans ${
                            isCurrentDraftImmutable ? 'cursor-default select-text' : ''
                          }`}
                        />

                        {/* Block metadata & facts pill */}
                        <div className="mt-2.5 flex flex-wrap items-center justify-between text-[11px] text-slate-400 pt-2 border-t border-slate-100">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-mono text-[11px] text-slate-500 font-medium">
                              第{block.order || idx + 1}段
                            </span>
                            {blocksNeedingReview.some((b) => b.id === block.id) && (
                              <span className="inline-flex items-center gap-1 text-[10px] bg-rose-50 text-rose-700 border border-rose-200 px-1.5 py-0.5 rounded font-medium">
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
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-100/90 text-blue-900 hover:bg-blue-200 font-medium cursor-pointer transition-colors"
                                  title={`点击反查材料出处：${fact.metric}`}
                                >
                                  <span>{fact.metric}: {fact.value}{fact.unit}</span>
                                  <ExternalLink className="w-2.5 h-2.5 opacity-70" />
                                </button>
                              );
                            })}
                          </div>

                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-slate-400 group-hover:text-slate-600 transition-colors">
                              {isSelected ? '当前正在定位' : '点击定位段落'}
                            </span>
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

        {/* Right: Collapsible Inspector with "AI修改建议" and "材料依据" Tabs */}
        {showRightInspector ? (
          <div className="col-span-12 lg:col-span-3 bg-white rounded-lg border border-slate-200 shadow-2xs p-4 space-y-4 sticky top-18 max-h-[82vh] overflow-y-auto">
            {/* Header with Tabs and Collapse toggle */}
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded text-xs font-medium">
                <button
                  onClick={() => setInspectorTab('ai_suggestions')}
                  className={`px-2.5 py-1 rounded transition-colors cursor-pointer ${
                    inspectorTab === 'ai_suggestions'
                      ? 'bg-white text-blue-800 shadow-2xs font-semibold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  AI修改建议
                </button>
                <button
                  onClick={() => setInspectorTab('material_evidence')}
                  className={`px-2.5 py-1 rounded transition-colors cursor-pointer ${
                    inspectorTab === 'material_evidence'
                      ? 'bg-white text-blue-800 shadow-2xs font-semibold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  材料依据
                </button>
              </div>

              <button
                onClick={() => setShowRightInspector(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded hover:bg-slate-100 cursor-pointer"
                title="折叠辅助面板"
                aria-label="折叠辅助面板"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            {/* Currently Focused Block Context */}
            {activeBlock ? (
              <div className="space-y-4">
                {/* Paragraph Context Pill */}
                <div className="p-2.5 bg-slate-50 rounded-md border border-slate-200/80 text-xs space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-800">
                      章节：{activeSection?.title || '正文'}
                    </span>
                    <span className="font-mono text-blue-700 font-bold">第{activeBlock.order}段</span>
                  </div>
                  <div className="text-[11px] text-slate-500 line-clamp-2">
                    摘要：“{activeBlock.content.slice(0, 50)}...”
                  </div>
                  <div className="pt-1 border-t border-slate-200/50 text-[10px] text-slate-500 flex items-center gap-1">
                    <Tag className="w-3 h-3 text-slate-400" />
                    <span>操作范围：仅限第{activeBlock.order}段（局部改写，不影响其他段落）</span>
                  </div>
                </div>

                {/* TAB 1: AI 修改建议 */}
                {inspectorTab === 'ai_suggestions' && (
                  <div className="space-y-4">
                    {/* Shortcut Revision Operations */}
                    <div className="space-y-2">
                      <span className="text-[11px] font-bold text-slate-700 block">快捷精修操作：</span>
                      <div className="grid grid-cols-2 gap-1.5 text-xs">
                        <button
                          onClick={() => handleRequestRevision('compress')}
                          disabled={isRevisionGenerating}
                          className="px-2.5 py-1.5 bg-slate-100 hover:bg-blue-50 text-slate-700 hover:text-blue-800 border border-slate-200 rounded text-center transition-colors cursor-pointer font-medium disabled:opacity-50"
                          title="精简常规修饰语约30%，严密保留事实数据与单位"
                        >
                          压缩精炼
                        </button>
                        <button
                          onClick={() => handleRequestRevision('expand')}
                          disabled={isRevisionGenerating}
                          className="px-2.5 py-1.5 bg-slate-100 hover:bg-blue-50 text-slate-700 hover:text-blue-800 border border-slate-200 rounded text-center transition-colors cursor-pointer font-medium disabled:opacity-50"
                          title="补充举措闭环机制；无真实案例时提示补充材料并避免虚构"
                        >
                          补充表达
                        </button>
                        <button
                          onClick={() => handleRequestRevision('formal')}
                          disabled={isRevisionGenerating}
                          className="px-2.5 py-1.5 bg-slate-100 hover:bg-blue-50 text-slate-700 hover:text-blue-800 border border-slate-200 rounded text-center transition-colors cursor-pointer font-medium disabled:opacity-50"
                          title="转换为标准公文庄重句式，提升规范度"
                        >
                          正式文风
                        </button>
                        <button
                          onClick={() => handleRequestRevision('highlight')}
                          disabled={isRevisionGenerating}
                          className="px-2.5 py-1.5 bg-slate-100 hover:bg-blue-50 text-slate-700 hover:text-blue-800 border border-slate-200 rounded text-center transition-colors cursor-pointer font-medium disabled:opacity-50"
                          title="增设重点工作成效标识"
                        >
                          突出重点
                        </button>
                      </div>
                    </div>

                    {/* Custom Prompt Input Box */}
                    <form onSubmit={handleRequestCustomRevision} className="space-y-2 pt-2 border-t border-slate-100">
                      <label className="text-[11px] font-bold text-slate-700 block">
                        我想怎样修改这一段：
                      </label>
                      <textarea
                        rows={2}
                        value={customPromptInput}
                        onChange={(e) => setCustomPromptInput(e.target.value)}
                        placeholder="例如：精简表达并保留数据、改成面向单位负责人的汇报口吻..."
                        className="w-full p-2 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500 focus:outline-hidden"
                      />

                      {/* Example Instruction Badges */}
                      <div className="space-y-1">
                        <span className="text-[10px] text-slate-400">示例指令：</span>
                        <div className="flex flex-wrap gap-1">
                          <button
                            type="button"
                            onClick={() => setCustomPromptInput('精简表达并保留数据')}
                            className="text-[10px] bg-slate-100 hover:bg-blue-50 text-slate-600 hover:text-blue-700 px-2 py-0.5 rounded border border-slate-200 cursor-pointer transition-colors"
                          >
                            精简表达并保留数据
                          </button>
                          <button
                            type="button"
                            onClick={() => setCustomPromptInput('改成面向单位负责人的汇报口吻')}
                            className="text-[10px] bg-slate-100 hover:bg-blue-50 text-slate-600 hover:text-blue-700 px-2 py-0.5 rounded border border-slate-200 cursor-pointer transition-colors"
                          >
                            改成面向单位负责人的汇报口吻
                          </button>
                          <button
                            type="button"
                            onClick={() => setCustomPromptInput('突出成效并删减泛泛修饰')}
                            className="text-[10px] bg-slate-100 hover:bg-blue-50 text-slate-600 hover:text-blue-700 px-2 py-0.5 rounded border border-slate-200 cursor-pointer transition-colors"
                          >
                            突出成效并删减泛泛修饰
                          </button>
                        </div>
                      </div>

                      <div className="flex justify-end pt-1">
                        <button
                          type="submit"
                          disabled={isRevisionGenerating || !customPromptInput.trim()}
                          className="px-3 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold shadow-2xs flex items-center gap-1 cursor-pointer disabled:opacity-50"
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          <span>生成建议</span>
                        </button>
                      </div>
                    </form>

                    {/* Loading State with Cancel */}
                    {isRevisionGenerating && (
                      <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-blue-900 flex items-center gap-1.5">
                            <RefreshCw className="w-3.5 h-3.5 text-blue-600 animate-spin" />
                            正在为第 {revisionTargetOrder || activeBlock.order} 段生成修改建议...
                          </span>
                          <button
                            onClick={handleCancelRevision}
                            className="text-[11px] text-rose-700 bg-white border border-rose-300 hover:bg-rose-50 px-2 py-0.5 rounded cursor-pointer font-medium"
                          >
                            取消
                          </button>
                        </div>
                        <p className="text-[10px] text-blue-700">
                          本地模拟生成中，现有正文内容保持不变。取消后不会改写正文。
                        </p>
                      </div>
                    )}

                    {/* Failure / Error State with Retry */}
                    {revisionError && (
                      <div className="p-3 bg-rose-50 border border-rose-300 rounded-lg text-xs space-y-2">
                        <div className="font-bold text-rose-900 flex items-center gap-1">
                          <AlertTriangle className="w-4 h-4 text-rose-600" />
                          <span>生成失败</span>
                        </div>
                        <p className="text-[11px] text-rose-800">{revisionError}</p>
                        <div className="flex justify-end">
                          <button
                            onClick={handleRetryRevision}
                            className="px-2.5 py-1 bg-rose-700 hover:bg-rose-800 text-white rounded text-xs font-medium cursor-pointer"
                          >
                            重试生成
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Copy toast feedback */}
                    {copyFeedback && (
                      <div className="p-2 bg-emerald-50 border border-emerald-300 rounded text-xs text-emerald-800 font-medium flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                        <span>{copyFeedback}</span>
                      </div>
                    )}

                    {/* Revision Diff Comparison Box */}
                    {revisionSuggestion && (() => {
                      const targetBlock = currentDraft?.blocks.find((b) => b.id === revisionSuggestion.targetBlockId);
                      const isModifiedAfter = targetBlock && targetBlock.content !== revisionSuggestion.baseContent;
                      const isDifferentBlockSelected = activeBlock && activeBlock.id !== revisionSuggestion.targetBlockId;

                      const diffSegments =
                        revisionSuggestion.diffSegments ||
                        computeTextDiff(revisionSuggestion.baseContent, revisionSuggestion.suggestedText);

                      return (
                        <div className="p-3.5 bg-blue-50/70 border-2 border-blue-200 rounded-lg space-y-3 text-xs shadow-2xs">
                          {/* Suggestion Header */}
                          <div className="flex items-center justify-between pb-2 border-b border-blue-200/80">
                            <div className="font-bold text-blue-900 flex items-center gap-1">
                              <Sparkles className="w-4 h-4 text-blue-600" />
                              <span>修改建议对比</span>
                            </div>
                            <span className="text-[10px] bg-blue-200 text-blue-800 px-2 py-0.5 rounded font-mono font-medium">
                              {revisionSuggestion.action === 'custom'
                                ? `指令：${revisionSuggestion.customPrompt?.slice(0, 10)}...`
                                : revisionSuggestion.action}
                            </span>
                          </div>

                          {/* Target binding info */}
                          <div className="text-[11px] text-slate-700 bg-white p-2 rounded border border-blue-100 flex items-center justify-between">
                            <span>
                              建议绑定目标：<strong className="text-blue-900 font-bold">第{targetBlock?.order || revisionSuggestion.targetBlockOrder || '?'}段</strong>
                            </span>
                            <span className="font-mono text-[10px] text-slate-400">
                              {targetBlock?.id}
                            </span>
                          </div>

                          {/* When user selected another block while suggestion targets another */}
                          {isDifferentBlockSelected && (
                            <div className="p-2 bg-amber-50 border border-amber-300 rounded text-[11px] text-amber-900 space-y-1">
                              <div className="font-semibold flex items-center gap-1">
                                <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                                <span>光标段落与建议目标不一致</span>
                              </div>
                              <p className="text-[10px] text-amber-800 leading-normal">
                                当前光标位于第<strong>{activeBlock?.order}段</strong>，采纳建议将<strong>仅更新原目标第{targetBlock?.order || revisionSuggestion.targetBlockOrder}段</strong>，不会误改写当前光标段落。
                              </p>
                              {targetBlock && (
                                <button
                                  onClick={() => handleJumpToTargetBlock(targetBlock.id)}
                                  className="text-[10px] text-blue-700 hover:underline font-bold flex items-center gap-0.5 cursor-pointer pt-0.5"
                                >
                                  <CornerDownRight className="w-3 h-3" />
                                  <span>回到目标第{targetBlock.order}段</span>
                                </button>
                              )}
                            </div>
                          )}

                          {/* Base modification conflict invalidation alert */}
                          {isModifiedAfter && (
                            <div className="p-2 bg-rose-50 border border-rose-300 rounded text-[11px] text-rose-900 space-y-1">
                              <div className="font-bold flex items-center gap-1 text-rose-800">
                                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                                <span>建议已失效（基准内容已被人工修改）</span>
                              </div>
                              <p className="text-[10px] text-rose-800 leading-normal">
                                目标段落自建议生成后已被人工编辑修改。为防止直接覆盖人工编写的内容，旧建议已锁定无法采纳。请重新基于当前文本生成建议。
                              </p>
                            </div>
                          )}

                          {/* Unsupported Prompt Notice */}
                          {revisionSuggestion.isUnsupportedPrompt && (
                            <div className="p-2 bg-amber-50 border border-amber-300 rounded text-[11px] text-amber-900 space-y-1">
                              <div className="font-bold text-amber-900 flex items-center gap-1">
                                <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
                                <span>未支持的演示指令</span>
                              </div>
                              <p className="text-[10px] text-amber-800 leading-normal">
                                {revisionSuggestion.unsupportedPromptNotice}
                              </p>
                            </div>
                          )}

                          {/* Text Diff Comparison: Original vs Suggested */}
                          <div className="space-y-2">
                            {/* Original Text at Generation */}
                            <div className="space-y-1">
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                生成时原文（基准）：
                              </span>
                              <div className="p-2 bg-white/90 rounded border border-slate-200 text-slate-600 text-[11px] leading-relaxed select-text font-serif">
                                {revisionSuggestion.baseContent}
                              </div>
                            </div>

                            {/* Suggested Text */}
                            <div className="space-y-1">
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] font-bold text-blue-900 uppercase tracking-wider">
                                  AI建议修改：
                                </span>
                                <span className="text-[10px] text-slate-500">
                                  字数变化：原 {revisionSuggestion.baseContent.length} 字 → 现 {revisionSuggestion.suggestedText.length} 字 (
                                  {revisionSuggestion.suggestedText.length - revisionSuggestion.baseContent.length >= 0 ? '+' : ''}
                                  {revisionSuggestion.suggestedText.length - revisionSuggestion.baseContent.length}字)
                                </span>
                              </div>
                              <div className="p-2.5 bg-white rounded border border-blue-200 text-slate-900 text-[11px] leading-relaxed select-text font-serif">
                                {revisionSuggestion.suggestedText}
                              </div>
                            </div>

                            {/* Visible Diff View with Explicit Badges */}
                            <div className="space-y-1 pt-1">
                              <span className="text-[10px] font-bold text-slate-600 block">
                                可见改动差异（含文字标识）：
                              </span>
                              <div className="p-2.5 bg-white rounded border border-slate-200 text-[11px] leading-relaxed text-slate-800 select-text font-serif">
                                {diffSegments.map((seg, sIdx) => {
                                  if (seg.type === 'equal') {
                                    return <span key={sIdx}>{seg.text}</span>;
                                  }
                                  if (seg.type === 'added') {
                                    return (
                                      <span
                                        key={sIdx}
                                        className="bg-emerald-100 text-emerald-900 px-1 py-0.5 mx-0.5 rounded font-medium border-b-2 border-emerald-500 inline-flex items-center gap-0.5"
                                        title="新增内容"
                                      >
                                        <span className="text-[9px] font-bold bg-emerald-300 text-emerald-900 px-0.5 rounded font-sans">
                                          +新增
                                        </span>
                                        <span>{seg.text}</span>
                                      </span>
                                    );
                                  }
                                  if (seg.type === 'removed') {
                                    return (
                                      <span
                                        key={sIdx}
                                        className="bg-rose-100 text-rose-900 line-through px-1 py-0.5 mx-0.5 rounded opacity-75 border-b-2 border-rose-400 inline-flex items-center gap-0.5"
                                        title="删减内容"
                                      >
                                        <span className="text-[9px] font-bold bg-rose-300 text-rose-900 px-0.5 rounded no-underline font-sans">
                                          -删减
                                        </span>
                                        <span>{seg.text}</span>
                                      </span>
                                    );
                                  }
                                  return null;
                                })}
                              </div>
                            </div>
                          </div>

                          {/* Revision Explanation & Facts check */}
                          <div className="space-y-1.5 pt-1 text-[11px] text-blue-900 bg-white/60 p-2 rounded border border-blue-100">
                            <div>
                              <strong>改写目的与说明：</strong>
                              <span className="text-slate-700">{revisionSuggestion.diffExplanation}</span>
                            </div>

                            {revisionSuggestion.needsVerificationNotes && revisionSuggestion.needsVerificationNotes.length > 0 && (
                              <div className="pt-1 border-t border-blue-100/80">
                                <strong className="text-amber-800">需核对项：</strong>
                                <ul className="list-disc list-inside mt-0.5 space-y-0.5 text-[10px] text-amber-900">
                                  {revisionSuggestion.needsVerificationNotes.map((note, nIdx) => (
                                    <li key={nIdx}>{note}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>

                          {/* Action Buttons: Adopt, Discard, Regenerate, Copy */}
                          <div className="pt-2 flex flex-wrap items-center justify-between gap-1.5 border-t border-blue-200/80">
                            <div className="flex gap-1.5">
                              <button
                                onClick={handleCopyRevision}
                                className="px-2.5 py-1 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 rounded text-[11px] font-medium flex items-center gap-1 cursor-pointer"
                                title="复制建议文本至剪贴板（不改写正文）"
                              >
                                <Copy className="w-3 h-3 text-slate-500" />
                                <span>复制建议</span>
                              </button>
                              <button
                                onClick={handleRegenerateRevision}
                                disabled={isRevisionGenerating}
                                className="px-2 py-1 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 rounded text-[11px] font-medium flex items-center gap-1 cursor-pointer disabled:opacity-50"
                                title="以当前段落重新生成建议"
                              >
                                <RefreshCw className="w-3 h-3 text-slate-500" />
                                <span>重新生成</span>
                              </button>
                            </div>

                            <div className="flex gap-1.5">
                              <button
                                onClick={handleDiscardRevision}
                                className="px-2.5 py-1 bg-white hover:bg-slate-50 border border-slate-300 text-slate-600 rounded text-[11px] cursor-pointer"
                                title="放弃此建议（正文不改变）"
                              >
                                放弃
                              </button>
                              <button
                                onClick={handleAdoptRevision}
                                disabled={
                                  Boolean(isModifiedAfter) ||
                                  Boolean(revisionSuggestion.isUnsupportedPrompt) ||
                                  !canUserEdit
                                }
                                className={`px-3 py-1 rounded text-[11px] font-semibold shadow-xs flex items-center gap-1 ${
                                  isModifiedAfter || revisionSuggestion.isUnsupportedPrompt || !canUserEdit
                                    ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                                    : 'bg-blue-700 hover:bg-blue-800 text-white cursor-pointer'
                                }`}
                                title={
                                  !canUserEdit
                                    ? `权限受限：当前身份为【${activeRole}】，仅主笔甲可采纳修改正文`
                                    : isModifiedAfter
                                    ? '目标段落基准自生成后已被人工编辑修改，无法采纳覆盖'
                                    : revisionSuggestion.isUnsupportedPrompt
                                    ? '未支持的自定义指令，无法采纳'
                                    : `采纳替换第${targetBlock?.order || revisionSuggestion.targetBlockOrder}段`
                                }
                              >
                                <Check className="w-3 h-3" />
                                <span>采纳到目标段落</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* TAB 2: 材料依据 */}
                {inspectorTab === 'material_evidence' && (
                  <div className="space-y-3">
                    <span className="text-[11px] font-bold text-slate-700 block">
                      第{activeBlock.order}段关联事实与出处：
                    </span>

                    {activeBlock.referencedFactIds.length > 0 ? (
                      activeBlock.referencedFactIds.map((factId) => {
                        const fact = task.facts.find((f) => f.id === factId);
                        const snippet = task.snippets.find((s) => s.id === fact?.primaryEvidenceId);
                        if (!fact) return null;

                        // Check frozen snapshot value if exists
                        const snapItem = currentDraft?.snapshotMetadata?.factSnapshot?.items?.find(
                          (item) => item.factId === fact.id
                        );
                        const hasSnapshotDiff = snapItem && (snapItem.value !== fact.value || snapItem.unit !== fact.unit);

                        return (
                          <div
                            key={fact.id}
                            className="p-2.5 bg-slate-50 rounded-md border border-slate-200 text-xs space-y-1.5"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-bold text-slate-900">{fact.metric}</span>
                              <span
                                className={`text-[10px] px-1.5 py-0.2 rounded font-medium ${
                                  fact.status === 'confirmed'
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : 'bg-amber-100 text-amber-800'
                                }`}
                              >
                                {fact.status === 'confirmed' ? '已核准' : '待确认'}
                              </span>
                            </div>

                            <div className="text-[11px] text-blue-700 font-semibold flex items-center justify-between">
                              <span>当前事实值：{fact.value} {fact.unit}</span>
                              <span className="text-[10px] text-slate-400 font-normal">{fact.period}</span>
                            </div>

                            {/* Frozen snapshot check comparison */}
                            {snapItem && (
                              <div className="text-[10px] text-slate-500 bg-white p-1 rounded border border-slate-100">
                                <span>稿件冻结依据：{snapItem.value} {snapItem.unit}</span>
                                {hasSnapshotDiff && (
                                  <span className="text-rose-600 font-bold ml-1">（与当前事实存在版本差异！）</span>
                                )}
                              </div>
                            )}

                            {fact.metricScope && (
                              <div className="text-[10px] text-slate-500">
                                口径：{fact.metricScope}
                              </div>
                            )}

                            {snippet && (
                              <button
                                onClick={() => onViewSnippet(snippet)}
                                className="text-[11px] text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1 cursor-pointer pt-0.5"
                              >
                                <span>来源：{snippet.docName} ({snippet.location})</span>
                                <ExternalLink className="w-2.5 h-2.5" />
                              </button>
                            )}
                          </div>
                        );
                      })
                    ) : (
                      <div className="p-3 bg-slate-50 rounded border border-slate-200 text-xs text-slate-400 text-center italic">
                        本段尚未绑定量化事实依据
                      </div>
                    )}

                    {/* Authentic Case Materials Info */}
                    <div className="pt-2 border-t border-slate-100 space-y-1">
                      <span className="text-[11px] font-bold text-slate-700 block">真实典型案例依据：</span>
                      {(() => {
                        const authenticCases = getAuthenticCaseCandidates(task);
                        if (authenticCases.length === 0) {
                          return (
                            <div className="p-2 bg-amber-50 rounded border border-amber-200 text-[11px] text-amber-800">
                              <strong>暂无真实案例：</strong>当前材料库未登记本期核准的典型案例材料。AI改写将提示补充材料，严格避免虚构案例数据。
                            </div>
                          );
                        }
                        return (
                          <div className="space-y-1">
                            {authenticCases.map((cs) => (
                              <div
                                key={cs.id}
                                className="p-2 bg-slate-50 rounded border border-slate-200 text-[11px] text-slate-700"
                              >
                                <div className="font-semibold">{cs.docName}</div>
                                <p className="text-[10px] text-slate-500 line-clamp-2 mt-0.5">{cs.text}</p>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-slate-400 text-center py-8">点击文稿中的段落以查看依据与修改建议</p>
            )}
          </div>
        ) : (
          <div className="col-span-1 hidden lg:block">
            <button
              onClick={() => setShowRightInspector(true)}
              className="p-2 bg-white border border-slate-200 rounded shadow-xs text-slate-600 hover:text-slate-900 cursor-pointer"
              title="展开辅助面板"
              aria-label="展开辅助面板"
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
                          恢复至此版本 (生成新工作稿)
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
