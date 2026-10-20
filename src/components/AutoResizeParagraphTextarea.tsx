import React, { useRef, useLayoutEffect, useEffect, useCallback } from 'react';

// Use isomorphic effect to silence SSR/JSDOM warning while retaining instantaneous sync height calculation in browser
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

interface AutoResizeParagraphTextareaProps {
  id?: string;
  value: string;
  layoutKey?: string;
  readOnly?: boolean;
  disabled?: boolean;
  onChange?: (value: string) => void;
  className?: string;
  placeholder?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

export const AutoResizeParagraphTextarea: React.FC<AutoResizeParagraphTextareaProps> = ({
  id,
  value,
  layoutKey,
  readOnly,
  disabled,
  onChange,
  className = '',
  placeholder,
  'aria-label': ariaLabel,
  'data-testid': dataTestId,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    const width = el.getBoundingClientRect().width;
    if (!width || !el.parentElement) return;

    // Never collapse the visible paragraph just to measure it: that can clamp
    // the document scroll position before its final height is restored.
    const measurement = el.cloneNode(false) as HTMLTextAreaElement;
    measurement.removeAttribute('id');
    measurement.removeAttribute('data-testid');
    measurement.setAttribute('aria-hidden', 'true');
    measurement.tabIndex = -1;
    measurement.value = el.value;
    Object.assign(measurement.style, {
      position: 'absolute', visibility: 'hidden', pointerEvents: 'none',
      top: '0', left: '0', width: `${width}px`, height: '0',
      minHeight: '0', maxHeight: 'none', overflow: 'hidden',
    });
    el.parentElement.appendChild(measurement);
    try {
      const scrollHeight = measurement.scrollHeight;
      if (scrollHeight > 0 && el.style.height !== `${scrollHeight}px`) {
        el.style.height = `${scrollHeight}px`;
      }
    } finally {
      measurement.remove();
    }
  }, []);

  // Update on value change immediately before repaint
  useIsomorphicLayoutEffect(() => {
    adjustHeight();
  }, [value, layoutKey, adjustHeight]);

  // Respond to window resize and container width changes (e.g. sidebar toggle / screen resize)
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    adjustHeight();

    const handleResize = () => {
      adjustHeight();
    };

    window.addEventListener('resize', handleResize);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        adjustHeight();
      });
      observer.observe(el);
      if (el.parentElement) {
        observer.observe(el.parentElement);
      }
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      if (observer) {
        observer.disconnect();
      }
    };
  }, [adjustHeight]);

  return (
    <textarea
      ref={textareaRef}
      id={id}
      data-testid={dataTestId}
      value={value}
      readOnly={readOnly}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => onChange?.(e.target.value)}
      className={`w-full bg-transparent resize-none overflow-hidden focus:outline-hidden text-slate-900 text-base leading-relaxed text-justify indent-8 font-normal font-sans ${
        readOnly ? 'cursor-default select-text' : ''
      } ${className}`}
    />
  );
};
