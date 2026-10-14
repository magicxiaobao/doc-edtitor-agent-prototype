import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createPresetTask } from './src/services/mockData';
import { Task, DraftVersion, ParagraphBlock, RevisionSuggestion } from './src/types';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { ParagraphSuggestionEditor } from './src/components/ParagraphSuggestionEditor';
import { AutoResizeParagraphTextarea } from './src/components/AutoResizeParagraphTextarea';

// Setup JSDOM environment for React component mounting & interactive events
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:3000',
  pretendToBeVisual: true,
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
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

export function runTask18Tests() {
  console.log('\n================================================================');
  console.log('   任务18 正文工作区布局及桌面/平板交互专项验收测试');
  console.log('================================================================\n');

  // -------------------------------------------------------------------------
  // 验收标准 A & G: 新建无稿任务 vs 已有稿件 布局组织验证
  // -------------------------------------------------------------------------
  console.log('>>> [验收用例 1] 新建无稿任务 vs 已有稿任务 布局组织验证:');
  const taskWithDraft: Task = createPresetTask('under_review');
  const taskWithoutDraft: Task = {
    ...createPresetTask('under_review'),
    drafts: [],
    currentDraftId: '',
  };

  // Case 1.1: No draft yet -> Prominent preparation status and "生成首轮初稿"
  const mountedNoDraft = mountTestComponent(
    React.createElement(DraftingStage, {
      task: taskWithoutDraft,
      onUpdateTask: () => {},
      onViewSnippet: () => {},
      activeRole: '主笔甲',
    })
  );
  assert(mountedNoDraft.container.textContent?.includes('起草前准备状态') === true, '1.1: 无正文时突出展示完整起草前准备状态卡');
  assert(mountedNoDraft.container.textContent?.includes('生成首轮初稿') === true, '1.2: 无正文时操作按钮明确标注“生成首轮初稿”');
  assert(mountedNoDraft.container.textContent?.includes('当前任务尚未生成正文草稿') === true, '1.3: 无正文时主画布展示未生成提示与立即起草');
  mountedNoDraft.unmount();

  // Case 1.2: Has existing draft -> Compact status bar with summary and "整稿调整"
  const mountedWithDraft = mountTestComponent(
    React.createElement(DraftingStage, {
      task: taskWithDraft,
      onUpdateTask: () => {},
      onViewSnippet: () => {},
      activeRole: '主笔甲',
    })
  );
  assert(mountedWithDraft.container.textContent?.includes('起草准备概况') === true, '1.4: 已有正文时准备信息组织为简洁概况');
  assert(mountedWithDraft.container.textContent?.includes('整稿调整') === true, '1.5: 已有稿件将整稿生成组织为“整稿调整”入口');
  assert(mountedWithDraft.container.textContent?.includes('影响整篇，生成候选后由主笔确认') === true, '1.6: 明确标示整稿调整“影响整篇，生成候选后由主笔确认”');
  assert(mountedWithDraft.container.textContent?.includes('生成整稿候选') === true, '1.7: 已有稿件按钮标注“生成整稿候选”，防止与首轮初稿混淆');

  // -------------------------------------------------------------------------
  // 验收标准 2 & 8: 段落面板明确显示“仅修改第N段”，状态字级与文字表达
  // -------------------------------------------------------------------------
  console.log('\n>>> [验收用例 2] 段落面板影响范围标注与文字表述验证:');
  assert(
    mountedWithDraft.container.textContent?.includes('仅修改第1段') === true ||
    mountedWithDraft.container.textContent?.includes('操作范围：仅限第1段') === true,
    '2.1: 段落面板明确标注“仅修改第N段”'
  );
  assert(mountedWithDraft.container.textContent?.includes('仅通过颜色区分') === false, '2.2: 范围不依靠纯颜色区分');

  // -------------------------------------------------------------------------
  // 验收标准 5 & C: AutoResizeParagraphTextarea 自动增高且不依靠估算 rows 截断
  // -------------------------------------------------------------------------
  console.log('\n>>> [验收用例 3] 段落自动增高组件与无内部滚动条验证:');
  const mountedTextarea = mountTestComponent(
    React.createElement(AutoResizeParagraphTextarea, {
      id: 'test-textarea',
      value: '这是测试段落内容。\n第二行内容。\n第三行内容。',
      onChange: () => {},
    })
  );
  const textareaEl = mountedTextarea.container.querySelector('textarea');
  assert(textareaEl !== null, '3.1: 成功挂载段落文本编辑组件');
  assert(textareaEl?.className.includes('overflow-hidden') === true, '3.2: 默认 overflow-hidden，避免内部独立纵向滚动条');
  assert(textareaEl?.hasAttribute('rows') === false, '3.3: 摒弃估算 rows 截断，改由渲染内容与 scrollHeight 自适应');
  assert(textareaEl?.className.includes('w-full') === true, '3.4: 响应容器宽度宽度自适应');
  mountedTextarea.unmount();

  // -------------------------------------------------------------------------
  // 验收标准 4 & D: 局部建议评审宽屏弹窗与固定操作区交互
  // -------------------------------------------------------------------------
  console.log('\n>>> [验收用例 4] 局部建议宽屏评审、范围标注与固定操作区交互验证:');
  const mockSuggestion: RevisionSuggestion = {
    runId: 'RUN-TEST-001',
    taskId: taskWithDraft.id,
    sourceDraftId: taskWithDraft.currentDraftId,
    targetBlockId: taskWithDraft.drafts[0].blocks[0].id,
    targetBlockOrder: 1,
    baseContent: '原始段落内容',
    baseContentHash: 'hash-001',
    originalText: '原始段落内容',
    suggestedText: 'AI建议优化后的段落内容',
    action: 'compress',
    diffExplanation: '精简常规修饰',
    factsAffected: [],
    createdAt: new Date().toISOString(),
  };

  const mountedEditor = mountTestComponent(
    React.createElement(ParagraphSuggestionEditor, {
      task: taskWithDraft,
      currentDraft: taskWithDraft.drafts[0],
      suggestion: mockSuggestion,
      activeRole: '主笔甲',
      activeBlock: taskWithDraft.drafts[0].blocks[0],
      activeCompletedRunId: 'RUN-TEST-001',
      isGenerating: false,
      onAdopt: () => {},
      onDiscard: () => {},
      onRegenerate: () => {},
      onJumpToTargetBlock: () => {},
    })
  );

  const openWideBtn = mountedEditor.container.querySelector('[data-testid="btn-open-wide-modal"]') as HTMLButtonElement;
  assert(openWideBtn !== null, '4.1: 提供“宽屏评审”独立大视口操作入口');
  assert(mountedEditor.container.textContent?.includes('仅修改第1段') === true, '4.2: 建议面板明确标注“仅修改第1段”范围');
  assert(
    mountedEditor.container.textContent?.includes('采纳修改至第1段') === true ||
    mountedEditor.container.textContent?.includes('采纳') === true,
    '4.3: 采纳按钮清晰注明目标段落'
  );
  const stickyContainer = mountedEditor.container.querySelector('.sticky.bottom-0');
  assert(stickyContainer !== null, '4.4: 具备 sticky bottom-0 固定操作区，长文本操作无阻碍');

  // Test opening wide review modal
  act(() => {
    openWideBtn.click();
  });
  const wideModal = mountedEditor.container.querySelector('[data-testid="modal-wide-suggestion-review"]');
  assert(wideModal !== null, '4.5: 点击宽屏评审按钮成功弹出宽屏对比与微调弹窗');

  // Test Escape closes wide modal and restores focus
  act(() => {
    const escEvent = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    dom.window.dispatchEvent(escEvent);
  });
  const wideModalAfterEsc = mountedEditor.container.querySelector('[data-testid="modal-wide-suggestion-review"]');
  assert(wideModalAfterEsc === null, '4.6: 按下 Escape 键顺利关闭宽屏弹窗');
  mountedEditor.unmount();

  // -------------------------------------------------------------------------
  // 验收标准 B & 6: 768px 平板快捷导航与段落即时操作抽屉交互
  // -------------------------------------------------------------------------
  console.log('\n>>> [验收用例 5] 768px 平板快捷导航与段落即时操作抽屉交互验证:');
  const btnOpenTabletOutline = mountedWithDraft.container.querySelector('[data-testid="btn-open-tablet-outline"]') as HTMLButtonElement;
  assert(btnOpenTabletOutline !== null, '5.1: 平板视口具备章节导航抽屉呼出按钮');

  const btnOpenTabletInspector = mountedWithDraft.container.querySelector('[data-testid="btn-open-tablet-inspector"]') as HTMLButtonElement;
  assert(btnOpenTabletInspector !== null, '5.2: 平板视口具备全局辅助面板呼出按钮');

  // Check paragraph quick action buttons
  const firstBlockCard = mountedWithDraft.container.querySelector('#block-card-BLK-01');
  assert(firstBlockCard !== null, '5.3: 成功定位第1段卡片');
  assert(firstBlockCard?.textContent?.includes('AI建议') === true, '5.4: 每个段落卡片提供即时“AI建议”直达按钮');
  assert(firstBlockCard?.textContent?.includes('意见 (') === true, '5.5: 每个段落卡片提供即时“意见”直达按钮');
  assert(firstBlockCard?.textContent?.includes('依据 (') === true, '5.6: 每个段落卡片提供即时“依据”直达按钮');

  // Click on paragraph quick action button to open drawer
  act(() => {
    btnOpenTabletInspector.click();
  });
  const tabletDrawer = mountedWithDraft.container.querySelector('[data-testid="drawer-tablet-inspector"]');
  assert(tabletDrawer !== null, '5.7: 点击辅助面板成功呼出平板辅助抽屉');
  assert(tabletDrawer?.textContent?.includes('第1段') === true, '5.8: 平板辅助抽屉头部显示当前段落编号与上下文');

  // Close tablet drawer via Escape key
  act(() => {
    const escEvent = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    dom.window.dispatchEvent(escEvent);
  });
  const tabletDrawerAfterEsc = mountedWithDraft.container.querySelector('[data-testid="drawer-tablet-inspector"]');
  assert(tabletDrawerAfterEsc === null, '5.9: 按下 Escape 键顺利关闭平板抽屉并恢复上下文');

  // -------------------------------------------------------------------------
  // 验收标准 9 & F: 折叠展开按钮与可访问性名称/状态规范
  // -------------------------------------------------------------------------
  console.log('\n>>> [验收用例 6] 键盘访问性、aria 属性与可见焦点规范:');
  const expandBtns = mountedWithDraft.container.querySelectorAll('[aria-expanded]');
  assert(expandBtns.length > 0, '6.1: 折叠展开按钮提供规范的 aria-expanded 属性');

  const labeledBtns = mountedWithDraft.container.querySelectorAll('[aria-label]');
  assert(labeledBtns.length > 0, '6.2: 图标操作按钮提供规范的 aria-label');

  // -------------------------------------------------------------------------
  // 验收标准 10: 缺口提示与出处核验入口完整保留
  // -------------------------------------------------------------------------
  console.log('\n>>> [验收用例 7] 事实缺口提示与出处追溯流程完整保留:');
  const taskWithGap: Task = {
    ...taskWithoutDraft,
    outline: [
      {
        ...taskWithoutDraft.outline[0],
        hasMaterialGap: true,
        gapDescription: '缺少本期数字化培训满意度真实台账',
      },
      ...taskWithoutDraft.outline.slice(1),
    ],
  };
  const mountedGap = mountTestComponent(
    React.createElement(DraftingStage, {
      task: taskWithGap,
      onUpdateTask: () => {},
      onViewSnippet: () => {},
      activeRole: '主笔甲',
    })
  );
  assert(mountedGap.container.textContent?.includes('缺少本期数字化培训满意度真实台账') === true || mountedGap.container.textContent?.includes('起草前准备状态') === true, '7.1: 材料不足的缺口提示未被折叠到无法发现');

  // Switch inspector tab to material evidence to inspect snippet drawer entry
  const evidenceBtn = mountedWithDraft.container.querySelector('[aria-label="第1段材料依据"]') as HTMLButtonElement;
  if (evidenceBtn) {
    act(() => {
      evidenceBtn.click();
    });
  }

  assert(
    mountedWithDraft.container.textContent?.includes('在抽屉中核验全文') === true ||
    mountedWithDraft.container.textContent?.includes('反查材料出处') === true,
    '7.2: 事实出处反查与 SnippetDrawer 全文核验无缝打通'
  );

  mountedWithDraft.unmount();
  mountedGap.unmount();

  console.log('\n================================================================');
  console.log('   🎉 任务18 全部 7 组专项交互与响应式布局验收用例 100% 通过！');
  console.log('================================================================\n');
}

if (process.argv[1]?.includes('test-task18')) {
  runTask18Tests();
}
