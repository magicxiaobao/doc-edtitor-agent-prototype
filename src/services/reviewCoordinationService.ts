import { 
  Task, 
  DraftVersion, 
  ParagraphBlock, 
  UserRole, 
  CoordinationStrategy, 
  CoordinationDiffResult,
  EvidenceSnippet,
  ReviewComment,
  ReviewCommentStatus
} from '../types';
import { applyDraftContentChange } from './draftLifecycleService';
import { checkPermission } from './permissionService';

/**
 * Validates whether a snippet is an authentic, approved case material for the current task.
 * - MUST be from current_fact documents
 * - Filters out historical style materials (2025)
 * - Filters out textless RAG clues (EVD-06 / 无原文 / 问答摘要)
 * - Filters out "无案例说明" / "暂无案例" (negative disclaimers cannot masquerade as cases!)
 * - Avoids any hallucination!
 */
export function isValidAuthenticCase(task: Task, snip: EvidenceSnippet): boolean {
  if (!snip || !snip.sourceDocId) return false;
  const doc = task.documents.find((d) => d.id === snip.sourceDocId);
  if (!doc) return false;

  // Filter out historical style reference and RAG clues
  if (doc.usage !== 'current_fact') return false;
  if (doc.period.includes('2025') || snip.period?.includes('2025')) return false;
  if (snip.id === 'EVD-06' || snip.location === '无原文' || snip.location?.includes('线索') || snip.location?.includes('摘要')) {
    return false;
  }

  // "无案例说明不冒充案例": negative statements indicating lack of cases MUST NOT be treated as authentic cases!
  const negativePatterns = ['暂无案例', '无典型案例', '无案例说明', '缺少案例', '未提供案例', '暂无典型', '无具体推进案例', '尚无案例', '无案例'];
  if (negativePatterns.some((np) => snip.text.includes(np) || snip.docName.includes(np) || doc.name.includes(np))) {
    return false;
  }

  const caseKeywords = ['典型案例', '推进案例', '具体案例', '典型做法', '对策专报', '工作专报', '示范点', '试点', '点位', '调研成果'];
  const hasKeyword = caseKeywords.some((kw) => snip.text.includes(kw) || snip.docName.includes(kw) || doc.name.includes(kw));
  if (!hasKeyword) return false;

  // Must have substantial descriptive text (> 15 chars)
  if (snip.text.trim().length < 15) return false;

  return true;
}

/**
 * Retrieves all authentic approved case candidates from task materials.
 */
export function getAuthenticCaseCandidates(task: Task): EvidenceSnippet[] {
  return task.snippets.filter((s) => isValidAuthenticCase(task, s));
}

/**
 * Searches task materials and snippets for authentic case/example materials.
 * If selectedCaseId is specified, uses that approved case; otherwise searches authentic registered snippets.
 */
export function findAuthenticCaseSnippet(task: Task, selectedCaseId?: string): EvidenceSnippet | undefined {
  if (selectedCaseId) {
    const matched = task.snippets.find((s) => s.id === selectedCaseId);
    if (matched && isValidAuthenticCase(task, matched)) {
      return matched;
    }
  }

  const candidates = getAuthenticCaseCandidates(task);
  if (candidates.length > 0) {
    return candidates[0];
  }

  return undefined;
}

/**
 * Requirement 5: Review Coordination Service
 * - Generates draft candidate diff preview for author inspection.
 * - Strategy affects word count and contents.
 * - When supplementing cases: selects REAL case material from registered snippets.
 * - If NO case material exists, outputs explicit 【待补案例材料:...】 placeholder.
 * - NEVER fabricates 128 / 12 / 2026 or fake case stories!
 */
export function generateCoordinationDiff(
  task: Task,
  draft: DraftVersion,
  strategy: CoordinationStrategy
): CoordinationDiffResult {
  const originalBlocks = JSON.parse(JSON.stringify(draft.blocks)) as ParagraphBlock[];
  const originalWordCount = originalBlocks.reduce((acc, b) => acc + b.content.length, 0);

  const realCaseSnippet = findAuthenticCaseSnippet(task);
  const hasRealCaseMaterial = !!realCaseSnippet;

  let candidateBlocks: ParagraphBlock[] = [];
  let strategyExplanation = '';
  let targetWordCount = originalWordCount;

  if (strategy === 'compress') {
    strategyExplanation = '采纳审阅乙压缩意见：精简第一部分铺垫表述与泛泛修饰词，突出核心数据指标。';
    candidateBlocks = originalBlocks.map((b, idx) => {
      if (idx === 0) {
        // Streamline paragraph 1
        let text = b.content;
        text = text.replace(/围绕高质量发展主线，统筹推进各项重点业务工作，/g, '统筹推进重点工作，');
        text = text.replace(/紧紧围绕年度核心工作目标，强化统筹联动与机制创新。/g, '强化统筹联动与机制创新。');
        text = text.replace(/在.*良好开局的基础上，/g, '');
        return { ...b, content: text, updatedAt: new Date().toISOString() };
      }
      return b;
    });
    targetWordCount = candidateBlocks.reduce((acc, b) => acc + b.content.length, 0);
  } else if (strategy === 'expand_case') {
    strategyExplanation = '采纳审阅丁增补案例意见：在调研与业务推进后增补实际推进案例。';
    candidateBlocks = originalBlocks.map((b, idx) => {
      // Find paragraph discussing survey or implementation (order 3 or last accomplishment block)
      if (idx === 2 || (idx === originalBlocks.length - 2 && idx > 0)) {
        if (hasRealCaseMaterial && realCaseSnippet) {
          const addition = `【典型案例推进】结合${realCaseSnippet.docName}调研成果，${realCaseSnippet.text.replace(/^.*?：/, '')}，有效推动了一线业务流程实质性改进。`;
          return {
            ...b,
            content: `${b.content} ${addition}`,
            updatedAt: new Date().toISOString(),
          };
        } else {
          // NO REAL CASE EXISTS -> Strictly mark as pending, NO HALLUCINATIONS!
          const addition = `【待补案例材料：当前资料库中无已登记的本期典型推进案例（历史文风参考材料不可作为本期案例），需业务科室补传材料后再行补充，严禁虚构数据】`;
          return {
            ...b,
            content: `${b.content} ${addition}`,
            updatedAt: new Date().toISOString(),
          };
        }
      }
      return b;
    });
    targetWordCount = candidateBlocks.reduce((acc, b) => acc + b.content.length, 0);
  } else {
    // balanced
    strategyExplanation = '统筹协调折中方案：精简开头铺垫修饰，并在调研段落紧凑嵌入案例（有真实材料则嵌入，无材料则标待补）。';
    candidateBlocks = originalBlocks.map((b, idx) => {
      if (idx === 0) {
        let text = b.content;
        text = text.replace(/围绕高质量发展主线，统筹推进各项重点业务工作，/g, '统筹推进重点工作，');
        text = text.replace(/紧紧围绕年度核心工作目标，强化统筹联动与机制创新。/g, '强化统筹联动与机制创新。');
        return { ...b, content: text, updatedAt: new Date().toISOString() };
      }
      if (idx === 2) {
        if (hasRealCaseMaterial && realCaseSnippet) {
          const addition = `【典型案例】${realCaseSnippet.text.replace(/^.*?：/, '')}。`;
          return { ...b, content: `${b.content} ${addition}`, updatedAt: new Date().toISOString() };
        } else {
          const addition = `【待补案例材料：当前资料库中无已登记的本期典型推进案例（历史文风参考材料不可作为本期案例），需业务科室补传材料后再行补充，严禁虚构数据】`;
          return { ...b, content: `${b.content} ${addition}`, updatedAt: new Date().toISOString() };
        }
      }
      return b;
    });
    targetWordCount = candidateBlocks.reduce((acc, b) => acc + b.content.length, 0);
  }

  // Generate diff preview
  const diffPreview: { blockId: string; originalText: string; proposedText: string }[] = [];
  candidateBlocks.forEach((cb, idx) => {
    const ob = originalBlocks[idx];
    if (ob && ob.content !== cb.content) {
      diffPreview.push({
        blockId: cb.id,
        originalText: ob.content,
        proposedText: cb.content,
      });
    }
  });

  return {
    strategy,
    baseDraftId: draft.id,
    baseContentHash: `HASH-${draft.id}-${originalWordCount}`,
    createdAt: new Date().toISOString(),
    originalWordCount,
    targetWordCount,
    strategyExplanation,
    candidateBlocks,
    diffPreview,
    hasRealCaseMaterial,
    selectedCaseSnippet: realCaseSnippet,
  };
}

/**
 * Requirement 5: Applies the author-confirmed coordination decision to the draft
 * and marks comments as implemented.
 * - Validates that diffPreview is not empty (无差异不能标已落实)
 * - Validates that candidate target blocks have not been edited in the meantime (防误覆盖人工编辑)
 */
export function applyCoordinationDecision(
  task: Task,
  draftId: string,
  coordinationResult: CoordinationDiffResult,
  authorRole: UserRole,
  relatedCommentIds: string[]
): { updatedTask: Task; workingDraft: DraftVersion } {
  // 1. Zero difference check: 无差异不能标已落实
  if (!coordinationResult.diffPreview || coordinationResult.diffPreview.length === 0) {
    throw new Error('未检测到正文文本差异（零差异），不能标记审阅意见为已落实！');
  }

  let currentDraft: DraftVersion | undefined;
  if (draftId) {
    currentDraft = task.drafts.find((d) => d.id === draftId);
    if (!currentDraft) {
      throw new Error(`未找到指定版本【${draftId}】，无法落实审阅协调意见！`);
    }
  } else {
    currentDraft = task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];
    if (!currentDraft) {
      throw new Error('未找到当前工作草稿，无法落实审阅协调意见');
    }
  }

  // 1b. Draft version alignment check
  if (coordinationResult.baseDraftId && coordinationResult.baseDraftId !== currentDraft.id) {
    throw new Error(
      `协调建议基于历史版本【${coordinationResult.baseDraftId}】生成，无法直接应用到当前不同版本【${currentDraft.id}】！请重新针对当前稿生成协调预览。`
    );
  }

  // 2. Outdated candidate conflict check: 协调候选过期不能覆盖人工编辑
  for (const diff of coordinationResult.diffPreview) {
    const targetBlock = currentDraft.blocks.find((b) => b.id === diff.blockId);
    if (!targetBlock) {
      throw new Error(`协调建议目标段落【${diff.blockId}】在当前稿件中已被删除或重构，建议已失效！`);
    }
    if (targetBlock.content !== diff.originalText) {
      throw new Error(
        `采纳冲突：检测到目标段落自协调生成后已被人工编辑修改，基准内容已变动。为防止直接覆盖人工文本，协调建议已失效，请重新生成协调预览！`
      );
    }
  }

  // Build a map of approved modifications from diffPreview
  const diffMap = new Map<string, string>();
  for (const diff of coordinationResult.diffPreview) {
    diffMap.set(diff.blockId, diff.proposedText);
  }

  // Apply changes via draftLifecycleService:
  // Strictly merges only the diff changes into the latest working draft,
  // completely protecting manual edits in unrelated blocks (e.g. BLK-02)
  const { updatedTask: taskWithNewDraft, workingDraft } = applyDraftContentChange(
    task,
    draftId,
    (blocks) =>
      blocks.map((b) => {
        if (diffMap.has(b.id)) {
          return {
            ...b,
            content: diffMap.get(b.id)!,
            updatedAt: new Date().toISOString(),
          };
        }
        return b;
      }),
    `落实审阅意见协调（${coordinationResult.strategyExplanation}）`,
    authorRole
  );

  // Update related review comments to 'implemented'
  const updatedComments = taskWithNewDraft.reviewComments.map((cmt) => {
    if (relatedCommentIds.includes(cmt.id)) {
      return {
        ...cmt,
        status: 'implemented' as const,
        authorReply: `主笔已协调决断：${coordinationResult.strategyExplanation}`,
        decisionReason: coordinationResult.strategyExplanation,
        resolutionType: 'strategy_decided' as const,
        implementationDraftId: workingDraft.id,
        implementationBlockId: coordinationResult.diffPreview[0]?.blockId,
      };
    }
    return cmt;
  });

  const finalTask: Task = {
    ...taskWithNewDraft,
    reviewComments: updatedComments,
    updatedAt: new Date().toISOString(),
  };

  return { updatedTask: finalTask, workingDraft };
}

export interface ReviewCommentLocationResult {
  isLocated: boolean;
  targetBlock?: ParagraphBlock;
  warning?: string;
  isOutdatedVersion?: boolean;
}

/**
 * Requirement 1 & 2: Resolves paragraph comment location against current draft blocks.
 * - MUST look up strictly by stable targetBlockId.
 * - If targetBlockId was deleted/removed, strictly returns isLocated: false with warning "定位需复核",
 *   NEVER incorrectly maps to another block with the same order index!
 */
export function getReviewCommentLocation(
  comment: ReviewComment,
  draft: DraftVersion
): ReviewCommentLocationResult {
  if (comment.type === 'overall') {
    return { isLocated: true };
  }

  if (!comment.targetBlockId) {
    return {
      isLocated: false,
      warning: '定位需复核：意见未关联具体目标段落。',
    };
  }

  // MUST look up strictly by stable ID, NEVER fallback to same array index!
  const block = draft.blocks.find((b) => b.id === comment.targetBlockId);
  if (!block) {
    return {
      isLocated: false,
      warning: '定位需复核：原目标段落已在正文中删除或合并，不可匹配至其他段落，需人工复核指定新段落。',
    };
  }

  // If found, check if version or base text changed
  const isOutdatedVersion = Boolean(comment.targetVersionId && comment.targetVersionId !== draft.id);
  if (comment.baseParagraphText && comment.baseParagraphText !== block.content) {
    return {
      isLocated: true,
      targetBlock: block,
      isOutdatedVersion,
      warning: '当前段落正文自意见提出后已有修改（提出时原文与当前内容不同）。',
    };
  }

  return {
    isLocated: true,
    targetBlock: block,
    isOutdatedVersion,
  };
}

/**
 * Adopts and implements a review comment by directly applying the author's modification
 * to the target block in the current draft.
 * - Enforces role permission (only 主笔甲 can implement review comments).
 * - Modifies ONLY the target block in the draft.
 * - Updates ONLY the target comment (status: 'implemented', resolutionType: 'text_modified').
 * - Preserves all other comments in their existing statuses without closing them!
 */
export function implementReviewCommentWithText(
  task: Task,
  commentId: string,
  draftId: string,
  updatedContent: string,
  authorReply: string,
  activeRole: UserRole,
  options?: {
    expectedBaseContent?: string;
  }
): { updatedTask: Task; workingDraft: DraftVersion; implementedComment: ReviewComment } {
  const perm = checkPermission(activeRole, 'resolve_comment');
  if (!perm.allowed) {
    throw new Error(perm.reason || '权限受限：仅主笔甲可采纳落实审阅意见');
  }

  const comment = task.reviewComments.find((c) => c.id === commentId);
  if (!comment) {
    throw new Error(`未找到指定审阅意见【${commentId}】！`);
  }

  let currentDraft: DraftVersion | undefined;
  if (draftId) {
    currentDraft = task.drafts.find((d) => d.id === draftId);
    if (!currentDraft) {
      throw new Error(`未找到指定版本【${draftId}】！`);
    }
  } else {
    currentDraft = task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];
    if (!currentDraft) {
      throw new Error('当前任务尚无正文草稿');
    }
  }

  // Determine target block
  const targetBlockId = comment.targetBlockId;
  if (!targetBlockId) {
    throw new Error('该意见属于整稿综合意见，请在正文具体段落中针对性落实，或通过审阅协调处理。');
  }

  const targetBlock = currentDraft.blocks.find((b) => b.id === targetBlockId);
  if (!targetBlock) {
    throw new Error(`意见目标段落【${targetBlockId}】在当前稿件中已被删除或重构，定位需复核！`);
  }

  // Base content conflict check if expectedBaseContent is passed
  if (options?.expectedBaseContent && targetBlock.content !== options.expectedBaseContent) {
    throw new Error('采纳冲突：检测到目标段落自建议生成后已被人工编辑修改，基准内容已变动。为防止直接覆盖人工文本，建议已失效，请重新生成建议。');
  }

  // Check that text actually changes (zero diff cannot be marked implemented)
  const isZeroDiff = targetBlock.content.trim() === updatedContent.trim();
  if (isZeroDiff) {
    throw new Error('未检测到正文文本差异（建议文本与段落当前正文完全相同），不能标记审阅意见为已落实！');
  }

  const { updatedTask: taskWithNewDraft, workingDraft } = applyDraftContentChange(
    task,
    draftId,
    (blocks) =>
      blocks.map((b) =>
        b.id === targetBlockId
          ? { ...b, content: updatedContent.trim(), updatedAt: new Date().toISOString() }
          : b
      ),
    `落实【${comment.reviewer}】意见（${comment.content.slice(0, 20)}...）`,
    activeRole
  );

  let updatedCommentObj: ReviewComment | undefined;

  // CRITICAL RULE: Updates ONLY the specified comment! Other comments remain completely unchanged!
  const updatedComments = taskWithNewDraft.reviewComments.map((cmt) => {
    if (cmt.id === commentId) {
      updatedCommentObj = {
        ...cmt,
        status: 'implemented' as const,
        authorReply: authorReply.trim() || `主笔已采纳落实意见并更新第${targetBlock.order}段正文。`,
        decisionReason: authorReply.trim() || cmt.decisionReason,
        resolutionType: 'text_modified' as const,
        implementationDraftId: workingDraft.id,
        implementationVersionNumber: workingDraft.versionNumber,
        implementationBlockId: targetBlockId,
        implementedAt: new Date().toISOString(),
      };
      return updatedCommentObj;
    }
    return cmt;
  });

  const finalTask: Task = {
    ...taskWithNewDraft,
    reviewComments: updatedComments,
    updatedAt: new Date().toISOString(),
  };

  return {
    updatedTask: finalTask,
    workingDraft,
    implementedComment: updatedCommentObj!,
  };
}

/**
 * Updates review comment decision without directly changing text:
 * - 'accepted_pending_implementation': Records author agreement, but keeps status as 'accepted_pending_implementation' (still blocks finalization!).
 * - 'rejected': Rejection requires reason, marks 'rejected'.
 * - 'need_discussion': Marks 'need_discussion' (still blocks finalization!).
 */
export function updateReviewCommentDecision(
  task: Task,
  commentId: string,
  status: 'accepted_pending_implementation' | 'rejected' | 'need_discussion',
  reasonOrReply: string,
  activeRole: UserRole
): { updatedTask: Task; updatedComment: ReviewComment } {
  const perm = checkPermission(activeRole, 'resolve_comment');
  if (!perm.allowed) {
    throw new Error(perm.reason || '权限受限：仅主笔甲可处理审阅意见决定');
  }

  const comment = task.reviewComments.find((c) => c.id === commentId);
  if (!comment) {
    throw new Error(`未找到指定审阅意见【${commentId}】！`);
  }

  if (status === 'rejected' && !reasonOrReply.trim()) {
    throw new Error('拒绝审阅意见必须填写具体业务理由（随公文版本存证归档）！');
  }

  let updatedCommentObj: ReviewComment | undefined;

  const updatedComments = task.reviewComments.map((cmt) => {
    if (cmt.id === commentId) {
      updatedCommentObj = {
        ...cmt,
        status,
        authorReply: reasonOrReply.trim() || (status === 'accepted_pending_implementation' ? '主笔决定采纳，待后续统筹落实' : '主笔已登记沟通'),
        decisionReason: reasonOrReply.trim(),
        resolutionType:
          status === 'accepted_pending_implementation'
            ? ('strategy_decided' as const)
            : status === 'rejected'
            ? ('rejected' as const)
            : ('communicated' as const),
      };
      return updatedCommentObj;
    }
    return cmt;
  });

  const updatedTask: Task = {
    ...task,
    reviewComments: updatedComments,
    updatedAt: new Date().toISOString(),
  };

  return { updatedTask, updatedComment: updatedCommentObj! };
}

/**
 * Relocates a review comment whose original paragraph was deleted or shifted to a new target block.
 */
export function rebindReviewCommentTargetBlock(
  task: Task,
  commentId: string,
  newBlockId: string,
  activeRole: UserRole
): { updatedTask: Task; updatedComment: ReviewComment } {
  const perm = checkPermission(activeRole, 'resolve_comment');
  if (!perm.allowed) {
    throw new Error(perm.reason || '权限受限：仅主笔甲可重新指定意见目标段落');
  }

  const comment = task.reviewComments.find((c) => c.id === commentId);
  if (!comment) {
    throw new Error(`未找到指定审阅意见【${commentId}】！`);
  }

  const currentDraft = task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];
  const newBlock = currentDraft?.blocks.find((b) => b.id === newBlockId);
  if (!newBlock) {
    throw new Error(`指定的新段落【${newBlockId}】不存在！`);
  }

  let updatedCommentObj: ReviewComment | undefined;
  const updatedComments = task.reviewComments.map((cmt) => {
    if (cmt.id === commentId) {
      updatedCommentObj = {
        ...cmt,
        type: 'paragraph' as const,
        targetBlockId: newBlock.id,
        targetBlockOrder: newBlock.order,
        baseParagraphText: newBlock.content,
        locationOutdated: false,
      };
      return updatedCommentObj;
    }
    return cmt;
  });

  const updatedTask: Task = {
    ...task,
    reviewComments: updatedComments,
    updatedAt: new Date().toISOString(),
  };

  return { updatedTask, updatedComment: updatedCommentObj! };
}

