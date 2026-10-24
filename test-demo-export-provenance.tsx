import {dom} from './test-jsdom-env';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {createPresetTask} from './src/services/mockData';
import {MaterialsAndFactsStage} from './src/components/stages/MaterialsAndFactsStage';
import {DraftingStage} from './src/components/stages/DraftingStage';
import {AuditAndExportStage} from './src/components/stages/AuditAndExportStage';
import {SnippetDrawer} from './src/components/SnippetDrawer';
import {resolveDraftFactEvidence} from './src/services/factLifecycleService';
import {createDraftSnapshot, adoptParagraphSuggestion} from './src/services/draftLifecycleService';
import {generateMaterialSupplementation} from './src/services/materialSupplementService';
import {exportDocumentAsTxt, exportDocumentAsDocx} from './src/services/exportService';
import type {Task, DraftVersion, ExportOptions} from './src/types';

const failures: string[] = [];
async function check(name: string, run: () => void | Promise<void>) {
  try { await run(); console.log(`PASS: ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL: ${name}\n${String(error)}`); }
}
function mount(render: (root: ReturnType<typeof createRoot>, host: HTMLDivElement) => void) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try { render(root, host); }
  finally { act(() => root.unmount()); host.remove(); }
}
function button(host: HTMLElement, label: string) {
  const result = [...host.querySelectorAll('button')].find(b => b.textContent?.includes(label));
  assert(result, `missing button: ${label}`); return result;
}
const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
async function exportText(task: Task, draft: DraftVersion, options: ExportOptions, docx: boolean) {
  if (!docx) return exportDocumentAsTxt(task, draft, options);
  const output = await exportDocumentAsDocx(task, draft, options);
  const bytes = output instanceof Blob ? new Uint8Array(await output.arrayBuffer()) : output;
  const zip = await JSZip.loadAsync(bytes, {checkCRC32: true});
  const part = zip.file('word/document.xml'); assert(part, 'DOCX must contain document.xml');
  const xml = new dom.window.DOMParser().parseFromString(await part.async('string'), 'application/xml');
  assert(!xml.querySelector('parsererror'), 'DOCX XML must parse');
  return [...xml.getElementsByTagNameNS(w, 'p')].map(p =>
    [...p.getElementsByTagNameNS(w, 't')].map(t => t.textContent).join('')).join('\n');
}
// Generate bytes without invoking the browser download side effect in JSDOM.
const previousCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
Object.defineProperty(URL, 'createObjectURL', {configurable: true, value: undefined});
try {
  let generatedTask = createPresetTask('ready_to_draft');
  await check('real fact confirmation captures provenance before real initial draft generation', async () => {
    mount((root, host) => {
      act(() => root.render(<MaterialsAndFactsStage task={generatedTask} activeRole="主笔甲"
        onUpdateTask={update => { generatedTask = {...generatedTask, ...update}; }}
        onViewSnippet={() => {}} onProceedToNextStage={() => {}}/>));
      act(() => button(host, '确认本次事实清单').click());
    });
    const source = generatedTask.snippets.find(s => s.id === 'EVD-02')!;
    const item = generatedTask.factSnapshot!.items.find(f => f.factId === 'FACT-01')!;
    assert.equal(item.provenance?.text, source.text);
    assert.equal(item.provenance?.evidenceId, 'EVD-02');
    assert.equal(item.provenance?.sourceDocId, source.sourceDocId);
    assert.equal(item.provenance?.sourceDocName, source.docName);
    assert.equal(item.provenance?.location, source.location);
    assert.equal(item.conflictResolutionReason, generatedTask.facts[0].conflictResolutionReason);
    assert.deepEqual(generatedTask.factSnapshot!.factIds, ['FACT-01', 'FACT-02', 'FACT-03', 'FACT-04']);
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    try {
      act(() => root.render(<DraftingStage task={generatedTask} activeRole="主笔甲"
        onUpdateTask={update => { generatedTask = {...generatedTask, ...update}; }}
        onViewSnippet={() => {}} onProceedToNextStage={() => {}}/>));
      await act(async () => { button(host, '立即生成初稿').click(); await new Promise(r => setTimeout(r, 850)); });
      const draft = generatedTask.drafts.find(d => d.id === generatedTask.currentDraftId)!;
      assert(draft?.snapshotMetadata?.factSnapshot);
      assert.deepEqual(draft.snapshotMetadata.factSnapshot, JSON.parse(JSON.stringify(generatedTask.factSnapshot)),
        'JSON cloning may omit undefined optional fields, but must preserve all recorded values');
      const expected = structuredClone(draft.snapshotMetadata.factSnapshot);
      generatedTask.factSnapshot!.items[0].provenance!.text = 'SOURCE-SNAPSHOT-CHANGED';
      assert.deepEqual(draft.snapshotMetadata.factSnapshot, expected, 'draft provenance must be an independent deep copy');
    } finally { act(() => root.unmount()); host.remove(); }
  });

  await check('saved historical TXT/DOCX keep frozen sources after live materials are renamed or deleted', async () => {
    assert(generatedTask.drafts.length, 'real draft generation must have succeeded');
    const saved = createDraftSnapshot(generatedTask, generatedTask.currentDraftId, '出处存证回归', '主笔甲');
    const history = saved.snapshotDraft;
    const item = history.snapshotMetadata!.factSnapshot!.items.find(f => f.factId === 'FACT-01')!;
    const expected = structuredClone(item.provenance!);
    const sourceDraft = saved.updatedTask.drafts.find(d => d.id === generatedTask.currentDraftId)!;
    sourceDraft.snapshotMetadata!.factSnapshot!.items[0].provenance!.text = 'WORKING-SNAPSHOT-CHANGED';
    assert.deepEqual(item.provenance, expected, 'milestone must deeply clone nested provenance');
    const changed = structuredClone(saved.updatedTask);
    changed.snippets.forEach(s => { s.text = 'LIVE-ONLY-RAW'; s.docName = 'LIVE-ONLY-DOC'; });
    changed.documents.forEach(d => { d.name = 'LIVE-ONLY-DOC'; d.content = 'LIVE-ONLY-FULL'; });
    for (const docx of [false, true]) {
      const renamed = await exportText(changed, history, {includeBody: false, includeEvidence: true, includeReviewLog: false}, docx);
      for (const value of [expected.text, expected.sourceDocName, expected.sourceDocId, expected.evidenceId, expected.location!]) assert(renamed.includes(value), `${docx ? 'DOCX' : 'TXT'} missing ${value}`);
      assert(!renamed.includes('LIVE-ONLY-'));
      const deleted = await exportText({...changed, snippets: [], documents: [], facts: []}, history,
        {includeBody: false, includeEvidence: true, includeReviewLog: false}, docx);
      assert.equal(deleted, renamed, 'deleting live material must not alter historical evidence export');
    }
  });

  await check('all eight TXT/DOCX option combinations keep body, evidence and frozen review independent', async () => {
    const task = createPresetTask('under_review'); const draft = task.drafts[0];
    draft.blocks[0].content = 'BODY-ONLY-MARKER：仅属于正文。';
    draft.frozenReviewComments = [{id: 'FROZEN-REVIEW', type: 'overall', targetVersionId: draft.id,
      reviewer: '审阅乙', content: 'REVIEW-ONLY-MARKER：本版冻结意见。', status: 'rejected',
      decisionReason: '已核实', createdAt: draft.createdAt}];
    task.reviewComments = [];
    const fact = draft.snapshotMetadata!.factSnapshot!.items.find(f => f.factId === 'FACT-01')!;
    assert(fact.provenance);
    for (const includeBody of [false, true]) for (const includeEvidence of [false, true]) for (const includeReviewLog of [false, true]) {
      for (const docx of [false, true]) {
        const text = await exportText(task, draft, {includeBody, includeEvidence, includeReviewLog}, docx);
        assert.equal(text.includes('BODY-ONLY-MARKER'), includeBody, 'body switch must control actual body');
        assert.equal(text.includes(fact.provenance.text), includeEvidence, 'evidence switch must control source quotation');
        assert.equal(text.includes(fact.provenance.sourceDocName), includeEvidence, 'evidence switch must control source name');
        assert.equal(text.includes('REVIEW-ONLY-MARKER'), includeReviewLog, 'review switch must use frozen comments');
        if (includeEvidence) {
          assert(text.includes('EVD-02')); assert(text.includes(fact.conflictResolutionReason!));
          assert(!text.includes('EVD-01'), 'non-adopted candidate source must not be exported as adopted evidence');
        }
      }
    }
  });

  await check('legacy historical export explains missing provenance without filling in live raw text', async () => {
    const task = createPresetTask('under_review'); const draft = task.drafts[0];
    draft.isHistoricalSnapshot = true; draft.isWorkingDraft = false;
    for (const item of draft.snapshotMetadata!.factSnapshot!.items) delete item.provenance;
    for (const snippet of task.snippets) snippet.text = 'LIVE-LEGACY-QUOTE-MUST-NOT-LEAK';
    for (const includeBody of [false, true]) for (const docx of [false, true]) {
      const text = await exportText(task, draft, {includeBody, includeEvidence: true, includeReviewLog: false}, docx);
      assert(text.includes('该版本未保存原文快照')); assert(text.includes('EVD-02'));
      assert(!text.includes('LIVE-LEGACY-QUOTE-MUST-NOT-LEAK'));
    }
  });

  await check('real material supplementation adoption exports its frozen source after deletion', async () => {
    const task = createPresetTask('under_review'); const draft = task.drafts[0]; const block = draft.blocks[0];
    const text = '为每次培训建立会前登记和课后反馈机制。';
    task.documents.push({id: 'SUPPLEMENT-DOC', name: 'SUPPLEMENT-FROZEN-NAME', source: '培训科',
      period: '2026年1至9月', usage: 'current_fact', parseStatus: 'parsed', fileType: 'pasted', content: text});
    const snippet = {id: 'SUPPLEMENT-EVIDENCE', sourceDocId: 'SUPPLEMENT-DOC', docName: 'SUPPLEMENT-FROZEN-NAME',
      location: 'SUPPLEMENT-LOCATION', period: '2026年1至9月', text};
    task.snippets.push(snippet);
    const suggestion = generateMaterialSupplementation(block, [snippet], {task, currentDraft: draft});
    const result = adoptParagraphSuggestion({task, currentDraft: draft, suggestion,
      pendingTextToAdopt: suggestion.suggestedText, activeCompletedRunId: suggestion.runId, activeRole: '主笔甲'});
    assert(result.success); assert.equal(result.targetBlock.adoptedEvidences?.[0].snippetText, text);
    const detached = {...result.updatedTask, snippets: [], documents: []};
    for (const docx of [false, true]) {
      const output = await exportText(detached, result.workingDraft, {includeBody: false, includeEvidence: true, includeReviewLog: false}, docx);
      assert(output.includes(text)); assert(output.includes(snippet.docName)); assert(output.includes(snippet.location));
    }
  });

  await check('working evidence keeps source name and location consistent with the snippet it opens', () => {
    const task = createPresetTask('under_review'); const draft = task.drafts[0];
    const fact = task.facts.find(f => f.id === 'FACT-01')!;
    const snippet = task.snippets.find(s => s.id === fact.primaryEvidenceId)!;
    snippet.docName = 'LIVE-RENAMED-DOC'; snippet.location = 'LIVE-NEW-LOCATION'; snippet.text = 'LIVE-NEW-QUOTE';
    const resolved = resolveDraftFactEvidence(fact, draft, task);
    assert.equal(resolved.effectiveDocName, resolved.effectiveSnippet?.docName, 'source label and opened snippet must belong to the same version');
    assert.equal(resolved.effectiveLocation, resolved.effectiveSnippet?.location);
  });

  await check('historical provenance drawer never presents current full document as frozen material', () => {
    const task = createPresetTask('under_review'); const draft = task.drafts[0];
    draft.isHistoricalSnapshot = true; draft.isWorkingDraft = false;
    const fact = task.facts.find(f => f.id === 'FACT-01')!;
    const resolved = resolveDraftFactEvidence(fact, draft, task);
    const saved = draft.snapshotMetadata!.factSnapshot!.items.find(f => f.factId === fact.id)!.provenance!;
    task.documents.find(d => d.id === saved.sourceDocId)!.content = 'LIVE-FULL-DOCUMENT-MUST-NOT-BE-FROZEN';
    mount((root, host) => {
      act(() => root.render(<SnippetDrawer snippet={resolved.effectiveSnippet} fact={fact} documents={task.documents}
        task={task} currentDraft={draft} onClose={() => {}}/>));
      assert(host.textContent?.includes(saved.text));
      assert(!host.textContent?.includes('LIVE-FULL-DOCUMENT-MUST-NOT-BE-FROZEN'), 'only the captured excerpt is frozen, not the live full document');
      assert(!host.textContent?.includes('下方为材料库现存原文'), 'captured excerpt must not be described as an unfrozen live excerpt');
    });
  });

  await check('deleted current fact drawer keeps its frozen excerpt isolated from live full text', () => {
    const task = createPresetTask('under_review'); const draft = task.drafts[0];
    const fact = task.facts.find(f => f.id === 'FACT-01')!;
    const saved = draft.snapshotMetadata!.factSnapshot!.items.find(f => f.factId === fact.id)!.provenance!;
    task.facts = task.facts.filter(f => f.id !== fact.id);
    task.documents.find(d => d.id === saved.sourceDocId)!.content = 'DELETED-FACT-LIVE-FULL-TEXT';
    const resolved = resolveDraftFactEvidence(fact, draft, task);
    assert(resolved.isCurrentFactDeleted); assert.equal(resolved.effectiveSnippet?.text, saved.text);
    mount((root, host) => {
      act(() => root.render(<SnippetDrawer snippet={resolved.effectiveSnippet} fact={fact} documents={task.documents}
        task={task} currentDraft={draft} onClose={() => {}}/>));
      assert(host.textContent?.includes(saved.text));
      assert(!host.textContent?.includes('DELETED-FACT-LIVE-FULL-TEXT'), 'deleted-fact fallback also displays a frozen excerpt, not current context');
      assert(host.textContent?.includes('未保存当时全文'));
    });
  });

  await check('evidence-only export preview shows the same frozen sources as the generated file', () => {
    const task = createPresetTask('under_review'); const draft = task.drafts[0];
    const expected = draft.snapshotMetadata!.factSnapshot!.items.find(f => f.factId === 'FACT-01')!.provenance!;
    mount((root, host) => {
      act(() => root.render(<AuditAndExportStage task={task} activeRole="主笔甲" onUpdateTask={() => {}}/>));
      act(() => button(host, '下载导出文件').click());
      const bodyLabel = [...host.querySelectorAll('label')].find(l => l.textContent?.includes('包含公文正文'))!;
      const body = bodyLabel.querySelector<HTMLInputElement>('input')!; assert(body.checked);
      act(() => body.click());
      const title = [...host.querySelectorAll('span')].find(s => s.textContent?.startsWith('实时导出预览：'))!;
      const preview = title.parentElement!.parentElement!;
      assert(preview.textContent?.includes(expected.sourceDocName), 'evidence-only preview must not be empty');
      assert(preview.textContent?.includes(expected.text), 'preview must include the frozen source quote');
    });
  });

  await check('preview option matrix preserves frozen sources, legacy limitations and independent sections', () => {
    for (const mode of ['historical', 'final', 'legacy'] as const) {
      const task = createPresetTask('under_review'); const draft = task.drafts[0];
      draft.isWorkingDraft = false; draft.isHistoricalSnapshot = mode !== 'final'; draft.isFinal = mode === 'final';
      draft.blocks[0].content = 'PREVIEW-BODY-ONLY';
      draft.frozenReviewComments = [{id: 'PREVIEW-REVIEW', type: 'overall', targetVersionId: draft.id,
        reviewer: '审阅乙', content: 'PREVIEW-REVIEW-ONLY', status: 'rejected', createdAt: draft.createdAt}];
      const item = draft.snapshotMetadata!.factSnapshot!.items.find(f => f.factId === 'FACT-01')!;
      const saved = structuredClone(item.provenance!);
      if (mode === 'legacy') for (const f of draft.snapshotMetadata!.factSnapshot!.items) delete f.provenance;
      task.snippets.forEach(s => { s.text = 'PREVIEW-LIVE-MUST-NOT-LEAK'; s.docName = 'PREVIEW-LIVE-MUST-NOT-LEAK'; });
      task.documents.forEach(d => { d.name = 'PREVIEW-LIVE-MUST-NOT-LEAK'; });
      mount((root, host) => {
        act(() => root.render(<AuditAndExportStage task={task} activeRole="主笔甲" onUpdateTask={() => {}}/>));
        act(() => button(host, '下载导出文件').click());
        const inputs = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
        assert.equal(inputs.length, 3);
        const title = [...host.querySelectorAll('span')].find(s => s.textContent?.startsWith('实时导出预览：'))!;
        const preview = title.parentElement!.parentElement!;
        for (const includeBody of [false, true]) for (const includeEvidence of [false, true]) for (const includeReviewLog of [false, true]) {
          [includeBody, includeEvidence, includeReviewLog].forEach((value, i) => {
            if (inputs[i].checked !== value) act(() => inputs[i].click());
          });
          const text = preview.textContent || '';
          assert.equal(text.includes('PREVIEW-BODY-ONLY'), includeBody);
          assert.equal(text.includes('PREVIEW-REVIEW-ONLY'), includeReviewLog);
          assert(!text.includes('PREVIEW-LIVE-MUST-NOT-LEAK'));
          assert.equal(text.includes(saved.text), includeEvidence && mode !== 'legacy');
          assert.equal(text.includes('该版本未保存原文快照'), includeEvidence && mode === 'legacy');
          if (includeEvidence && mode !== 'legacy') {
            for (const value of [saved.sourceDocName, saved.sourceDocId, saved.location!, saved.evidenceId, item.period, item.metricScope!, item.conflictResolutionReason!]) assert(text.includes(value));
          }
          assert(!/[：:]\s*\$|\(主出处：\$/.test(text), 'preview must not render template interpolation dollar signs');
        }
      });
    }
  });
} finally {
  if (previousCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', previousCreateObjectURL);
  else Reflect.deleteProperty(URL, 'createObjectURL');
}
assert.equal(failures.length, 0, `export provenance regressions: ${failures.join('; ')}`);
