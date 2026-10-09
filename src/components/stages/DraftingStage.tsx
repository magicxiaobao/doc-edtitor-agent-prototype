import React, { useState, useEffect, useRef } from 'react';
import { 
  Task, 
  TaskStage,
  ParagraphBlock, 
  DraftVersion, 
  UserRole, 
  EvidenceSnippet, 
  SnapshotMetadata, 
  DraftCandidate,
  RevisionAction, 
  RevisionSuggestion,
  ReviewComment,
  ReviewCommentStatus
} from '../../types';
import { 
  generateDraftFromFactsAndOutline, 
  computeContentHash,
  formatTaskPeriod,
  isSupportedDraftInstruction
} from '../../services/mockDraftService';
import { CandidateComparisonModal } from '../CandidateComparisonModal';
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
  acceptDraftCandidate,
  createDraftSnapshot,
  restoreDraftVersion,
  submitDraftForReview
} from '../../services/draftLifecycleService';
import { 
  computeTextDiff 
} from '../../services/diffService';
import { 
  getStorageError 
} from '../../services/storageService';
import { 
  isValidAuthenticCase, 
  getAuthenticCaseCandidates,
  getReviewCommentLocation,
  implementReviewCommentWithText,
  updateReviewCommentDecision,
  rebindReviewCommentTargetBlock,
  generateCoordinationDiff,
  applyCoordinationDecision,
  findAuthenticCaseSnippet
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
  Layers, 
  ChevronDown, 
  FileDiff, 
  Info,
  MessageSquare,
  Send,
  UserCheck,
  MessageCircle,
  HelpCircle,
  XCircle
} from 'lucide-react';

interface DraftingStageProps {
  task: Task;
  onUpdateTask: (updated: Partial<Task>) => void;
  onViewSnippet: (snippet: EvidenceSnippet) => void;
  onProceedToNextStage: () => void;
  activeRole: UserRole;
  onSelectStage?: (stage: TaskStage) => void;
}

export const DraftingStage: React.FC<DraftingStageProps> = ({
  task,
  onUpdateTask,
  onViewSnippet,
  onProceedToNextStage,
  activeRole,
  onSelectStage,
}) => {
  // Active draft version
  const currentDraft = task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];

  // Collapsible panels
  const [showLeftNav, setShowLeftNav] = useState(true);
  const [showRightInspector, setShowRightInspector] = useState(true);

  // Inspector tab: 'ai_suggestions' | 'review_comments' | 'material_evidence'
  const [inspectorTab, setInspectorTab] = useState<'ai_suggestions' | 'review_comments' | 'material_evidence'>('ai_suggestions');

  // Review comments filtering and modal state
  const [commentStatusFilter, setCommentStatusFilter] = useState<'all' | ReviewCommentStatus>('all');
  const [commentReviewerFilter, setCommentReviewerFilter] = useState<'all' | '审阅乙' | '审阅丁'>('all');
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);

  // Manual implement comment modal
  const [implementingComment, setImplementingComment] = useState<ReviewComment | null>(null);
  const [implBlockContent, setImplBlockContent] = useState<string>('');
  const [implAuthorReply, setImplAuthorReply] = useState<string>('');

  // Reject comment modal
  const [rejectingComment, setRejectingComment] = useState<ReviewComment | null>(null);
  const [rejectReason, setRejectReason] = useState<string>('');

  // Discuss comment modal
  const [discussingComment, setDiscussingComment] = useState<ReviewComment | null>(null);
  const [discussNote, setDiscussNote] = useState<string>('');

  // Re-bind comment block modal
  const [reboundingComment, setReboundingComment] = useState<ReviewComment | null>(null);
  const [reboundBlockId, setReboundBlockId] = useState<string>('');

  // Contradiction resolution panel
  const [showContradictionModal, setShowContradictionModal] = useState(false);
  const [selectedStrategy, setSelectedStrategy] = useState<'compress_priority' | 'case_priority' | 'balanced'>('balanced');
  const [strategyReason, setStrategyReason] = useState(
    '综合两位审阅领导意见：在第一部分压缩常规动员铺垫约300字，同时以提炼式短句补充基层专项调研代表性成效，控制全篇在2500字左右。'
  );

  // Selected block for editing / inspection
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

  // Inspected fact ID for targeted evidence examination
  const [inspectingFactId, setInspectingFactId] = useState<string | null>(null);

  // Draft regeneration / candidate state & strict isolation refs
  const [isGenerating, setIsGenerating] = useState(false);
  const [pendingCandidate, setPendingCandidate] = useState<DraftCandidate | null>(null);
  const [showCandidateComparisonModal, setShowCandidateComparisonModal] = useState(false);
  const [draftInstructionInput, setDraftInstructionInput] = useState<string>('突出成效，减少铺垫');
  const [showPrepDetails, setShowPrepDetails] = useState(false);
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
    sourceComment?: ReviewComment;
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

  // Calculation of preparation statuses
  const confirmedFactsCount = task.facts.filter((f) => f.status === 'confirmed').length;
  const isFactReady = Boolean(task.factSnapshot && confirmedFactsCount > 0);
  const activeStyleRulesCount = task.styleRules.filter((r) => r.confirmed && !r.excluded).length;
  const isStyleReady = Boolean(task.styleConfirmed && task.styleSnapshot);
  const outlineSectionsCount = task.outline.length;
  const isOutlineReady = Boolean(task.outlineConfirmed && task.outlineSnapshot);
  const taskPeriodStr = formatTaskPeriod(task.startDate, task.endDate);
  const isPeriodReady = Boolean(task.startDate && task.endDate);

  // Prerequisite check: facts, style, outline must all be confirmed
  const isPrerequisiteMet = isFactReady && isStyleReady && isOutlineReady && isPeriodReady;

  const handleJumpStage = (stage: TaskStage) => {
    if (onSelectStage) {
      onSelectStage(stage);
    } else {
      onUpdateTask({ currentStage: stage });
    }
  };

  const handleInspectFact = (factId: string, blockId?: string) => {
    if (blockId) setSelectedBlockId(blockId);
    setInspectingFactId(factId);
    setShowRightInspector(true);
    setInspectorTab('material_evidence');
  };

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

  // Active review comments associated with current draft:
  // If viewing historical snapshot or finalized draft, read frozen review comments; otherwise read task.reviewComments
  const activeReviewComments: ReviewComment[] =
    isCurrentDraftImmutable && currentDraft?.frozenReviewComments
      ? currentDraft.frozenReviewComments
      : task.reviewComments;

  const totalCommentsCount = activeReviewComments.length;
  const pendingCommentsCount = activeReviewComments.filter((c) => c.status === 'pending').length;
  const acceptedPendingCount = activeReviewComments.filter((c) => c.status === 'accepted_pending_implementation').length;
  const implementedCount = activeReviewComments.filter((c) => c.status === 'implemented').length;
  const needDiscussionCount = activeReviewComments.filter((c) => c.status === 'need_discussion').length;
  const rejectedCount = activeReviewComments.filter((c) => c.status === 'rejected').length;
  const pendingOrAcceptedCommentsCount = pendingCommentsCount + acceptedPendingCount + needDiscussionCount;

  // Handle Generate / Regenerate Whole Draft
  const handleStartGenerate = (promptToUse?: string) => {
    const perm = checkPermission(activeRole, 'generate_draft');
    if (!perm.allowed) {
      alert(perm.reason || '当前身份无权起草正文');
      return;
    }

    if (!isPrerequisiteMet) {
      alert('前序事实清单未确认/已失效、文风未核准或大纲批准已失效，无法生成正文。请先前往前序阶段重新核准。现有文稿已保留浏览，未自动覆盖旧稿。');
      return;
    }

    const instructionToApply = (promptToUse !== undefined ? promptToUse : draftInstructionInput).trim();

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

      const generatedBlocks = generateDraftFromFactsAndOutline(task, {
        instructionPrompt: instructionToApply,
      });

      if (task.drafts.length === 0) {
        // Direct initial draft
        const initialDraft: DraftVersion = {
          id: `DRAFT-${Date.now()}`,
          versionNumber: 'v1.0 (初稿)',
          createdAt: new Date().toISOString(),
          author: activeRole,
          summary: instructionToApply
            ? `系统按写作要求【${instructionToApply}】生成的首个完整初稿版本`
            : '系统根据已确认事实及大纲生成的首个完整初稿版本',
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
        const isSupported = isSupportedDraftInstruction(instructionToApply);
        const cand: DraftCandidate = {
          taskId: startingTaskId,
          runId,
          baseDraftId,
          baseDraftContentHash,
          upstreamApprovalVersion,
          blocks: generatedBlocks,
          snapshotMetadata: capturedSnapshotMeta,
          generatedAt: new Date().toISOString(),
          instructionPrompt: instructionToApply,
          requestSummary: instructionToApply ? `写作要求：${instructionToApply}` : '标准公文起草规范',
          isUnsupportedPrompt: !isSupported,
          unsupportedPromptNotice: !isSupported
            ? `当前原型模拟服务暂未支持自定义起草指令“${instructionToApply}”。原型支持明确的演示指令（如“突出成效，减少铺垫”、“精简表达”、“优化问题与安排的对应”、“改成面向单位负责人的汇报口吻”）。已基于标准公文规范生成。`
            : undefined,
        };
        setPendingCandidate(cand);
        setShowCandidateComparisonModal(true);
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
    customPrompt?: string,
    sourceComment?: ReviewComment
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
      sourceComment,
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
        sourceComment,
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
      const { block, action, customPrompt, sourceComment } = lastRevisionRequestRef.current;
      executeRevisionRequest(block, action, customPrompt, sourceComment);
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
    const matchingComment = revisionSuggestion.sourceCommentId
      ? task.reviewComments.find((c) => c.id === revisionSuggestion.sourceCommentId)
      : undefined;
    executeRevisionRequest(targetBlock, revisionSuggestion.action, revisionSuggestion.customPrompt, matchingComment);
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

      // Rule: If revision was generated from a review comment, update ONLY this comment to implemented!
      let updatedComments = updatedTask.reviewComments;
      if (revisionSuggestion.sourceCommentId) {
        const commentId = revisionSuggestion.sourceCommentId;
        updatedComments = updatedTask.reviewComments.map((cmt) => {
          if (cmt.id === commentId) {
            return {
              ...cmt,
              status: 'implemented' as const,
              authorReply: `主笔已采纳修改建议并更新第${targetBlock.order}段正文。`,
              decisionReason: revisionSuggestion.diffExplanation,
              resolutionType: 'text_modified' as const,
              implementationDraftId: workingDraft.id,
              implementationBlockId: targetBlock.id,
            };
          }
          return cmt;
        });
      }

      onUpdateTask({
        drafts: updatedTask.drafts,
        currentDraftId: workingDraft.id,
        reviewComments: updatedComments,
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

  // Generate revision for review comment
  const handleGenerateRevisionFromComment = (cmt: ReviewComment) => {
    const perm = checkPermission(activeRole, 'edit_draft');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可根据意见生成修改建议');
      return;
    }

    if (!currentDraft) return;
    const loc = getReviewCommentLocation(cmt, currentDraft);
    if (!loc.isLocated || !loc.targetBlock) {
      alert(loc.warning || '该意见原目标段落已在正文中删除或合并，定位失效，请先点击【重新指定目标段落】！');
      return;
    }

    setSelectedBlockId(loc.targetBlock.id);
    executeRevisionRequest(
      loc.targetBlock,
      'custom',
      cmt.suggestedChange || cmt.content,
      cmt
    );
  };

  // Accept comment decision only (marks as accepted_pending_implementation, does not mark implemented!)
  const handleAcceptCommentDecisionOnly = (cmt: ReviewComment) => {
    const perm = checkPermission(activeRole, 'resolve_comment');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可处理审阅意见');
      return;
    }

    const note = prompt(
      '请输入采纳处理决定说明（此操作仅记录决定为【决定采纳，待落实】，在正文中实际修改前不会标记为已落实）：',
      cmt.authorReply || '主笔决定采纳此意见方向，待后续统筹落实篇幅与正文'
    );
    if (note === null) return;

    try {
      const { updatedTask } = updateReviewCommentDecision(
        task,
        cmt.id,
        'accepted_pending_implementation',
        note.trim(),
        activeRole
      );
      onUpdateTask({ reviewComments: updatedTask.reviewComments });
    } catch (err: any) {
      alert(err.message || '记录采纳决定失败');
    }
  };

  // Open direct implement modal
  const handleOpenDirectImplementModal = (cmt: ReviewComment) => {
    const perm = checkPermission(activeRole, 'resolve_comment');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可在正文中落实审阅意见');
      return;
    }

    const loc = getReviewCommentLocation(cmt, currentDraft);
    if (!loc.isLocated || !loc.targetBlock) {
      alert(loc.warning || '该意见原目标段落已在正文中删除或合并，请先重新指定目标段落！');
      return;
    }

    setImplementingComment(cmt);
    setImplBlockContent(cmt.suggestedChange || loc.targetBlock.content);
    setImplAuthorReply(`采纳【${cmt.reviewer}】意见，已在第${loc.targetBlock.order}段完成正文落实。`);
  };

  const handleConfirmDirectImplement = (e: React.FormEvent) => {
    e.preventDefault();
    if (!implementingComment || !currentDraft) return;

    try {
      const { updatedTask, workingDraft } = implementReviewCommentWithText(
        task,
        implementingComment.id,
        currentDraft.id,
        implBlockContent,
        implAuthorReply,
        activeRole
      );

      onUpdateTask({
        drafts: updatedTask.drafts,
        currentDraftId: workingDraft.id,
        reviewComments: updatedTask.reviewComments,
        isFinalized: updatedTask.isFinalized,
        status: updatedTask.status,
      });

      setImplementingComment(null);
    } catch (err: any) {
      alert(err.message || '落实修改失败');
    }
  };

  // Open reject modal
  const handleOpenRejectModal = (cmt: ReviewComment) => {
    const perm = checkPermission(activeRole, 'resolve_comment');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可处理审阅意见');
      return;
    }
    setRejectingComment(cmt);
    setRejectReason(cmt.decisionReason || '');
  };

  const handleConfirmReject = (e: React.FormEvent) => {
    e.preventDefault();
    if (!rejectingComment) return;
    if (!rejectReason.trim()) {
      alert('拒绝审阅意见必须填写具体理由说明！');
      return;
    }

    try {
      const { updatedTask } = updateReviewCommentDecision(
        task,
        rejectingComment.id,
        'rejected',
        rejectReason.trim(),
        activeRole
      );
      onUpdateTask({ reviewComments: updatedTask.reviewComments });
      setRejectingComment(null);
    } catch (err: any) {
      alert(err.message || '拒绝操作失败');
    }
  };

  // Open discuss modal
  const handleOpenDiscussModal = (cmt: ReviewComment) => {
    const perm = checkPermission(activeRole, 'resolve_comment');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可处理审阅意见');
      return;
    }
    setDiscussingComment(cmt);
    setDiscussNote(cmt.authorReply || '');
  };

  const handleConfirmDiscuss = (e: React.FormEvent) => {
    e.preventDefault();
    if (!discussingComment) return;

    try {
      const { updatedTask } = updateReviewCommentDecision(
        task,
        discussingComment.id,
        'need_discussion',
        discussNote.trim() || '需进一步沟通讨论',
        activeRole
      );
      onUpdateTask({ reviewComments: updatedTask.reviewComments });
      setDiscussingComment(null);
    } catch (err: any) {
      alert(err.message || '操作失败');
    }
  };

  // Open rebind modal
  const handleOpenRebindModal = (cmt: ReviewComment) => {
    const perm = checkPermission(activeRole, 'resolve_comment');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可重新指定意见目标段落');
      return;
    }
    setReboundingComment(cmt);
    setReboundBlockId(currentDraft?.blocks[0]?.id || '');
  };

  const handleConfirmRebind = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reboundingComment || !reboundBlockId) return;

    try {
      const { updatedTask } = rebindReviewCommentTargetBlock(
        task,
        reboundingComment.id,
        reboundBlockId,
        activeRole
      );
      onUpdateTask({ reviewComments: updatedTask.reviewComments });
      setReboundingComment(null);
    } catch (err: any) {
      alert(err.message || '重新指定段落失败');
    }
  };

  // Resolve contradiction between CMT-01 and CMT-02
  const handleResolveContradiction = (mode: 'strategy_only' | 'implement_now') => {
    const perm = checkPermission(activeRole, 'resolve_comment');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可裁决审阅矛盾意见');
      return;
    }

    if (!currentDraft) return;

    const mappedStrategy = 
      selectedStrategy === 'compress_priority' ? ('compress' as const) :
      selectedStrategy === 'case_priority' ? ('expand_case' as const) : ('balanced' as const);

    const diff = generateCoordinationDiff(task, currentDraft, mappedStrategy);

    if (mode === 'strategy_only') {
      const updatedComments = task.reviewComments.map((c) => {
        if (c.id === 'CMT-01' || c.id === 'CMT-02') {
          return {
            ...c,
            status: 'accepted_pending_implementation' as const,
            authorReply: `【主笔协调裁决策略·待落实】：${diff.strategyExplanation}`,
            decisionReason: strategyReason.trim() || diff.strategyExplanation,
            resolutionType: 'strategy_decided' as const,
          };
        }
        return c;
      });

      onUpdateTask({ reviewComments: updatedComments });
      setShowContradictionModal(false);
      return;
    }

    // mode === 'implement_now'
    if (diff.diffPreview.length === 0) {
      alert('未检测到正文文本差异（零差异），不能标记审阅意见为已落实！');
      return;
    }

    try {
      const { updatedTask, workingDraft } = applyCoordinationDecision(
        task,
        currentDraft.id,
        diff,
        activeRole,
        ['CMT-01', 'CMT-02']
      );

      onUpdateTask({
        drafts: updatedTask.drafts,
        currentDraftId: workingDraft.id,
        reviewComments: updatedTask.reviewComments,
        isFinalized: updatedTask.isFinalized,
        status: updatedTask.status,
      });

      setShowContradictionModal(false);
    } catch (err: any) {
      alert(err.message || '落实审阅协调失败');
    }
  };

  // Submit draft for review click
  const handleSubmitDraftForReviewClick = () => {
    const perm = checkPermission(activeRole, 'edit_draft');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可提交审阅');
      return;
    }
    if (!currentDraft) return;

    if (!window.confirm(`确认将当前版本【${currentDraft.versionNumber}】提交审阅吗？系统将自动冻结只读审阅基准快照，任务状态将变更为“审阅中”。`)) {
      return;
    }

    try {
      const { updatedTask } = submitDraftForReview(
        task,
        currentDraft.id,
        activeRole,
        true
      );
      onUpdateTask({
        drafts: updatedTask.drafts,
        currentStage: 'review',
        status: '审阅中',
      });
      if (onSelectStage) {
        onSelectStage('review');
      } else {
        onProceedToNextStage();
      }
    } catch (err: any) {
      alert(err.message || '提交审阅失败');
    }
  };

  // Save version snapshot using unified helper
  const handleSaveVersion = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentDraft) return;

    try {
      const { updatedTask } = createDraftSnapshot(
        task,
        currentDraft.id,
        versionSummary,
        activeRole
      );
      onUpdateTask({
        drafts: updatedTask.drafts,
        currentDraftId: updatedTask.drafts[0].id,
      });

      setShowSaveVersionModal(false);
      setVersionSummary('');
    } catch (err: any) {
      alert(err.message || '保存版本快照失败');
    }
  };

  // Restore history draft using unified helper
  const handleRestoreDraft = (version: DraftVersion) => {
    try {
      const { updatedTask, workingDraft } = restoreDraftVersion(
        task,
        version.id,
        activeRole
      );

      onUpdateTask({
        drafts: updatedTask.drafts,
        currentDraftId: workingDraft.id,
        isFinalized: false,
        status: '起草中',
      });

      setShowVersionHistory(false);
    } catch (err: any) {
      alert(err.message || '恢复版本失败');
    }
  };

  const mappedStrategy = 
    selectedStrategy === 'compress_priority' ? ('compress' as const) :
    selectedStrategy === 'case_priority' ? ('expand_case' as const) : ('balanced' as const);

  const currentCoordinationDiff = currentDraft ? generateCoordinationDiff(task, currentDraft, mappedStrategy) : null;

  const handleApplyCoordination = (mode: 'strategy_only' | 'implement_now') => {
    const perm = checkPermission(activeRole, 'resolve_comment');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可协调裁决篇幅冲突');
      return;
    }

    if (!currentDraft || !currentCoordinationDiff) return;

    if (mode === 'strategy_only') {
      const updatedComments = task.reviewComments.map((c) => {
        if (c.id === 'CMT-01' || c.id === 'CMT-02') {
          return {
            ...c,
            status: 'accepted_pending_implementation' as const,
            authorReply: `【主笔协调裁决策略·待落实】：${currentCoordinationDiff.strategyExplanation}`,
            decisionReason: strategyReason.trim() || currentCoordinationDiff.strategyExplanation,
            resolutionType: 'strategy_decided' as const,
          };
        }
        return c;
      });
      onUpdateTask({ reviewComments: updatedComments });
      setShowContradictionModal(false);
      return;
    }

    try {
      const { updatedTask, workingDraft } = applyCoordinationDecision(
        task,
        currentDraft.id,
        currentCoordinationDiff,
        activeRole,
        ['CMT-01', 'CMT-02']
      );
      onUpdateTask({
        drafts: updatedTask.drafts,
        currentDraftId: workingDraft.id,
        reviewComments: updatedTask.reviewComments,
        isFinalized: updatedTask.isFinalized,
        status: updatedTask.status,
      });
      setShowContradictionModal(false);
    } catch (err: any) {
      alert(err.message || '落实审阅协调失败');
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
            onClick={onProceedToNextStage}
            className="px-4 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold shadow-xs flex items-center gap-1 cursor-pointer"
          >
            <span>下一步：审阅修改</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 2. Preparation Status Bar */}
      <div className="bg-white p-3.5 rounded-lg border border-slate-200 shadow-2xs text-xs space-y-2.5">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="font-bold text-slate-800 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5 text-blue-700" />
              起草前准备状态
            </span>
            <span
              className={`text-[11px] px-2 py-0.5 rounded font-medium flex items-center gap-1 ${
                isPrerequisiteMet
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                  : 'bg-amber-50 text-amber-800 border border-amber-200'
              }`}
            >
              {isPrerequisiteMet ? (
                <CheckCircle2 className="w-3 h-3 text-emerald-600" />
              ) : (
                <AlertTriangle className="w-3 h-3 text-amber-600" />
              )}
              <span>{isPrerequisiteMet ? '前序审批完备 · 具备起草条件' : '准备条件未满足'}</span>
            </span>
          </div>

          <button
            onClick={() => setShowPrepDetails(!showPrepDetails)}
            className="text-slate-500 hover:text-slate-800 text-[11px] flex items-center gap-1 cursor-pointer"
          >
            <span>{showPrepDetails ? '收起说明' : '展开指标口径说明'}</span>
            <ChevronDown
              className={`w-3 h-3 transition-transform ${showPrepDetails ? 'rotate-180' : ''}`}
            />
          </button>
        </div>

        {/* 5 Indicator Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 text-xs">
          <div
            className={`p-2 rounded border ${
              isFactReady ? 'bg-slate-50/80 border-slate-200' : 'bg-amber-50/70 border-amber-300 text-amber-950'
            }`}
          >
            <div className="text-[10px] text-slate-500">1. 事实清单</div>
            <div className="font-bold mt-0.5 text-slate-800">{confirmedFactsCount} 项已核准</div>
            <div className="text-[10px] text-slate-400">
              {task.factSnapshot ? '快照已锁定' : '快照未生成'}
            </div>
          </div>

          <div
            className={`p-2 rounded border ${
              isStyleReady ? 'bg-slate-50/80 border-slate-200' : 'bg-amber-50/70 border-amber-300 text-amber-950'
            }`}
          >
            <div className="text-[10px] text-slate-500">2. 单位文风</div>
            <div className="font-bold mt-0.5 text-slate-800">{activeStyleRulesCount} 条规则生效</div>
            <div className="text-[10px] text-slate-400">
              {task.styleConfirmed ? '已核准通过' : '未核准'}
            </div>
          </div>

          <div
            className={`p-2 rounded border ${
              isOutlineReady ? 'bg-slate-50/80 border-slate-200' : 'bg-amber-50/70 border-amber-300 text-amber-950'
            }`}
          >
            <div className="text-[10px] text-slate-500">3. 章节大纲</div>
            <div className="font-bold mt-0.5 text-slate-800">{outlineSectionsCount} 个章节</div>
            <div className="text-[10px] text-slate-400">
              {task.outlineConfirmed ? '大纲已审批' : '未审批'}
            </div>
          </div>

          <div
            className={`p-2 rounded border ${
              isPeriodReady ? 'bg-slate-50/80 border-slate-200' : 'bg-amber-50/70 border-amber-300 text-amber-950'
            }`}
          >
            <div className="text-[10px] text-slate-500">4. 统计期间</div>
            <div className="font-bold mt-0.5 text-slate-800">{taskPeriodStr}</div>
            <div className="text-[10px] text-slate-400">
              {isPeriodReady ? '口径已设定' : '未设定'}
            </div>
          </div>

          <div className="p-2 rounded border bg-slate-50/80 border-slate-200">
            <div className="text-[10px] text-slate-500">5. 目标字数</div>
            <div className="font-bold mt-0.5 text-slate-800">{task.targetWordCount || 2000} 字</div>
            <div className="text-[10px] text-slate-400">
              当前文稿 {currentWordCount} 字
            </div>
          </div>
        </div>

        {/* Deficiency alert if not met */}
        {!isPrerequisiteMet && (
          <div className="p-3 bg-amber-50 border border-amber-300 rounded text-xs text-amber-950 space-y-2">
            <div className="flex items-center gap-1.5 font-semibold text-amber-900">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>起草条件不足说明：</span>
            </div>
            <ul className="list-disc list-inside text-[11px] text-amber-800 space-y-0.5">
              {!isFactReady && <li>事实清单尚未核准或事实快照缺失/已失效（需包含有效核准事实）。</li>}
              {!isStyleReady && <li>单位文风规范尚未核准或快照缺失。</li>}
              {!isOutlineReady && <li>章节大纲规划尚未确认审批通过。</li>}
              {!isPeriodReady && <li>任务起止日期及统计期间未设定完整。</li>}
            </ul>
            <p className="text-[11px] text-amber-700">
              系统保护现有文稿，<strong>旧正文保持可浏览与手动编辑</strong>。请先前往前序阶段完成审批后再执行整稿起草。
            </p>
            <div className="flex items-center gap-2 pt-1 flex-wrap">
              {!isFactReady && (
                <button
                  onClick={() => handleJumpStage('material_fact')}
                  className="px-3 py-1 bg-amber-700 hover:bg-amber-800 text-white rounded text-xs font-semibold cursor-pointer"
                >
                  前往核准事实清单
                </button>
              )}
              {(!isStyleReady || !isOutlineReady) && (
                <button
                  onClick={() => handleJumpStage('style_outline')}
                  className="px-3 py-1 bg-amber-700 hover:bg-amber-800 text-white rounded text-xs font-semibold cursor-pointer"
                >
                  前往确认文风与大纲
                </button>
              )}
            </div>
          </div>
        )}

        {/* Collapsible Explanations */}
        {showPrepDetails && isPrerequisiteMet && (
          <div className="p-3 bg-slate-50 border border-slate-200 rounded text-[11px] text-slate-600 space-y-1">
            <div>• 事实依据：已核准事实与台账口径一致，起草服务将严格保留所有数值、单位与期间。</div>
            <div>• 文风大纲：按已确认大纲结构进行确定性合成，各章节按分配事实生成，无虚构案例。</div>
            <div>• 版本继承：起草生成的整稿将作为候选稿供主笔在差异对比后决定是否整体采纳。</div>
          </div>
        )}
      </div>

      {/* 3. Round Drafting Instruction Input Bar */}
      <div className="bg-white p-3.5 rounded-lg border border-slate-200 shadow-2xs text-xs space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-1">
          <label htmlFor="round-draft-instruction" className="font-bold text-slate-800 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-blue-700" />
            <span>本轮写作要求（表达意图与行文侧重）：</span>
          </label>
          <span className="text-[11px] text-slate-400">受已核准事实、文风与大纲严格约束</span>
        </div>
        <div className="flex gap-2">
          <input
            id="round-draft-instruction"
            type="text"
            value={draftInstructionInput}
            onChange={(e) => setDraftInstructionInput(e.target.value)}
            placeholder="例如：突出成效，减少铺垫；优化问题与安排的对应；改成面向单位负责人的汇报口吻..."
            className="flex-1 p-2 bg-slate-50 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500 focus:bg-white focus:outline-hidden"
          />
          <button
            onClick={() => handleStartGenerate(draftInstructionInput)}
            disabled={isGenerating || !isPrerequisiteMet || !canUserEdit}
            className={`px-4 py-2 rounded text-xs font-semibold shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer shrink-0 ${
              !isPrerequisiteMet || isGenerating || !canUserEdit
                ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                : 'bg-blue-700 hover:bg-blue-800 text-white'
            }`}
            title={
              !canUserEdit
                ? `权限受限：当前身份为【${activeRole}】，仅主笔甲可起草正文`
                : !isPrerequisiteMet
                ? '前序审批未就绪，无法起草'
                : task.drafts.length === 0
                ? '生成首轮初稿'
                : '生成整稿候选稿'
            }
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>
              {isGenerating
                ? '起草生成中...'
                : task.drafts.length === 0
                ? '生成首轮初稿'
                : '生成整稿候选'}
            </span>
          </button>
        </div>
        {/* Preset Instruction Chips */}
        <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
          <span className="text-[11px] text-slate-400 font-medium">常用指令预设：</span>
          {[
            '突出成效，减少铺垫',
            '减少铺垫，精简表达',
            '优化问题与安排的对应',
            '改成面向单位负责人的汇报口吻',
            '标准公文规范起草',
          ].map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setDraftInstructionInput(preset)}
              className={`text-[11px] px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                draftInstructionInput === preset
                  ? 'bg-blue-50 text-blue-800 border-blue-300 font-medium'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-600 border-slate-200'
              }`}
            >
              {preset}
            </button>
          ))}
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

      {/* Candidate comparison banner if present */}
      {pendingCandidate && (() => {
        const candWordCount = pendingCandidate.blocks.reduce((acc, b) => acc + b.content.length, 0);
        const isModifiedLive =
          currentDraft &&
          pendingCandidate.baseDraftContentHash &&
          computeDraftBlocksHash(currentDraft.blocks) !== pendingCandidate.baseDraftContentHash;
        const hasPromptMismatch = Boolean(
          draftInstructionInput.trim() &&
            pendingCandidate.instructionPrompt &&
            draftInstructionInput.trim() !== pendingCandidate.instructionPrompt.trim()
        );

        return (
          <div
            className={`p-4 rounded-lg border-2 shadow-xs space-y-2.5 ${
              isModifiedLive
                ? 'bg-rose-50 border-rose-300'
                : 'bg-blue-50/80 border-blue-300'
            }`}
          >
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div>
                <h4 className="font-bold text-xs text-slate-900 flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-blue-600" />
                  已生成整稿候选稿（共 {candWordCount} 字 · 依据最新已核准事实与大纲）
                </h4>
                <p className="text-[11px] text-slate-600 mt-0.5">
                  生成要求：<strong className="text-slate-800">{pendingCandidate.instructionPrompt || '标准公文规范起草'}</strong>
                  <span className="mx-1.5 text-slate-300">|</span>
                  生成时刻：
                  {new Date(pendingCandidate.generatedAt).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0 flex-wrap">
                <button
                  onClick={() => setPendingCandidate(null)}
                  className="px-3 py-1.5 bg-white border border-slate-300 text-slate-700 rounded text-xs hover:bg-slate-50 cursor-pointer font-medium"
                >
                  放弃候选稿
                </button>
                <button
                  onClick={() => setShowCandidateComparisonModal(true)}
                  className="px-3.5 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold shadow-xs flex items-center gap-1 cursor-pointer"
                >
                  <FileDiff className="w-3.5 h-3.5" />
                  <span>查看完整候选对比与差异</span>
                </button>
                <button
                  onClick={handleAcceptCandidate}
                  disabled={Boolean(isModifiedLive) || activeRole !== '主笔甲'}
                  className={`px-4 py-1.5 rounded text-xs font-semibold shadow-xs cursor-pointer ${
                    isModifiedLive || activeRole !== '主笔甲'
                      ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                      : 'bg-emerald-700 hover:bg-emerald-800 text-white'
                  }`}
                  title={
                    isModifiedLive
                      ? '正文已被编辑修改，候选已失效，禁止采纳覆盖'
                      : '整体采纳并自动归档旧稿，创建新工作稿'
                  }
                >
                  整体采纳并创建新工作稿
                </button>
              </div>
            </div>

            {/* Invalidation warning */}
            {isModifiedLive && (
              <div className="p-2 bg-rose-100/80 border border-rose-300 rounded text-[11px] text-rose-900 flex items-center gap-1.5 font-medium">
                <AlertTriangle className="w-3.5 h-3.5 text-rose-700 shrink-0" />
                <span>
                  候选稿已失效：正文在此候选生成后已被人工编辑修改，采纳旧候选将覆盖人工编辑！请点击上方“生成整稿候选”以最新正文为基准重新起草。
                </span>
              </div>
            )}

            {/* Instruction prompt mismatch notice */}
            {hasPromptMismatch && !isModifiedLive && (
              <div className="p-2 bg-amber-100/70 border border-amber-300 rounded text-[11px] text-amber-900 flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5 text-amber-700 shrink-0" />
                <span>
                  提示：输入框已调整为新要求【{draftInstructionInput}】，当前候选稿系基于上一轮要求【
                  {pendingCandidate.instructionPrompt}】生成。如需按新要求起草，可点击“生成整稿候选”。
                </span>
              </div>
            )}
          </div>
        );
      })()}


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

                            {/* Review comments targeting this block */}
                            {task.reviewComments
                              .filter((c) => c.type === 'paragraph' && c.targetBlockId === block.id)
                              .map((c) => (
                                <button
                                  key={c.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedBlockId(block.id);
                                    setInspectorTab('review_comments');
                                    setSelectedCommentId(c.id);
                                  }}
                                  className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium cursor-pointer transition-colors ${
                                    c.status === 'implemented'
                                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                                      : c.status === 'accepted_pending_implementation'
                                      ? 'bg-blue-100 text-blue-800 border border-blue-300'
                                      : c.status === 'rejected'
                                      ? 'bg-slate-200 text-slate-700'
                                      : c.status === 'need_discussion'
                                      ? 'bg-purple-100 text-purple-800 border border-purple-200'
                                      : 'bg-amber-100 text-amber-800 border border-amber-300'
                                  }`}
                                  title={`点击定位查看【${c.reviewer}】审阅意见`}
                                >
                                  <MessageSquare className="w-2.5 h-2.5" />
                                  <span>
                                    {c.reviewer}：{c.status === 'implemented' ? '已落实' : c.status === 'accepted_pending_implementation' ? '待落实' : c.status === 'rejected' ? '已拒绝' : c.status === 'need_discussion' ? '待沟通' : '待处理'}
                                  </span>
                                </button>
                              ))}
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
                onClick={() => handleStartGenerate()}
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
                  onClick={() => setInspectorTab('review_comments')}
                  className={`px-2.5 py-1 rounded transition-colors cursor-pointer flex items-center gap-1 ${
                    inspectorTab === 'review_comments'
                      ? 'bg-white text-blue-800 shadow-2xs font-semibold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <span>审阅意见</span>
                  {task.reviewComments.filter((c) => c.status === 'pending' || c.status === 'accepted_pending_implementation').length > 0 && (
                    <span className="bg-amber-100 text-amber-800 px-1 py-0.2 rounded-full text-[10px] font-bold">
                      {task.reviewComments.filter((c) => c.status === 'pending' || c.status === 'accepted_pending_implementation').length}
                    </span>
                  )}
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

            {/* Inspector Body: Review Comments Tab OR Paragraph Inspection (AI Suggestions / Evidence) */}
            {inspectorTab === 'review_comments' ? (
              <div className="space-y-3">
                {/* Review Comments Header & Conflict Banner */}
                <div className="flex items-center justify-between pb-1 border-b border-slate-100">
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-xs text-slate-800">全部审阅意见</span>
                    <span className="text-[10px] bg-slate-200 text-slate-700 px-1.5 py-0.2 rounded font-mono font-medium">
                      {task.reviewComments.length}
                    </span>
                  </div>
                  {onSelectStage && (
                    <button
                      onClick={() => onSelectStage('review')}
                      className="text-[10px] text-blue-700 hover:underline flex items-center gap-0.5 cursor-pointer font-medium"
                    >
                      <span>审阅全景视图</span>
                      <ExternalLink className="w-2.5 h-2.5" />
                    </button>
                  )}
                </div>

                {/* Contradictory comments warning banner */}
                {task.reviewComments.some((c) => (c.id === 'CMT-01' || c.id === 'CMT-02') && (c.status === 'pending' || c.status === 'accepted_pending_implementation')) && (
                  <div className="p-2.5 bg-amber-50 border border-amber-300 rounded text-xs text-amber-950 space-y-1.5">
                    <div className="flex items-center gap-1 font-bold text-amber-800">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                      <span>检测到相互矛盾的审阅篇幅要求！</span>
                    </div>
                    <p className="text-[10px] text-amber-800 leading-normal">
                      审阅乙提出“压缩到2000字以内”；审阅丁提出“增加两个详细案例”。
                    </p>
                    <button
                      onClick={() => setShowContradictionModal(true)}
                      className="w-full py-1 bg-amber-600 hover:bg-amber-700 text-white rounded text-[11px] font-bold cursor-pointer"
                    >
                      主笔协调裁决此冲突
                    </button>
                  </div>
                )}

                {/* Filter Controls */}
                <div className="grid grid-cols-2 gap-1.5 text-xs">
                  <select
                    value={commentStatusFilter}
                    onChange={(e) => setCommentStatusFilter(e.target.value as any)}
                    className="border border-slate-300 rounded px-1.5 py-1 bg-white text-slate-700 text-[11px]"
                  >
                    <option value="all">全部状态 ({task.reviewComments.length})</option>
                    <option value="pending">待处理 ({task.reviewComments.filter((c) => c.status === 'pending').length})</option>
                    <option value="accepted_pending_implementation">决定采纳·待落实 ({task.reviewComments.filter((c) => c.status === 'accepted_pending_implementation').length})</option>
                    <option value="implemented">已落实 ({task.reviewComments.filter((c) => c.status === 'implemented').length})</option>
                    <option value="need_discussion">待沟通 ({task.reviewComments.filter((c) => c.status === 'need_discussion').length})</option>
                    <option value="rejected">已拒绝 ({task.reviewComments.filter((c) => c.status === 'rejected').length})</option>
                  </select>

                  <select
                    value={commentReviewerFilter}
                    onChange={(e) => setCommentReviewerFilter(e.target.value as any)}
                    className="border border-slate-300 rounded px-1.5 py-1 bg-white text-slate-700 text-[11px]"
                  >
                    <option value="all">全部审阅人</option>
                    <option value="审阅乙">审阅乙</option>
                    <option value="审阅丁">审阅丁</option>
                  </select>
                </div>

                {/* Comment Cards List */}
                <div className="space-y-2.5">
                  {task.reviewComments
                    .filter((c) => {
                      if (commentStatusFilter !== 'all' && c.status !== commentStatusFilter) return false;
                      if (commentReviewerFilter !== 'all' && c.reviewer !== commentReviewerFilter) return false;
                      return true;
                    })
                    .map((cmt) => {
                      const loc = getReviewCommentLocation(cmt, currentDraft);
                      const isLocationOutdated = !loc.isLocated || !loc.targetBlock || Boolean(loc.warning);
                      const isSelectedComment = selectedCommentId === cmt.id;

                      return (
                        <div
                          key={cmt.id}
                          className={`p-3 rounded-lg border text-xs space-y-2 transition-all ${
                            isSelectedComment
                              ? 'bg-blue-50/50 border-blue-400 ring-2 ring-blue-100'
                              : 'bg-slate-50 border-slate-200'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-bold text-slate-900">{cmt.reviewer}</span>
                              <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-200 text-slate-700 font-medium">
                                {cmt.type === 'overall' ? '全局意见' : `第${cmt.targetBlockOrder || '?'}段批注`}
                              </span>
                            </div>

                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                                cmt.status === 'implemented'
                                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                                  : cmt.status === 'accepted_pending_implementation'
                                  ? 'bg-blue-100 text-blue-800 border border-blue-300'
                                  : cmt.status === 'rejected'
                                  ? 'bg-slate-200 text-slate-700'
                                  : cmt.status === 'need_discussion'
                                  ? 'bg-purple-100 text-purple-800 border border-purple-200'
                                  : 'bg-amber-100 text-amber-800 border border-amber-300'
                              }`}
                            >
                              {cmt.status === 'implemented'
                                ? '已落实'
                                : cmt.status === 'accepted_pending_implementation'
                                ? '决定采纳·待落实'
                                : cmt.status === 'rejected'
                                ? '已拒绝'
                                : cmt.status === 'need_discussion'
                                ? '待沟通'
                                : '待处理'}
                            </span>
                          </div>

                          <p className="text-[11px] text-slate-800 leading-relaxed font-medium">{cmt.content}</p>

                          {cmt.suggestedChange && (
                            <div className="p-1.5 bg-white rounded border border-blue-200 text-[10px] text-blue-900">
                              <span className="font-semibold block text-blue-600">建议修改方向：</span>
                              <span>{cmt.suggestedChange}</span>
                            </div>
                          )}

                          {/* Location & Warning Section */}
                          {cmt.type === 'paragraph' && (
                            <>
                              {isLocationOutdated ? (
                                <div className="p-2 bg-amber-50 border border-amber-300 rounded text-[10px] text-amber-900 space-y-1">
                                  <div className="flex items-center gap-1 font-bold text-amber-800">
                                    <AlertTriangle className="w-3 h-3 text-amber-600 shrink-0" />
                                    <span>定位需复核：原目标段落已变动或已删除</span>
                                  </div>
                                  {cmt.baseParagraphText && (
                                    <p className="text-slate-600 italic">
                                      提出时原句：“{cmt.baseParagraphText.slice(0, 45)}...”
                                    </p>
                                  )}
                                  {canUserEdit && (
                                    <button
                                      onClick={() => handleOpenRebindModal(cmt)}
                                      className="px-2 py-0.5 bg-white border border-amber-300 hover:bg-amber-100 rounded text-[10px] font-bold text-amber-900 cursor-pointer"
                                    >
                                      重新指定目标段落
                                    </button>
                                  )}
                                </div>
                              ) : loc.targetBlock ? (
                                <div className="p-1.5 bg-white rounded border border-slate-200 text-[10px] text-slate-600 flex items-center justify-between">
                                  <span className="truncate pr-1">
                                    对应第{loc.targetBlock.order}段：“{loc.targetBlock.content.slice(0, 24)}...”
                                  </span>
                                  <button
                                    onClick={() => handleJumpToTargetBlock(loc.targetBlock!.id)}
                                    className="text-blue-700 hover:underline font-bold shrink-0 cursor-pointer"
                                  >
                                    定位段落
                                  </button>
                                </div>
                              ) : null}
                            </>
                          )}

                          {/* Author reply record */}
                          {cmt.authorReply && (
                            <div className="p-1.5 bg-emerald-50 rounded border border-emerald-200 text-[10px] text-emerald-900 space-y-0.5">
                              <div className="font-semibold flex items-center justify-between">
                                <span>主笔处理说明：</span>
                                {cmt.implementationDraftId && (
                                  <span className="font-mono text-[9px] text-emerald-700">
                                    {cmt.implementationDraftId}
                                  </span>
                                )}
                              </div>
                              <p>{cmt.authorReply}</p>
                            </div>
                          )}

                          {/* Action Buttons for Author */}
                          {canUserEdit && (cmt.status === 'pending' || cmt.status === 'accepted_pending_implementation') && (
                            <div className="pt-1.5 border-t border-slate-200/70 flex flex-wrap justify-end gap-1 text-[10px]">
                              {loc.targetBlock && (
                                <button
                                  onClick={() => handleGenerateRevisionFromComment(cmt)}
                                  className="px-2 py-0.5 bg-blue-700 hover:bg-blue-800 text-white rounded font-medium flex items-center gap-0.5 cursor-pointer"
                                  title="在左侧正文中定位并生成AI修改建议"
                                >
                                  <Sparkles className="w-2.5 h-2.5" />
                                  <span>生成修改建议</span>
                                </button>
                              )}

                              <button
                                onClick={() => handleAcceptCommentDecisionOnly(cmt)}
                                className="px-2 py-0.5 bg-blue-50 text-blue-800 hover:bg-blue-100 border border-blue-200 rounded font-medium cursor-pointer"
                                title="记录处理决定为【决定采纳，待落实】（不直接改写正文）"
                              >
                                决定采纳 (待落实)
                              </button>

                              <button
                                onClick={() => handleOpenDirectImplementModal(cmt)}
                                className="px-2 py-0.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded font-medium cursor-pointer"
                                title="直接写入正文并生成新工作稿"
                              >
                                直接落实修改
                              </button>

                              <button
                                onClick={() => handleOpenRejectModal(cmt)}
                                className="px-2 py-0.5 text-slate-600 hover:bg-slate-100 border border-slate-300 rounded cursor-pointer"
                              >
                                拒绝并说明
                              </button>

                              <button
                                onClick={() => handleOpenDiscussModal(cmt)}
                                className="px-2 py-0.5 text-purple-700 hover:bg-purple-50 border border-purple-200 rounded cursor-pointer"
                              >
                                待沟通
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            ) : activeBlock ? (
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
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold text-slate-700 block">
                        第 {activeBlock.order} 段关联事实与出处：
                      </span>
                      {inspectingFactId && (
                        <button
                          onClick={() => setInspectingFactId(null)}
                          className="text-[10px] text-blue-600 hover:text-blue-800 cursor-pointer"
                        >
                          清除聚焦
                        </button>
                      )}
                    </div>

                    {activeBlock.referencedFactIds.length > 0 ? (
                      activeBlock.referencedFactIds.map((factId) => {
                        const fact = task.facts.find((f) => f.id === factId);
                        const snippet = task.snippets.find((s) => s.id === fact?.primaryEvidenceId);
                        if (!fact) return null;

                        const isFocused = inspectingFactId === fact.id;

                        // Check frozen snapshot value if exists
                        const snapItem = currentDraft?.snapshotMetadata?.factSnapshot?.items?.find(
                          (item) => item.factId === fact.id
                        );
                        const hasSnapshotDiff =
                          snapItem &&
                          (snapItem.value !== fact.value || snapItem.unit !== fact.unit);

                        const adoptedVal = snapItem
                          ? `${snapItem.value} ${snapItem.unit}`
                          : `${fact.value} ${fact.unit}`;
                        const currentVal = `${fact.value} ${fact.unit}`;

                        return (
                          <div
                            key={fact.id}
                            className={`p-3 rounded-lg border text-xs space-y-2 transition-all ${
                              isFocused
                                ? 'bg-blue-50/70 border-blue-400 ring-2 ring-blue-100 shadow-2xs'
                                : 'bg-slate-50 border-slate-200'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-bold text-slate-900">{fact.metric}</span>
                              <span
                                className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                                  fact.status === 'confirmed'
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : 'bg-amber-100 text-amber-800'
                                }`}
                              >
                                {fact.status === 'confirmed' ? '当前已核准' : '待确认'}
                              </span>
                            </div>

                            {/* Comparison of Adopted value vs Current confirmed value */}
                            <div className="grid grid-cols-2 gap-1.5 text-[11px] bg-white p-2 rounded border border-slate-200/80">
                              <div>
                                <span className="text-[10px] text-slate-400 block">
                                  {isCurrentDraftImmutable ? '稿件冻结采用值' : '当前稿采用值'}
                                </span>
                                <span className="font-bold text-slate-900 font-mono">
                                  {adoptedVal}
                                </span>
                              </div>
                              <div>
                                <span className="text-[10px] text-slate-400 block">任务最新核准值</span>
                                <span className="font-bold text-blue-800 font-mono">
                                  {currentVal}
                                </span>
                              </div>
                            </div>

                            {/* Version discrepancy notice */}
                            {hasSnapshotDiff && (
                              <div className="p-2 bg-amber-50 border border-amber-300 rounded text-[11px] text-amber-900 space-y-1">
                                <div className="font-semibold flex items-center gap-1">
                                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                                  <span>版本差异提示</span>
                                </div>
                                <p className="text-[10px] text-amber-800 leading-normal">
                                  {isCurrentDraftImmutable
                                    ? `本稿属于历史只读快照，按规则优先保持当时冻结依据（${adoptedVal}），当前最新核准值不回填旧稿。`
                                    : `当前工作稿采用值为【${adoptedVal}】，材料库最新核准为【${currentVal}】。如需更新正文，可重新生成整稿候选或通过段落修改建议更新。`}
                                </p>
                              </div>
                            )}

                            <div className="text-[11px] text-slate-500 space-y-0.5 pt-0.5">
                              <div>统计期间：<strong className="text-slate-700 font-medium">{fact.period}</strong></div>
                              {fact.metricScope && (
                                <div>统计口径：<strong className="text-slate-700 font-medium">{fact.metricScope}</strong></div>
                              )}
                            </div>

                            {snippet ? (
                              <div className="pt-1.5 border-t border-slate-200/60 flex items-center justify-between">
                                <span className="text-[10px] text-slate-500">
                                  出处：{snippet.docName} ({snippet.location || '段落索引'})
                                </span>
                                <button
                                  onClick={() => onViewSnippet(snippet)}
                                  className="text-[11px] text-blue-700 hover:text-blue-900 font-semibold flex items-center gap-1 cursor-pointer"
                                >
                                  <span>在抽屉中核验全文</span>
                                  <ExternalLink className="w-2.5 h-2.5" />
                                </button>
                              </div>
                            ) : (
                              <div className="text-[10px] text-amber-800 italic pt-1 border-t border-slate-200/60">
                                材料库未关联特定摘录片段（出处未登记或台账录入，无纸质页码）
                              </div>
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
              <div className="py-12 text-center space-y-2">
                <FileText className="w-8 h-8 text-slate-300 mx-auto" />
                <p className="text-xs text-slate-400">点击文稿中的段落以查看依据与修改建议</p>
                <button
                  onClick={() => setInspectorTab('review_comments')}
                  className="px-3 py-1.5 text-xs text-blue-700 bg-blue-50 hover:bg-blue-100 rounded font-medium cursor-pointer"
                >
                  查看全部审阅意见 ({task.reviewComments.length})
                </button>
              </div>
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

      {/* Candidate Comparison & Difference Modal */}
      <CandidateComparisonModal
        isOpen={showCandidateComparisonModal}
        onClose={() => setShowCandidateComparisonModal(false)}
        task={task}
        currentDraft={currentDraft}
        candidate={pendingCandidate}
        onAccept={() => {
          handleAcceptCandidate();
          setShowCandidateComparisonModal(false);
        }}
        onDiscard={() => {
          setPendingCandidate(null);
          setShowCandidateComparisonModal(false);
        }}
        onRegenerate={() => {
          setShowCandidateComparisonModal(false);
          handleStartGenerate(draftInstructionInput);
        }}
        activeRole={activeRole}
        onViewSnippet={onViewSnippet}
        currentInstructionInput={draftInstructionInput}
        onInspectFact={handleInspectFact}
      />

      {/* 1. Direct Implement Comment Modal */}
      {implementingComment && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="font-bold text-sm text-slate-800 flex items-center gap-1.5">
                <Edit3 className="w-4 h-4 text-emerald-700" />
                <span>落实审阅意见修改到正文</span>
              </h3>
              <button
                onClick={() => setImplementingComment(null)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <form onSubmit={handleConfirmDirectImplement} className="p-5 space-y-3.5 text-xs">
              <div className="p-2.5 bg-blue-50/70 rounded border border-blue-200 space-y-1">
                <div className="font-bold text-blue-900 flex items-center justify-between">
                  <span>审阅意见（{implementingComment.reviewer}）</span>
                  <span className="text-[10px] bg-blue-200 text-blue-800 px-1.5 py-0.2 rounded font-medium">
                    {implementingComment.type === 'overall' ? '全局意见' : `第${implementingComment.targetBlockOrder || '?'}段`}
                  </span>
                </div>
                <p className="text-slate-700">{implementingComment.content}</p>
                {implementingComment.suggestedChange && (
                  <div className="pt-1 text-[11px] text-blue-800 font-medium">
                    建议方向：{implementingComment.suggestedChange}
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">落实修改后的段落正文：</label>
                <textarea
                  rows={4}
                  value={implBlockContent}
                  onChange={(e) => setImplBlockContent(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded font-serif text-xs leading-relaxed focus:ring-1 focus:ring-emerald-600 focus:outline-hidden"
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">主笔落实答复与说明：</label>
                <input
                  type="text"
                  value={implAuthorReply}
                  onChange={(e) => setImplAuthorReply(e.target.value)}
                  placeholder="例如：主笔已核实修改第X段，并补充相关成效表述"
                  className="w-full p-2 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-emerald-600 focus:outline-hidden"
                  required
                />
              </div>

              <div className="pt-2 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setImplementingComment(null)}
                  className="px-3 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded font-medium shadow-xs cursor-pointer"
                >
                  确认写入正文并生成新工作稿
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 2. Reject Comment Modal */}
      {rejectingComment && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="font-bold text-sm text-slate-800 flex items-center gap-1.5">
                <XCircle className="w-4 h-4 text-slate-600" />
                <span>拒绝审阅意见并说明理由</span>
              </h3>
              <button
                onClick={() => setRejectingComment(null)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <form onSubmit={handleConfirmReject} className="p-5 space-y-3.5 text-xs">
              <div className="p-2.5 bg-slate-100 rounded border border-slate-200 space-y-1">
                <div className="font-bold text-slate-800">
                  【{rejectingComment.reviewer}】提出的意见：
                </div>
                <p className="text-slate-600">{rejectingComment.content}</p>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">
                  拒绝理由说明（必填，将随审阅记录归档存证）：
                </label>
                <textarea
                  rows={3}
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="例如：经主笔核实，公文法定篇幅限制须优先保证上级发文规范，该部分表述暂不作扩展"
                  className="w-full p-2 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500 focus:outline-hidden"
                  required
                />
              </div>

              <div className="pt-2 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRejectingComment(null)}
                  className="px-3 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-slate-700 hover:bg-slate-800 text-white rounded font-medium shadow-xs cursor-pointer"
                >
                  确认拒绝意见
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 3. Discuss Comment Modal */}
      {discussingComment && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="font-bold text-sm text-slate-800 flex items-center gap-1.5">
                <MessageCircle className="w-4 h-4 text-purple-700" />
                <span>标记审阅意见为待沟通讨论</span>
              </h3>
              <button
                onClick={() => setDiscussingComment(null)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <form onSubmit={handleConfirmDiscuss} className="p-5 space-y-3.5 text-xs">
              <div className="p-2.5 bg-purple-50/70 rounded border border-purple-200 space-y-1">
                <div className="font-bold text-purple-900">
                  【{discussingComment.reviewer}】提出的意见：
                </div>
                <p className="text-slate-700">{discussingComment.content}</p>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">沟通要点与备忘说明：</label>
                <textarea
                  rows={3}
                  value={discussNote}
                  onChange={(e) => setDiscussNote(e.target.value)}
                  placeholder="例如：口径表述涉及两部门交叉，拟于明日协调会与审阅领导当面确认后统一落实"
                  className="w-full p-2 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-purple-500 focus:outline-hidden"
                  required
                />
              </div>

              <div className="pt-2 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDiscussingComment(null)}
                  className="px-3 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-purple-700 hover:bg-purple-800 text-white rounded font-medium shadow-xs cursor-pointer"
                >
                  保存待沟通状态
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 4. Rebind Comment Target Block Modal */}
      {reboundingComment && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="font-bold text-sm text-slate-800 flex items-center gap-1.5">
                <CornerDownRight className="w-4 h-4 text-blue-700" />
                <span>重新指定审阅意见目标段落</span>
              </h3>
              <button
                onClick={() => setReboundingComment(null)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <form onSubmit={handleConfirmRebind} className="p-5 space-y-3.5 text-xs">
              <div className="p-2.5 bg-amber-50 rounded border border-amber-200 space-y-1">
                <div className="font-bold text-amber-900">
                  【{reboundingComment.reviewer}】提出的意见：
                </div>
                <p className="text-slate-700">{reboundingComment.content}</p>
                {reboundingComment.baseParagraphText && (
                  <p className="text-[10px] text-slate-500 italic pt-1">
                    提出时原句：“{reboundingComment.baseParagraphText.slice(0, 50)}...”
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">请选择当前文稿中的新目标段落：</label>
                <select
                  value={reboundBlockId}
                  onChange={(e) => setReboundBlockId(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded text-xs bg-white focus:ring-1 focus:ring-blue-500"
                >
                  {currentDraft?.blocks.map((b) => (
                    <option key={b.id} value={b.id}>
                      第{b.order}段 ({b.id}): {b.content.slice(0, 36)}...
                    </option>
                  ))}
                </select>
              </div>

              <div className="pt-2 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setReboundingComment(null)}
                  className="px-3 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded font-medium shadow-xs cursor-pointer"
                >
                  确认重新关联
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 5. Contradiction Resolution Modal */}
      {showContradictionModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-xl w-full border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-amber-50 flex items-center justify-between">
              <h3 className="font-bold text-sm text-amber-900 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                <span>主笔协调裁决审阅矛盾意见</span>
              </h3>
              <button
                onClick={() => setShowContradictionModal(false)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2.5 bg-slate-50 rounded border border-slate-200 space-y-1">
                  <div className="font-bold text-slate-800">审阅乙（分管领导）：</div>
                  <p className="text-slate-600">“篇幅建议压缩到2000字以内，主要汇报面向领导，需精炼紧凑。”</p>
                </div>
                <div className="p-2.5 bg-slate-50 rounded border border-slate-200 space-y-1">
                  <div className="font-bold text-slate-800">审阅丁（业务处长）：</div>
                  <p className="text-slate-600">“第二部分成效偏薄弱，建议补充两个详细案例以丰富基层说服力。”</p>
                </div>
              </div>

              <div className="space-y-2">
                <label className="font-semibold text-slate-700 block">选择协调裁决策略：</label>
                <div className="space-y-2">
                  <label className="flex items-start gap-2 p-2.5 rounded border border-slate-200 hover:bg-slate-50 cursor-pointer">
                    <input
                      type="radio"
                      name="strat"
                      checked={selectedStrategy === 'balanced'}
                      onChange={() => {
                        setSelectedStrategy('balanced');
                        setStrategyReason('综合两位领导意见：在第一部分压缩常规动员铺垫约300字，同时以提炼式短句补充基层专项调研成效，控制全篇在2500字左右。');
                      }}
                      className="mt-0.5"
                    />
                    <div>
                      <div className="font-bold text-slate-900">综合协调策略（推荐）</div>
                      <div className="text-[11px] text-slate-500">压缩动员铺垫300字，同时以提炼式短句精炼补充代表性成效，兼顾紧凑与成效。</div>
                    </div>
                  </label>

                  <label className="flex items-start gap-2 p-2.5 rounded border border-slate-200 hover:bg-slate-50 cursor-pointer">
                    <input
                      type="radio"
                      name="strat"
                      checked={selectedStrategy === 'compress_priority'}
                      onChange={() => {
                        setSelectedStrategy('compress_priority');
                        setStrategyReason('篇幅优先：严格执行篇幅压缩要求至2000字内，成效案例列入附件供参考。');
                      }}
                      className="mt-0.5"
                    />
                    <div>
                      <div className="font-bold text-slate-900">篇幅优先策略</div>
                      <div className="text-[11px] text-slate-500">优先响应审阅乙：删减铺垫段落，严格将正文压缩至2000字以内。</div>
                    </div>
                  </label>

                  <label className="flex items-start gap-2 p-2.5 rounded border border-slate-200 hover:bg-slate-50 cursor-pointer">
                    <input
                      type="radio"
                      name="strat"
                      checked={selectedStrategy === 'case_priority'}
                      onChange={() => {
                        setSelectedStrategy('case_priority');
                        setStrategyReason('案例丰富优先：优先响应审阅丁充实基层成效，篇幅可适当放宽。');
                      }}
                      className="mt-0.5"
                    />
                    <div>
                      <div className="font-bold text-slate-900">案例丰富优先策略</div>
                      <div className="text-[11px] text-slate-500">优先响应审阅丁：补充典型调研案例与举措细节，篇幅适度放宽。</div>
                    </div>
                  </label>
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">主笔裁决说明与备忘理由：</label>
                <textarea
                  rows={2}
                  value={strategyReason}
                  onChange={(e) => setStrategyReason(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-amber-500"
                />
              </div>

              <div className="pt-2 border-t border-slate-200 flex flex-wrap justify-between items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowContradictionModal(false)}
                  className="px-3 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => handleResolveContradiction('strategy_only')}
                    className="px-3 py-1.5 bg-blue-50 text-blue-800 hover:bg-blue-100 border border-blue-200 rounded font-medium cursor-pointer"
                    title="记录裁决决定为【决定采纳，待落实】，两项意见保持待落实状态，不立即改写正文"
                  >
                    仅记录裁决策略 (待落实)
                  </button>

                  <button
                    type="button"
                    onClick={() => handleResolveContradiction('implement_now')}
                    className="px-4 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded font-bold shadow-xs cursor-pointer"
                    title="立即根据裁决策略改写对应段落正文，生成新工作稿并将两项意见标记为已落实"
                  >
                    立即按策略落实正文
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

