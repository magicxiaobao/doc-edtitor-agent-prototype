import { CoordinationOpinionSelector } from '../CoordinationOpinionSelector';
import { DecisionNoteModal } from '../DecisionNoteModal';
import React, { useState, useEffect, useLayoutEffect, useId, useRef, useMemo } from 'react';
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
  ReviewCommentStatus,
  Fact,
  AdoptedEvidenceRecord,
  ReviewNavigationIntent,
  FactRevisionCandidate,
  MultiParagraphFactRevisionCandidate
} from '../../types';
import { acceptFactRevisionCandidate, acceptMultiParagraphFactRevisionCandidate } from '../../services/factRevisionCandidateService';
import { resolveDraftFactEvidence, findDraftFact } from '../../services/factLifecycleService';
import { 
  generateDraftFromFactsAndOutline, 
  computeContentHash,
  formatTaskPeriod,
  isSupportedDraftInstruction
} from '../../services/mockDraftService';
import { CandidateComparisonModal } from '../CandidateComparisonModal';
import { ParagraphSuggestionEditor } from '../ParagraphSuggestionEditor';
import { RecentModificationsModal } from '../RecentModificationsModal';
import { AutoResizeParagraphTextarea } from '../AutoResizeParagraphTextarea';
import { DraftingInspectorContent } from '../DraftingInspectorContent';
import { MaterialEvidenceList } from '../MaterialEvidenceList';
import { MaterialSupplementModal } from '../MaterialSupplementModal';
import { FactImpactModal } from '../FactImpactModal';
import { analyzeFactImpact, FactImpactItem } from '../../services/factImpactService';
import {
  saveFactReviewRecord,
  revokeFactReviewRecord,
  evaluateDraftFactReviews,
} from '../../services/factReviewService';
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
  submitDraftForReview,
  adoptParagraphSuggestion,
  undoSafeParagraphModification,
  validateUndoEligibility,
  getRecentModificationLogs,
  getLatestAppliedLogForDraft,
  getDraftReviewComments
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
  resolveReviewNavigationContext,
  implementReviewCommentWithText,
  updateReviewCommentDecision,
  rebindReviewCommentTargetBlock,
  generateCoordinationDiff,
  applyCoordinationDecision,
  findAuthenticCaseSnippet,
  interpretReviewCommentSuggestion
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
  XCircle,
  Menu
} from 'lucide-react';

interface DraftingStageProps {
  task: Task;
  onUpdateTask: (updated: Partial<Task>) => void;
  onViewSnippet: (snippet: EvidenceSnippet, fact?: Fact, adoptedEvidence?: AdoptedEvidenceRecord, freezeDraftEvidence?: boolean) => void;
  onProceedToNextStage: () => void;
  activeRole: UserRole;
  onSelectStage?: (stage: TaskStage) => void;
  initialInspectorTab?: 'ai_suggestions' | 'review_comments' | 'material_evidence';
  navIntent?: ReviewNavigationIntent | null;
  onClearNavIntent?: () => void;
}

export const DraftingStage: React.FC<DraftingStageProps> = ({
  task,
  onUpdateTask,
  onViewSnippet,
  onProceedToNextStage,
  activeRole,
  onSelectStage,
  initialInspectorTab,
  navIntent,
  onClearNavIntent,
}) => {
  // Active draft version
  const currentDraft = task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];
  const activeReviewComments = useMemo(() => getDraftReviewComments(task, currentDraft), [task, currentDraft]);

  // Task 21: Fact Impact Analysis (derived deterministically from task and currentDraft snapshot)
  const factImpact = useMemo(() => analyzeFactImpact(task, currentDraft), [task, currentDraft]);
  // Task 22: Fact Review Records Evaluation
  const reviewOverview = useMemo(() => evaluateDraftFactReviews(task, currentDraft), [task, currentDraft]);
  const [showFactImpactModal, setShowFactImpactModal] = useState(false);
  const [impactFocusBlockId,setImpactFocusBlockId]=useState<string|undefined>();
  const [locateError, setLocateError] = useState<string | null>(null);
  const impactLocateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear locate error when switching task or draft
  useEffect(() => {
    setLocateError(null);
    setShowFactImpactModal(false);
    setImpactFocusBlockId(undefined);
    return () => {
      if (impactLocateTimer.current !== null) clearTimeout(impactLocateTimer.current);
    };
  }, [task.id, currentDraft?.id]);

  // Collapsible panels
  const [showLeftNav, setShowLeftNav] = useState(true);
  const [showRightInspector, setShowRightInspector] = useState(true);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const outlinePanelId = useId();
  const inspectorPanelId = useId();
  const panelTransitionRef = useRef<{
    anchor: HTMLElement | null;
    top: number;
    side: 'outline' | 'inspector';
  } | null>(null);

  const toggleDesktopPanel = (side: 'outline' | 'inspector', expanded: boolean) => {
    const workspace = workspaceRef.current;
    const stickyTop = workspace
      ? parseFloat(window.getComputedStyle(workspace).getPropertyValue('--app-header-height')) || 64
      : 64;
    // Anchor the paragraph currently being read, which can differ from the selected one.
    const anchor = Array.from(workspace?.querySelectorAll<HTMLElement>('[data-testid^="textarea-block-"]') || [])
      .find(el => {
        const rect = el.getBoundingClientRect();
        return rect.bottom > stickyTop + 8 && rect.top < window.innerHeight;
      }) || workspace?.querySelector<HTMLElement>('[data-testid="document-editor-canvas"]') || null;
    panelTransitionRef.current = { anchor, top: anchor?.getBoundingClientRect().top || 0, side };
    if (side === 'outline') setShowLeftNav(expanded);
    else setShowRightInspector(expanded);
  };

  useLayoutEffect(() => {
    const transition = panelTransitionRef.current;
    if (!transition) return;
    panelTransitionRef.current = null;
    if (transition.anchor?.isConnected) {
      const delta = transition.anchor.getBoundingClientRect().top - transition.top;
      if (delta) window.scrollBy(0, delta);
    }
    const label = transition.side === 'outline'
      ? showLeftNav ? '折叠导航栏' : '展开章节导航'
      : showRightInspector ? '折叠辅助面板' : '展开辅助面板';
    workspaceRef.current?.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.focus({ preventScroll: true });
  }, [showLeftNav, showRightInspector]);

  // Inspector tab: 'ai_suggestions' | 'review_comments' | 'material_evidence'
  const [inspectorTab, setInspectorTab] = useState<'ai_suggestions' | 'review_comments' | 'material_evidence'>(() => {
    if (navIntent && navIntent.taskId === task.id && navIntent.commentId) return 'review_comments';
    return initialInspectorTab || 'ai_suggestions';
  });

  // In-app modal for submit for review (replaces window.confirm)
  const [showSubmitReviewModal, setShowSubmitReviewModal] = useState(false);

  // Review comments filtering and modal state
  const [commentStatusFilter, setCommentStatusFilter] = useState<'all' | ReviewCommentStatus>('all');
  const [commentReviewerFilter, setCommentReviewerFilter] = useState<'all' | '审阅乙' | '审阅丁'>('all');
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(() => {
    if (navIntent && navIntent.taskId === task.id) {
      return navIntent.commentId;
    }
    return null;
  });

  // Manual implement comment modal
  const [implementingComment, setImplementingComment] = useState<ReviewComment | null>(null);
  const [implBlockContent, setImplBlockContent] = useState<string>('');
  const [implAuthorReply, setImplAuthorReply] = useState<string>('');

  // Reject comment modal
  const [acceptingComment, setAcceptingComment] = useState<ReviewComment | null>(null);
  const [showMaterialSupplementModal, setShowMaterialSupplementModal] = useState<boolean>(false);
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
  const [coordinationCommentIds, setCoordinationCommentIds] = useState<string[]>(() => activeReviewComments.filter(c => ['pending', 'accepted_pending_implementation', 'need_discussion'].includes(c.status)).slice(0, 2).map(c => c.id));
  useEffect(() => { setShowContradictionModal(false); setCoordinationCommentIds([]); }, [task.id]);

  const [strategyReason, setStrategyReason] = useState(
    '综合两位审阅领导意见：在第一部分压缩常规动员铺垫约300字，同时以提炼式短句补充基层专项调研代表性成效，控制全篇在2500字左右。'
  );

  // Selected block for editing / inspection
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(() => {
    if (navIntent && navIntent.taskId === task.id && navIntent.commentId) {
      const initDraft = task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];
      const comments = activeReviewComments;
      const cmt = comments.find((c) => c.id === navIntent.commentId);
      if (cmt && initDraft) {
        const resolved = resolveReviewNavigationContext(cmt, initDraft);
        if (resolved.targetBlock) {
          return resolved.targetBlock.id;
        }
        return null;
      }
    }
    return null;
  });

  // Inspected fact ID for targeted evidence examination
  const [inspectingFactId, setInspectingFactId] = useState<string | null>(null);

  // Draft regeneration / candidate state & strict isolation refs
  const [isGenerating, setIsGenerating] = useState(false);
  const [pendingCandidate, setPendingCandidate] = useState<DraftCandidate | null>(null);
  const [showCandidateComparisonModal, setShowCandidateComparisonModal] = useState(false);
  const [showSaveVersionModal, setShowSaveVersionModal] = useState(false);
  const [versionSummary, setVersionSummary] = useState('');
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [showRecentModificationsModal, setShowRecentModificationsModal] = useState(false);
  const [adoptFeedback, setAdoptFeedback] = useState<{
    logId: string;
    blockOrder: number;
    blockId: string;
    message: string;
  } | null>(null);
  const [draftInstructionInput, setDraftInstructionInput] = useState<string>('突出成效，减少铺垫');
  const [showPrepDetails, setShowPrepDetails] = useState(false);
  const [showWholeDraftAdjust, setShowWholeDraftAdjust] = useState(false);
  const [showTabletInspectorDrawer, setShowTabletInspectorDrawer] = useState(() => {
    return Boolean(navIntent && navIntent.taskId === task.id && navIntent.commentId);
  });
  const [showTabletOutlineDrawer, setShowTabletOutlineDrawer] = useState(false);
  const lastTabletTriggerRef = useRef<HTMLElement | null>(null);

  // Map of fine-tuned pending texts keyed by `${suggestionKey}` to persist across drawer/inspector close & reopen
  const [fineTunedPendingTexts, setFineTunedPendingTexts] = useState<Record<string, string>>({});

  // Close tablet drawers on Escape with focus restoration (only when drawer is top-most)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // If an inner/nested modal is open, let that inner modal handle Escape
        if (
          document.querySelector('[data-nested-modal="true"]') ||
          showCandidateComparisonModal || showMaterialSupplementModal || acceptingComment ||
          showSaveVersionModal ||
          showVersionHistory ||
          showRecentModificationsModal ||
          showFactImpactModal ||
          showSubmitReviewModal ||
          showContradictionModal ||
          implementingComment ||
          rejectingComment ||
          discussingComment ||
          reboundingComment
        ) {
          return;
        }

        if (showTabletInspectorDrawer) {
          e.preventDefault();
          setShowTabletInspectorDrawer(false);
          if (selectedBlockId) {
            setTimeout(() => {
              const el = document.getElementById(`block-card-${selectedBlockId}`);
              if (el && typeof el.scrollIntoView === 'function') {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
              lastTabletTriggerRef.current?.focus();
            }, 30);
          } else {
            lastTabletTriggerRef.current?.focus();
          }
        } else if (showTabletOutlineDrawer) {
          e.preventDefault();
          setShowTabletOutlineDrawer(false);
          lastTabletTriggerRef.current?.focus();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    showTabletInspectorDrawer,
    showTabletOutlineDrawer,
    selectedBlockId,
    showCandidateComparisonModal, showMaterialSupplementModal, acceptingComment,
    showSaveVersionModal,
    showVersionHistory,
    showRecentModificationsModal,
    showSubmitReviewModal,
    showContradictionModal,
    implementingComment,
    rejectingComment,
    discussingComment,
    reboundingComment,
  ]);

  // Focus trapping and initial focus for tablet drawers
  const tabletDrawerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showTabletInspectorDrawer && !showTabletOutlineDrawer) return;

    const drawerEl = tabletDrawerRef.current || document.querySelector<HTMLElement>('[data-testid="drawer-tablet-inspector"], [data-testid="drawer-tablet-outline"]');
    if (!drawerEl) return;

    // Focus initial element inside drawer
    const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusables = Array.from(drawerEl.querySelectorAll<HTMLElement>(focusableSelector));
    if (focusables.length > 0) {
      const closeBtn = drawerEl.querySelector<HTMLElement>('[data-testid="btn-close-tablet-inspector"], [data-testid="btn-close-tablet-outline"]');
      if (closeBtn) {
        closeBtn.focus();
      } else {
        focusables[0].focus();
      }
    }

    const handleTabKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (document.querySelector('[data-nested-modal="true"]')) return;

      const currentFocusables = Array.from(drawerEl.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (currentFocusables.length === 0) return;

      const firstEl = currentFocusables[0];
      const lastEl = currentFocusables[currentFocusables.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === firstEl || !drawerEl.contains(document.activeElement)) {
          e.preventDefault();
          lastEl.focus();
        }
      } else {
        if (document.activeElement === lastEl || !drawerEl.contains(document.activeElement)) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };

    window.addEventListener('keydown', handleTabKey);
    return () => window.removeEventListener('keydown', handleTabKey);
  }, [showTabletInspectorDrawer, showTabletOutlineDrawer]);

  // Auto-close tablet drawers when viewport expands to desktop (>= 1024px)
  useEffect(() => {
    const handleResize = () => {
      if (typeof window !== 'undefined' && window.innerWidth >= 1024) {
        setShowTabletInspectorDrawer(false);
        setShowTabletOutlineDrawer(false);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Unified responsive routing helper: desktop updates sidebar without covering canvas, narrow screen opens drawer
  const handleOpenBlockInspector = (
    blockId: string,
    tab: 'ai_suggestions' | 'review_comments' | 'material_evidence',
    triggerEl?: HTMLElement,
    commentId?: string
  ) => {
    setSelectedBlockId(blockId);
    setInspectorTab(tab);
    if (commentId) setSelectedCommentId(commentId);
    setShowRightInspector(true);
    const isNarrowScreen = typeof window !== 'undefined' && window.innerWidth < 1024;
    if (isNarrowScreen) {
      if (triggerEl) lastTabletTriggerRef.current = triggerEl;
      setShowTabletInspectorDrawer(true);
    } else {
      setShowTabletInspectorDrawer(false);
    }
  };

  const draftCancelledRef = useRef(false);
  const [activeDraftRunId, setActiveDraftRunId] = useState<string | null>(null);
  const activeDraftRunIdRef = useRef<string | null>(null);
  const completedCandidateRunIdRef = useRef<string | null>(null);
  const currentTaskIdRef = useRef<string>(task.id);
  const currentDraftIdRef = useRef<string>(currentDraft?.id || '');
  const isUnmountedRef = useRef(false);
  const generateTimerRef = useRef<any>(null);

  useEffect(() => {
    currentDraftIdRef.current = currentDraft?.id || '';
  }, [currentDraft?.id]);

  // Local paragraph revision state
  const [revisionSuggestion, setRevisionSuggestion] = useState<RevisionSuggestion | null>(null);
  const [isRevisionGenerating, setIsRevisionGenerating] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [revisionTargetOrder, setRevisionTargetOrder] = useState<number | null>(null);
  const [customPromptInput, setCustomPromptInput] = useState<string>('');
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [activeRevisionRunId, setActiveRevisionRunId] = useState<string | null>(null);
  const activeRevisionRunIdRef = useRef<string | null>(null);
  const completedRevisionRunIdRef = useRef<string | null>(null);

  // Task 20: Material Supplementation Modal state & handler
  const handleOpenMaterialSupplement = () => {
    setShowMaterialSupplementModal(true);
  };
  const handleSupplementSuccess = (suggestion: RevisionSuggestion) => {
    if (
      !suggestion ||
      suggestion.taskId !== task.id ||
      (currentDraft && suggestion.sourceDraftId !== currentDraft.id) ||
      (selectedBlockId && suggestion.targetBlockId !== selectedBlockId)
    ) {
      return;
    }
    setRevisionSuggestion(suggestion);
    setInspectorTab('ai_suggestions');
    if (suggestion.runId) {
      completedRevisionRunIdRef.current = suggestion.runId;
    }
  };

  // Key and fine-tuned text for current suggestion
  const fineTuneKey = revisionSuggestion && currentDraft
    ? `${revisionSuggestion.runId || 'run'}-${currentDraft.id}-${revisionSuggestion.targetBlockId}`
    : '';
  const currentPendingFineTune = fineTuneKey && fineTunedPendingTexts[fineTuneKey] !== undefined
    ? fineTunedPendingTexts[fineTuneKey]
    : (revisionSuggestion?.suggestedText || '');

  // Refs for revision abort & retry
  const revisionAbortControllerRef = useRef<AbortController | null>(null);
  const lastRevisionRequestRef = useRef<{
    block: ParagraphBlock;
    action: RevisionAction;
    customPrompt?: string;
    sourceComment?: ReviewComment;
  } | null>(null);


  // Cancel generation and clear isolated results ONLY if task actually changes
  const prevTaskIdRef = useRef<string>(task.id);
  useEffect(() => {
    if (prevTaskIdRef.current !== task.id) {
      prevTaskIdRef.current = task.id;
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
      setSelectedBlockId(null);
      setSelectedCommentId(null);
      setCustomPromptInput('');
      setFineTunedPendingTexts({});
      if (onClearNavIntent) {
        onClearNavIntent();
      }
    }
  }, [task.id, onClearNavIntent]);

  // Component unmount cleanup
  useEffect(() => {
    isUnmountedRef.current = false;
    return () => {
      isUnmountedRef.current = true;
      activeDraftRunIdRef.current = null;
      activeRevisionRunIdRef.current = null;
      completedRevisionRunIdRef.current = null;
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
  const latestWorkingDraft = task.drafts.find((d) => !d.isHistoricalSnapshot && !d.isFinal);

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
  const hasExistingDraft = Boolean(currentDraft && currentDraft.blocks && currentDraft.blocks.length > 0);

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

  // Active review comments associated with current draft:
  // If viewing historical snapshot or finalized draft, STRICTLY read frozen review comments;
  // If missing frozenReviewComments on a historical version, NEVER fallback to task.reviewComments (which would leak current comments into history)!
  // Selected comment: STRICTLY query within activeReviewComments of the current version.
  // NEVER fallback to task.reviewComments to prevent polluting historical snapshots with current comments.
  const selectedComment = activeReviewComments.find((c) => c.id === selectedCommentId);
  const selectedCommentNavContext = selectedComment
    ? resolveReviewNavigationContext(selectedComment, currentDraft)
    : null;

  // Selected block object: if selectedBlockId is specified, use it.
  // If an overall comment or deleted paragraph comment is actively selected, do NOT fake selection of block 0!
  const activeBlock = selectedBlockId
    ? currentDraft?.blocks.find((b) => b.id === selectedBlockId)
    : (selectedComment ? undefined : currentDraft?.blocks[0]);

  // Total word count of current draft
  const currentWordCount = currentDraft?.blocks.reduce((acc, b) => acc + b.content.length, 0) || 0;

  // Storage error status
  const currentStorageError = getStorageError();
  const lastSavedTimeStr = task.updatedAt
    ? new Date(task.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '刚刚';

  // Task & Version switch cleanup effect: cancel in-flight requests, clear suggestions and stale location
  const previousRoleRef = useRef(activeRole);
  const previousTaskIdRef = useRef<string>(task.id);
  const previousDraftIdRef = useRef<string | undefined>(currentDraft?.id);
  useEffect(() => {
    const isTaskChanged = previousTaskIdRef.current !== task.id;
    const isDraftChanged = previousDraftIdRef.current && previousDraftIdRef.current !== currentDraft?.id;

    const isRoleChanged = previousRoleRef.current !== activeRole;
    if (isTaskChanged || isDraftChanged || isRoleChanged) {
      activeDraftRunIdRef.current = null; completedCandidateRunIdRef.current = null;
      if (generateTimerRef.current) clearTimeout(generateTimerRef.current);
      setIsGenerating(false); setPendingCandidate(null); setShowCandidateComparisonModal(false);
      setShowSaveVersionModal(false); setShowVersionHistory(false); setShowRecentModificationsModal(false);
      setShowSubmitReviewModal(false); setShowContradictionModal(false);
      setImplementingComment(null); setRejectingComment(null); setDiscussingComment(null); setReboundingComment(null); setAcceptingComment(null);
      setAdoptFeedback(null); setInspectingFactId(null);

      // 1. Cancel in-flight revision request & supplementation
      if (revisionAbortControllerRef.current) {
        revisionAbortControllerRef.current.abort();
        revisionAbortControllerRef.current = null;
      }
      setIsRevisionGenerating(false);
      setActiveRevisionRunId(null);
      activeRevisionRunIdRef.current = null;
      completedRevisionRunIdRef.current = null;

      // 2. Clear revision suggestions, errors, and modal
      setRevisionSuggestion(null);
      setRevisionError(null);
      setCustomPromptInput('');
      setFineTunedPendingTexts({});
      setShowMaterialSupplementModal(false);

      // 3. Clear invalid / stale block selection if block doesn't exist in new draft or task
      if (selectedBlockId && currentDraft) {
        const blockStillExists = currentDraft.blocks.some((b) => b.id === selectedBlockId);
        if (!blockStillExists || isTaskChanged) {
          setSelectedBlockId(null);
        }
      }

      // 4. Clear invalid / stale comment selection if comment doesn't exist in new draft's comments or task
      if (selectedCommentId) {
        const commentStillExists = activeReviewComments.some((c) => c.id === selectedCommentId);
        if (!commentStillExists || isTaskChanged) {
          setSelectedCommentId(null);
        }
      }
    }
    previousRoleRef.current = activeRole;
    previousTaskIdRef.current = task.id;
    previousDraftIdRef.current = currentDraft?.id;
  }, [task.id, currentDraft?.id, activeRole, currentDraft?.blocks, activeReviewComments, selectedBlockId, selectedCommentId]);

  // Requirement 1, 2, 3, 8: Handle navigation intent from ReviewStage
  const lastProcessedNavRef = useRef<string | null>(null);

  useEffect(() => {
    if (!navIntent) return;
    if (navIntent.taskId !== task.id) {
      if (onClearNavIntent) onClearNavIntent();
      return;
    }

    const intentKey = `${navIntent.taskId}-${navIntent.commentId}-${navIntent.timestamp || 0}`;
    if (lastProcessedNavRef.current === intentKey) {
      return;
    }
    lastProcessedNavRef.current = intentKey;

    const targetComment = activeReviewComments.find((c) => c.id === navIntent.commentId);

    if (!targetComment) {
      // Comment does not exist in current draft's review comments (e.g. historical snapshot)
      setSelectedCommentId(navIntent.commentId);
      return;
    }

    // 1. Expand inspector (desktop sidebar on >=1024px, tablet drawer on <1024px) and switch to 'review_comments' tab
    setShowRightInspector(true);
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      setShowTabletInspectorDrawer(true);
    }
    setInspectorTab('review_comments');
    setSelectedCommentId(targetComment.id);

    // 2. Clear filters so the comment is never hidden
    setCommentStatusFilter('all');
    setCommentReviewerFilter('all');

    // 3. Clear previous suggestion, custom prompt, and run IDs (no residue!)
    setRevisionSuggestion(null);
    setCustomPromptInput('');
    activeRevisionRunIdRef.current = null;
    completedRevisionRunIdRef.current = null;
    setActiveRevisionRunId(null);
    setIsRevisionGenerating(false);
    setRevisionError(null);

    // 4. Resolve target paragraph location
    const navCtx = resolveReviewNavigationContext(targetComment, currentDraft);
    if (navCtx.isOverall) {
      // Overall comment has no fixed paragraph. Do NOT fake first paragraph!
      setSelectedBlockId(null);
    } else if (navCtx.location?.isLocated && navCtx.targetBlock) {
      setSelectedBlockId(navCtx.targetBlock.id);
      setTimeout(() => {
        const el = document.getElementById(`block-card-${navCtx.targetBlock!.id}`);
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 50);
    } else {
      // Missing or deleted target paragraph: do NOT fallback to block 0!
      setSelectedBlockId(null);
    }

    // 5. Scroll comment card into view in the inspector
    setTimeout(() => {
      const cEl = document.getElementById(`comment-card-${targetComment.id}`);
      if (cEl) {
        cEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 80);
  }, [navIntent, task.id, currentDraft?.id, activeReviewComments]);

  // Task 21: Identify blocks needing review strictly from deterministic fact impact analysis
  const blocksNeedingReview = useMemo(() => {
    return (currentDraft?.blocks || []).filter((block) =>
      factImpact.affectedBlockIds.includes(block.id)
    );
  }, [currentDraft?.blocks, factImpact.affectedBlockIds]);

  // Task 21: Locate block from impact panel (strict Block ID matching, no index fallback)
  const handleLocateBlock = (blockId: string, factId?: string) => {
    setShowFactImpactModal(false);

    const targetBlock = currentDraft?.blocks.find((b) => b.id === blockId);
    if (!targetBlock) {
      setLocateError(`定位失败：目标段落【${blockId}】在当前稿件中不存在（可能已被删除或重构），已停止定位。`);
      return;
    }

    setLocateError(null);
    setSelectedBlockId(blockId);

    if (factId) {
      setInspectingFactId(factId);
      setInspectorTab('material_evidence');
    }

    if (!showRightInspector) {
      setShowRightInspector(true);
    }

    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      setShowTabletInspectorDrawer(true);
    }

    if (impactLocateTimer.current !== null) clearTimeout(impactLocateTimer.current);
    impactLocateTimer.current = setTimeout(() => {
      const el =
        document.getElementById(`paragraph-textarea-${blockId}`) ||
        document.getElementById(`block-card-${blockId}`) ||
        document.getElementById(`block-${blockId}`);
      if (el) {
        if (typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        if (el instanceof HTMLElement) {
          el.focus({ preventScroll: true });
        }
      }
    }, 100);
  };

  // Task 21: View frozen draft evidence from impact panel
  const handleViewDraftEvidence = (item: FactImpactItem) => {
    setShowFactImpactModal(false);
    const fact = findDraftFact(task, currentDraft, item.factId);
    if (fact) {
      const resolved = resolveDraftFactEvidence(fact, currentDraft, task, {freezeSnapshot: true});
      onViewSnippet(
        resolved.effectiveSnippet || {
          id: resolved.effectiveEvidenceId || '',
          sourceDocId: '',
          docName: '出处已不可用',
          location: '',
          period: resolved.effectivePeriod,
          text: '',
        },
        fact,
        undefined,
        true
      );
    } else {
      setLocateError('无法查看本稿依据：此事实既无本稿冻结记录，也无当前事实记录，缺少可核验的依据。请结合原始材料人工核实。');
    }
  };

  // Task 22: Fact Review Records handlers
  const handleSaveReviewRecord = (blockId: string, status: 'reviewed' | 'deferred', notes: string, context: string) => {
    if (!currentDraft) return;
    try {
      const res = saveFactReviewRecord({
        task,
        targetDraftId: currentDraft.id,
        targetBlockId: blockId,
        status,
        notes,
        activeRole,
        expectedContextFingerprint:context,
      });
      onUpdateTask({
        drafts: res.updatedTask.drafts,
      });
    } catch (err: any) {
      return err.message || '保存复核记录失败';
    }
  };

  const handleRevokeReviewRecord = (blockId: string, reason: string, context: string, recordId: string) => {
    if (!currentDraft) return;
    try {
      const res = revokeFactReviewRecord({
        task,
        targetDraftId: currentDraft.id,
        targetBlockId: blockId,
        reason,
        activeRole,
        expectedContextFingerprint:context,expectedRecordId:recordId,
      });
      onUpdateTask({
        drafts: res.updatedTask.drafts,
      });
    } catch (err: any) {
      return err.message || '撤回复核记录失败';
    }
  };

  const handleAcceptFactRevision = (candidate: FactRevisionCandidate, activeRunId: string) => {
    try {
      const res = acceptFactRevisionCandidate(task, currentDraft, candidate, activeRole, activeRunId);
      if (!res.success || !res.updatedTask) {
        return { success: false, reason: res.reason || '采纳修订失败' };
      }
      onUpdateTask(res.updatedTask);
      return { success: true };
    } catch (err: any) {
      return { success: false, reason: err.message || '采纳修订异常' };
    }
  };

  const handleAcceptMultiParagraphFactRevision = (candidateGroup: MultiParagraphFactRevisionCandidate, activeRunId: string) => {
    try {
      const res = acceptMultiParagraphFactRevisionCandidate(task, currentDraft, candidateGroup, activeRole, activeRunId);
      if (!res.success || !res.updatedTask) {
        return { success: false, reason: res.reason || '采纳多段落修订失败' };
      }
      onUpdateTask(res.updatedTask);
      return { success: true };
    } catch (err: any) {
      return { success: false, reason: err.message || '采纳多段落修订异常' };
    }
  };

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
        currentTaskIdRef.current !== startingTaskId ||
        currentDraftIdRef.current !== baseDraftId
      ) {
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
            b.id === blockId
              ? {
                  ...b,
                  content: newContent,
                  updatedAt: new Date().toISOString(),
                  revisionSeq: (typeof b.revisionSeq === 'number' && Number.isFinite(b.revisionSeq) ? b.revisionSeq : 1) + 1,
                }
              : b
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
    const requestedDraftId = currentDraft.id;

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
    activeRevisionRunIdRef.current = runId;
    setActiveRevisionRunId(runId);
    setIsRevisionGenerating(true);
    setRevisionError(null);
    setRevisionTargetOrder(targetBlock.order);
    // Explicitly invalidate/clear any prior suggestions to prevent adopting stale suggestion during new generation
    setRevisionSuggestion(null);

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

      // Strict validation against current task boundary, current draft version boundary, and active runId (Requirement P2)
      if (
        abortController.signal.aborted || isUnmountedRef.current ||
        currentTaskIdRef.current !== task.id ||
        currentDraftIdRef.current !== requestedDraftId ||
        currentDraft.id !== requestedDraftId ||
        activeRevisionRunIdRef.current !== runId
      ) {
        return;
      }

      completedRevisionRunIdRef.current = runId;
      setRevisionSuggestion(suggestion);
      setIsRevisionGenerating(false);
      setActiveRevisionRunId(null);
      activeRevisionRunIdRef.current = null;
      revisionAbortControllerRef.current = null;
    } catch (err: any) {
      if (
        currentTaskIdRef.current !== task.id ||
        currentDraftIdRef.current !== requestedDraftId ||
        currentDraft.id !== requestedDraftId ||
        activeRevisionRunIdRef.current !== runId
      ) {
        return; // Ignore errors from superseded / cancelled requests or switched drafts
      }
      if (err.name === 'AbortError' || err.message?.includes('取消')) {
        // Cleanly aborted by user, no error banner
        setIsRevisionGenerating(false);
        setActiveRevisionRunId(null);
        activeRevisionRunIdRef.current = null;
        return;
      }
      setRevisionError(err.message || '生成修改建议失败，请重试');
      setIsRevisionGenerating(false);
      setActiveRevisionRunId(null);
      activeRevisionRunIdRef.current = null;
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
    if (revisionSuggestion && currentDraft) {
      const fKey = `${revisionSuggestion.runId || 'run'}-${currentDraft.id}-${revisionSuggestion.targetBlockId}`;
      setFineTunedPendingTexts((prev) => {
        const next = { ...prev };
        delete next[fKey];
        return next;
      });
    }
    // Explicitly invalidate runId and suggestion upon user cancel
    activeRevisionRunIdRef.current = null;
    completedRevisionRunIdRef.current = null;
    setActiveRevisionRunId(null);
    setRevisionSuggestion(null);
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
    const fKey = `${revisionSuggestion.runId || 'run'}-${currentDraft.id}-${revisionSuggestion.targetBlockId}`;
    setFineTunedPendingTexts((prev) => {
      const next = { ...prev };
      delete next[fKey];
      return next;
    });
    const targetBlock = currentDraft.blocks.find((b) => b.id === revisionSuggestion.targetBlockId);
    if (!targetBlock) {
      alert('未找到原目标段落，无法重新生成。');
      return;
    }
    const matchingComment = revisionSuggestion.sourceCommentId
      ? activeReviewComments.find((c) => c.id === revisionSuggestion.sourceCommentId)
      : undefined;
    executeRevisionRequest(targetBlock, revisionSuggestion.action, revisionSuggestion.customPrompt, matchingComment);
  };

  // Adopt revision into target block (AI original or human fine-tuned)
  const handleAdoptRevision = (pendingTextToAdopt?: string) => {
    if (!revisionSuggestion || !currentDraft) return;

    const fKey = `${revisionSuggestion.runId || 'run'}-${currentDraft.id}-${revisionSuggestion.targetBlockId}`;
    const textToUse = pendingTextToAdopt !== undefined
      ? pendingTextToAdopt
      : (fineTunedPendingTexts[fKey] !== undefined
          ? fineTunedPendingTexts[fKey]
          : revisionSuggestion.suggestedText);

    try {
      const result = adoptParagraphSuggestion({
        task,
        currentDraft,
        suggestion: revisionSuggestion,
        pendingTextToAdopt: textToUse,
        activeCompletedRunId: completedRevisionRunIdRef.current,
        activeRole,
        isGenerating: isRevisionGenerating,
      });

      onUpdateTask({
        drafts: result.updatedTask.drafts,
        currentDraftId: result.workingDraft.id,
        reviewComments: result.updatedTask.reviewComments,
        modificationLogs: result.updatedTask.modificationLogs,
        isFinalized: result.updatedTask.isFinalized,
        status: result.updatedTask.status,
      });

      setRevisionSuggestion(null);
      completedRevisionRunIdRef.current = null;
      setFineTunedPendingTexts((prev) => {
        const next = { ...prev };
        delete next[fKey];
        return next;
      });

      // Provide visible feedback toast with direct safe undo trigger
      setAdoptFeedback({
        logId: result.logEntry.id,
        blockOrder: result.targetBlock.order,
        blockId: result.targetBlock.id,
        message: result.logEntry.isFineTuned
          ? (result.logEntry.isMaterialSupplementation ? '已微调材料补写写入' : '已微调写入')
          : (result.logEntry.isMaterialSupplementation ? '材料补写建议采纳写入' : 'AI建议采纳写入'),
      });
    } catch (err: any) {
      alert(err.message || '采纳建议失败');
    }
  };

  // Safe undo handler via unified lifecycle service
  const handleUndoModification = (logId: string) => {
    try {
      const result = undoSafeParagraphModification(task, currentDraft, logId, activeRole);
      onUpdateTask({
        drafts: result.updatedTask.drafts,
        currentDraftId: result.workingDraft.id,
        reviewComments: result.updatedTask.reviewComments,
        modificationLogs: result.updatedTask.modificationLogs,
        isFinalized: result.updatedTask.isFinalized,
        status: result.updatedTask.status,
      });
      setAdoptFeedback(null);
    } catch (err: any) {
      alert(err.message || '撤销修改失败');
    }
  };

  // Discard suggestion
  const handleDiscardRevision = () => {
    if (revisionSuggestion && currentDraft) {
      const fKey = `${revisionSuggestion.runId || 'run'}-${currentDraft.id}-${revisionSuggestion.targetBlockId}`;
      setFineTunedPendingTexts((prev) => {
        const next = { ...prev };
        delete next[fKey];
        return next;
      });
    }
    completedRevisionRunIdRef.current = null;
    activeRevisionRunIdRef.current = null;
    setActiveRevisionRunId(null);
    setRevisionSuggestion(null);
  };

  // Copy suggestion text only to clipboard (does not modify draft)
  const handleCopyRevision = async () => {
    if (!revisionSuggestion) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(revisionSuggestion.suggestedText);
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

  // Generate revision for review comment (supports paragraph and overall comments)
  const handleGenerateRevisionFromComment = (cmt: ReviewComment, overrideTargetBlock?: ParagraphBlock) => {
    const perm = checkPermission(activeRole, 'edit_draft');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可根据意见生成修改建议');
      return;
    }

    if (!currentDraft) return;

    if (cmt.type === 'overall') {
      const targetBlockToUse = overrideTargetBlock || activeBlock;
      if (!targetBlockToUse) {
        alert('该意见为全局审阅意见，未绑定固定段落。请先在左侧正文中点击选择要应用修改的目标段落，明确修改范围后再生成建议。');
        return;
      }
      setSelectedBlockId(targetBlockToUse.id);
      executeRevisionRequest(
        targetBlockToUse,
        'custom',
        cmt.suggestedChange || cmt.content,
        cmt
      );
      return;
    }

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
    if (!checkPermission(activeRole, 'resolve_comment').allowed || isCurrentDraftImmutable) return;
    setAcceptingComment(cmt);
  };
  const handleConfirmAcceptDecision = (note: string) => {
    if (!acceptingComment || isCurrentDraftImmutable) return;
    try {
      const { updatedTask } = updateReviewCommentDecision(task, acceptingComment.id, 'accepted_pending_implementation', note.trim(), activeRole);
      onUpdateTask({ reviewComments: updatedTask.reviewComments }); setAcceptingComment(null);
    } catch (err: any) { alert(err.message || '记录采纳决定失败'); }
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

    const interpretation = interpretReviewCommentSuggestion(cmt);
    setImplementingComment(cmt);
    // If replacement prose, prefill with reviewer's draft; if instruction, initialize with current paragraph content!
    setImplBlockContent(
      interpretation.isReplacement && interpretation.replacementText
        ? interpretation.replacementText
        : loc.targetBlock.content
    );
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
        modificationLogs: updatedTask.modificationLogs,
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
      setSelectedBlockId(reboundBlockId);
      setTimeout(() => {
        const el = document.getElementById(`block-card-${reboundBlockId}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 50);
      setReboundingComment(null);
    } catch (err: any) {
      alert(err.message || '重新指定段落失败');
    }
  };

  // Resolve contradiction between CMT-01 and CMT-02
  const handleResolveContradiction = (mode: 'strategy_only' | 'implement_now') => {
    if (coordinationCommentIds.some(id => !activeReviewComments.some(c => c.id === id))) { alert('所选意见不适用于当前版本，请重新选择'); return; }
    if (coordinationCommentIds.length < 2) { alert('请明确选择至少两条需要协调的意见'); return; }
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
        if (coordinationCommentIds.includes(c.id)) {
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
        { ...diff, strategyExplanation: strategyReason.trim() || diff.strategyExplanation },
        activeRole,
        coordinationCommentIds
      );

      onUpdateTask({
        drafts: updatedTask.drafts,
        currentDraftId: workingDraft.id,
        reviewComments: updatedTask.reviewComments,
        modificationLogs: updatedTask.modificationLogs,
        isFinalized: updatedTask.isFinalized,
        status: updatedTask.status,
      });

      setShowContradictionModal(false);
    } catch (err: any) {
      alert(err.message || '落实审阅协调失败');
    }
  };

  // Submit draft for review click - opens in-app confirmation modal (eliminates window.confirm iframe failure)
  const handleSubmitDraftForReviewClick = () => {
    const perm = checkPermission(activeRole, 'edit_draft');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可提交审阅');
      return;
    }
    if (!currentDraft) return;
    setShowSubmitReviewModal(true);
  };

  const handleConfirmSubmitForReview = () => {
    if (!currentDraft) return;
    try {
      const { updatedTask } = submitDraftForReview(
        task,
        currentDraft.id,
        activeRole,
        true
      );
      setShowSubmitReviewModal(false);
      onUpdateTask({
        drafts: updatedTask.drafts,
        currentStage: 'review',
        status: '审阅中',
        reviewBaseDraftId: updatedTask.reviewBaseDraftId,
        currentReviewRound: updatedTask.currentReviewRound,
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
        currentDraftId: currentDraft.id,
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
    if (coordinationCommentIds.some(id => !activeReviewComments.some(c => c.id === id))) { alert('所选意见不适用于当前版本，请重新选择'); return; }
    const perm = checkPermission(activeRole, 'resolve_comment');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可协调裁决篇幅冲突');
      return;
    }

    if (!currentDraft || !currentCoordinationDiff) return;

    if (mode === 'strategy_only') {
      const updatedComments = task.reviewComments.map((c) => {
        if (coordinationCommentIds.includes(c.id)) {
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
        { ...currentCoordinationDiff, strategyExplanation: strategyReason.trim() || currentCoordinationDiff.strategyExplanation },
        activeRole,
        coordinationCommentIds
      );
      onUpdateTask({
        drafts: updatedTask.drafts,
        currentDraftId: workingDraft.id,
        reviewComments: updatedTask.reviewComments,
        modificationLogs: updatedTask.modificationLogs,
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
                  className={`text-xs px-2.5 py-0.5 rounded font-mono font-medium flex items-center gap-1 ${
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
                  <span className="text-xs opacity-75">
                    {currentDraft.isFinal ? '· 定稿快照' : currentDraft.isHistoricalSnapshot ? '· 历史快照' : '· 工作稿'}
                  </span>
                </span>
              )}
            </div>

            {/* Word count & Real save status */}
            <div className="flex items-center gap-3 mt-1 text-xs text-slate-500 flex-wrap">
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
                <span className="text-slate-400 text-xs">（工作稿自动存盘 · 里程碑可保存快照）</span>
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
            className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded text-sm font-medium flex items-center gap-1 cursor-pointer disabled:opacity-40"
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
            className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded text-sm font-medium flex items-center gap-1 cursor-pointer"
            title="查看与恢复历史版本快照"
          >
            <History className="w-3.5 h-3.5 text-slate-500" />
            <span>版本历史 ({task.drafts.length})</span>
          </button>

          <button
            type="button"
            data-testid="btn-open-recent-modifications"
            onClick={() => setShowRecentModificationsModal(true)}
            className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded text-sm font-medium flex items-center gap-1 cursor-pointer"
            title="查看当前文稿的局部AI建议采纳与微调操作存证记录，支持安全撤销"
          >
            <RotateCcw className="w-3.5 h-3.5 text-slate-500" />
            <span>最近修改记录 ({getRecentModificationLogs(task, currentDraft?.id).length})</span>
          </button>

          <button
            onClick={handleSubmitDraftForReviewClick}
            disabled={!canUserEdit || isCurrentDraftImmutable}
            className="px-3.5 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded text-sm font-semibold shadow-xs flex items-center gap-1 cursor-pointer disabled:opacity-40"
            title="将当前工作稿提交进入新一轮审阅，自动冻结只读基准快照并递增审阅轮次"
          >
            <Send className="w-3.5 h-3.5" />
            <span>提交本轮审阅</span>
          </button>

          <button
            onClick={onProceedToNextStage}
            className="px-3.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded text-sm font-medium flex items-center gap-1 cursor-pointer"
            title="仅切换至审阅修改阶段界面查看已有审阅意见"
          >
            <span>进入审阅页面</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 2. Preparation Status Bar */}
      {hasExistingDraft ? (
        // Existing Draft: Defaults to Compact Status Bar with summary metrics and expand button
        <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-2xs text-xs space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-slate-800 flex items-center gap-1.5 text-xs">
                <FileText className="w-3.5 h-3.5 text-blue-700" />
                起草准备概况
              </span>
              <span
                className={`text-xs px-2 py-0.5 rounded font-medium flex items-center gap-1 ${
                  isPrerequisiteMet
                    ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                    : 'bg-amber-50 text-amber-800 border border-amber-200'
                }`}
              >
                {isPrerequisiteMet ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                ) : (
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                )}
                <span>{isPrerequisiteMet ? '前序审批完备 · 具备起草条件' : '准备条件未满足'}</span>
              </span>

              {isPrerequisiteMet && (
                <div className="hidden sm:flex items-center gap-2 text-xs text-slate-500 flex-wrap">
                  <span className="text-slate-300">|</span>
                  <span>已核准事实 <strong className="text-slate-700 font-mono">{confirmedFactsCount}</strong> 项</span>
                  <span>· 文风 <strong className="text-slate-700 font-mono">{activeStyleRulesCount}</strong> 条</span>
                  <span>· 大纲 <strong className="text-slate-700 font-mono">{outlineSectionsCount}</strong> 章</span>
                  <span>· 期间 <strong className="text-slate-700">{taskPeriodStr}</strong></span>
                  <span>· 目标 <strong className="text-slate-700 font-mono">{task.targetWordCount}</strong> 字</span>
                </div>
              )}

              {/* Task 21: Fact Impact Compact Entrance */}
              <button
                type="button"
                onClick={() => {setImpactFocusBlockId(undefined);setShowFactImpactModal(true);}}
                data-testid="btn-open-fact-impact"
                className={`text-xs px-2.5 py-0.5 rounded font-medium flex items-center gap-1.5 cursor-pointer transition-colors shadow-2xs border ${
                  factImpact.changedFactsCount > 0
                    ? 'bg-amber-50 hover:bg-amber-100 text-amber-900 border-amber-300'
                    : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                }`}
                title="查看事实变更对当前稿件的影响总览与逐段定位"
              >
                <AlertCircle
                  className={`w-3.5 h-3.5 ${
                    factImpact.changedFactsCount > 0 ? 'text-amber-600' : 'text-slate-400'
                  }`}
                />
                <span>
                  {!factImpact.hasDraft
                    ? '依据变更影响：尚无稿件可比较'
                    : !factImpact.hasSnapshotBaseline
                    ? '依据变更影响：缺少比较基准，需人工核实'
                    : factImpact.changedFactsCount > 0
                    ? `依据变更影响：${factImpact.changedFactsCount}项事实 · ${factImpact.affectedBlocksCount}段需复核`
                    : '依据变更影响：未发现已关联事实的差异'}
                </span>
              </button>
            </div>

            <button
              onClick={() => setShowPrepDetails(!showPrepDetails)}
              aria-expanded={showPrepDetails}
              aria-label={showPrepDetails ? '收起准备指标口径说明' : '展开准备指标口径说明'}
              className="text-slate-600 hover:text-slate-900 text-xs flex items-center gap-1 cursor-pointer font-medium focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-hidden px-2 py-0.5 rounded hover:bg-slate-100"
            >
              <span>{showPrepDetails ? '收起指标详情' : '展开指标口径'}</span>
              <ChevronDown
                className={`w-3.5 h-3.5 transition-transform ${showPrepDetails ? 'rotate-180' : ''}`}
              />
            </button>
          </div>

          {/* Deficiency alert if not met - NEVER hidden even if compact! */}
          {!isPrerequisiteMet && (
            <div className="p-2.5 bg-amber-50 border border-amber-300 rounded text-xs text-amber-950 space-y-1.5">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-1.5 font-semibold text-amber-900">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                  <span>起草前置条件不足（真实缺口）：</span>
                  <span className="font-normal text-amber-800">
                    {!isFactReady && '事实清单未核准/快照缺失；'}
                    {!isStyleReady && '文风规范未核准；'}
                    {!isOutlineReady && '大纲尚未审批；'}
                    {!isPeriodReady && '统计期间未设定；'}
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {!isFactReady && (
                    <button
                      onClick={() => handleJumpStage('material_fact')}
                      className="px-2.5 py-1 bg-amber-700 hover:bg-amber-800 text-white rounded text-xs font-semibold cursor-pointer"
                    >
                      前往核准事实
                    </button>
                  )}
                  {(!isStyleReady || !isOutlineReady) && (
                    <button
                      onClick={() => handleJumpStage('style_outline')}
                      className="px-2.5 py-1 bg-amber-700 hover:bg-amber-800 text-white rounded text-xs font-semibold cursor-pointer"
                    >
                      前往确认文风与大纲
                    </button>
                  )}
                </div>
              </div>
              <p className="text-xs text-amber-700">
                现有文稿已受保护，旧正文保持可浏览与微调。请补充前序审批后生成整稿，禁止使用虚构正文补足。
              </p>
            </div>
          )}

          {/* 5 Indicator Cards when expanded */}
          {showPrepDetails && (
            <div className="pt-2 border-t border-slate-100 space-y-2.5">
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 text-xs">
                <div
                  className={`p-2 rounded border ${
                    isFactReady ? 'bg-slate-50/80 border-slate-200' : 'bg-amber-50/70 border-amber-300 text-amber-950'
                  }`}
                >
                  <div className="text-xs text-slate-500">1. 事实清单</div>
                  <div className="font-bold mt-0.5 text-slate-800">{confirmedFactsCount} 项已核准</div>
                  <div className="text-xs text-slate-400">
                    {task.factSnapshot ? '快照已锁定' : '快照未生成'}
                  </div>
                </div>

                <div
                  className={`p-2 rounded border ${
                    isStyleReady ? 'bg-slate-50/80 border-slate-200' : 'bg-amber-50/70 border-amber-300 text-amber-950'
                  }`}
                >
                  <div className="text-xs text-slate-500">2. 单位文风</div>
                  <div className="font-bold mt-0.5 text-slate-800">{activeStyleRulesCount} 条规则生效</div>
                  <div className="text-xs text-slate-400">
                    {task.styleConfirmed ? '已核准通过' : '未核准'}
                  </div>
                </div>

                <div
                  className={`p-2 rounded border ${
                    isOutlineReady ? 'bg-slate-50/80 border-slate-200' : 'bg-amber-50/70 border-amber-300 text-amber-950'
                  }`}
                >
                  <div className="text-xs text-slate-500">3. 章节大纲</div>
                  <div className="font-bold mt-0.5 text-slate-800">{outlineSectionsCount} 个章节</div>
                  <div className="text-xs text-slate-400">
                    {task.outlineConfirmed ? '大纲已审批' : '未审批'}
                  </div>
                </div>

                <div
                  className={`p-2 rounded border ${
                    isPeriodReady ? 'bg-slate-50/80 border-slate-200' : 'bg-amber-50/70 border-amber-300 text-amber-950'
                  }`}
                >
                  <div className="text-xs text-slate-500">4. 统计期间</div>
                  <div className="font-bold mt-0.5 text-slate-800">{taskPeriodStr}</div>
                  <div className="text-xs text-slate-400">
                    {isPeriodReady ? '口径已设定' : '未设定'}
                  </div>
                </div>

                <div className="p-2 rounded border bg-slate-50/80 border-slate-200">
                  <div className="text-xs text-slate-500">5. 目标字数</div>
                  <div className="font-bold mt-0.5 text-slate-800">{task.targetWordCount || 2000} 字</div>
                  <div className="text-xs text-slate-400">
                    当前文稿 {currentWordCount} 字
                  </div>
                </div>
              </div>

              {isPrerequisiteMet && (
                <div className="p-2.5 bg-slate-50 border border-slate-200 rounded text-xs text-slate-600 space-y-1">
                  <div>• 事实依据：已核准事实与台账口径一致，起草服务将严格保留所有数值、单位与期间。</div>
                  <div>• 文风大纲：按已确认大纲结构进行确定性合成，各章节按分配事实生成，无虚构案例。</div>
                  <div>• 版本继承：起草生成的整稿将作为候选稿供主笔在差异对比后决定是否整体采纳。</div>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        // No draft yet: Prominently display full preparation cards
        <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-2xs text-xs space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm text-slate-800 flex items-center gap-1.5">
                <FileText className="w-4 h-4 text-blue-700" />
                起草前准备状态
              </span>
              <span
                className={`text-xs px-2.5 py-0.5 rounded font-medium flex items-center gap-1 ${
                  isPrerequisiteMet
                    ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                    : 'bg-amber-50 text-amber-800 border border-amber-200'
                }`}
              >
                {isPrerequisiteMet ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                ) : (
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                )}
                <span>{isPrerequisiteMet ? '前序审批完备 · 具备起草条件' : '准备条件未满足'}</span>
              </span>

              {/* Task 21: Fact impact button when no draft */}
              <button
                type="button"
                onClick={() => {setImpactFocusBlockId(undefined);setShowFactImpactModal(true);}}
                data-testid="btn-open-fact-impact"
                className="text-xs px-2.5 py-0.5 rounded font-medium flex items-center gap-1.5 cursor-pointer bg-slate-50 hover:bg-slate-100 text-slate-600 border border-slate-200"
                title="尚无稿件可比较"
              >
                <Info className="w-3.5 h-3.5 text-slate-400" />
                <span>依据变更影响：尚无稿件可比较</span>
              </button>
            </div>

            <button
              onClick={() => setShowPrepDetails(!showPrepDetails)}
              aria-expanded={showPrepDetails}
              aria-label={showPrepDetails ? '收起准备指标口径说明' : '展开指标口径说明'}
              className="text-slate-500 hover:text-slate-800 text-xs flex items-center gap-1 cursor-pointer font-medium focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-hidden"
            >
              <span>{showPrepDetails ? '收起说明' : '展开指标口径说明'}</span>
              <ChevronDown
                className={`w-3.5 h-3.5 transition-transform ${showPrepDetails ? 'rotate-180' : ''}`}
              />
            </button>
          </div>

          {/* 5 Indicator Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 text-xs">
            <div
              className={`p-2.5 rounded border ${
                isFactReady ? 'bg-slate-50/80 border-slate-200' : 'bg-amber-50/70 border-amber-300 text-amber-950'
              }`}
            >
              <div className="text-xs text-slate-500">1. 事实清单</div>
              <div className="font-bold mt-0.5 text-slate-800">{confirmedFactsCount} 项已核准</div>
              <div className="text-xs text-slate-400">
                {task.factSnapshot ? '快照已锁定' : '快照未生成'}
              </div>
            </div>

            <div
              className={`p-2.5 rounded border ${
                isStyleReady ? 'bg-slate-50/80 border-slate-200' : 'bg-amber-50/70 border-amber-300 text-amber-950'
              }`}
            >
              <div className="text-xs text-slate-500">2. 单位文风</div>
              <div className="font-bold mt-0.5 text-slate-800">{activeStyleRulesCount} 条规则生效</div>
              <div className="text-xs text-slate-400">
                {task.styleConfirmed ? '已核准通过' : '未核准'}
              </div>
            </div>

            <div
              className={`p-2.5 rounded border ${
                isOutlineReady ? 'bg-slate-50/80 border-slate-200' : 'bg-amber-50/70 border-amber-300 text-amber-950'
              }`}
            >
              <div className="text-xs text-slate-500">3. 章节大纲</div>
              <div className="font-bold mt-0.5 text-slate-800">{outlineSectionsCount} 个章节</div>
              <div className="text-xs text-slate-400">
                {task.outlineConfirmed ? '大纲已审批' : '未审批'}
              </div>
            </div>

            <div
              className={`p-2.5 rounded border ${
                isPeriodReady ? 'bg-slate-50/80 border-slate-200' : 'bg-amber-50/70 border-amber-300 text-amber-950'
              }`}
            >
              <div className="text-xs text-slate-500">4. 统计期间</div>
              <div className="font-bold mt-0.5 text-slate-800">{taskPeriodStr}</div>
              <div className="text-xs text-slate-400">
                {isPeriodReady ? '口径已设定' : '未设定'}
              </div>
            </div>

            <div className="p-2.5 rounded border bg-slate-50/80 border-slate-200">
              <div className="text-xs text-slate-500">5. 目标字数</div>
              <div className="font-bold mt-0.5 text-slate-800">{task.targetWordCount || 2000} 字</div>
              <div className="text-xs text-slate-400">
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
              <ul className="list-disc list-inside text-xs text-amber-800 space-y-0.5">
                {!isFactReady && <li>事实清单尚未核准或事实快照缺失/已失效（需包含有效核准事实）。</li>}
                {!isStyleReady && <li>单位文风规范尚未核准或快照缺失。</li>}
                {!isOutlineReady && <li>章节大纲规划尚未确认审批通过。</li>}
                {!isPeriodReady && <li>任务起止日期及统计期间未设定完整。</li>}
              </ul>
              <div className="flex items-center gap-2 pt-1 flex-wrap">
                {!isFactReady && (
                  <button
                    onClick={() => handleJumpStage('material_fact')}
                    className="px-3 py-1.5 bg-amber-700 hover:bg-amber-800 text-white rounded text-xs font-semibold cursor-pointer"
                  >
                    前往核准事实清单
                  </button>
                )}
                {(!isStyleReady || !isOutlineReady) && (
                  <button
                    onClick={() => handleJumpStage('style_outline')}
                    className="px-3 py-1.5 bg-amber-700 hover:bg-amber-800 text-white rounded text-xs font-semibold cursor-pointer"
                  >
                    前往确认文风与大纲
                  </button>
                )}
              </div>
            </div>
          )}

          {showPrepDetails && isPrerequisiteMet && (
            <div className="p-3 bg-slate-50 border border-slate-200 rounded text-xs text-slate-600 space-y-1">
              <div>• 事实依据：已核准事实与台账口径一致，起草服务将严格保留所有数值、单位与期间。</div>
              <div>• 文风大纲：按已确认大纲结构进行确定性合成，各章节按分配事实生成，无虚构案例。</div>
              <div>• 版本继承：起草生成的整稿将作为候选稿供主笔在差异对比后决定是否整体采纳。</div>
            </div>
          )}
        </div>
      )}

      {/* Locate Block Error Banner */}
      {locateError && (
        <div
          data-testid="locate-error-alert"
          className="p-3 bg-rose-50 border border-rose-300 rounded-lg text-xs text-rose-900 flex items-center justify-between gap-2 animate-in fade-in"
        >
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{locateError}</span>
          </div>
          <button
            onClick={() => setLocateError(null)}
            className="text-rose-500 hover:text-rose-700 p-1 cursor-pointer"
            title="关闭提示"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 3. Round Drafting Instruction / Whole Draft Adjustment */}
      {hasExistingDraft ? (
        // Existing Draft: Organized into "整稿调整" header and expandable instruction area
        <div className="bg-white p-3.5 rounded-lg border border-slate-200 shadow-2xs text-xs space-y-2.5">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShowWholeDraftAdjust(!showWholeDraftAdjust)}
              aria-expanded={showWholeDraftAdjust}
              aria-label="整稿调整指令区展开或收起"
              className="flex items-center gap-2 text-left cursor-pointer focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-hidden p-1 rounded hover:bg-slate-50"
            >
              <Sparkles className="w-4 h-4 text-blue-700 shrink-0" />
              <span className="font-bold text-sm text-slate-900">整稿调整</span>
              <span className="text-xs bg-amber-50 text-amber-900 border border-amber-200 px-2 py-0.5 rounded font-medium">
                影响整篇，生成候选后由主笔确认
              </span>
              <ChevronDown
                className={`w-3.5 h-3.5 text-slate-500 transition-transform ${showWholeDraftAdjust ? 'rotate-180' : ''}`}
              />
            </button>

            {!showWholeDraftAdjust && !isGenerating && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-slate-500 hidden md:inline">
                  当前侧重：“{draftInstructionInput}”
                </span>
                <button
                  type="button"
                  onClick={() => handleStartGenerate(draftInstructionInput)}
                  disabled={isGenerating || !isPrerequisiteMet || !canUserEdit}
                  className={`px-3.5 py-1.5 rounded text-sm font-semibold shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer shrink-0 ${
                    !isPrerequisiteMet || isGenerating || !canUserEdit
                      ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                      : 'bg-blue-700 hover:bg-blue-800 text-white'
                  }`}
                  title={
                    !canUserEdit
                      ? `权限受限：当前身份为【${activeRole}】，仅主笔甲可起草正文`
                      : !isPrerequisiteMet
                      ? '前序审批未就绪，无法起草'
                      : '生成整稿候选稿'
                  }
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>生成整稿候选</span>
                </button>
              </div>
            )}
          </div>

          {(showWholeDraftAdjust || isGenerating) && (
            <div className="pt-2 border-t border-slate-100 space-y-2 animate-in fade-in duration-150">
              <div className="flex items-center justify-between flex-wrap gap-1">
                <label htmlFor="round-draft-instruction" className="font-bold text-xs text-slate-800 flex items-center gap-1.5">
                  <span>整篇改写要求（表达意图与行文侧重）：</span>
                </label>
                <span className="text-xs text-slate-400">受已核准事实、文风与大纲严格约束</span>
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
                  type="button"
                  onClick={() => handleStartGenerate(draftInstructionInput)}
                  disabled={isGenerating || !isPrerequisiteMet || !canUserEdit}
                  className={`px-4 py-2 rounded text-sm font-semibold shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer shrink-0 ${
                    !isPrerequisiteMet || isGenerating || !canUserEdit
                      ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                      : 'bg-blue-700 hover:bg-blue-800 text-white'
                  }`}
                  title={
                    !canUserEdit
                      ? `权限受限：当前身份为【${activeRole}】，仅主笔甲可起草正文`
                      : !isPrerequisiteMet
                      ? '前序审批未就绪，无法起草'
                      : '生成整稿候选'
                  }
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{isGenerating ? '起草生成中...' : '生成整稿候选'}</span>
                </button>
              </div>
              {/* Preset Instruction Chips */}
              <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                <span className="text-xs text-slate-400 font-medium">常用指令预设：</span>
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
                    className={`text-xs px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                      draftInstructionInput === preset
                        ? 'bg-blue-50 text-blue-800 border-blue-300 font-medium'
                        : 'bg-slate-100 hover:bg-slate-200 text-slate-600 border-slate-200'
                    }`}
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-500 bg-slate-50 p-2 rounded border border-slate-200 leading-relaxed">
                <strong>范围说明：</strong>本功能将重新合成整篇公文并创建独立候选稿（影响整篇），候选稿将在双栏对比中清晰展示差异，由主笔确认采纳后方会写入新工作稿，现有文稿在此之前受严格保护。如仅需修改个别段落，请直接在正文段落中调用局部AI建议（仅修改第N段）。
              </p>
            </div>
          )}
        </div>
      ) : (
        // No draft yet: Prominent Round Drafting Instruction Input Bar with "生成首轮初稿"
        <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-2xs text-xs space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-1">
            <label htmlFor="round-draft-instruction" className="font-bold text-sm text-slate-800 flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-blue-700" />
              <span>本轮写作要求（表达意图与行文侧重）：</span>
            </label>
            <span className="text-xs text-slate-400">受已核准事实、文风与大纲严格约束</span>
          </div>
          <div className="flex gap-2">
            <input
              id="round-draft-instruction"
              type="text"
              value={draftInstructionInput}
              onChange={(e) => setDraftInstructionInput(e.target.value)}
              placeholder="例如：突出成效，减少铺垫；优化问题与安排的对应；改成面向单位负责人的汇报口吻..."
              className="flex-1 p-2.5 bg-slate-50 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500 focus:bg-white focus:outline-hidden"
            />
            <button
              onClick={() => handleStartGenerate(draftInstructionInput)}
              disabled={isGenerating || !isPrerequisiteMet || !canUserEdit}
              className={`px-5 py-2.5 rounded text-sm font-semibold shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer shrink-0 ${
                !isPrerequisiteMet || isGenerating || !canUserEdit
                  ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  : 'bg-blue-700 hover:bg-blue-800 text-white'
              }`}
              title={
                !canUserEdit
                  ? `权限受限：当前身份为【${activeRole}】，仅主笔甲可起草正文`
                  : !isPrerequisiteMet
                  ? '前序审批未就绪，无法起草'
                  : '生成首轮初稿'
              }
            >
              <Sparkles className="w-4 h-4" />
              <span>{isGenerating ? '起草生成中...' : '生成首轮初稿'}</span>
            </button>
          </div>
          {/* Preset Instruction Chips */}
          <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
            <span className="text-xs text-slate-400 font-medium">常用指令预设：</span>
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
                className={`text-xs px-2.5 py-1 rounded border transition-colors cursor-pointer ${
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
      )}

      {/* Immutable Draft Alert Notice */}
      {isCurrentDraftImmutable && currentDraft && (
        <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg text-xs text-amber-950 space-y-2 shadow-2xs">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Lock className="w-4 h-4 text-amber-600 shrink-0" />
              <div>
                <span className="font-bold">只读快照保护：</span>
                <span>
                  当前查看的是【{currentDraft.versionNumber}】（{currentDraft.isFinal ? '正式定稿归档' : '历史快照'}），内容只读不可直接修改。
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              {latestWorkingDraft && (
                <button
                  onClick={() => onUpdateTask({ currentDraftId: latestWorkingDraft.id })}
                  className="px-3 py-1 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold flex items-center gap-1 cursor-pointer"
                  title={`返回正在起草的工作稿【${latestWorkingDraft.versionNumber}】`}
                >
                  <ArrowRight className="w-3.5 h-3.5" />
                  <span>返回当前工作稿（{latestWorkingDraft.versionNumber}）</span>
                </button>
              )}
              {canUserEdit && (
                <button
                  onClick={handleForkWorkingDraftFromImmutable}
                  className="px-3 py-1 bg-amber-700 hover:bg-amber-800 text-white rounded text-xs font-semibold flex items-center gap-1 cursor-pointer"
                  title="基于此只读快照创建新的可编辑工作草稿"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>基于此稿继续编辑（创建新工作稿）</span>
                </button>
              )}
            </div>
          </div>
          {!currentDraft.frozenReviewComments && (
            <div className="text-xs text-amber-800 bg-amber-100/60 p-2 rounded border border-amber-200/80 flex items-center justify-between gap-2">
              <span>
                <strong>审阅意见记录状态：</strong>该历史快照未记录审阅意见（无法回溯当时意见），已严格隔离最新意见，避免历史失真。
              </span>
              <button
                onClick={() => {
                  setInspectorTab('review_comments');
                  setShowRightInspector(true);
                }}
                className="text-xs text-blue-800 underline font-medium shrink-0 cursor-pointer"
              >
                查看审阅栏
              </button>
            </div>
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
                <p className="text-xs text-slate-600 mt-0.5">
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
              <div className="p-2 bg-rose-100/80 border border-rose-300 rounded text-xs text-rose-900 flex items-center gap-1.5 font-medium">
                <AlertTriangle className="w-3.5 h-3.5 text-rose-700 shrink-0" />
                <span>
                  候选稿已失效：正文在此候选生成后已被人工编辑修改，采纳旧候选将覆盖人工编辑！请点击上方“生成整稿候选”以最新正文为基准重新起草。
                </span>
              </div>
            )}

            {/* Instruction prompt mismatch notice */}
            {hasPromptMismatch && !isModifiedLive && (
              <div className="p-2 bg-amber-100/70 border border-amber-300 rounded text-xs text-amber-900 flex items-center gap-1.5">
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
      <div
        ref={workspaceRef}
        data-testid="drafting-workspace"
        data-outline-collapsed={!showLeftNav}
        data-inspector-collapsed={!showRightInspector}
        className="drafting-workspace min-h-[640px]"
      >
        {/* Left: Collapsible Outline Navigation */}
        {showLeftNav ? (
          <div id={outlinePanelId} className="drafting-panel-sticky hidden lg:block min-w-0 bg-white rounded-lg border border-slate-200 shadow-2xs p-4 space-y-3 overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <span className="font-bold text-xs text-slate-800 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-blue-700" />
                章节大纲导航
              </span>
              <button
                onClick={() => toggleDesktopPanel('outline', false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded hover:bg-slate-100 cursor-pointer focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-hidden"
                title="折叠导航栏"
                aria-label="折叠导航栏"
                aria-expanded={true}
                aria-controls={outlinePanelId}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-1.5">
              {task.outline.map((sec, idx) => {
                const firstBlockOfSec = currentDraft?.blocks.find((b) => b.sectionId === sec.id);
                const isCurrentSecActive = activeBlock?.sectionId === sec.id;

                return (
                  <button
                    type="button"
                    key={sec.id}
                    onClick={() => {
                      if (firstBlockOfSec) {
                        setSelectedBlockId(firstBlockOfSec.id);
                        const el = document.getElementById(`block-card-${firstBlockOfSec.id}`);
                        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      }
                    }}
                    className={`w-full text-left p-2.5 rounded border transition-colors cursor-pointer text-xs focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-hidden ${
                      isCurrentSecActive
                        ? 'bg-blue-50/80 border-blue-300 text-blue-900 font-medium'
                        : 'bg-slate-50 hover:bg-slate-100 border-slate-200/70 text-slate-700'
                    }`}
                    aria-label={`定位章节：${sec.title}`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="line-clamp-1 font-semibold text-sm">
                        {idx + 1}. {sec.title}
                      </span>
                      {isCurrentSecActive && (
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-600 shrink-0" />
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mt-1 flex justify-between">
                      <span>建议：{sec.suggestedWordCount}字</span>
                      <span>{sec.assignedFactIds.length}项依据</span>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="pt-2 border-t border-slate-100 text-xs text-slate-500 space-y-1">
              <div>当前正文字数：<strong className="text-slate-800 font-mono">{currentWordCount}</strong> 字</div>
              <div>目标总字数：<strong className="text-slate-800 font-mono">{task.targetWordCount}</strong> 字</div>
            </div>
          </div>
        ) : (
          <div id={outlinePanelId} className="drafting-panel-sticky hidden lg:block">
            <button
              type="button"
              onClick={() => toggleDesktopPanel('outline', true)}
              className="w-full min-h-20 py-3 flex flex-col items-center gap-2 bg-white border border-slate-200 rounded-lg shadow-xs text-slate-600 hover:text-blue-800 hover:bg-blue-50 cursor-pointer focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-hidden"
              title="展开章节导航"
              aria-label="展开章节导航"
              aria-expanded={false}
              aria-controls={outlinePanelId}
            >
              <ChevronRight className="w-4 h-4" aria-hidden="true" />
              <span className="text-xs font-medium">大纲</span>
            </button>
          </div>
        )}

        {/* Center: White Document Editor Canvas */}
        <div
          data-testid="document-editor-canvas"
          className={`${!showLeftNav && !showRightInspector ? 'max-w-4xl mx-auto' : ''} min-w-0 w-full bg-white rounded-lg border border-slate-200 shadow-sm p-5 sm:p-8 xl:p-10 min-h-[640px] flex flex-col justify-between`}
        >
          {currentDraft ? (
            <div className="space-y-6">
              {/* Tablet Quick Access Bar: Instant Outline & Inspector Access on <= 1024px */}
              <div className="lg:hidden flex items-center justify-between gap-2 p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs mb-3 flex-wrap">
                <button
                  type="button"
                  data-testid="btn-open-tablet-outline"
                  onClick={(e) => {
                    lastTabletTriggerRef.current = e.currentTarget;
                    setShowTabletOutlineDrawer(true);
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-300 rounded-md font-semibold text-slate-700 hover:bg-slate-100 cursor-pointer shadow-2xs focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-hidden"
                  aria-label="打开章节大纲导航"
                >
                  <FileText className="w-4 h-4 text-blue-700" />
                  <span>章节导航 ({task.outline.length})</span>
                </button>
                <button
                  type="button"
                  data-testid="btn-open-tablet-inspector"
                  onClick={(e) => {
                    lastTabletTriggerRef.current = e.currentTarget;
                    setShowTabletInspectorDrawer(true);
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-md font-semibold text-blue-800 hover:bg-blue-100 cursor-pointer shadow-2xs focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-hidden"
                  aria-label="打开段落辅助面板"
                >
                  <Sparkles className="w-4 h-4 text-blue-700" />
                  <span>辅助面板</span>
                  {activeBlock && (
                    <span className="bg-blue-200 text-blue-900 px-1.5 py-0.2 rounded text-xs font-mono font-bold">
                      第{activeBlock.order}段
                    </span>
                  )}
                </button>
              </div>
              {/* Document Header */}
              <div className="text-center pb-6 border-b border-slate-200 space-y-2">
                <h1 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight font-serif leading-snug">
                  {task.title}
                </h1>
                <div className="text-xs text-slate-500 space-y-0.5">
                  <p>统计期间：{task.startDate} 至 {task.endDate} · 汇报对象：{task.audience}</p>
                  <p className="text-xs text-slate-400">
                    拟稿人：{currentDraft.author} · 统计字数：{currentWordCount}字 · 版本：{currentDraft.versionNumber}
                  </p>
                </div>
              </div>

              {/* Document Paragraph Blocks */}
              <div className="space-y-6">
                {/* Historical Version Missing Comment Notice (Requirement P1) */}
                {selectedCommentId && !selectedComment && (
                  <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg text-xs text-amber-950 flex items-center justify-between shadow-2xs">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                      <div>
                        <span className="font-bold">审阅记录说明：</span>
                        <span>
                          {isCurrentDraftImmutable
                            ? `当前查看的是历史快照版本（${currentDraft.versionNumber}），该版本未收录此审阅意见记录。系统已严格隔离，不回退展示最新审阅意见。`
                            : '当前文稿未找到该审阅意见，可能已被删除或归档。'}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => setSelectedCommentId(null)}
                      className="px-2.5 py-1 text-sm text-amber-800 hover:text-amber-950 border border-amber-300 rounded bg-white cursor-pointer font-medium"
                    >
                      清除选择
                    </button>
                  </div>
                )}

                {/* Overall Comment Navigation Context Banner */}
                {selectedComment && selectedComment.type === 'overall' && (
                  <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-lg text-xs text-indigo-950 space-y-1.5 shadow-2xs">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 font-bold">
                        <MessageSquare className="w-4 h-4 text-indigo-600 shrink-0" />
                        <span>{`正在定位全局审阅意见：【${selectedComment.reviewer}】`}</span>
                      </div>
                      <span className="text-xs bg-indigo-100 text-indigo-800 px-2 py-0.5 rounded font-medium">
                        全篇适用
                      </span>
                    </div>
                    <p className="text-slate-800 font-medium">{`“${selectedComment.content}”`}</p>
                    <div className="text-xs text-indigo-900 bg-white/70 p-2 rounded border border-indigo-100">
                      <strong>修改范围说明：</strong>{`此意见针对整篇文稿，未绑定固定段落。请在下方正文中点击选择要应用修改的具体目标段落${selectedBlockId ? `（当前已选第${currentDraft.blocks.find(b => b.id === selectedBlockId)?.order}段）` : '（尚未选择段落）'}，明确修改范围后再据此改写。`}
                    </div>
                  </div>
                )}

                {/* Deleted / Missing Target Block Comment Banner */}
                {selectedComment && selectedComment.type === 'paragraph' && selectedCommentNavContext?.isDeletedOrMissing && (
                  <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg text-xs text-amber-950 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 shadow-2xs">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                      <div className="space-y-0.5">
                        <div className="font-bold text-amber-900">
                          定位需复核：原目标段落已在正文中删除或合并
                        </div>
                        <p className="text-xs text-amber-800">
                          {`意见来自【${selectedComment.reviewer}】（原第${selectedComment.targetBlockOrder || '?'}段）。当前正文中该段落已不存在，不可自动匹配至其他段落，严禁直接自动改写。`}
                        </p>
                        {selectedComment.baseParagraphText && (
                          <p className="text-xs text-slate-500 italic">
                            {`提出时原文：“${selectedComment.baseParagraphText.slice(0, 45)}...”`}
                          </p>
                        )}
                      </div>
                    </div>
                    {canUserEdit && !isCurrentDraftImmutable && (
                      <button
                        onClick={() => handleOpenRebindModal(selectedComment)}
                        className="px-3.5 py-1.5 bg-amber-700 hover:bg-amber-800 text-white rounded text-sm font-semibold shrink-0 cursor-pointer self-start sm:self-auto"
                      >
                        重新指定目标段落
                      </button>
                    )}
                  </div>
                )}

                {/* Adopt Feedback Banner with Safe Undo */}
                {adoptFeedback && (
                  <div
                    data-testid="toast-adopt-success"
                    className="p-3 bg-emerald-50 border-2 border-emerald-300 rounded-lg text-xs text-emerald-950 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 shadow-2xs"
                  >
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      <div>
                        <span className="font-bold text-emerald-900">
                          已更新第 {adoptFeedback.blockOrder} 段 · 撤销本次修改
                        </span>
                        <span className="text-xs text-emerald-700 ml-1.5 font-normal">
                          ({adoptFeedback.message})
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 self-end sm:self-auto">
                      <button
                        type="button"
                        data-testid="btn-undo-latest-toast"
                        onClick={() => handleUndoModification(adoptFeedback.logId)}
                        className="px-3.5 py-1.5 bg-white hover:bg-emerald-100 text-emerald-800 border border-emerald-400 rounded text-sm font-bold flex items-center gap-1 cursor-pointer transition-colors shadow-2xs"
                        title="安全撤销本次修改并恢复原正文"
                      >
                        <RotateCcw className="w-3.5 h-3.5 text-emerald-600" />
                        <span>撤销本次修改</span>
                      </button>
                      <button
                        type="button"
                        data-testid="btn-close-adopt-toast"
                        onClick={() => setAdoptFeedback(null)}
                        className="p-1 text-emerald-600 hover:text-emerald-800 rounded hover:bg-emerald-100 cursor-pointer"
                        title="关闭提示"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}

                {currentDraft.blocks.map((block, idx) => {
                  const isSelected = selectedBlockId === block.id || (!selectedBlockId && !selectedComment && idx === 0);
                  const isRevisionTarget = revisionSuggestion?.targetBlockId === block.id;
                  const section = task.outline.find((s) => s.id === block.sectionId);
                  const isSectionFirstBlock = idx === 0 || currentDraft.blocks[idx - 1]?.sectionId !== block.sectionId;

                  return (
                    <div 
                      key={block.id} 
                      id={`block-card-${block.id}`} 
                      data-testid={`block-card-${block.id}`} 
                      onClick={() => setSelectedBlockId(block.id)}
                      className="space-y-2"
                    >
                      {/* Section Title if First Block */}
                      {isSectionFirstBlock && section && (
                        <h2 className="text-base font-bold text-slate-800 pt-3 pb-1 border-b border-slate-100 flex items-center justify-between">
                          <span>{section.title}</span>
                          <span className="text-xs text-slate-400 font-normal">
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
                        {/* Review Comment Context Banner on Target Block */}
                        {selectedComment && (selectedComment.currentBlockId || selectedComment.targetBlockId) === block.id && (
                          <div className="mb-2 p-2 bg-blue-50 border border-blue-200 rounded text-xs text-blue-900 flex items-center justify-between">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <MessageSquare className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                              <span className="font-semibold">{`来源：【${selectedComment.reviewer}】审阅意见`}</span>
                              <span className="text-xs text-blue-700 font-mono">{`当前第${block.order}段`}</span>
                              <span className="text-xs text-slate-500">{`（修改范围：仅限第${block.order}段）`}</span>
                            </div>
                            {selectedComment.rebindRecord && (
                              <span className="text-xs bg-purple-100 text-purple-800 px-1.5 py-0.5 rounded font-medium">
                                {`已重定位（原第${selectedComment.targetBlockOrder}段）`}
                              </span>
                            )}
                          </div>
                        )}
                        {/* Status badge when targeted by pending suggestion */}
                        {isRevisionTarget && (
                          <div className="absolute top-2 right-2 flex items-center gap-1 text-xs bg-amber-100 text-amber-800 border border-amber-300 px-2 py-0.5 rounded font-medium">
                            <Sparkles className="w-3 h-3 text-amber-600" />
                            <span>AI建议修改目标段落</span>
                          </div>
                        )}

                        {/* Paragraph content (auto-resizes to render content fully without scrollbars) */}
                        <AutoResizeParagraphTextarea
                          id={`paragraph-textarea-${block.id}`}
                          data-testid={`textarea-block-${block.id}`}
                          value={block.content}
                          layoutKey={`${showLeftNav}-${showRightInspector}`}
                          readOnly={isCurrentDraftImmutable || !canUserEdit}
                          disabled={!canUserEdit && !isReviewerOnly}
                          onChange={(val) => handleUpdateBlockContent(block.id, val)}
                          className={isCurrentDraftImmutable ? 'cursor-default select-text' : ''}
                        />

                        {/* Paragraph quick actions (accessible immediately on paragraph card) */}
                        <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-sm text-slate-800 font-bold">
                              第{block.order || idx + 1}段
                            </span>
                            <span className="text-xs text-slate-500">
                              ({block.content.length}字)
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleOpenBlockInspector(block.id, 'ai_suggestions', e.currentTarget);
                              }}
                              className="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded-md text-sm font-semibold flex items-center gap-1.5 cursor-pointer transition-colors shadow-2xs focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-hidden"
                              title={`针对第${block.order}段打开AI修改建议（仅修改第${block.order}段）`}
                              aria-label={`第${block.order}段AI修改建议`}
                            >
                              <Sparkles className="w-4 h-4 text-blue-600" />
                              <span>AI建议</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleOpenBlockInspector(block.id, 'review_comments', e.currentTarget);
                              }}
                              className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded-md text-sm font-semibold flex items-center gap-1.5 cursor-pointer transition-colors shadow-2xs focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-hidden"
                              title={`查看针对第${block.order}段的审阅意见`}
                              aria-label={`第${block.order}段审阅意见`}
                            >
                              <MessageSquare className="w-4 h-4 text-slate-500" />
                              <span>
                                意见 ({activeReviewComments.filter((c) => (c.currentBlockId || c.targetBlockId) === block.id).length})
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleOpenBlockInspector(block.id, 'material_evidence', e.currentTarget);
                              }}
                              className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded-md text-sm font-semibold flex items-center gap-1.5 cursor-pointer transition-colors shadow-2xs focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-hidden"
                              title={`查看第${block.order}段关联的事实与出处依据`}
                              aria-label={`第${block.order}段材料依据`}
                            >
                              <FileText className="w-4 h-4 text-slate-500" />
                              <span>
                                依据 ({block.referencedFactIds.length})
                              </span>
                            </button>
                          </div>

                          <span className="text-xs text-slate-500 group-hover:text-slate-700 transition-colors">
                            {isSelected ? '当前正在定位' : '点击定位段落'}
                          </span>
                        </div>

                        {/* Block metadata & facts / comments pills */}
                        <div className="mt-2 flex flex-wrap items-center justify-between text-xs text-slate-500 pt-1.5 border-t border-slate-100/60">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-mono text-xs text-slate-600 font-medium">
                              第{block.order || idx + 1}段
                            </span>
                            {blocksNeedingReview.some((b) => b.id === block.id) && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setImpactFocusBlockId(block.id);
                                  setShowFactImpactModal(true);
                                }}
                                data-testid={`badge-block-fact-changed-${block.id}`}
                                className="inline-flex items-center gap-1 text-xs bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 px-2 py-0.5 rounded font-medium cursor-pointer transition-colors"
                                title="点击查看影响该段落的事实变动详情"
                              >
                                <AlertCircle className="w-3.5 h-3.5 text-rose-600" />
                                <span>{reviewOverview.blockEvaluations.find(ev=>ev.blockId===block.id)?.isReviewed
                                  ? '引用事实仍有差异' : '引用事实已变动/待复核'}</span>
                              </button>
                            )}
                            {(() => {
                              const blockEval = reviewOverview.blockEvaluations.find((ev) => ev.blockId === block.id);
                              if (!blockEval || blockEval.displayStatus === 'pending') return null;
                              return (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setImpactFocusBlockId(block.id);
                                    setShowFactImpactModal(true);
                                  }}
                                  data-testid={`badge-block-review-status-${block.id}`}
                                  className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded font-semibold cursor-pointer border ${
                                    blockEval.displayStatus === 'reviewed'
                                      ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                                      : blockEval.displayStatus === 'deferred'
                                      ? 'bg-amber-50 text-amber-800 border-amber-300'
                                      : 'bg-rose-50 text-rose-800 border-rose-300'
                                  }`}
                                  title={`人工复核状态：${blockEval.displayStatusLabel}（点击查看留痕详情）`}
                                >
                                  <span>{blockEval.displayStatusLabel}</span>
                                </button>
                              );
                            })()}
                            {block.referencedFactIds.map((factId) => {
                              const fact = findDraftFact(task, currentDraft, factId);
                              if (!fact) return null;
                              return (
                                <button
                                  key={fact.id}
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const resolved = resolveDraftFactEvidence(fact, currentDraft, task);
                                    onViewSnippet(resolved.effectiveSnippet || { id: resolved.effectiveEvidenceId || '', sourceDocId: '', docName: '出处已不可用', location: '', period: resolved.effectivePeriod, text: '' }, fact);
                                  }}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-100/90 text-blue-900 hover:bg-blue-200 font-medium cursor-pointer transition-colors text-xs"
                                  title={`点击反查材料出处：${fact.metric}`}
                                >
                                  <span>{currentDraft?.snapshotMetadata?.factSnapshot?.items?.find(f => f.factId === factId)?.metric || fact.metric}: {resolveDraftFactEvidence(fact, currentDraft, task).adoptedValue}</span>
                                  <ExternalLink className="w-3 h-3 opacity-70" />
                                </button>
                              );
                            })}

                            {/* Review comments targeting this block (including rebound comments) */}
                            {activeReviewComments
                              .filter((c) => c.type === 'paragraph' && (c.currentBlockId || c.targetBlockId) === block.id)
                              .map((c) => (
                                <button
                                  key={c.id}
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleOpenBlockInspector(block.id, 'review_comments', e.currentTarget, c.id);
                                  }}
                                  className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded font-medium cursor-pointer transition-colors ${
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
                                  <MessageSquare className="w-3 h-3" />
                                  <span>
                                    {c.reviewer}：{c.status === 'implemented' ? '已落实' : c.status === 'accepted_pending_implementation' ? '待落实' : c.status === 'rejected' ? '已拒绝' : c.status === 'need_discussion' ? '待沟通' : '待处理'}
                                  </span>
                                </button>
                              ))}
                          </div>

                          <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-500 group-hover:text-slate-700 transition-colors">
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
          <div id={inspectorPanelId} className="drafting-panel-sticky hidden lg:flex min-w-0 bg-white rounded-lg border border-slate-200 shadow-2xs p-4 overflow-hidden flex-col">
            <DraftingInspectorContent
              task={task}
              currentDraft={currentDraft}
              activeRole={activeRole}
              activeBlock={activeBlock}
              activeSection={activeSection}
              inspectorTab={inspectorTab}
              onSelectInspectorTab={setInspectorTab}
              isCurrentDraftImmutable={isCurrentDraftImmutable}
              canUserEdit={canUserEdit}
              activeReviewComments={activeReviewComments}
              selectedCommentId={selectedCommentId}
              onSelectCommentId={setSelectedCommentId}
              commentStatusFilter={commentStatusFilter}
              onChangeCommentStatusFilter={setCommentStatusFilter}
              commentReviewerFilter={commentReviewerFilter}
              onChangeCommentReviewerFilter={setCommentReviewerFilter}
              inspectingFactId={inspectingFactId}
              onClearInspectingFactId={() => setInspectingFactId(null)}
              onViewSnippet={onViewSnippet}
              onSelectStage={onSelectStage}
              onOpenContradictionModal={() => setShowContradictionModal(true)}
              onOpenRebindModal={handleOpenRebindModal}
              onOpenDirectImplementModal={handleOpenDirectImplementModal}
              onOpenRejectModal={handleOpenRejectModal}
              onOpenDiscussModal={handleOpenDiscussModal}
              onAcceptCommentDecisionOnly={handleAcceptCommentDecisionOnly}
              onGenerateRevisionFromComment={handleGenerateRevisionFromComment}
              onJumpToTargetBlock={handleJumpToTargetBlock}
              revisionSuggestion={revisionSuggestion}
              isRevisionGenerating={isRevisionGenerating}
              revisionError={revisionError}
              revisionTargetOrder={revisionTargetOrder}
              customPromptInput={customPromptInput}
              onChangeCustomPromptInput={setCustomPromptInput}
              onRequestRevision={handleRequestRevision}
              onRequestCustomRevision={handleRequestCustomRevision}
              onCancelRevision={handleCancelRevision}
              onRetryRevision={handleRetryRevision}
              onAdoptRevision={handleAdoptRevision}
              onDiscardRevision={handleDiscardRevision}
              onRegenerateRevision={handleRegenerateRevision}
              copyFeedback={copyFeedback}
              activeCompletedRunId={completedRevisionRunIdRef.current}
              pendingFineTuneText={currentPendingFineTune}
              onPendingFineTuneTextChange={(text) => {
                if (fineTuneKey) {
                  setFineTunedPendingTexts((prev) => ({ ...prev, [fineTuneKey]: text }));
                }
              }}
              isDrawer={false}
              panelId={inspectorPanelId}
              onClose={() => toggleDesktopPanel('inspector', false)}
              onOpenMaterialSupplement={handleOpenMaterialSupplement}
            />
          </div>
        ) : (
          <div id={inspectorPanelId} className="drafting-panel-sticky hidden lg:block">
            <button
              type="button"
              onClick={() => toggleDesktopPanel('inspector', true)}
              className="w-full min-h-20 py-3 flex flex-col items-center gap-2 bg-white border border-slate-200 rounded-lg shadow-xs text-slate-600 hover:text-blue-800 hover:bg-blue-50 cursor-pointer focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-hidden"
              title="展开辅助面板"
              aria-label="展开辅助面板"
              aria-expanded={false}
              aria-controls={inspectorPanelId}
            >
              <ChevronLeft className="w-4 h-4" aria-hidden="true" />
              <span className="text-xs font-medium">辅助</span>
            </button>
          </div>
        )}
      </div>

      {/* Tablet Outline Navigation Drawer */}
      {showTabletOutlineDrawer && (
        <div
          data-testid="drawer-tablet-outline"
          role="dialog"
          aria-modal="true"
          aria-label="章节大纲导航"
          className="fixed inset-0 z-50 overflow-hidden bg-slate-900/50 backdrop-blur-xs flex justify-start animate-in fade-in duration-150"
        >
          <div className="w-full max-w-xs sm:max-w-sm bg-white h-full shadow-2xl flex flex-col border-r border-slate-200">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-blue-700" />
                <h3 className="font-bold text-sm text-slate-800">章节大纲导航</h3>
              </div>
              <button data-testid="btn-close-tablet-outline"
                type="button"
                onClick={() => {
                  setShowTabletOutlineDrawer(false);
                  lastTabletTriggerRef.current?.focus();
                }}
                className="p-1 text-slate-400 hover:text-slate-600 rounded hover:bg-slate-100 cursor-pointer"
                aria-label="关闭章节大纲导航"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {task.outline.map((sec, idx) => {
                const firstBlockOfSec = currentDraft?.blocks.find((b) => b.sectionId === sec.id);
                const isCurrentSecActive = activeBlock?.sectionId === sec.id;

                return (
                  <button
                    type="button"
                    key={sec.id}
                    onClick={() => {
                      if (firstBlockOfSec) {
                        setSelectedBlockId(firstBlockOfSec.id);
                        setShowTabletOutlineDrawer(false);
                        setTimeout(() => {
                          const el = document.getElementById(`block-card-${firstBlockOfSec.id}`);
                          if (el && typeof el.scrollIntoView === 'function') {
                            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                          }
                          lastTabletTriggerRef.current?.focus();
                        }, 50);
                      }
                    }}
                    className={`w-full text-left p-3 rounded-lg border transition-colors cursor-pointer text-sm focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-hidden ${
                      isCurrentSecActive
                        ? 'bg-blue-50/80 border-blue-300 text-blue-900 font-medium'
                        : 'bg-slate-50 hover:bg-slate-100 border-slate-200/70 text-slate-700'
                    }`}
                    aria-label={`定位章节：${sec.title}`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-semibold text-sm">
                        {idx + 1}. {sec.title}
                      </span>
                      {isCurrentSecActive && (
                        <span className="w-2 h-2 rounded-full bg-blue-600 shrink-0" />
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mt-1 flex justify-between">
                      <span>建议：{sec.suggestedWordCount}字</span>
                      <span>{sec.assignedFactIds.length}项依据</span>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="p-3 border-t border-slate-100 bg-slate-50 text-xs text-slate-500 space-y-1">
              <div>当前正文字数：<strong className="text-slate-800 font-mono">{currentWordCount}</strong> 字</div>
              <div>目标总字数：<strong className="text-slate-800 font-mono">{task.targetWordCount}</strong> 字</div>
            </div>
          </div>
        </div>
      )}

      {/* Tablet Inspector Drawer */}
      {showTabletInspectorDrawer && (
        <div
          ref={tabletDrawerRef}
          data-testid="drawer-tablet-inspector"
          role="dialog"
          aria-modal="true"
          aria-label="段落辅助面板"
          className="fixed inset-0 z-50 overflow-hidden bg-slate-900/50 backdrop-blur-xs flex justify-end animate-in fade-in duration-150"
        >
          <div className="w-full max-w-md sm:max-w-lg bg-white h-full shadow-2xl flex flex-col border-l border-slate-200 p-4">
            <DraftingInspectorContent
              task={task}
              currentDraft={currentDraft}
              activeRole={activeRole}
              activeBlock={activeBlock}
              activeSection={activeSection}
              inspectorTab={inspectorTab}
              onSelectInspectorTab={setInspectorTab}
              isCurrentDraftImmutable={isCurrentDraftImmutable}
              canUserEdit={canUserEdit}
              activeReviewComments={activeReviewComments}
              selectedCommentId={selectedCommentId}
              onSelectCommentId={setSelectedCommentId}
              commentStatusFilter={commentStatusFilter}
              onChangeCommentStatusFilter={setCommentStatusFilter}
              commentReviewerFilter={commentReviewerFilter}
              onChangeCommentReviewerFilter={setCommentReviewerFilter}
              inspectingFactId={inspectingFactId}
              onClearInspectingFactId={() => setInspectingFactId(null)}
              onViewSnippet={onViewSnippet}
              onSelectStage={onSelectStage}
              onOpenContradictionModal={() => setShowContradictionModal(true)}
              onOpenRebindModal={handleOpenRebindModal}
              onOpenDirectImplementModal={handleOpenDirectImplementModal}
              onOpenRejectModal={handleOpenRejectModal}
              onOpenDiscussModal={handleOpenDiscussModal}
              onAcceptCommentDecisionOnly={handleAcceptCommentDecisionOnly}
              onGenerateRevisionFromComment={handleGenerateRevisionFromComment}
              onJumpToTargetBlock={handleJumpToTargetBlock}
              revisionSuggestion={revisionSuggestion}
              isRevisionGenerating={isRevisionGenerating}
              revisionError={revisionError}
              revisionTargetOrder={revisionTargetOrder}
              customPromptInput={customPromptInput}
              onChangeCustomPromptInput={setCustomPromptInput}
              onRequestRevision={handleRequestRevision}
              onRequestCustomRevision={handleRequestCustomRevision}
              onCancelRevision={handleCancelRevision}
              onRetryRevision={handleRetryRevision}
              onAdoptRevision={handleAdoptRevision}
              onDiscardRevision={handleDiscardRevision}
              onRegenerateRevision={handleRegenerateRevision}
              copyFeedback={copyFeedback}
              activeCompletedRunId={completedRevisionRunIdRef.current}
              pendingFineTuneText={currentPendingFineTune}
              onPendingFineTuneTextChange={(text) => {
                if (fineTuneKey) {
                  setFineTunedPendingTexts((prev) => ({ ...prev, [fineTuneKey]: text }));
                }
              }}
              isDrawer={true}
              onClose={() => {
                setShowTabletInspectorDrawer(false);
                if (selectedBlockId) {
                  setTimeout(() => {
                    const el = document.getElementById(`block-card-${selectedBlockId}`);
                    if (el && typeof el.scrollIntoView === 'function') {
                      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                    lastTabletTriggerRef.current?.focus();
                  }, 50);
                }
              }}
              onOpenMaterialSupplement={handleOpenMaterialSupplement}
            />
          </div>
        </div>
      )}
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
                      <span className="text-xs text-slate-400">
                        {new Date(ver.createdAt).toLocaleTimeString('zh-CN')}
                      </span>
                    </div>

                    <p className="text-slate-600 text-xs">{ver.summary}</p>
                    <div className="text-xs text-slate-400">保存人：{ver.author}</div>

                    <div className="pt-1 flex justify-end gap-2">
                      {!isCurrent && (
                        <>
                          <button
                            onClick={() => {
                              onUpdateTask({ currentDraftId: ver.id });
                              setShowVersionHistory(false);
                            }}
                            className="px-2.5 py-1 border rounded text-xs font-medium text-slate-700 hover:bg-slate-50 border-slate-300 cursor-pointer"
                          >
                            查看此版本
                          </button>
                          <button
                            onClick={() => handleRestoreDraft(ver)}
                            disabled={!canUserEdit}
                            className={`px-2.5 py-1 border rounded text-xs font-medium transition-colors ${
                              !canUserEdit
                                ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                                : 'text-blue-700 hover:bg-blue-50 border-blue-200 cursor-pointer'
                            }`}
                            title={!canUserEdit ? `权限受限：当前身份为【${activeRole}】，仅主笔甲可恢复历史版本` : '恢复至此版本 (生成新版本)'}
                          >
                            恢复至此版本 (生成新工作稿)
                          </button>
                        </>
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
      {acceptingComment && <DecisionNoteModal initialNote={acceptingComment.authorReply || '主笔决定采纳此意见方向，待落实正文'} onCancel={() => setAcceptingComment(null)} onConfirm={handleConfirmAcceptDecision} />}

      <CandidateComparisonModal
        isOpen={showCandidateComparisonModal}
        onClose={() => setShowCandidateComparisonModal(false)}
        task={task}
        currentDraft={currentDraft}
        candidate={pendingCandidate}
      activeCompletedRunId={completedCandidateRunIdRef.current}
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
                  <span className="text-xs bg-blue-200 text-blue-800 px-1.5 py-0.2 rounded font-medium">
                    {implementingComment.type === 'overall' ? '全局意见' : `第${implementingComment.targetBlockOrder || '?'}段`}
                  </span>
                </div>
                <p className="text-slate-700">{implementingComment.content}</p>
                {implementingComment.suggestedChange && (
                  <div className={`pt-1 text-xs font-medium ${
                    interpretReviewCommentSuggestion(implementingComment).isReplacement
                      ? 'text-emerald-800'
                      : 'text-blue-800'
                  }`}>
                    {interpretReviewCommentSuggestion(implementingComment).isReplacement
                      ? '审阅人提供的替换稿：'
                      : '修改方向（只读）：'}
                    {implementingComment.suggestedChange}
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">
                  {interpretReviewCommentSuggestion(implementingComment).isReplacement
                    ? '落实修改后的段落正文（已预填审阅人替换稿，可人工微调）：'
                    : '落实修改后的段落正文（已从当前原文初始化，请依据修改方向调整正文）：'}
                </label>
                <textarea
                  rows={4}
                  value={implBlockContent}
                  onChange={(e) => setImplBlockContent(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded font-serif text-xs leading-relaxed focus:ring-1 focus:ring-emerald-600 focus:outline-hidden"
                  required
                />
                {interpretReviewCommentSuggestion(implementingComment).isInstruction && (
                  <p className="text-xs text-slate-500">
                    提示：修改方向仅供指引，未对正文进行实际改动（零差异）时不能确认落实。
                  </p>
                )}
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
                <div className="font-bold text-amber-900 flex items-center justify-between">
                  <span>【{reboundingComment.reviewer}】提出的意见：</span>
                  <span className="text-xs text-amber-700 font-mono">
                    针对 {reboundingComment.targetVersionNumber || reboundingComment.targetVersionId} 第{reboundingComment.targetBlockOrder || '?'}段
                  </span>
                </div>
                <p className="text-slate-700">{reboundingComment.content}</p>
                {reboundingComment.baseParagraphText && (
                  <p className="text-xs text-slate-500 italic pt-1 border-t border-amber-200/60 mt-1">
                    提出时原句：“{reboundingComment.baseParagraphText.slice(0, 60)}...”
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
              <CoordinationOpinionSelector comments={activeReviewComments} selected={coordinationCommentIds} onChange={setCoordinationCommentIds}/>

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
                      <div className="text-xs text-slate-500">压缩动员铺垫300字，同时以提炼式短句精炼补充代表性成效，兼顾紧凑与成效。</div>
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
                      <div className="text-xs text-slate-500">优先响应审阅乙：删减铺垫段落，严格将正文压缩至2000字以内。</div>
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
                      <div className="text-xs text-slate-500">优先响应审阅丁：补充典型调研案例与举措细节，篇幅适度放宽。</div>
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
                    title="根据策略调整正文；意见仍需逐条核实，不自动视为全部落实"
                  >
                    应用策略并逐条核实意见
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 5. In-App Submit Draft For Review Confirmation Modal (replaces window.confirm) */}
      {showSubmitReviewModal && currentDraft && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full border border-slate-200 overflow-hidden animate-in fade-in zoom-in duration-150">
            <div className="p-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Send className="w-5 h-5 text-blue-600" />
                <h3 className="font-bold text-sm text-slate-800">提交本轮审阅确认</h3>
              </div>
              <button
                onClick={() => setShowSubmitReviewModal(false)}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
                aria-label="关闭"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg space-y-1">
                <div className="font-semibold text-blue-900">
                  当前待提交文稿：【{currentDraft.versionNumber}】
                </div>
                <div className="text-xs text-blue-800">
                  字数：{currentWordCount} 字 · 拟稿人：{currentDraft.author}
                </div>
              </div>

              <div className="space-y-2 text-slate-700">
                <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                  <Info className="w-4 h-4 text-blue-600 shrink-0" />
                  <span>提交审阅与冻结基准影响说明：</span>
                </div>
                <ul className="space-y-1.5 pl-5 list-disc text-xs text-slate-600 leading-normal">
                  <li>
                    <strong>生成冻结基准快照：</strong>系统将以当前版本自动生成不可篡改的审阅基准快照，作为本轮审阅对比基线。
                  </li>
                  <li>
                    <strong>递增审阅轮次：</strong>当前审阅轮次将从第 {task.currentReviewRound || 0} 轮推进至第 {(task.currentReviewRound || 0) + 1} 轮。
                  </li>
                  <li>
                    <strong>变更任务状态：</strong>任务状态将流转至“审阅中”，并自动跳转至审阅修改工作区。
                  </li>
                  <li>
                    <strong>审阅意见严格绑定：</strong>审阅领导提出的修改批注与建议将绑定本轮基准，不污染历史版本。
                  </li>
                </ul>
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-2.5">
              <button
                onClick={() => setShowSubmitReviewModal(false)}
                className="px-3.5 py-1.5 border border-slate-300 hover:bg-slate-100 rounded text-xs font-semibold text-slate-700 cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={handleConfirmSubmitForReview}
                className="px-4 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold shadow-xs flex items-center gap-1.5 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                <span>确认提交并进入审阅</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Recent Modifications & Safe Undo Modal */}
      <RecentModificationsModal
        isOpen={showRecentModificationsModal}
        onClose={() => setShowRecentModificationsModal(false)}
        task={task}
        currentDraft={currentDraft}
        activeRole={activeRole}
        onUndo={handleUndoModification}
      />

      {/* Task 20: Material-Driven Paragraph Supplementation Modal */}
      <MaterialSupplementModal
        isOpen={showMaterialSupplementModal}
        onClose={() => setShowMaterialSupplementModal(false)}
        task={task}
        currentDraft={currentDraft}
        activeBlock={activeBlock}
        activeRole={activeRole}
        onViewSnippet={onViewSnippet}
        onSelectStage={onSelectStage}
        onSupplementSuccess={handleSupplementSuccess}
      />

      {/* Task 21 & 22: Fact Impact Overview & Block Review Modal */}
      <FactImpactModal
        isOpen={showFactImpactModal}
        onClose={() => setShowFactImpactModal(false)}
        analysis={factImpact}
        currentDraft={currentDraft}
        task={task}
        activeRole={activeRole}
        onLocateBlock={handleLocateBlock}
        onViewDraftEvidence={handleViewDraftEvidence}
        onJumpToFactsStage={onSelectStage ? () => onSelectStage('material_fact') : undefined}
        onJumpToOutlineStage={onSelectStage ? () => onSelectStage('style_outline') : undefined}
        onSaveReviewRecord={handleSaveReviewRecord}
        onRevokeReviewRecord={handleRevokeReviewRecord}
        onAcceptFactRevision={handleAcceptFactRevision}
        onAcceptMultiParagraphFactRevision={handleAcceptMultiParagraphFactRevision}
        initialBlockId={impactFocusBlockId}
      />
    </div>
  );
};

