import React, {useEffect, useRef} from 'react';

export function ConfirmActionModal({title, children, confirmLabel, onConfirm, onCancel}: {
  title: string; children: React.ReactNode; confirmLabel: string;
  onConfirm: () => void; onCancel: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel); cancel.current = onCancel;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector('button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); cancel.current();
      }
      if (event.key !== 'Tab') return;
      const controls = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus();}
      else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
    };
    window.addEventListener('keydown', onKey, true);
    return () => {window.removeEventListener('keydown', onKey, true); if (previous?.isConnected) previous.focus();};
  }, []);
  return <div className="fixed inset-0 z-[100] bg-slate-900/50 flex items-center justify-center p-4">
    <div ref={panel} role="dialog" aria-modal="true" aria-label={title} className="bg-white text-slate-800 rounded-lg shadow-xl max-w-lg w-full p-5 space-y-4 text-sm">
      <h3 className="text-base font-bold">{title}</h3>
      <div className="leading-relaxed">{children}</div>
      <div className="flex justify-end gap-3">
        <button type="button" onClick={onCancel} className="border border-slate-300 rounded px-4 py-2 hover:bg-slate-50">取消</button>
        <button type="button" onClick={onConfirm} className="bg-blue-700 hover:bg-blue-800 text-white rounded px-4 py-2">{confirmLabel}</button>
      </div>
    </div>
  </div>;
}
