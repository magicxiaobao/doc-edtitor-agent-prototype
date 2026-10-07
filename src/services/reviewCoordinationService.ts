import { 
  Task, 
  DraftVersion, 
  ParagraphBlock, 
  UserRole, 
  CoordinationStrategy, 
  CoordinationDiffResult,
  EvidenceSnippet 
} from '../types';
import { applyDraftContentChange } from './draftLifecycleService';

/**
 * Searches task materials and snippets for authentic case/example materials.
 * Avoids any hallucination!
 */
export function findAuthenticCaseSnippet(task: Task): EvidenceSnippet | undefined {
  const caseKeywords = ['典型案例', '推进案例', '具体案例', '典型做法', '对策专报', '工作专报', '示范点', '试点', '点位'];
  
  for (const snip of task.snippets) {
    if (caseKeywords.some((kw) => snip.text.includes(kw) || snip.docName.includes(kw))) {
      return snip;
    }
  }

  // Also check document contents if snippet isn't explicitly segmented
  for (const doc of task.documents) {
    if (doc.usage === 'current_fact' && caseKeywords.some((kw) => doc.content.includes(kw) || doc.name.includes(kw))) {
      return {
        id: `EVD-DOC-${doc.id}`,
        sourceDocId: doc.id,
        docName: doc.name,
        location: '正文材料',
        period: doc.period,
        text: doc.content.slice(0, 80) + '...',
      };
    }
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
          const addition = `【待补案例材料：当前资料库中无已登记的典型推进案例，需业务科室补传材料后再行补充，严禁虚构数据】`;
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
        let text = b.content.replace(/围绕高质量发展主线，统筹推进各项重点业务工作，/g, '统筹推进重点工作，');
        return { ...b, content: text, updatedAt: new Date().toISOString() };
      }
      if (idx === 2) {
        if (hasRealCaseMaterial && realCaseSnippet) {
          const addition = `【典型案例】${realCaseSnippet.text.replace(/^.*?：/, '')}。`;
          return { ...b, content: `${b.content} ${addition}`, updatedAt: new Date().toISOString() };
        } else {
          const addition = `【待补案例材料：当前资料库中无已登记的典型推进案例，需业务科室补传材料后再行补充，严禁虚构数据】`;
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
 */
export function applyCoordinationDecision(
  task: Task,
  draftId: string,
  coordinationResult: CoordinationDiffResult,
  authorRole: UserRole,
  relatedCommentIds: string[]
): { updatedTask: Task; workingDraft: DraftVersion } {
  // Apply changes via draftLifecycleService (safely forks immutable snapshots if needed)
  const { updatedTask: taskWithNewDraft, workingDraft } = applyDraftContentChange(
    task,
    draftId,
    () => coordinationResult.candidateBlocks,
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
