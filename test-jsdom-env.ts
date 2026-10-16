import { JSDOM } from 'jsdom';

export const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:3000',
  pretendToBeVisual: true,
});

(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLButtonElement = dom.window.HTMLButtonElement;
(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).localStorage = dom.window.localStorage;
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Standard DOM prototype setter + input/change event dispatch for JSDOM React testing.
 * Strictly uses standards-compliant DOM events; never touches internal private React props.
 */
export function simulateTextareaChange(textareaEl: HTMLTextAreaElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    (dom.window as any).HTMLTextAreaElement.prototype,
    'value'
  )?.set;
  if (nativeSetter) {
    nativeSetter.call(textareaEl, value);
  } else {
    textareaEl.value = value;
  }
  textareaEl.dispatchEvent(new (dom.window as any).Event('input', { bubbles: true }));
  textareaEl.dispatchEvent(new (dom.window as any).Event('change', { bubbles: true }));
}
