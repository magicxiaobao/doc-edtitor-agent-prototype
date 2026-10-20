import React, {useEffect, useRef, useState} from 'react';

export function DecisionNoteModal({initialNote, onCancel, onConfirm}: {initialNote: string; onCancel: () => void; onConfirm: (note: string) => void}) {
  const [note, setNote] = useState(initialNote);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector('textarea')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onCancel(); }
      if (event.key !== 'Tab') return;
      const controls = [...(ref.current?.querySelectorAll<HTMLElement>('textarea,button:not(:disabled)') || [])];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', keydown, true);
    return () => { window.removeEventListener('keydown', keydown, true); previous?.focus(); };
  }, [onCancel]);
  return <div data-nested-modal="true" className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4">
    <div ref={ref} role="dialog" aria-modal="true" aria-label="采纳处理决定" className="bg-white p-5 rounded-lg max-w-lg w-full space-y-4 text-sm">
      <h3 className="font-bold">决定采纳，待落实正文</h3>
      <p>此操作记录处理方向；实际修改正文后才标为已落实。</p>
      <textarea aria-label="采纳处理说明" value={note} onChange={e => setNote(e.target.value)} className="w-full border p-3"/>
      <div className="flex justify-end gap-3"><button onClick={onCancel}>取消</button><button disabled={!note.trim()} onClick={() => onConfirm(note)}>确认记录决定</button></div>
    </div>
  </div>;
}
