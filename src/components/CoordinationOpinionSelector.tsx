import React, {useEffect} from 'react';
import type {ReviewComment} from '../types';
export function CoordinationOpinionSelector({comments,selected,onChange}:{comments:ReviewComment[];selected:string[];onChange:(ids:string[])=>void}) {
  useEffect(() => {
    const next=selected.filter(id=>comments.some(c=>c.id===id && ['pending','accepted_pending_implementation','need_discussion'].includes(c.status)));
    if(next.length!==selected.length) onChange(next);
  },[comments,selected,onChange]);
  return <fieldset className="space-y-2"><legend className="font-semibold">参与本次协调的意见（请确认范围）</legend>
    {comments.filter(c=>['pending','accepted_pending_implementation','need_discussion'].includes(c.status)).map(c=><label key={c.id} className="block p-3 border rounded text-sm">
      <input type="checkbox" checked={selected.includes(c.id)} onChange={e=>onChange(e.target.checked?[...selected,c.id]:selected.filter(id=>id!==c.id))}/>
      <strong className="ml-2">{c.reviewer}</strong>：{c.content}
    </label>)}
  </fieldset>;
}
