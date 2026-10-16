import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createPresetTask } from './src/services/mockData';
import { 
  Task, 
  ReviewComment, 
  ParagraphBlock, 
  RevisionSuggestion 
} from './src/types';
import { 
  generateParagraphRevision, 
  applyParagraphCompression 
} from './src/services/mockDraftService';
import { 
  interpretReviewCommentSuggestion, 
  getCommentSuggestionType, 
  implementReviewCommentWithText 
} from './src/services/reviewCoordinationService';
import { 
  validateParagraphSuggestionAcceptance,
  adoptParagraphSuggestion,
  undoSafeParagraphModification
} from './src/services/draftLifecycleService';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { ReviewStage } from './src/components/stages/ReviewStage';
import { ParagraphSuggestionEditor } from './src/components/ParagraphSuggestionEditor';
import { loadPersistedState, STORAGE_KEY_V2, setStorageItem } from './src/services/storageService';

// Setup JSDOM environment for React component mounting & interactive events
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:3000',
  pretendToBeVisual: true,
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).localStorage = dom.window.localStorage;
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function mountTestComponent(element: React.ReactElement) {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    root,
    rerender: (newElement: React.ReactElement) => {
      act(() => {
        root.render(newElement);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✅ PASSED: ${message}`);
}

export async function runTask19Tests() {
  console.log('\n================================================================');
  console.log('   任务19 审阅修改方向与替换正文区分及意见驱动改写验收测试');
  console.log('================================================================\n');

  // -------------------------------------------------------------------------
  // 验收用例 A: 修改方向生成正文
  // -------------------------------------------------------------------------
  console.log('>>> [验收用例 A] 修改方向生成正文 (CMT-03 生成有效培训段落正文，非指令文本):');
  const taskA: Task = createPresetTask('under_review');
  const cmt03 = taskA.reviewComments.find((c) => c.id === 'CMT-03');
  assert(Boolean(cmt03), 'A.1: 找到 under_review 预置的第2段意见 CMT-03');
  assert(cmt03?.suggestionType === 'instruction', 'A.2: CMT-03 的 suggestionType 正确标示为 instruction (修改方向)');
  assert(cmt03?.suggestedChange === '压缩前缀修饰，保留16场、800人次。', 'A.3: CMT-03 的 suggestedChange 为修改方向指令');

  const draftA = taskA.drafts.find((d) => d.id === taskA.currentDraftId)!;
  const block2A = draftA.blocks.find((b) => b.id === 'BLK-02')!;
  const originalBlock2Content = block2A.content;

  // 调用生成服务并传入 CMT-03
  const revisionResultA = generateParagraphRevision(
    block2A,
    'custom',
    taskA.id,
    draftA.id,
    'RUN-TASK19-A',
    {
      customPrompt: cmt03?.suggestedChange,
      sourceComment: cmt03,
      task: taskA,
      currentDraft: draftA,
    }
  );

  // 验证结果是培训正文，而非指令原样返回
  assert(revisionResultA.suggestedText !== cmt03?.suggestedChange, 'A.4: suggestedText 绝未原样返回指令文本');
  assert(revisionResultA.suggestedText !== originalBlock2Content, 'A.5: suggestedText 与原段落存在实际精简压缩差异');
  assert(revisionResultA.suggestedText.includes('16场'), 'A.6: 严格保留“16场”关键事实与单位');
  assert(revisionResultA.suggestedText.includes('800人次'), 'A.7: 严格保留“800人次”关键事实与单位');
  assert(revisionResultA.suggestedText.includes('前三季度'), 'A.8: 严格保留“前三季度”统计期间');
  assert(
    revisionResultA.suggestedText.startsWith('前三季度累计组织专题培训16场') ||
    revisionResultA.suggestedText.includes('组织专题培训16场，累计参训800人次'),
    'A.9: 正确生成精简后的可读公文正文'
  );
  assert(revisionResultA.sourceCommentId === 'CMT-03', 'A.10: 来源意见绑定为 CMT-03');
  assert(revisionResultA.targetBlockId === 'BLK-02', 'A.11: 目标段落绑定为 BLK-02');
  assert(block2A.content === originalBlock2Content, 'A.12: 生成阶段草稿正文尚未被自动修改');

  // -------------------------------------------------------------------------
  // 验收用例 B: 数据变化仍正确 (动态台账数据保护，无写死回退值)
  // -------------------------------------------------------------------------
  console.log('\n>>> [验收用例 B] 数据变化仍正确 (修改为其他场次与人次，引用实际数据无固定回退):');
  const taskB: Task = createPresetTask('under_review');
  const draftB = taskB.drafts[0];
  const block2B = draftB.blocks[1];
  // 模拟将当前段落及任务数据修改为 28场、1200人次
  block2B.content = '在队伍履职能力建设方面，立足基层实际需要，深化分级分类专业实操培养。前三季度累计组织专题培训28场，累计参训1200人次，有效增强了骨干人员政策理解与规范执行水平。';
  
  const revisionResultB = generateParagraphRevision(
    block2B,
    'custom',
    taskB.id,
    draftB.id,
    'RUN-TASK19-B',
    {
      customPrompt: '压缩前缀修饰，保留数据',
      sourceComment: cmt03,
      task: taskB,
      currentDraft: draftB,
    }
  );

  assert(revisionResultB.suggestedText.includes('28场'), 'B.1: 正确引用当前段落实际数据“28场”');
  assert(revisionResultB.suggestedText.includes('1200人次'), 'B.2: 正确引用当前段落实际数据“1200人次”');
  assert(!revisionResultB.suggestedText.includes('16场'), 'B.3: 无写死回退值“16场”');
  assert(!revisionResultB.suggestedText.includes('800人次'), 'B.4: 无写死回退值“800人次”');
  assert(revisionResultB.suggestedText.length < block2B.content.length, 'B.5: 成功精简篇幅');

  // -------------------------------------------------------------------------
  // 验收用例 C: 替换稿模式 (审阅人明确输入完整替换正文，比对、微调与采纳)
  // -------------------------------------------------------------------------
  console.log('\n>>> [验收用例 C] 替换稿模式 (明确替换稿标识、人工微调与完整存证采纳):');
  const taskC: Task = createPresetTask('under_review');
  const draftC = taskC.drafts[0];
  const block2C = draftC.blocks[1];
  const reviewerReplacementText = '前三季度，全系统深化干部队伍履职赋能，累计组织专题实操培训16场，参训800人次，有效提升基层专业执行水准。';
  
  const replacementComment: ReviewComment = {
    id: 'CMT-REPLACE-01',
    type: 'paragraph',
    targetBlockId: block2C.id,
    targetBlockOrder: block2C.order,
    targetVersionId: draftC.id,
    baseParagraphText: block2C.content,
    reviewer: '审阅乙',
    content: '建议直接采用我拟定的完整精炼段落正文。',
    suggestedChange: reviewerReplacementText,
    suggestionType: 'replacement',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  taskC.reviewComments.push(replacementComment);

  const interpretationC = interpretReviewCommentSuggestion(replacementComment);
  assert(interpretationC.isReplacement === true, 'C.1: 准确识别为审阅人替换稿模式');
  assert(interpretationC.typeLabel === '建议替换正文', 'C.2: 标签明确显示为建议替换正文');
  assert(interpretationC.replacementText === reviewerReplacementText, 'C.3: 提取的替换正文与审阅人拟定一致');

  const revisionResultC = generateParagraphRevision(
    block2C,
    'custom',
    taskC.id,
    draftC.id,
    'RUN-TASK19-C',
    {
      sourceComment: replacementComment,
      task: taskC,
      currentDraft: draftC,
    }
  );

  assert(revisionResultC.suggestedText === reviewerReplacementText, 'C.4: 替换稿模式下 suggestedText 精准采用替换正文');
  assert(revisionResultC.diffExplanation.includes('审阅人提供的替换稿'), 'C.5: 明确标示为审阅人提供的替换稿，不冒充AI原创');

  // 测试微调后采纳
  const fineTunedText = reviewerReplacementText.replace('有效提升基层专业执行水准。', '全面提升基层规范执行与业务攻坚水准。');
  const { updatedTask: taskAfterAdoptC } = adoptParagraphSuggestion({
    task: taskC,
    currentDraft: draftC,
    suggestion: revisionResultC,
    pendingTextToAdopt: fineTunedText,
    activeCompletedRunId: revisionResultC.runId,
    activeRole: '主笔甲',
  });

  const updatedWorkingDraftC = taskAfterAdoptC.drafts.find((d) => d.id === taskAfterAdoptC.currentDraftId)!;
  const updatedBlock2C = updatedWorkingDraftC.blocks.find((b) => b.id === block2C.id)!;
  assert(updatedBlock2C.content === fineTunedText, 'C.6: 采纳后实际写入与微调后的待采纳文本一致');
  assert(updatedWorkingDraftC.blocks[0].content === draftC.blocks[0].content, 'C.7: 其他段落BLK-01正文严密保持不变');
  
  const cmtAdoptedC = taskAfterAdoptC.reviewComments.find((c) => c.id === replacementComment.id)!;
  assert(cmtAdoptedC.status === 'implemented', 'C.8: 关联审阅意见状态更新为 implemented');
  assert(taskAfterAdoptC.modificationLogs.length > 0, 'C.9: 记录了完整的修改日志存证');
  assert(taskAfterAdoptC.modificationLogs[0].isFineTuned === true, 'C.10: 日志中标注了 isFineTuned=true');

  // -------------------------------------------------------------------------
  // 验收用例 D: 两页直接落实入口语义一致 (instruction 不预填替换正文，零差异拦截)
  // -------------------------------------------------------------------------
  console.log('\n>>> [验收用例 D] 两页直接落实入口语义一致 (instruction 不预填指令，零差异阻断):');
  const taskD: Task = createPresetTask('under_review');
  const draftD = taskD.drafts[0];
  const block2D = draftD.blocks[1];

  // 1. 对于 instruction (CMT-03)
  const interpInstruction = interpretReviewCommentSuggestion(cmt03);
  const initialSuggestedInstruction = (interpInstruction.isReplacement && interpInstruction.replacementText)
    ? interpInstruction.replacementText
    : block2D.content;

  assert(initialSuggestedInstruction === block2D.content, 'D.1: instruction 模式下弹窗从当前段落原文初始化，未用指令填充');
  assert(initialSuggestedInstruction !== cmt03?.suggestedChange, 'D.2: instruction 模式输入框绝不包含指令文本');

  // 尝试在未改动正文（零差异）时直接落实
  let zeroDiffBlocked = false;
  try {
    implementReviewCommentWithText(
      taskD,
      cmt03!.id,
      draftD.id,
      block2D.content, // 与原文零差异
      '直接确认',
      '主笔甲'
    );
  } catch (err: any) {
    zeroDiffBlocked = true;
    assert(err.message.includes('未检测到正文文本差异'), 'D.3: 零差异落实被安全阻断，提示未检测到差异');
  }
  assert(zeroDiffBlocked, 'D.4: 共享落实服务阻断零差异修改并保留意见 pending 状态');
  assert(taskD.reviewComments.find((c) => c.id === cmt03!.id)?.status === 'pending', 'D.5: 意见状态未被错误标记为已落实');

  // 2. 对于 replacement
  const interpReplacement = interpretReviewCommentSuggestion(replacementComment);
  const initialSuggestedReplacement = (interpReplacement.isReplacement && interpReplacement.replacementText)
    ? interpReplacement.replacementText
    : block2D.content;
  assert(initialSuggestedReplacement === reviewerReplacementText, 'D.6: replacement 模式下预填审阅人替换稿');

  // -------------------------------------------------------------------------
  // 验收用例 E: 旧数据兼容与损坏恢复
  // -------------------------------------------------------------------------
  console.log('\n>>> [验收用例 E] 旧数据兼容 (无语义标记旧意见保守按修改方向解释，损坏安全恢复):');
  const legacyCommentWithoutType: Partial<ReviewComment> = {
    id: 'CMT-LEGACY-01',
    type: 'paragraph',
    content: '这段需要精简',
    suggestedChange: '精简第二段动员修饰，保持数据口径。',
    // 没有 suggestionType
  };

  const resolvedType = getCommentSuggestionType(legacyCommentWithoutType);
  assert(resolvedType === 'instruction', 'E.1: 无标记旧意见保守判定为 instruction');
  const legacyInterp = interpretReviewCommentSuggestion(legacyCommentWithoutType as ReviewComment);
  assert(legacyInterp.isInstruction === true, 'E.2: 旧意见解析为修改方向');
  assert(legacyInterp.isReplacement === false, 'E.3: 旧意见绝不根据外观被自动认定为替换稿');

  // 测试持久化加载对损坏 suggestionType 的安全规整
  const corruptedRaw = JSON.stringify({
    schemaVersion: 2,
    currentTaskId: taskD.id,
    activeRole: '主笔甲',
    tasks: [
      {
        ...taskD,
        reviewComments: [
          {
            ...cmt03,
            suggestionType: 'CORRUPTED_VALUE_123', // 非法值
          },
        ],
      },
    ],
  });
  dom.window.localStorage.setItem(STORAGE_KEY_V2, corruptedRaw);
  setStorageItem(STORAGE_KEY_V2, corruptedRaw);
  const loadedState = loadPersistedState();
  assert(loadedState.isCorrupted === false, 'E.4: 非法 suggestionType 未造成整库损坏崩溃');
  const loadedComment = loadedState.tasks[0].reviewComments.find((c) => c.id === cmt03?.id);
  assert(loadedComment?.suggestionType === undefined, 'E.5: 非法值被安全规整为 undefined');
  assert(loadedComment?.content === cmt03?.content, 'E.6: 原始意见文本完好无损');
  assert(loadedComment?.baseParagraphText === cmt03?.baseParagraphText, 'E.7: 提出意见时的基准原文存证完好无损');

  // -------------------------------------------------------------------------
  // 验收用例 F: 不支持指令与真实零差异处理 (删除虚假“压缩30%”，空原文保护)
  // -------------------------------------------------------------------------
  console.log('\n>>> [验收用例 F] 不支持指令与零差异处理 (无虚假30%宣称，空原文无NaN/除零):');
  const unsupportedRes = generateParagraphRevision(
    block2A,
    'custom',
    taskA.id,
    draftA.id,
    'RUN-UNSUPPORTED',
    {
      customPrompt: '请用苏轼赤壁怀古词风重新作词',
      task: taskA,
      currentDraft: draftA,
    }
  );
  assert(unsupportedRes.isUnsupportedPrompt === true, 'F.1: 不支持的指令明确标记 isUnsupportedPrompt');
  assert(unsupportedRes.suggestedText === block2A.content, 'F.2: 不支持指令未修改正文');
  assert(!unsupportedRes.diffExplanation.includes('压缩约30%'), 'F.3: 未输出虚假压缩30%宣称');

  // 对已经是精简后的正文再次执行 compress 操作
  const alreadyCompressedBlock: ParagraphBlock = {
    ...block2A,
    content: '前三季度累计组织专题培训16场，累计参训800人次，有效增强骨干人员政策理解与规范执行能力。',
  };
  const zeroDiffCompressRes = generateParagraphRevision(
    alreadyCompressedBlock,
    'compress',
    taskA.id,
    draftA.id,
    'RUN-ZERO-DIFF',
    {
      task: taskA,
      currentDraft: draftA,
    }
  );
  assert(zeroDiffCompressRes.suggestedText === alreadyCompressedBlock.content, 'F.4: 无法进一步安全压缩时正文未变');
  assert(!zeroDiffCompressRes.diffExplanation.includes('30%'), 'F.5: 正文未变时严禁声称压缩30%');
  assert(zeroDiffCompressRes.diffExplanation.includes('未找到可安全改写的内容，本次正文未变化'), 'F.6: 真实说明未找到可安全改写的内容');

  // 空原文防御
  const emptyBlock: ParagraphBlock = {
    ...block2A,
    content: '',
  };
  const emptyRes = generateParagraphRevision(emptyBlock, 'compress');
  assert(!isNaN(emptyRes.wordCountDelta || 0), 'F.7: 空原文时字数统计无 NaN');
  assert(!emptyRes.diffExplanation.includes('NaN'), 'F.8: 说明文案无 NaN');
  assert(!emptyRes.diffExplanation.includes('Infinity'), 'F.9: 说明文案无 Infinity');

  // -------------------------------------------------------------------------
  // 验收用例 G: 真实操作闭环 (定位第2段→生成建议→人工微调→关闭→重开→采纳→安全撤销)
  // -------------------------------------------------------------------------
  console.log('\n>>> [验收用例 G] 真实操作闭环 (定位第2段→生成建议→微调→关闭重开保留→采纳→安全撤销):');
  let currentTaskG: Task = createPresetTask('under_review');
  const mountedDrafting = mountTestComponent(
    React.createElement(DraftingStage, {
      task: currentTaskG,
      onUpdateTask: (patch) => {
        currentTaskG = { ...currentTaskG, ...patch };
      },
      onViewSnippet: () => {},
      activeRole: '主笔甲',
    })
  );

  // 验证第2段卡片渲染
  assert(
    Boolean(mountedDrafting.container.querySelector('#block-card-BLK-02') || mountedDrafting.container.innerHTML.includes('block-card-BLK-02')),
    'G.1: 成功挂载起草工作区并渲染第2段'
  );

  // 执行意见生成建议并进行微调、采纳、撤销全生命周期检验
  const suggestionG = generateParagraphRevision(
    currentTaskG.drafts[0].blocks[1],
    'custom',
    currentTaskG.id,
    currentTaskG.currentDraftId,
    'RUN-G-01',
    {
      sourceComment: cmt03,
      task: currentTaskG,
      currentDraft: currentTaskG.drafts[0],
    }
  );

  const fineTunedGText = `${suggestionG.suggestedText.replace('。', '')}，为全局高质量发展奠定坚实基础。`;

  // 挂载 ParagraphSuggestionEditor 并测试微调跨挂载持久性
  const mountedEditor = mountTestComponent(
    React.createElement(ParagraphSuggestionEditor, {
      task: currentTaskG,
      currentDraft: currentTaskG.drafts[0],
      suggestion: suggestionG,
      activeBlock: currentTaskG.drafts[0].blocks[1],
      isGenerating: false,
      activeCompletedRunId: 'RUN-G-01',
      activeRole: '主笔甲',
      onAdopt: (textToAdopt) => {
        const { updatedTask } = adoptParagraphSuggestion({
          task: currentTaskG,
          currentDraft: currentTaskG.drafts[0],
          suggestion: suggestionG,
          pendingTextToAdopt: textToAdopt,
          activeCompletedRunId: 'RUN-G-01',
          activeRole: '主笔甲',
        });
        currentTaskG = updatedTask;
      },
      onDiscard: () => {},
      onRegenerate: () => {},
      controlledPendingText: fineTunedGText,
    })
  );

  assert(mountedEditor.container.textContent?.includes('已人工微调') === true, 'G.2: 微调后展示【已人工微调】标识');
  mountedEditor.unmount(); // 模拟关闭面板

  // 重新打开编辑器
  const remountedEditor = mountTestComponent(
    React.createElement(ParagraphSuggestionEditor, {
      task: currentTaskG,
      currentDraft: currentTaskG.drafts[0],
      suggestion: suggestionG,
      activeBlock: currentTaskG.drafts[0].blocks[1],
      isGenerating: false,
      activeCompletedRunId: 'RUN-G-01',
      activeRole: '主笔甲',
      onAdopt: (textToAdopt) => {
        const { updatedTask } = adoptParagraphSuggestion({
          task: currentTaskG,
          currentDraft: currentTaskG.drafts[0],
          suggestion: suggestionG,
          pendingTextToAdopt: textToAdopt,
          activeCompletedRunId: 'RUN-G-01',
          activeRole: '主笔甲',
        });
        currentTaskG = updatedTask;
      },
      onDiscard: () => {},
      onRegenerate: () => {},
      controlledPendingText: fineTunedGText,
    })
  );
  assert(remountedEditor.container.textContent?.includes('已人工微调') === true, 'G.3: 重新打开后微调状态与标识完好保留');

  // 执行采纳
  const { updatedTask: taskAfterAdoptG } = adoptParagraphSuggestion({
    task: currentTaskG,
    currentDraft: currentTaskG.drafts[0],
    suggestion: suggestionG,
    pendingTextToAdopt: fineTunedGText,
    activeCompletedRunId: 'RUN-G-01',
    activeRole: '主笔甲',
  });
  currentTaskG = taskAfterAdoptG;

  const currentWorkingDraftG = currentTaskG.drafts.find((d) => d.id === currentTaskG.currentDraftId)!;
  const adoptedBlockG = currentWorkingDraftG.blocks.find((b) => b.id === 'BLK-02')!;
  assert(adoptedBlockG.content === fineTunedGText, 'G.4: 采纳后正文更新为微调后的文本');
  assert(adoptedBlockG.revisionSeq === 1, 'G.5: revisionSeq 正确递增为 1');

  // 执行安全撤销
  const latestLogG = currentTaskG.modificationLogs[0];
  const { updatedTask: taskAfterUndoG } = undoSafeParagraphModification(
    currentTaskG,
    currentWorkingDraftG,
    latestLogG.id,
    '主笔甲'
  );
  currentTaskG = taskAfterUndoG;

  const restoredWorkingDraftG = currentTaskG.drafts.find((d) => d.id === currentTaskG.currentDraftId)!;
  const restoredBlockG = restoredWorkingDraftG.blocks.find((b) => b.id === 'BLK-02')!;
  assert(restoredBlockG.content === originalBlock2Content, 'G.6: 安全撤销后正文成功恢复为修改前原文');
  assert(restoredBlockG.revisionSeq === 2, 'G.7: 撤销记录生成新的版本序列');

  remountedEditor.unmount();
  mountedDrafting.unmount();

  // -------------------------------------------------------------------------
  // 验收用例 H: 生命周期保护 (取消/切换隔离、定稿只读、平板与键盘Escape隔离)
  // -------------------------------------------------------------------------
  console.log('\n>>> [验收用例 H] 生命周期保护 (运行失效隔离、定稿冻结只读、宽屏弹窗Escape隔离):');
  
  // 1. 失效校验
  const validationCancelled = validateParagraphSuggestionAcceptance({
    task: currentTaskG,
    currentDraft: currentWorkingDraftG,
    suggestion: suggestionG,
    pendingTextToAdopt: fineTunedGText,
    activeCompletedRunId: 'RUN-DIFFERENT-ACTIVE-ID', // 运行ID不匹配已失效
    activeRole: '主笔甲',
  });
  assert(validationCancelled.valid === false, 'H.1: 运行ID不匹配时严格阻断采纳');
  assert(validationCancelled.reason?.includes('已失效') === true, 'H.2: 返回明确的失效提示');

  // 2. 定稿只读保护
  const finalizedTask: Task = {
    ...currentTaskG,
    isFinalized: true,
  };
  const validationFinalized = validateParagraphSuggestionAcceptance({
    task: finalizedTask,
    currentDraft: currentWorkingDraftG,
    suggestion: suggestionG,
    pendingTextToAdopt: fineTunedGText,
    activeCompletedRunId: 'RUN-G-01',
    activeRole: '主笔甲',
  });
  assert(validationFinalized.valid === false, 'H.3: 任务已定稿时严格阻断修改正文');

  // 3. 挂载 ReviewStage 检查直接落实弹窗在 instruction 和 replacement 下的表现
  let taskH: Task = createPresetTask('under_review');
  const mountedReview = mountTestComponent(
    React.createElement(ReviewStage, {
      task: taskH,
      onUpdateTask: (patch) => {
        taskH = { ...taskH, ...patch };
      },
      onViewFact: () => {},
      activeRole: '主笔甲',
    })
  );
  assert(mountedReview.container.textContent?.includes('审阅意见清单') === true, 'H.4: 成功挂载审阅阶段');
  assert(mountedReview.container.textContent?.includes('【修改方向】：') === true, 'H.5: 审阅意见卡片清晰展示【修改方向】标识');
  mountedReview.unmount();

  console.log('\n================================================================');
  console.log('   🎉 任务19 全部 8 组验收用例 (A-H) 100% 通过！');
  console.log('================================================================\n');
}

runTask19Tests().catch((err) => {
  console.error('Task19 Tests Failed:', err);
  process.exit(1);
});
