import { dom, simulateTextareaChange } from './test-jsdom-env';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'node:assert/strict';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { AutoResizeParagraphTextarea } from './src/components/AutoResizeParagraphTextarea';
import { createPresetTask } from './src/services/mockData';
import type { Task } from './src/types';

// JSDOM checks context, focus and scroll compensation, not real sticky/grid layout.
Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
let task = createPresetTask('under_review');
const originalContent = task.drafts.find(d => d.id === task.currentDraftId)!.blocks.map(b => b.content);
function Harness() {
  const [state, setState] = useState(task);
  return <DraftingStage task={state} activeRole="主笔甲" onUpdateTask={u => {
    task = { ...task, ...u };
    setState(task);
  }} onViewSnippet={() => {}} onProceedToNextStage={() => {}} />;
}
act(() => root.render(<Harness />));
const button = (label: string) => {
  const el = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  assert(el, `missing ${label}`);
  return el;
};
const click = (label: string) => act(() => button(label).click());

click('第3段AI修改建议');
assert(!host.querySelector('[data-testid="drawer-tablet-inspector"]'));
const prompt = host.querySelector<HTMLTextAreaElement>('textarea[placeholder^="例如：精简表达"]')!;
assert(prompt);
act(() => simulateTextareaChange(prompt, '精简表达并保留数据'));
const inspector = button('折叠辅助面板').parentElement!.parentElement!;
const condense = Array.from(inspector.querySelectorAll('button')).find(b => b.textContent === '压缩精炼')!;
assert(condense);
await act(async () => {
  condense.click();
  await new Promise(resolve => setTimeout(resolve, 600));
});
act(() => host.querySelector<HTMLButtonElement>('[data-testid="tab-editor-view"]')!.click());
const pending = host.querySelector<HTMLTextAreaElement>('[data-testid="textarea-pending-text"]')!;
assert(pending);
const fineTune = pending.value + '【保留人工微调】';
act(() => simulateTextareaChange(pending, fineTune));

// Read the fourth paragraph while the third remains selected in the inspector.
const textareas = Array.from(host.querySelectorAll<HTMLTextAreaElement>('[data-testid^="textarea-block-"]'));
const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
const scrollCalls: number[] = [];
const originalScrollBy = window.scrollBy;
window.scrollBy = (_x: number, y: number) => { scrollCalls.push(y); };
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  const collapsed = host.querySelector('[data-testid="drafting-workspace"]')?.getAttribute('data-outline-collapsed') === 'true';
  const index = textareas.indexOf(this as HTMLTextAreaElement);
  const top = index === 3 ? collapsed ? 140 : 100 : index < 3 ? -200 : 500;
  return { x: 0, y: top, top, bottom: top + 40, left: 0, right: 100, width: 100, height: 40, toJSON() {} };
};

click('折叠导航栏');
assert.equal(scrollCalls.at(-1), 40, 'compensate using visible paragraph, not selected paragraph');
assert.equal(document.activeElement, button('展开章节导航'));
assert.equal(button('展开章节导航').getAttribute('aria-expanded'), 'false');
click('折叠辅助面板');
assert.equal(document.activeElement, button('展开辅助面板'));
assert.equal(button('展开辅助面板').getAttribute('aria-expanded'), 'false');
assert(button('展开章节导航').textContent?.includes('大纲'));
assert(button('展开辅助面板').textContent?.includes('辅助'));
click('展开章节导航');
assert.equal(scrollCalls.at(-1), -40);
assert.equal(document.activeElement, button('折叠导航栏'));
click('展开辅助面板');
assert.equal(document.activeElement, button('折叠辅助面板'));
assert.equal(button('折叠辅助面板').getAttribute('aria-expanded'), 'true');

assert.equal(host.querySelector<HTMLTextAreaElement>('textarea[placeholder^="例如：精简表达"]')?.value, '精简表达并保留数据');
const editorTab = host.querySelector<HTMLButtonElement>('[data-testid="tab-editor-view"]')!;
assert(editorTab);
act(() => editorTab.click());
assert.equal(host.querySelector<HTMLTextAreaElement>('[data-testid="textarea-pending-text"]')?.value, fineTune);
assert.match(button('折叠辅助面板').parentElement!.parentElement!.textContent || '', /操作范围：仅限第\s*3\s*段/);
assert.deepEqual(task.drafts.find(d => d.id === task.currentDraftId)!.blocks.map(b => b.content), originalContent);

dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect;
window.scrollBy = originalScrollBy;
act(() => root.unmount());
host.remove();

// Model a long paragraph's measured height without a real browser. Reading its
// size must never temporarily shorten the live paragraph/document.
const resizeHost = document.createElement('div');
document.body.append(resizeHost);
const resizeRoot = createRoot(resizeHost);
let measuredWidth = 600;
const heightsDuringMeasurement: string[] = [];
const originalTextareaScrollHeight = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'scrollHeight');
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  return { x: 0, y: -51, top: -51, bottom: 677, left: 0, right: measuredWidth, width: measuredWidth, height: 728, toJSON() {} };
};
Object.defineProperty(dom.window.HTMLTextAreaElement.prototype, 'scrollHeight', {
  configurable: true,
  get() {
    const live = resizeHost.querySelector<HTMLTextAreaElement>('#resize-probe')!;
    heightsDuringMeasurement.push(live.style.height);
    assert.notEqual(live.style.height, 'auto', 'measurement must not collapse the live paragraph');
    const width = parseFloat(this.style.width) || measuredWidth;
    return Math.ceil(this.value.length / (width / 10)) * 24;
  },
});
const renderResize = (value: string, layoutKey: string) => act(() => resizeRoot.render(
  <AutoResizeParagraphTextarea id="resize-probe" value={value} layoutKey={layoutKey} />
));
renderResize('长'.repeat(1200), 'panels-open');
const liveParagraph = resizeHost.querySelector<HTMLTextAreaElement>('#resize-probe')!;
assert.equal(liveParagraph.style.height, '480px');
measuredWidth = 960;
renderResize('长'.repeat(1200), 'panels-closed');
assert.equal(heightsDuringMeasurement.at(-1), '480px', 'keep previous height until replacement is measured');
assert.equal(liveParagraph.style.height, '312px');
renderResize('短'.repeat(120), 'panels-closed');
assert.equal(heightsDuringMeasurement.at(-1), '312px');
assert.equal(liveParagraph.style.height, '48px', 'deleting content still shrinks the paragraph');
assert.equal(resizeHost.querySelectorAll('textarea').length, 1, 'temporary measurement nodes are removed');
if (originalTextareaScrollHeight) Object.defineProperty(dom.window.HTMLTextAreaElement.prototype, 'scrollHeight', originalTextareaScrollHeight);
else delete (dom.window.HTMLTextAreaElement.prototype as any).scrollHeight;
dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect;
act(() => resizeRoot.unmount());
resizeHost.remove();
console.log('PASS: desktop panel combinations, focus, visible paragraph anchoring, prompt/fine-tune/target retention; real grid/sticky layout requires browser verification');
console.log('PASS: long paragraph measurement preserves the live height during reflow and still shrinks after deletion');
