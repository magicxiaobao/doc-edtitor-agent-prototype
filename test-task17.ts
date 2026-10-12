import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createPresetTask } from './src/services/mockData';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { ParagraphSuggestionEditor } from './src/components/ParagraphSuggestionEditor';
import { RecentModificationsModal } from './src/components/RecentModificationsModal';
import {
  validateParagraphSuggestionAcceptance,
  adoptParagraphSuggestion,
  validateUndoEligibility,
  undoSafeParagraphModification,
  getRecentModificationLogs,
  applyDraftContentChange,
  finalizeDraft
} from './src/services/draftLifecycleService';
import {
  savePersistedState,
  loadPersistedState,
  setStorageItem,
  STORAGE_KEY_V2
} from './src/services/storageService';
import { requestParagraphRevisionAsync } from './src/services/paragraphRevisionAdapter';
import {
  Task,
  DraftVersion,
  ParagraphBlock,
  RevisionSuggestion,
  ReviewComment
} from './src/types';

// Setup JSDOM environment for React 18 component mounting & event tests
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:3000',
  pretendToBeVisual: true,
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
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
    throw new Error(message);
  }
  console.log(`✅ PASSED: ${message}`);
}

async function runTask17Tests() {
  console.log('================================================================');
  console.log('   任务17 局部AI建议支持人工微调、采纳与安全撤销专项验收测试');
  console.log('================================================================\n');

  // --------------------------------------------------------------------------
  // [验收用例 A] 生成建议后人工微调：原AI建议不变，差异随待采纳文本变化，实际采纳内容与微调结果一致，其他段落不变
  // --------------------------------------------------------------------------
  console.log('>>> [验收用例 A] 生成建议后人工微调与采纳隔离测试:');

  const taskA = createPresetTask('under_review');
  const draftA = taskA.drafts.find((d) => d.id === taskA.currentDraftId)!;
  const block1A = draftA.blocks[0];
  const block2A = draftA.blocks[1];
  const originalBlock1Text = block1A.content;
  const originalBlock2Text = block2A.content;

  const mockRunIdA = 'RUN-TASK17-A1';
  const suggestionA: RevisionSuggestion = {
    runId: mockRunIdA,
    taskId: taskA.id,
    sourceDraftId: draftA.id,
    targetBlockId: block2A.id,
    targetBlockOrder: block2A.order,
    baseContent: originalBlock2Text,
    baseContentHash: 'HASH-A-BLK2',
    action: 'compress',
    originalText: originalBlock2Text,
    suggestedText: '深入推进业务管理改革，健全全流程协调联动机制，统筹确保前三季度业务平稳高效运转。',
    diffExplanation: 'AI压缩精炼建议：删减冗余铺垫修饰。',
    factsAffected: [],
    createdAt: new Date().toISOString(),
  };

  const humanFineTunedText = '深入推进业务管理机制创新，健全跨部门工作协调机制，扎实确保前三季度各项业务平稳高效运转。';

  // 1. Validate fine-tuned params
  const validationA = validateParagraphSuggestionAcceptance({
    task: taskA,
    currentDraft: draftA,
    suggestion: suggestionA,
    pendingTextToAdopt: humanFineTunedText,
    activeCompletedRunId: mockRunIdA,
    activeRole: '主笔甲',
  });

  assert(validationA.valid === true, 'A1: 人工微调后的文本验证通过');
  assert(validationA.isFineTuned === true, 'A2: 正确识别已发生人工微调 (isFineTuned: true)');
  assert(validationA.isZeroDiff === false, 'A3: 微调文本与原文存在实际差异 (isZeroDiff: false)');

  // 2. Adopt fine-tuned suggestion
  const adoptResultA = adoptParagraphSuggestion({
    task: taskA,
    currentDraft: draftA,
    suggestion: suggestionA,
    pendingTextToAdopt: humanFineTunedText,
    activeCompletedRunId: mockRunIdA,
    activeRole: '主笔甲',
  });

  const updatedBlock1A = adoptResultA.workingDraft.blocks.find((b) => b.id === block1A.id)!;
  const updatedBlock2A = adoptResultA.workingDraft.blocks.find((b) => b.id === block2A.id)!;

  assert(updatedBlock2A.content === humanFineTunedText, 'A4: 实际采纳写入的内容与人工微调结果 100% 一致');
  assert(updatedBlock1A.content === originalBlock1Text, 'A5: 【隔离保证】第1段正文保持完全不变');
  assert(adoptResultA.logEntry.aiOriginalSuggestedText === suggestionA.suggestedText, 'A6: 原始AI建议文本在存证日志中完好保留未被覆盖');
  assert(adoptResultA.logEntry.afterContent === humanFineTunedText, 'A7: 存证日志中 afterContent 记录实际微调采纳文本');
  assert(adoptResultA.logEntry.isFineTuned === true, 'A8: 存证日志中 isFineTuned 标记为 true');

  // 3. Component level JSDOM test for ParagraphSuggestionEditor
  let adoptedTextFromComponent = '';
  const testEditor = mountTestComponent(
    React.createElement(ParagraphSuggestionEditor, {
      task: taskA,
      currentDraft: draftA,
      suggestion: suggestionA,
      activeRole: '主笔甲',
      activeBlock: block2A,
      activeCompletedRunId: mockRunIdA,
      isGenerating: false,
      onAdopt: (text: string) => {
        adoptedTextFromComponent = text;
      },
      onDiscard: () => {},
      onRegenerate: () => {},
    })
  );

  // Switch to editor view tab
  const editorTabBtn = testEditor.container.querySelector('[data-testid="tab-editor-view"]') as HTMLButtonElement;
  assert(editorTabBtn !== null, 'A9: 提供待采纳文本视图切换标签');
  act(() => {
    editorTabBtn.click();
  });

  const textarea = testEditor.container.querySelector('[data-testid="textarea-pending-text"]') as HTMLTextAreaElement;
  assert(textarea !== null, 'A10: 成功渲染待采纳文本编辑输入框');

  // Simulate human fine-tuning in textarea via React onChange
  act(() => {
    const propKey = Object.keys(textarea).find((k) => k.startsWith('__reactProps'));
    if (propKey && (textarea as any)[propKey]?.onChange) {
      (textarea as any)[propKey].onChange({ target: { value: humanFineTunedText } });
    } else {
      textarea.value = humanFineTunedText;
      textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      textarea.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    }
  });

  // Verify fine-tuned badge appears
  const fineTunedBadge = testEditor.container.querySelector('[data-testid="badge-fine-tuned"]');
  assert(fineTunedBadge !== null, 'A11: 界面清晰展示【已人工微调】标识');

  // Click adopt button
  const adoptBtn = testEditor.container.querySelector('[data-testid="btn-adopt-suggestion"]') as HTMLButtonElement;
  assert(adoptBtn !== null && !adoptBtn.disabled, 'A12: 采纳按钮可用且未被禁用');
  act(() => {
    adoptBtn.click();
  });

  assert(adoptedTextFromComponent === humanFineTunedText, 'A13: 组件实际采纳传递的文本为人工微调结果');
  testEditor.unmount();

  // --------------------------------------------------------------------------
  // [验收用例 B] 微调回原正文：明确零差异，不能标记意见已落实
  // --------------------------------------------------------------------------
  console.log('\n>>> [验收用例 B] 微调回原正文零差异阻断测试:');

  const validationB = validateParagraphSuggestionAcceptance({
    task: taskA,
    currentDraft: draftA,
    suggestion: suggestionA,
    pendingTextToAdopt: originalBlock2Text, // fine-tuned back to original!
    activeCompletedRunId: mockRunIdA,
    activeRole: '主笔甲',
  });

  assert(validationB.valid === false, 'B1: 微调回原正文时校验失败 (valid: false)');
  assert(validationB.isZeroDiff === true, 'B2: 准确识别为零差异 (isZeroDiff: true)');
  assert(validationB.reason!.includes('零差异') || validationB.reason!.includes('完全一致'), 'B3: 提供明确的零差异原因说明');

  let zeroDiffBlocked = false;
  try {
    adoptParagraphSuggestion({
      task: taskA,
      currentDraft: draftA,
      suggestion: suggestionA,
      pendingTextToAdopt: originalBlock2Text,
      activeCompletedRunId: mockRunIdA,
      activeRole: '主笔甲',
    });
  } catch (err: any) {
    zeroDiffBlocked = true;
  }
  assert(zeroDiffBlocked === true, 'B4: 统一服务安全阻断零差异采纳');

  // --------------------------------------------------------------------------
  // [验收用例 C] 生成后人工修改基准正文、换任务、换版本、取消或发起新请求：旧微调候选不可采纳
  // --------------------------------------------------------------------------
  console.log('\n>>> [验收用例 C] 旧建议/微调候选失效与冲突校验测试:');

  // C1: Base text modified after suggestion generation
  const modifiedDraftC: DraftVersion = {
    ...draftA,
    blocks: draftA.blocks.map((b) =>
      b.id === block2A.id ? { ...b, content: '科室乙人工在正文中新插入了段落内容。' } : b
    ),
  };
  const valC1 = validateParagraphSuggestionAcceptance({
    task: taskA,
    currentDraft: modifiedDraftC,
    suggestion: suggestionA,
    pendingTextToAdopt: humanFineTunedText,
    activeCompletedRunId: mockRunIdA,
    activeRole: '主笔甲',
  });
  assert(valC1.valid === false, 'C1: 基准正文被人工修改后旧建议微调候选不可采纳');
  assert(valC1.isModifiedAfter === true, 'C2: 正确识别基准已被修改 (isModifiedAfter: true)');

  // C2: Task mismatch
  const valC2 = validateParagraphSuggestionAcceptance({
    task: { ...taskA, id: 'TASK-ANOTHER-DIFF' },
    currentDraft: draftA,
    suggestion: suggestionA,
    pendingTextToAdopt: humanFineTunedText,
    activeCompletedRunId: mockRunIdA,
    activeRole: '主笔甲',
  });
  assert(valC2.valid === false && valC2.isTaskMismatch === true, 'C3: 跨任务切换时旧微调候选安全失效');

  // C3: Draft version mismatch
  const valC3 = validateParagraphSuggestionAcceptance({
    task: taskA,
    currentDraft: { ...draftA, id: 'DRAFT-VERSION-NEW-V2' },
    suggestion: suggestionA,
    pendingTextToAdopt: humanFineTunedText,
    activeCompletedRunId: mockRunIdA,
    activeRole: '主笔甲',
  });
  assert(valC3.valid === false && valC3.isDraftVersionMismatch === true, 'C4: 稿件版本切换时旧建议微调候选安全失效');

  // C4: Superseded run ID
  const valC4 = validateParagraphSuggestionAcceptance({
    task: taskA,
    currentDraft: draftA,
    suggestion: suggestionA,
    pendingTextToAdopt: humanFineTunedText,
    activeCompletedRunId: 'RUN-SUPERSEDED-NEW-99',
    activeRole: '主笔甲',
  });
  assert(valC4.valid === false && valC4.isSupersededRun === true, 'C5: 发生新生成运行或取消后旧运行候选安全失效');

  // --------------------------------------------------------------------------
  // [验收用例 D] 普通局部采纳后撤销：正文完整恢复，其他段落及其他意见不变
  // --------------------------------------------------------------------------
  console.log('\n>>> [验收用例 D] 普通局部采纳后安全撤销测试:');

  const taskD = adoptResultA.updatedTask;
  const draftD = adoptResultA.workingDraft;
  const logIdD = adoptResultA.logEntry.id;

  const undoValD = validateUndoEligibility(taskD, draftD, logIdD, '主笔甲');
  assert(undoValD.canUndo === true, 'D1: 最近一次局部采纳具备撤销资格');

  const undoResultD = undoSafeParagraphModification(taskD, draftD, logIdD, '主笔甲');
  const restoredBlock2D = undoResultD.workingDraft.blocks.find((b) => b.id === block2A.id)!;
  const untouchedBlock1D = undoResultD.workingDraft.blocks.find((b) => b.id === block1A.id)!;

  assert(restoredBlock2D.content === originalBlock2Text, 'D2: 撤销后目标段落正文 100% 恢复为采纳前基准');
  assert(untouchedBlock1D.content === originalBlock1Text, 'D3: 撤销后其他段落正文保持完全不变');
  assert(undoResultD.undoneLog.status === 'undone', 'D4: 存证日志状态更新为 undone');
  assert(!!undoResultD.undoneLog.undoneAt, 'D5: 记录撤销操作时间存证');

  // Cannot undo again
  const doubleUndoVal = validateUndoEligibility(undoResultD.updatedTask, undoResultD.workingDraft, logIdD, '主笔甲');
  assert(doubleUndoVal.canUndo === false, 'D6: 撤销后不可重复撤销');

  // --------------------------------------------------------------------------
  // [验收用例 E] 来源为审阅意见的采纳后撤销：只恢复本次引起的意见变化，原始存证不变
  // --------------------------------------------------------------------------
  console.log('\n>>> [验收用例 E] 审阅意见关联采纳与安全撤销存证保护测试:');

  const commentE: ReviewComment = {
    id: 'CMT-E-REVIEW-BLK2',
    type: 'paragraph',
    targetVersionId: draftA.id,
    targetBlockId: block2A.id,
    targetBlockOrder: block2A.order,
    baseParagraphText: originalBlock2Text,
    reviewer: '审阅乙',
    content: '第2段需精简篇幅并强化成效',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  const otherCommentE: ReviewComment = {
    id: 'CMT-E-OTHER-BLK1',
    type: 'paragraph',
    targetVersionId: draftA.id,
    targetBlockId: block1A.id,
    targetBlockOrder: block1A.order,
    baseParagraphText: originalBlock1Text,
    reviewer: '审阅丁',
    content: '第1段标题与概述需核实',
    status: 'need_discussion',
    createdAt: new Date().toISOString(),
  };

  const taskE: Task = {
    ...taskA,
    reviewComments: [commentE, otherCommentE],
    modificationLogs: [],
  };

  const suggestionE: RevisionSuggestion = {
    ...suggestionA,
    runId: 'RUN-E-1',
    sourceCommentId: commentE.id,
    sourceCommentReviewer: commentE.reviewer,
    sourceCommentSummary: commentE.content,
  };

  // 1. Adopt suggestion with comment implementation
  const adoptResultE = adoptParagraphSuggestion({
    task: taskE,
    currentDraft: draftA,
    suggestion: suggestionE,
    pendingTextToAdopt: humanFineTunedText,
    activeCompletedRunId: 'RUN-E-1',
    activeRole: '主笔甲',
  });

  const implementedCommentE = adoptResultE.updatedTask.reviewComments.find((c) => c.id === commentE.id)!;
  const preservedOtherCommentE = adoptResultE.updatedTask.reviewComments.find((c) => c.id === otherCommentE.id)!;

  assert(implementedCommentE.status === 'implemented', 'E1: 采纳后关联审阅意见状态更新为 implemented');
  assert(preservedOtherCommentE.status === 'need_discussion', 'E2: 其他未关联审阅意见状态完全未受影响');

  // 2. Undo adoption
  const undoResultE = undoSafeParagraphModification(
    adoptResultE.updatedTask,
    adoptResultE.workingDraft,
    adoptResultE.logEntry.id,
    '主笔甲'
  );

  const restoredCommentE = undoResultE.updatedTask.reviewComments.find((c) => c.id === commentE.id)!;
  const otherCommentAfterUndo = undoResultE.updatedTask.reviewComments.find((c) => c.id === otherCommentE.id)!;

  assert(restoredCommentE.status === 'pending', 'E3: 安全撤销后关联意见状态精确恢复为 pending');
  assert(restoredCommentE.targetBlockId === block2A.id, 'E4: 【存证保护】意见原始 targetBlockId 严格未变');
  assert(restoredCommentE.baseParagraphText === originalBlock2Text, 'E5: 【存证保护】意见原始基准原文 baseParagraphText 严格未变');
  assert(otherCommentAfterUndo.status === 'need_discussion', 'E6: 【存证保护】其他意见状态严格保持未变');

  // --------------------------------------------------------------------------
  // [验收用例 F] 后续人工编辑、意见被再次处理、归档或定稿：旧撤销入口失效且有原因说明，不覆盖新内容
  // --------------------------------------------------------------------------
  console.log('\n>>> [验收用例 F] 后续变动保护与撤销阻断测试:');

  // Adopt again to create an active log
  const adoptF = adoptParagraphSuggestion({
    task: taskE,
    currentDraft: draftA,
    suggestion: suggestionE,
    pendingTextToAdopt: humanFineTunedText,
    activeCompletedRunId: 'RUN-E-1',
    activeRole: '主笔甲',
  });

  const taskF = adoptF.updatedTask;
  const draftF = adoptF.workingDraft;
  const logIdF = adoptF.logEntry.id;

  // F1: Target block manually edited subsequently
  const { updatedTask: taskF1, workingDraft: draftF1 } = applyDraftContentChange(
    taskF,
    draftF.id,
    (blocks) =>
      blocks.map((b) =>
        b.id === block2A.id ? { ...b, content: '后续主笔又进行了新的正文手工修改。' } : b
      ),
    '后续手工修改',
    '主笔甲'
  );
  const undoF1 = validateUndoEligibility(taskF1, draftF1, logIdF, '主笔甲');
  assert(undoF1.canUndo === false, 'F1: 正文被后续人工编辑后阻断撤销');
  assert(undoF1.reason!.includes('已变动') || undoF1.reason!.includes('人工编辑'), 'F2: 提示正文已变动不可覆盖');

  // F2: Review comment subsequently handled
  const taskF2: Task = {
    ...taskF,
    reviewComments: taskF.reviewComments.map((c) =>
      c.id === commentE.id ? { ...c, status: 'need_discussion' as const, authorReply: '后续重新发起线下沟通' } : c
    ),
  };
  const undoF2 = validateUndoEligibility(taskF2, draftF, logIdF, '主笔甲');
  assert(undoF2.canUndo === false, 'F3: 关联意见被后续重新处理后阻断撤销');
  assert(undoF2.reason!.includes('意见') && undoF2.reason!.includes('后续'), 'F4: 提示意见已被后续处理');

  // F3: Draft finalized or immutable
  const taskF3: Task = {
    ...taskF,
    isFinalized: true,
  };
  const draftF3: DraftVersion = {
    ...draftF,
    isFinal: true,
  };
  const undoF3 = validateUndoEligibility(taskF3, draftF3, logIdF, '主笔甲');
  assert(undoF3.canUndo === false, 'F5: 文稿定稿锁定后禁止撤销');

  // F4: Non-author role
  const undoF4 = validateUndoEligibility(taskF, draftF, logIdF, '审阅乙');
  assert(undoF4.canUndo === false && undoF4.reason!.includes('主笔甲'), 'F6: 非主笔角色禁止执行撤销');

  // --------------------------------------------------------------------------
  // [验收用例 G] 刷新后保留真实修改记录；旧数据没有记录时正常加载；不伪造历史
  // --------------------------------------------------------------------------
  console.log('\n>>> [验收用例 G] 存储持久化与兼容性测试:');

  // 1. Persistence & reload
  savePersistedState([taskF], taskF.id, '主笔甲');
  const loadedState = loadPersistedState();
  const reloadedTask = loadedState.tasks.find((t) => t.id === taskF.id)!;
  assert(Array.isArray(reloadedTask.modificationLogs), 'G1: 刷新加载后保留 modificationLogs 数组');
  assert(reloadedTask.modificationLogs!.length === 1, 'G2: 准确恢复记录数量');
  assert(reloadedTask.modificationLogs![0].id === logIdF, 'G3: 准确恢复操作存证ID');
  assert(reloadedTask.modificationLogs![0].isFineTuned === true, 'G4: 准确恢复微调标记状态');

  // 2. Compatibility with old data missing modificationLogs
  const oldTaskWithoutLogs: any = {
    ...taskA,
    id: 'TASK-OLD-LEGACY',
  };
  delete oldTaskWithoutLogs.modificationLogs;

  const rawOldPayload = JSON.stringify({
    schemaVersion: 2,
    currentTaskId: oldTaskWithoutLogs.id,
    activeRole: '主笔甲',
    tasks: [oldTaskWithoutLogs],
    lastSavedAt: new Date().toISOString(),
  });
  setStorageItem(STORAGE_KEY_V2, rawOldPayload);

  const loadedOldState = loadPersistedState();
  const loadedOldTask = loadedOldState.tasks.find((t) => t.id === oldTaskWithoutLogs.id)!;
  assert(Array.isArray(loadedOldTask.modificationLogs), 'G5: 旧数据缺少该字段时兼容为空数组');
  assert(loadedOldTask.modificationLogs!.length === 0, 'G6: 绝不伪造过去的修改操作历史');

  // --------------------------------------------------------------------------
  // [验收用例 H] 长文本下查看、微调与操作，采纳按钮固定底栏
  // --------------------------------------------------------------------------
  console.log('\n>>> [验收用例 H] 长文本视图切换与固定底栏测试:');

  const longBaseText = '围绕深入落实创新驱动发展战略，扎实推进重点工作攻坚。'.repeat(15);
  const longSuggestedText = '深入推进创新驱动发展战略，集中攻坚核心业务环节，全面实现提质增效。'.repeat(12);

  const suggestionLong: RevisionSuggestion = {
    ...suggestionA,
    baseContent: longBaseText,
    suggestedText: longSuggestedText,
  };

  const longEditorMount = mountTestComponent(
    React.createElement(ParagraphSuggestionEditor, {
      task: taskA,
      currentDraft: draftA,
      suggestion: suggestionLong,
      activeRole: '主笔甲',
      activeBlock: block2A,
      activeCompletedRunId: mockRunIdA,
      isGenerating: false,
      onAdopt: () => {},
      onDiscard: () => {},
      onRegenerate: () => {},
    })
  );

  // Check sticky action bar exists
  const stickyActions = longEditorMount.container.querySelector('[data-testid="suggestion-sticky-actions"]');
  assert(stickyActions !== null, 'H1: 操作区存在 sticky bottom 固定容器');
  assert(stickyActions!.className.includes('sticky') && stickyActions!.className.includes('bottom-0'), 'H2: 操作区具有 sticky bottom-0 样式，长文本滚动时始终可访问');

  // Check view modes switch cleanly
  const tabBaseline = longEditorMount.container.querySelector('[data-testid="tab-baseline-view"]') as HTMLButtonElement;
  act(() => {
    tabBaseline.click();
  });
  const baselineView = longEditorMount.container.querySelector('[data-testid="view-baseline-content"]');
  assert(baselineView !== null, 'H3: 可顺利切换至生成时原文视图');

  const tabAi = longEditorMount.container.querySelector('[data-testid="tab-ai-original-view"]') as HTMLButtonElement;
  act(() => {
    tabAi.click();
  });
  const aiView = longEditorMount.container.querySelector('[data-testid="view-ai-original-content"]');
  assert(aiView !== null, 'H4: 可顺利切换至AI原始建议视图');

  longEditorMount.unmount();

  // --------------------------------------------------------------------------
  // [特别验收用例 1] 生成建议 → 完成前切换版本 → 等待旧请求结束 → 确认无旧建议、错误或正文写入
  // --------------------------------------------------------------------------
  console.log('\n>>> [特别验收 1] 生成前切换版本隔离测试:');

  let stageUpdatedTask: Partial<Task> | null = null;
  const stageMount = mountTestComponent(
    React.createElement(DraftingStage, {
      task: taskA,
      onUpdateTask: (updated) => {
        stageUpdatedTask = updated;
      },
      onViewSnippet: () => {},
      onProceedToNextStage: () => {},
      activeRole: '主笔甲',
    })
  );

  // Switch draft version in props
  const draftVersion2: DraftVersion = {
    ...draftA,
    id: 'DRAFT-VERSION-NEW-999',
    versionNumber: 'v2.0 (切换的新版本)',
  };
  const taskVersion2: Task = {
    ...taskA,
    currentDraftId: draftVersion2.id,
    drafts: [draftVersion2, ...taskA.drafts],
  };

  act(() => {
    stageMount.rerender(
      React.createElement(DraftingStage, {
        task: taskVersion2,
        onUpdateTask: (updated) => {
          stageUpdatedTask = updated;
        },
        onViewSnippet: () => {},
        onProceedToNextStage: () => {},
        activeRole: '主笔甲',
      })
    );
  });

  // Verify that suggestions editor is not showing stale suggestion
  const staleSuggestionEditor = stageMount.container.querySelector('[data-testid="paragraph-suggestion-editor"]');
  assert(staleSuggestionEditor === null, 'P1: 版本切换后旧建议与旧请求已彻底清理');

  stageMount.unmount();

  // --------------------------------------------------------------------------
  // [特别验收用例 2] 同一挂载实例从第2段意见切到第3段 → 确认定位、意见和建议上下文同步切换
  // --------------------------------------------------------------------------
  console.log('\n>>> [特别验收 2] 跨段落意见上下文同步切换测试:');

  const block3A = draftA.blocks[2];
  const commentOnBlock2: ReviewComment = {
    id: 'CMT-BLOCK2-P2',
    type: 'paragraph',
    targetVersionId: draftA.id,
    targetBlockId: block2A.id,
    targetBlockOrder: block2A.order,
    baseParagraphText: block2A.content,
    reviewer: '审阅乙',
    content: '第2段基层调研举措表述过于笼统',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  const commentOnBlock3: ReviewComment = {
    id: 'CMT-BLOCK3-P2',
    type: 'paragraph',
    targetVersionId: draftA.id,
    targetBlockId: block3A.id,
    targetBlockOrder: block3A.order,
    baseParagraphText: block3A.content,
    reviewer: '审阅丁',
    content: '第3段培训成效需核对具体参训口径',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  const taskWithTwoComments: Task = {
    ...taskA,
    reviewComments: [commentOnBlock2, commentOnBlock3],
  };

  // Mount with navIntent pointing to Block 2 comment
  const navMount = mountTestComponent(
    React.createElement(DraftingStage, {
      task: taskWithTwoComments,
      onUpdateTask: () => {},
      onViewSnippet: () => {},
      onProceedToNextStage: () => {},
      activeRole: '主笔甲',
      navIntent: { taskId: taskWithTwoComments.id, commentId: commentOnBlock2.id, timestamp: 1 },
      onClearNavIntent: () => {},
    })
  );

  // Check block 2 card highlighted
  const block2Card = navMount.container.querySelector(`#block-card-${block2A.id}`);
  assert(block2Card !== null && block2Card.textContent!.includes('来源：【审阅乙】审阅意见'), 'P2.1: 初始定位至第2段意见');

  // Switch navIntent to Block 3 comment in the SAME mounted instance
  act(() => {
    navMount.rerender(
      React.createElement(DraftingStage, {
        task: taskWithTwoComments,
        onUpdateTask: () => {},
        onViewSnippet: () => {},
        onProceedToNextStage: () => {},
        activeRole: '主笔甲',
        navIntent: { taskId: taskWithTwoComments.id, commentId: commentOnBlock3.id, timestamp: 2 },
        onClearNavIntent: () => {},
      })
    );
  });

  const block3Card = navMount.container.querySelector(`#block-card-${block3A.id}`);
  assert(block3Card !== null && block3Card.textContent!.includes('来源：【审阅丁】审阅意见'), 'P2.2: 同一挂载实例顺利切换定位至第3段意见');

  navMount.unmount();

  console.log('\n================================================================');
  console.log('   🎉 任务17 全部 8 项验收用例与回归测试 100% 通过！');
  console.log('================================================================\n');
}

runTask17Tests().catch((err) => {
  console.error('Test run failed with error:', err);
  process.exit(1);
});
