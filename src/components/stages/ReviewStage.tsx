import React, { useState } from 'react';
import { 
  Task, 
  ReviewComment, 
  ReviewCommentStatus,
  UserRole, 
  DraftVersion 
} from '../../types';
import { 
  checkPermission, 
  canResolveComments, 
  canAddComment 
} from '../../services/permissionService';
import { 
  generateCoordinationDiff, 
  applyCoordinationDecision,
  implementReviewCommentWithText,
  getReviewCommentLocation,
  rebindReviewCommentTargetBlock
} from '../../services/reviewCoordinationService';
import { applyDraftContentChange } from '../../services/draftLifecycleService';
import { 
  MessageSquare, 
  UserCheck, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  AlertTriangle, 
  Plus, 
  Send, 
  ArrowRight, 
  MessageCircle, 
  HelpCircle,
  Sparkles,
  ShieldAlert,
  Edit3,
  FileText,
  Check,
  ChevronRight
} from 'lucide-react';

interface ReviewStageProps {
  task: Task;
  onUpdateTask: (updated: Partial<Task>) => void;
  onProceedToNextStage: () => void;
  activeRole: UserRole;
  onSelectStage?: (stage: any) => void;
}

export const ReviewStage: React.FC<ReviewStageProps> = ({
  task,
  onUpdateTask,
  onProceedToNextStage,
  activeRole,
  onSelectStage,
}) => {
  const currentDraft = task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];
  const reviewBaseDraft = (task.reviewBaseDraftId ? task.drafts.find((d) => d.id === task.reviewBaseDraftId) : undefined) || currentDraft;
  const currentReviewRound = task.currentReviewRound || 1;

  // Comment filter
  const [commentFilter, setCommentFilter] = useState<'all' | ReviewCommentStatus>('all');
  const [reviewerFilter, setReviewerFilter] = useState<'all' | '审阅乙' | '审阅丁'>('all');

  // New comment input modal/form
  const [showAddCommentModal, setShowAddCommentModal] = useState(false);
  const [commentType, setCommentType] = useState<'overall' | 'paragraph'>('overall');
  const [selectedBlockId, setSelectedBlockId] = useState<string>(currentDraft?.blocks[0]?.id || '');
  const [newCommentContent, setNewCommentContent] = useState('');
  const [newCommentSuggestion, setNewCommentSuggestion] = useState('');

  // Author general reply modal (decisions without immediate text overwrite)
  const [replyingComment, setReplyingComment] = useState<ReviewComment | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyAction, setReplyAction] = useState<'accepted_pending_implementation' | 'rejected' | 'need_discussion'>('accepted_pending_implementation');

  // Text modification comparison & implementation modal
  const [implementingComment, setImplementingComment] = useState<ReviewComment | null>(null);
  const [implTargetBlockId, setImplTargetBlockId] = useState<string>('');
  const [implOriginalText, setImplOriginalText] = useState<string>('');
  const [implSuggestedText, setImplSuggestedText] = useState<string>('');
  const [implAuthorReply, setImplAuthorReply] = useState<string>('');

  // Rebind comment modal (when target paragraph deleted/merged)
  const [rebindingComment, setRebindingComment] = useState<ReviewComment | null>(null);
  const [rebindTargetBlockId, setRebindTargetBlockId] = useState<string>('');

  // Contradiction resolution panel state (Compress to 2000 words vs Add 2 cases)
  const [showContradictionModal, setShowContradictionModal] = useState(false);
  const [selectedStrategy, setSelectedStrategy] = useState<'compress_priority' | 'case_priority' | 'balanced'>('balanced');
  const [strategyReason, setStrategyReason] = useState(
    '综合两位审阅领导意见：在第一部分压缩常规动员铺垫约300字，同时以提炼式短句补充基层专项调研代表性成效，控制全篇在2500字左右。'
  );

  const isAuthor = activeRole === '主笔甲';
  const isReviewer = activeRole === '审阅乙' || activeRole === '审阅丁';

  // Counts calculated dynamically from reviewComments
  const totalComments = task.reviewComments.length;
  const pendingCommentsCount = task.reviewComments.filter((c) => c.status === 'pending').length;
  const acceptedPendingCount = task.reviewComments.filter((c) => c.status === 'accepted_pending_implementation').length;
  const implementedCount = task.reviewComments.filter((c) => c.status === 'implemented').length;
  const needDiscussionCount = task.reviewComments.filter((c) => c.status === 'need_discussion').length;
  const rejectedCount = task.reviewComments.filter((c) => c.status === 'rejected').length;

  const handleAddComment = (e: React.FormEvent) => {
    e.preventDefault();
    const perm = checkPermission(activeRole, 'add_comment');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：当前身份不可发表审阅意见');
      return;
    }
    if (!newCommentContent.trim()) return;

    const targetBlock = currentDraft?.blocks.find((b) => b.id === selectedBlockId);

    const newComment: ReviewComment = {
      id: `CMT-${Date.now().toString(36)}`,
      type: commentType,
      targetBlockId: commentType === 'paragraph' ? selectedBlockId : undefined,
      targetBlockOrder: commentType === 'paragraph' ? targetBlock?.order : undefined,
      targetVersionId: reviewBaseDraft?.id || currentDraft?.id || 'DRAFT-DEFAULT',
      targetVersionNumber: reviewBaseDraft?.versionNumber || currentDraft?.versionNumber,
      baseParagraphText: commentType === 'paragraph' ? targetBlock?.content : undefined,
      reviewer: activeRole === '主笔甲' ? '审阅乙' : activeRole,
      content: newCommentContent.trim(),
      suggestedChange: newCommentSuggestion.trim() || undefined,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    onUpdateTask({
      reviewComments: [newComment, ...task.reviewComments],
      status: '审阅中',
    });

    setShowAddCommentModal(false);
    setNewCommentContent('');
    setNewCommentSuggestion('');
  };

  // Author applies reply or decision without modifying text immediately
  const handleApplyDecisionOnly = (e: React.FormEvent) => {
    e.preventDefault();
    const perm = checkPermission(activeRole, 'resolve_comment');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可处理审阅意见');
      return;
    }
    if (!replyingComment) return;

    const updatedComments = task.reviewComments.map((c) => {
      if (c.id === replyingComment.id) {
        return {
          ...c,
          status: replyAction,
          authorReply: replyText.trim() || (replyAction === 'accepted_pending_implementation' ? '主笔决定采纳，待后续统筹落实' : '主笔已核实并答复'),
          decisionReason: replyText.trim(),
          resolutionType: replyAction === 'accepted_pending_implementation' ? ('strategy_decided' as const) : replyAction === 'rejected' ? ('rejected' as const) : ('communicated' as const),
        };
      }
      return c;
    });

    onUpdateTask({ reviewComments: updatedComments });
    setReplyingComment(null);
    setReplyText('');
  };

  // Open modal to view original vs suggestion and implement into text
  const handleOpenImplementModal = (cmt: ReviewComment) => {
    const perm = checkPermission(activeRole, 'resolve_comment');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可采纳落实审阅建议');
      return;
    }

    if (!currentDraft) {
      alert('当前文稿草稿不存在，无法落实修改');
      return;
    }

    // STRICT LOCATION CHECK: NEVER fallback to blocks[0]!
    const loc = getReviewCommentLocation(cmt, currentDraft);
    if (!loc.isLocated || !loc.targetBlock) {
      alert('【定位需复核】该意见的目标段落已在正文中删除或合并，不可直接落实或错挂至第一段！请先重新指定目标段落。');
      setRebindingComment(cmt);
      setRebindTargetBlockId(currentDraft.blocks[0]?.id || '');
      return;
    }

    const targetBlock = loc.targetBlock;
    const initialSuggested = cmt.suggestedChange || targetBlock.content;

    setImplementingComment(cmt);
    setImplTargetBlockId(targetBlock.id);
    setImplOriginalText(targetBlock.content);
    setImplSuggestedText(initialSuggested);
    setImplAuthorReply(`采纳【${cmt.reviewer}】修改建议，已核实修改第${targetBlock.order}段正文。`);
  };

  // Confirm text modification, update draft working copy, generate new version snapshot
  const handleConfirmImplementText = (e: React.FormEvent) => {
    e.preventDefault();
    const perm = checkPermission(activeRole, 'resolve_comment');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可采纳落实审阅建议');
      return;
    }
    if (!implementingComment || !currentDraft) return;

    try {
      // Use shared implementation service: enforces target exists, base content unchanged, and zero diff rejected!
      const { updatedTask, workingDraft } = implementReviewCommentWithText(
        task,
        implementingComment.id,
        currentDraft.id,
        implSuggestedText,
        implAuthorReply,
        activeRole,
        {
          expectedBaseContent: implOriginalText,
        }
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

  // Rebind comment target block
  const handleConfirmRebind = () => {
    if (!rebindingComment || !currentDraft || !rebindTargetBlockId) return;
    try {
      const res = rebindReviewCommentTargetBlock(
        task,
        rebindingComment.id,
        rebindTargetBlockId,
        activeRole
      );
      onUpdateTask({ reviewComments: res.updatedTask.reviewComments });
      setRebindingComment(null);
      alert('目标段落已成功重新绑定');
    } catch (err: any) {
      alert(err.message || '重新指定目标段落失败');
    }
  };

  const mappedStrategy = 
    selectedStrategy === 'compress_priority' ? ('compress' as const) :
    selectedStrategy === 'case_priority' ? ('expand_case' as const) : ('balanced' as const);

  const currentCoordinationDiff = currentDraft ? generateCoordinationDiff(task, currentDraft, mappedStrategy) : null;

  // Reconcile contradictory comments (CMT-01 & CMT-02)
  const handleResolveContradiction = (mode: 'strategy_only' | 'implement_now') => {
    const perm = checkPermission(activeRole, 'resolve_comment');
    if (!perm.allowed) {
      alert(perm.reason || '权限受限：仅主笔甲可裁决审阅矛盾意见');
      return;
    }

    if (!currentDraft || !currentCoordinationDiff) return;

    if (mode === 'strategy_only') {
      // Record strategy decision only; status remains accepted_pending_implementation
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

    // mode === 'implement_now': Actually adjust draft text and create new version
    if (currentCoordinationDiff.diffPreview.length === 0) {
      alert('未检测到正文文本差异（零差异），不能标记审阅意见为已落实！');
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

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
              <MessageSquare className="w-5 h-5 text-blue-700" />
              阶段05：审阅意见收集与协同修改处理
            </h2>
            <span className="text-xs bg-amber-100 text-amber-800 border border-amber-200 px-2 py-0.5 rounded font-medium">
              待处理意见：{pendingCommentsCount} 条
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            审阅者（审阅乙、审阅丁）提出整体或段落批注；主笔甲负责逐条研判、回复、决定采纳或落实修改。遇到相互矛盾意见提供协调裁决策略。
          </p>
        </div>

        <div className="flex items-center gap-2">
          {onSelectStage && (
            <button
              onClick={() => onSelectStage('drafting')}
              className="px-3.5 py-2 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 rounded text-xs font-semibold shadow-2xs flex items-center gap-1.5 cursor-pointer"
              title="切换至正文工作区，通过段落AI建议或对比组件进行深度修改与落实"
            >
              <FileText className="w-4 h-4 text-blue-600" />
              <span>前往正文起草工作区</span>
            </button>
          )}

          <button
            onClick={() => setShowAddCommentModal(true)}
            className="px-3.5 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded text-xs font-semibold shadow-xs flex items-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>提出审阅意见</span>
          </button>

          <button
            onClick={onProceedToNextStage}
            className="px-4 py-2 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold shadow-xs flex items-center gap-1.5 cursor-pointer"
          >
            <span>下一步：核校与定稿导出</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Role Notice */}
      <div className="bg-blue-50/70 border border-blue-200 p-3 rounded-lg flex items-center justify-between text-xs text-blue-900">
        <div className="flex items-center gap-2">
          <UserCheck className="w-4 h-4 text-blue-700 shrink-0" />
          <span>
            当前操作角色为：<strong>{activeRole}</strong>
            {isReviewer ? '（审阅者权限：可查阅文稿并新增批注，不可直接修改正文或批准定稿）' : activeRole === '供稿丙' ? '（供稿人权限：可查阅材料，不可直接批注正文或定稿）' : '（主笔权限：可逐条研判意见、落实修改正文并保存新版本）'}
          </span>
        </div>
        <span className="text-[11px] text-blue-700">可在顶部导航随时切换演示角色验证权限</span>
      </div>

      {/* Review Round & Base Draft Reference Banner */}
      <div className="bg-white border border-slate-200 p-3.5 rounded-lg shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-800 flex items-center justify-center font-bold text-xs shrink-0">
            R{currentReviewRound}
          </div>
          <div>
            <div className="font-bold text-slate-800 flex items-center gap-2">
              <span>第 {currentReviewRound} 轮审阅周期</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-blue-50 text-blue-700 border border-blue-200 font-medium">
                进行中
              </span>
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 flex flex-wrap items-center gap-2">
              <span>本轮审阅基准版本：<strong className="text-slate-700 font-medium">{reviewBaseDraft?.versionNumber || '初始版本'}</strong></span>
              <span aria-hidden="true">·</span>
              <span>当前最新工作稿：<strong className="text-slate-700 font-medium">{currentDraft?.versionNumber || '无'}</strong></span>
            </div>
          </div>
        </div>
        <div className="text-right text-[11px] text-slate-400">
          <div>意见总数：{totalComments} 条（待处理 {pendingCommentsCount} 条）</div>
          <div>意见针对基准版本提出，落实后记录落实版本与段落</div>
        </div>
      </div>

      {/* Contradictory comments banner */}
      {task.reviewComments.some((c) => (c.id === 'CMT-01' || c.id === 'CMT-02') && c.status === 'pending') && (
        <div className="bg-amber-50 border-2 border-amber-400 p-4 rounded-lg flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-xs">
          <div className="space-y-1">
            <div className="flex items-center gap-2 font-bold text-xs text-amber-900">
              <AlertTriangle className="w-4 h-4 text-amber-600" />
              <span>检测到相互矛盾的审阅篇幅要求！</span>
            </div>
            <p className="text-xs text-amber-800">
              审阅乙提出“篇幅压缩到2000字以内”；审阅丁提出“增加两个详细案例以丰富成效”。需要主笔统筹裁决协调策略。
            </p>
          </div>
          <button
            onClick={() => setShowContradictionModal(true)}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded text-xs font-bold shadow-xs cursor-pointer shrink-0"
          >
            协调裁决此冲突
          </button>
        </div>
      )}

      {/* Main Review Grid */}
      <div className="grid grid-cols-12 gap-6">
        {/* Left: Comments List */}
        <div className="col-span-12 lg:col-span-7 bg-white rounded-lg border border-slate-200 shadow-2xs p-5 space-y-4">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 pb-2 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <span className="font-bold text-xs text-slate-800">全部审阅意见</span>
              <span className="text-[11px] bg-slate-200 text-slate-700 px-1.5 py-0.2 rounded font-mono">
                {task.reviewComments.length}
              </span>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <select
                value={commentFilter}
                onChange={(e) => setCommentFilter(e.target.value as any)}
                className="border border-slate-300 rounded px-2 py-1 bg-white text-slate-700 text-xs"
              >
                <option value="all">全部状态 ({task.reviewComments.length})</option>
                <option value="pending">待处理 ({pendingCommentsCount})</option>
                <option value="accepted_pending_implementation">决定采纳·待落实 ({acceptedPendingCount})</option>
                <option value="implemented">已修改/已落实 ({implementedCount})</option>
                <option value="need_discussion">待沟通 ({needDiscussionCount})</option>
                <option value="rejected">拒绝采纳 ({rejectedCount})</option>
              </select>

              <select
                value={reviewerFilter}
                onChange={(e) => setReviewerFilter(e.target.value as any)}
                className="border border-slate-300 rounded px-2 py-1 bg-white text-slate-700 text-xs"
              >
                <option value="all">全部审阅人</option>
                <option value="审阅乙">审阅乙</option>
                <option value="审阅丁">审阅丁</option>
              </select>
            </div>
          </div>

          {/* Comments Feed */}
          <div className="space-y-3">
            {task.reviewComments
              .filter((c) => {
                if (commentFilter !== 'all' && c.status !== commentFilter) return false;
                if (reviewerFilter !== 'all' && c.reviewer !== reviewerFilter) return false;
                return true;
              })
              .map((cmt) => {
                const targetBlock = currentDraft?.blocks.find((b) => b.id === cmt.targetBlockId);

                // Requirement 6: Accurate detection of location obsolescence
                const isLocationOutdated = cmt.type === 'paragraph' && (
                  cmt.targetVersionId !== currentDraft?.id ||
                  !targetBlock ||
                  (!!cmt.baseParagraphText && targetBlock.content !== cmt.baseParagraphText)
                );

                return (
                  <div
                    key={cmt.id}
                    className="p-4 border border-slate-200 rounded-lg bg-slate-50/50 hover:bg-slate-50 transition-colors space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-xs text-slate-800">{cmt.reviewer}</span>
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-200 text-slate-700">
                          {cmt.type === 'overall' ? '整体全局意见' : `第${cmt.targetBlockOrder || '指定'}段批注`}
                        </span>
                        <span className="text-[10px] text-slate-400 font-mono">
                          基准版本: {cmt.targetVersionId}
                        </span>
                      </div>

                      {/* Requirement 5: Clear distinct status pills. Only decision -> NOT "已采纳修改" */}
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded font-medium ${
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
                          ? '已修改·正文已落实'
                          : cmt.status === 'accepted_pending_implementation'
                          ? '决定采纳·待落实正文'
                          : cmt.status === 'rejected'
                          ? '拒绝采纳'
                          : cmt.status === 'need_discussion'
                          ? '沟通讨论中'
                          : '待主笔处理'}
                      </span>
                    </div>

                    <p className="text-xs text-slate-800 leading-relaxed font-medium">{cmt.content}</p>

                    {cmt.suggestedChange && (
                      <div className="p-2 bg-white rounded border border-blue-200 text-[11px] text-blue-900 space-y-0.5">
                        <span className="text-blue-500 font-semibold block">【修改建议方向】：</span>
                        <p>{cmt.suggestedChange}</p>
                      </div>
                    )}

                    {/* Requirement 6: Show accurate location outdated notice; never silently attach */}
                    {isLocationOutdated && (
                      <div className="p-2 bg-amber-50 border border-amber-300 rounded text-[11px] text-amber-900 space-y-1">
                        <div className="flex items-center gap-1 font-bold text-amber-800">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                          <span>定位提示：目标段落定位已过期（正文内容已变动或已重构）</span>
                        </div>
                        <p className="text-[10px] text-amber-700">
                          该意见针对草稿【{cmt.targetVersionId}】第{cmt.targetBlockOrder}段提出。为防止错挂，系统已隔离定位。
                        </p>
                        {cmt.baseParagraphText && (
                          <div className="mt-1 p-1 bg-white/80 rounded border border-amber-200 text-[10px] font-mono text-slate-600 italic">
                            提出时基准原句：“{cmt.baseParagraphText.slice(0, 80)}...”
                          </div>
                        )}
                      </div>
                    )}

                    {/* Target block context snippet if still valid */}
                    {!isLocationOutdated && targetBlock && (
                      <div className="p-2 bg-slate-100/70 rounded border border-slate-200 text-[11px] text-slate-600 italic">
                        目标原段：{targetBlock.content.slice(0, 80)}...
                      </div>
                    )}

                    {/* Author Reply Section */}
                    {cmt.authorReply && (
                      <div className="p-2.5 bg-emerald-50/70 border border-emerald-200 rounded text-xs text-emerald-900 space-y-1">
                        <div className="font-semibold text-[11px] flex items-center justify-between">
                          <span className="flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                            主笔处理答复记录：
                          </span>
                          {cmt.implementationDraftId && (
                            <span className="text-[10px] text-emerald-700 font-mono">
                              落实版本：{cmt.implementationDraftId}
                            </span>
                          )}
                        </div>
                        <p>{cmt.authorReply}</p>
                      </div>
                    )}

                    {/* Actions for Author */}
                    {isAuthor && (cmt.status === 'pending' || cmt.status === 'accepted_pending_implementation') && (
                      <div className="pt-2 border-t border-slate-200/70 flex flex-wrap justify-end gap-2">
                        {onSelectStage && (
                          <button
                            onClick={() => onSelectStage('drafting')}
                            className="px-2.5 py-1 text-blue-700 hover:bg-blue-50 border border-blue-200 rounded text-xs flex items-center gap-1 cursor-pointer font-medium"
                            title="在正文工作区定位原段落、查阅事实依据并生成AI建议或对比采纳"
                          >
                            <FileText className="w-3.5 h-3.5 text-blue-600" />
                            <span>在正文工作区定位与落实</span>
                          </button>
                        )}

                        {cmt.suggestedChange && (
                          <button
                            onClick={() => handleOpenImplementModal(cmt)}
                            className="px-3 py-1 bg-emerald-700 hover:bg-emerald-800 text-white rounded text-xs font-semibold shadow-xs flex items-center gap-1 cursor-pointer"
                            title="对比原文与建议，确认后直接写入正文并创建新版本"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                            <span>对比并落实修改到正文</span>
                          </button>
                        )}

                        <button
                          onClick={() => {
                            setReplyingComment(cmt);
                            setReplyAction('need_discussion');
                            setReplyText(cmt.authorReply || '');
                          }}
                          className="px-2.5 py-1 text-blue-700 hover:bg-blue-50 border border-blue-200 rounded text-xs cursor-pointer"
                        >
                          标记待沟通
                        </button>

                        <button
                          onClick={() => {
                            setReplyingComment(cmt);
                            setReplyAction('rejected');
                            setReplyText(cmt.authorReply || '');
                          }}
                          className="px-2.5 py-1 text-slate-600 hover:bg-slate-100 border border-slate-300 rounded text-xs cursor-pointer"
                        >
                          拒绝并说明理由
                        </button>

                        <button
                          onClick={() => {
                            setReplyingComment(cmt);
                            setReplyAction('accepted_pending_implementation');
                            setReplyText(cmt.authorReply || '主笔研判决定采纳此方向，待后续统筹落实篇幅');
                          }}
                          className="px-2.5 py-1 bg-blue-50 text-blue-800 hover:bg-blue-100 border border-blue-200 rounded text-xs font-medium cursor-pointer"
                        >
                          决定采纳 (待落实)
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </div>

        {/* Right: Document Reference Snapshot */}
        <div className="col-span-12 lg:col-span-5 bg-white rounded-lg border border-slate-200 shadow-2xs p-5 space-y-4">
          <div className="flex items-center justify-between pb-2 border-b border-slate-100">
            <span className="font-bold text-xs text-slate-800">当前审阅基准稿件预览</span>
            <span className="text-[11px] text-slate-500 font-mono">{currentDraft?.versionNumber}</span>
          </div>

          <div className="space-y-4 max-h-[600px] overflow-y-auto pr-1">
            {currentDraft?.blocks.map((block) => (
              <div key={block.id} className="p-3 rounded bg-slate-50 border border-slate-200/80 text-xs space-y-1">
                <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                  <span>第{block.order}段 (ID: {block.id})</span>
                  <span>{block.referencedFactIds.length}项事实关联</span>
                </div>
                <p className="text-slate-800 leading-relaxed text-justify indent-6">{block.content}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Add Comment Modal */}
      {showAddCommentModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="font-bold text-sm text-slate-800">提出审阅意见 / 批注</h3>
              <button
                onClick={() => setShowAddCommentModal(false)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <form onSubmit={handleAddComment} className="p-5 space-y-3 text-xs">
              <div className="space-y-1">
                <label className="font-semibold text-slate-700">意见类型</label>
                <div className="flex gap-3">
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="radio"
                      name="cmtType"
                      checked={commentType === 'overall'}
                      onChange={() => setCommentType('overall')}
                    />
                    <span>全局整体意见</span>
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="radio"
                      name="cmtType"
                      checked={commentType === 'paragraph'}
                      onChange={() => setCommentType('paragraph')}
                    />
                    <span>按段落批注</span>
                  </label>
                </div>
              </div>

              {commentType === 'paragraph' && (
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700">目标段落</label>
                  <select
                    value={selectedBlockId}
                    onChange={(e) => setSelectedBlockId(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded bg-white"
                  >
                    {currentDraft?.blocks.map((b) => (
                      <option key={b.id} value={b.id}>
                        第{b.order}段：{b.content.slice(0, 24)}...
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">意见与评价说明</label>
                <textarea
                  rows={3}
                  placeholder="详细描述具体的修改意见..."
                  value={newCommentContent}
                  onChange={(e) => setNewCommentContent(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">建议修改方向或文本建议 (可选)</label>
                <input
                  type="text"
                  placeholder="例如：精简措辞，保留16场、800人次"
                  value={newCommentSuggestion}
                  onChange={(e) => setNewCommentSuggestion(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddCommentModal(false)}
                  className="px-3 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded font-medium shadow-xs cursor-pointer"
                >
                  提交审阅意见
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Author General Reply / Strategy Decision Modal */}
      {replyingComment && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="font-bold text-sm text-slate-800">研判处理意见：{replyingComment.reviewer}</h3>
              <button
                onClick={() => setReplyingComment(null)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <form onSubmit={handleApplyDecisionOnly} className="p-5 space-y-3 text-xs">
              <div className="p-3 bg-slate-50 rounded border border-slate-200 text-slate-700">
                “{replyingComment.content}”
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">处理决定</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setReplyAction('accepted_pending_implementation')}
                    className={`flex-1 py-1.5 rounded border text-xs font-medium cursor-pointer ${
                      replyAction === 'accepted_pending_implementation'
                        ? 'bg-blue-50 border-blue-500 text-blue-800'
                        : 'border-slate-300 text-slate-600'
                    }`}
                  >
                    决定采纳 (待落实)
                  </button>
                  <button
                    type="button"
                    onClick={() => setReplyAction('need_discussion')}
                    className={`flex-1 py-1.5 rounded border text-xs font-medium cursor-pointer ${
                      replyAction === 'need_discussion'
                        ? 'bg-purple-50 border-purple-500 text-purple-800'
                        : 'border-slate-300 text-slate-600'
                    }`}
                  >
                    待进一步沟通
                  </button>
                  <button
                    type="button"
                    onClick={() => setReplyAction('rejected')}
                    className={`flex-1 py-1.5 rounded border text-xs font-medium cursor-pointer ${
                      replyAction === 'rejected'
                        ? 'bg-slate-200 border-slate-400 text-slate-800'
                        : 'border-slate-300 text-slate-600'
                    }`}
                  >
                    拒绝并说明
                  </button>
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">主笔回复/处理理由说明</label>
                <textarea
                  rows={3}
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="说明采纳方向、或不予采纳的业务依据..."
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setReplyingComment(null)}
                  className="px-3 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded font-medium shadow-xs cursor-pointer"
                >
                  确认处理决定
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Requirement 5: Text Revision Comparison & Implementation Modal */}
      {implementingComment && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-emerald-50 flex items-center justify-between">
              <h3 className="font-bold text-sm text-emerald-900 flex items-center gap-1.5">
                <Edit3 className="w-4 h-4 text-emerald-600" />
                采纳审阅修改：对比原文并落实写入正文
              </h3>
              <button
                onClick={() => setImplementingComment(null)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <form onSubmit={handleConfirmImplementText} className="p-5 space-y-4 text-xs">
              <div className="p-3 bg-slate-50 border border-slate-200 rounded space-y-1">
                <div className="font-bold text-slate-800 flex justify-between">
                  <span>来自【{implementingComment.reviewer}】的审阅建议</span>
                  <span className="text-[11px] text-slate-400 font-mono">基准版本: {implementingComment.targetVersionId}</span>
                </div>
                <p className="text-slate-700">“{implementingComment.content}”</p>
                {implementingComment.suggestedChange && (
                  <p className="text-blue-700 font-medium pt-1 border-t border-slate-200/60">
                    建议方向：{implementingComment.suggestedChange}
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">落实目标段落：</label>
                <select
                  value={implTargetBlockId}
                  onChange={(e) => {
                    setImplTargetBlockId(e.target.value);
                    const b = currentDraft?.blocks.find((blk) => blk.id === e.target.value);
                    if (b) setImplOriginalText(b.content);
                  }}
                  className="w-full p-2 border border-slate-300 rounded bg-white"
                >
                  {currentDraft?.blocks.map((b) => (
                    <option key={b.id} value={b.id}>
                      第{b.order}段 ({b.id})：{b.content.slice(0, 30)}...
                    </option>
                  ))}
                </select>
              </div>

              {/* Side-by-side comparison */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <span className="font-semibold text-slate-700 block">当前段落原文（修订前）：</span>
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded text-slate-700 leading-relaxed min-h-[100px] text-justify indent-6">
                    {implOriginalText}
                  </div>
                </div>

                <div className="space-y-1">
                  <span className="font-semibold text-slate-700 block">修改后段落正文（可微调）：</span>
                  <textarea
                    rows={5}
                    value={implSuggestedText}
                    onChange={(e) => setImplSuggestedText(e.target.value)}
                    className="w-full p-2.5 border border-emerald-300 rounded focus:ring-1 focus:ring-emerald-500 bg-emerald-50/20 text-slate-800 leading-relaxed text-justify indent-6"
                    required
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">主笔落实回复与归档记录：</label>
                <input
                  type="text"
                  value={implAuthorReply}
                  onChange={(e) => setImplAuthorReply(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setImplementingComment(null)}
                  className="px-3 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded font-bold shadow-xs cursor-pointer flex items-center gap-1"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>确认修改并生成新版本</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Requirement 6: Contradiction Modal differentiating "决定策略" and "已落实" */}
      {showContradictionModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-xl w-full border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-amber-50 flex items-center justify-between">
              <h3 className="font-bold text-sm text-amber-900 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                裁决篇幅意见冲突：压缩篇幅 vs 增补案例
              </h3>
              <button
                onClick={() => setShowContradictionModal(false)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <div className="space-y-2">
                <div className="p-3 bg-slate-50 border border-slate-200 rounded">
                  <strong>审阅乙要求：</strong>面向主要领导，建议压缩到2000字以内，精简铺垫。
                </div>
                <div className="p-3 bg-slate-50 border border-slate-200 rounded">
                  <strong>审阅丁要求：</strong>增加两个详细案例以丰富成效，展现亮点。
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">请选择协调策略：</label>
                <div className="space-y-2">
                  <label
                    onClick={() => setSelectedStrategy('balanced')}
                    className={`block p-3 rounded border cursor-pointer ${
                      selectedStrategy === 'balanced'
                        ? 'border-blue-700 bg-blue-50 ring-1 ring-blue-700'
                        : 'border-slate-200'
                    }`}
                  >
                    <div className="font-bold text-slate-800">折中平衡策略（推荐）</div>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      精炼铺垫修饰语，以紧凑提炼短句融入调研成效案例，控制在2500字左右。
                    </p>
                  </label>

                  <label
                    onClick={() => setSelectedStrategy('compress_priority')}
                    className={`block p-3 rounded border cursor-pointer ${
                      selectedStrategy === 'compress_priority'
                        ? 'border-blue-700 bg-blue-50 ring-1 ring-blue-700'
                        : 'border-slate-200'
                    }`}
                  >
                    <div className="font-bold text-slate-800">优先遵循压缩要求</div>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      严格压减字数至2000字内，将案例置于附件或口头汇报，不入主稿。
                    </p>
                  </label>

                  <label
                    onClick={() => setSelectedStrategy('case_priority')}
                    className={`block p-3 rounded border cursor-pointer ${
                      selectedStrategy === 'case_priority'
                        ? 'border-blue-700 bg-blue-50 ring-1 ring-blue-700'
                        : 'border-slate-200'
                    }`}
                  >
                    <div className="font-bold text-slate-800">优先充实典型案例</div>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      完整展开两个工作推进典型案例，篇幅适度放宽至3200字。
                    </p>
                  </label>
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">主笔协调裁决理由：</label>
                <textarea
                  rows={2}
                  value={strategyReason}
                  onChange={(e) => setStrategyReason(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                />
              </div>

              {/* Requirement 5: Live Diff Preview for coordination */}
              {currentCoordinationDiff && (
                <div className="space-y-2 p-3 bg-slate-50 border border-slate-200 rounded">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-800">协调效果差异预览（基于当前稿计算）：</span>
                    <span className="text-[11px] text-slate-500 font-mono">
                      篇幅变动：{currentCoordinationDiff.originalWordCount}字 → {currentCoordinationDiff.targetWordCount}字
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-600">{currentCoordinationDiff.strategyExplanation}</p>
                  
                  {currentCoordinationDiff.diffPreview.length > 0 ? (
                    <div className="space-y-2 pt-2 border-t border-slate-200 max-h-40 overflow-y-auto">
                      {currentCoordinationDiff.diffPreview.map((diff, idx) => (
                        <div key={idx} className="p-2 bg-white rounded border border-slate-200 space-y-1">
                          <div className="text-[10px] text-slate-500 font-semibold">变更段落：{diff.blockId}</div>
                          <div className="text-rose-700 bg-rose-50/50 p-1 rounded text-[11px] line-through">
                            {diff.originalText}
                          </div>
                          <div className="text-emerald-700 bg-emerald-50/50 p-1 rounded text-[11px] font-medium">
                            {diff.proposedText}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-amber-700 bg-amber-50 p-2 rounded text-[11px]">
                      当前策略未对正文产生实质文本差异（无差异不能标已落实）。
                    </div>
                  )}

                  {!currentCoordinationDiff.hasRealCaseMaterial && selectedStrategy !== 'compress_priority' && (
                    <div className="text-amber-800 bg-amber-50/80 p-2 rounded border border-amber-200 text-[11px] flex items-start gap-1">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                      <span>资料库中尚无已登记的本期典型案例，正文已插入待补材料占位符，严禁虚构案例。</span>
                    </div>
                  )}
                </div>
              )}

              <div className="pt-3 border-t border-slate-200 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowContradictionModal(false)}
                  className="px-3 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => handleResolveContradiction('strategy_only')}
                  className="px-3.5 py-1.5 bg-blue-50 text-blue-800 hover:bg-blue-100 border border-blue-200 rounded font-semibold cursor-pointer"
                  title="仅确定裁决策略与说明，状态记为待落实"
                >
                  确定裁决策略 (待落实)
                </button>
                <button
                  type="button"
                  onClick={() => handleResolveContradiction('implement_now')}
                  className="px-4 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded font-bold shadow-xs cursor-pointer"
                  title="执行正文段落压缩调整并生成新版本，标记为已落实"
                >
                  确认策略并落实到正文
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
