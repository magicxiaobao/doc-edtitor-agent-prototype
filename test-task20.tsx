import { dom, simulateTextareaChange } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createPresetTask } from './src/services/mockData';
import { 
  Task, 
  ParagraphBlock, 
  EvidenceSnippet, 
  SourceDocument, 
  Fact,
  RevisionSuggestion 
} from './src/types';
import { 
  validateMaterialForSupplementation,
  validateSelectedMaterialsQuantitativeClaims,
  computeMaterialFingerprint,
  isSupportedSupplementPrompt,
  generateMaterialSupplementation,
  requestMaterialSupplementationAsync,
  arePeriodsStrictlyIdentical,
  parsePeriodDateRange
} from './src/services/materialSupplementService';
import { 
  validateParagraphSuggestionAcceptance,
  adoptParagraphSuggestion,
  undoSafeParagraphModification,
  validateUndoEligibility,
  applyDraftContentChange,
} from './src/services/draftLifecycleService';
import { modifyOrExcludeFact } from './src/services/factLifecycleService';
import { exportDocumentAsTxt } from './src/services/exportService';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { MaterialSupplementModal } from './src/components/MaterialSupplementModal';
import { ParagraphSuggestionEditor } from './src/components/ParagraphSuggestionEditor';
import { RecentModificationsModal } from './src/components/RecentModificationsModal';
import { App } from './src/App';
import { 
  loadPersistedState, 
  savePersistedState, 
  setStorageItem, 
  STORAGE_KEY_V2, 
  BACKUP_CORRUPTED_KEY,
  validateTaskStructure, 
  recoverTasksFromCorruptedBackup,
  isValidAdoptedEvidenceRecord 
} from './src/services/storageService';

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

async function runTask20Tests() {
  console.log('================================================================');
  console.log('   🚀 启动任务20 (Task20) 验收测试：指定材料驱动的段落补写');
  console.log('================================================================\n');

  // Helper task with custom valid materials for test isolation
  function createTestTaskWithCases(): Task {
    const base = createPresetTask('under_review');
    
    // Add two distinct authentic business documents
    const docA: SourceDocument = {
      id: 'DOC-APPOINT-01',
      name: '政务大厅推行便民服务预约制工作总结',
      docType: '工作总结',
      fileSize: '1.2MB',
      uploadDate: '2026-10-01',
      usage: 'current_fact',
      period: '2026年1至9月',
      status: 'confirmed',
      excluded: false,
    };

    const docB: SourceDocument = {
      id: 'DOC-PROCURE-01',
      name: '全市深化公共资源集中采购与阳光交易试点报告',
      docType: '试点报告',
      fileSize: '1.5MB',
      uploadDate: '2026-10-02',
      usage: 'current_fact',
      period: '2026年1至9月',
      status: 'confirmed',
      excluded: false,
    };

    const docStyle: SourceDocument = {
      id: 'DOC-STYLE-01',
      name: '往年优秀公文范例汇编',
      docType: '范例文稿',
      fileSize: '800KB',
      uploadDate: '2025-05-01',
      usage: 'style_ref',
      period: '2025年',
      status: 'confirmed',
      excluded: false,
    };

    const docExcluded: SourceDocument = {
      id: 'DOC-EXCLUDED-01',
      name: '已被排除的旧业务台账',
      docType: '业务台账',
      fileSize: '500KB',
      uploadDate: '2026-09-01',
      usage: 'current_fact',
      period: '2026年1至9月',
      status: 'confirmed',
      excluded: true,
    };

    const docCrossPeriod: SourceDocument = {
      id: 'DOC-CROSS-01',
      name: '2024年度历史改革回顾总结',
      docType: '历史总结',
      fileSize: '700KB',
      uploadDate: '2025-01-01',
      usage: 'current_fact',
      period: '2024年全年',
      status: 'confirmed',
      excluded: false,
    };

    // Snippets
    const snipA: EvidenceSnippet = {
      id: 'SNIP-APPOINT-01',
      sourceDocId: 'DOC-APPOINT-01',
      docName: '政务大厅推行便民服务预约制工作总结',
      location: '第2章第1节',
      period: '2026年1至9月',
      text: '创新推出“便民服务分时段精准预约”新模式，实行预约事项清单化指引与错峰办理机制，累计为企业和群众提供预约办理1500人次。',
    };

    const snipB: EvidenceSnippet = {
      id: 'SNIP-PROCURE-01',
      sourceDocId: 'DOC-PROCURE-01',
      docName: '全市深化公共资源集中采购与阳光交易试点报告',
      location: '第3章第2节',
      period: '2026年1至9月',
      text: '扎实推行集中带量采购与全流程线上透明阳光交易，组织重大工程集中招投标32批次，有效压降交易成本并提升资金规范度。',
    };

    const snipStyle: EvidenceSnippet = {
      id: 'SNIP-STYLE-01',
      sourceDocId: 'DOC-STYLE-01',
      docName: '往年优秀公文范例汇编',
      location: '卷首',
      period: '2025年',
      text: '坚持高位统筹，突出实干笃行，推动各项事业迈上新台阶。',
    };

    const snipExcluded: EvidenceSnippet = {
      id: 'SNIP-EXCLUDED-01',
      sourceDocId: 'DOC-EXCLUDED-01',
      docName: '已被排除的旧业务台账',
      location: '第1段',
      period: '2026年1至9月',
      text: '某某试点已暂缓实施。',
    };

    const snipCross: EvidenceSnippet = {
      id: 'SNIP-CROSS-01',
      sourceDocId: 'DOC-CROSS-01',
      docName: '2024年度历史改革回顾总结',
      location: '第2段',
      period: '2024年全年',
      text: '2024年历史完成任务。',
    };

    // Facts
    const factA: Fact = {
      id: 'FACT-APPOINT-01',
      metric: '便民预约办理',
      period: '2026年1至9月',
      value: '1500',
      unit: '人次',
      metricScope: '政务大厅便民预约口径',
      primaryEvidenceId: 'SNIP-APPOINT-01',
      evidenceIds: ['SNIP-APPOINT-01'],
      sourceDocId: 'DOC-APPOINT-01',
      hasConflict: false,
      status: 'confirmed',
    };

    const factB: Fact = {
      id: 'FACT-PROCURE-01',
      metric: '集中招投标',
      period: '2026年1至9月',
      value: '32',
      unit: '批次',
      metricScope: '集中采购交易口径',
      primaryEvidenceId: 'SNIP-PROCURE-01',
      evidenceIds: ['SNIP-PROCURE-01'],
      sourceDocId: 'DOC-PROCURE-01',
      hasConflict: false,
      status: 'confirmed',
    };

    return {
      ...base,
      documents: [...base.documents, docA, docB, docStyle, docExcluded, docCrossPeriod],
      snippets: [...base.snippets, snipA, snipB, snipStyle, snipExcluded, snipCross],
      facts: [...base.facts, factA, factB],
    };
  }

  // ================================================================
  // A. 有效补写
  // ================================================================
  console.log('>>> [验收用例 A] 有效补写 (选择已有段落与有效材料，生成未改正文，来源可查，其余段落不变):');
  {
    const task = createTestTaskWithCases();
    const workingDraft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    const targetBlock = workingDraft.blocks[1]; // 第2段
    const otherBlockBefore = workingDraft.blocks[0].content;
    const snipA = task.snippets.find((s) => s.id === 'SNIP-APPOINT-01')!;

    // 1. Admission check
    const admission = validateMaterialForSupplementation(task, snipA, workingDraft);
    assert(admission.eligible === true, 'A.1: 有效材料片段顺利通过准入校验');

    // 2. Generate suggestion
    const suggestion = generateMaterialSupplementation(targetBlock, [snipA], {
      customPrompt: '结合所选案例补充本段工作做法',
      task,
      currentDraft: workingDraft,
    });

    assert(suggestion.isMaterialSupplementation === true, 'A.2: 建议明确标记为材料驱动补写 isMaterialSupplementation');
    assert(suggestion.suggestedText.includes('便民服务分时段精准预约'), 'A.3: 候选包含所选材料支持的具体预约做法');
    assert(suggestion.suggestedText.includes('1500人次'), 'A.4: 候选包含经核准的真实数据指标“1500人次”');
    assert(targetBlock.content !== suggestion.suggestedText, 'A.5: 候选生成后当前正文严密保持不变（生成不改草稿正文）');
    assert(workingDraft.blocks[0].content === otherBlockBefore, 'A.6: 其他段落（第1段）正文完好不变');
    assert(suggestion.adoptedEvidences !== undefined && suggestion.adoptedEvidences.length === 1, 'A.7: 候选捕获了采纳存证依据快照');
    assert(suggestion.adoptedEvidences![0].sourceDocName === snipA.docName, 'A.8: 存证来源文档名称准确');
    assert(suggestion.adoptedEvidences![0].contentFingerprint.startsWith('MAT-FP-'), 'A.9: 存证包含确定性指纹信息');
  }

  // ================================================================
  // B. 材料变化
  // ================================================================
  console.log('\n>>> [验收用例 B] 材料变化 (预约服务 vs 集中采购两套材料内容不同，真实输入无写死回退):');
  {
    const task = createTestTaskWithCases();
    const workingDraft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    const targetBlock = workingDraft.blocks[1];
    const snipA = task.snippets.find((s) => s.id === 'SNIP-APPOINT-01')!;
    const snipB = task.snippets.find((s) => s.id === 'SNIP-PROCURE-01')!;

    const resA = generateMaterialSupplementation(targetBlock, [snipA], { task, currentDraft: workingDraft });
    const resB = generateMaterialSupplementation(targetBlock, [snipB], { task, currentDraft: workingDraft });

    assert(resA.suggestedText !== resB.suggestedText, 'B.1: 预约服务与集中采购两套材料生成的补写候选内容实际不同');
    assert(resA.suggestedText.includes('便民服务') && !resA.suggestedText.includes('集中带量采购'), 'B.2: 预约服务材料未混入集中采购内容');
    assert(resB.suggestedText.includes('集中带量采购') && !resB.suggestedText.includes('便民服务分时段'), 'B.3: 集中采购材料未混入预约服务内容');
    assert(!resA.suggestedText.includes('跟踪台账与周调度闭环机制') && !resB.suggestedText.includes('跟踪台账与周调度闭环机制'), 'B.4: 两套材料均未产生虚构的固定闭环机制模板');

    // Dynamic number verification: change value to 3680
    const customSnip: EvidenceSnippet = {
      ...snipA,
      id: 'SNIP-APPOINT-CUSTOM',
      text: '创新推出“便民服务分时段精准预约”新模式，累计提供预约办理3680人次。',
    };
    const customFact: Fact = {
      id: 'FACT-APPOINT-CUSTOM',
      metric: '便民预约办理',
      period: '2026年1至9月',
      value: '3680',
      unit: '人次',
      metricScope: '政务大厅便民预约口径',
      primaryEvidenceId: 'SNIP-APPOINT-CUSTOM',
      evidenceIds: ['SNIP-APPOINT-CUSTOM'],
      hasConflict: false,
      status: 'confirmed',
    };
    const taskCustom = {
      ...task,
      snippets: [...task.snippets, customSnip],
      facts: [...task.facts, customFact],
    };
    const cleanTargetBlock = workingDraft.blocks[0]; // 第1段（不包含16场与800人次）
    const resCustom = generateMaterialSupplementation(cleanTargetBlock, [customSnip], {
      task: taskCustom,
      currentDraft: workingDraft,
    });
    assert(resCustom.suggestedText.includes('3680人次'), 'B.5: 替换材料数值后结果忠实使用真实输入“3680人次”');
    assert(!resCustom.suggestedText.includes('16场') && !resCustom.suggestedText.includes('800人次'), 'B.6: 无 16/800 等硬编码写死回退');
  }

  // ================================================================
  // C. 不合格依据
  // ================================================================
  console.log('\n>>> [验收用例 C] 不合格依据 (文风/跨期/排除/无材料阻断生成，材料库无有效材料时提供前往入口):');
  {
    const task = createTestTaskWithCases();
    const workingDraft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    const targetBlock = workingDraft.blocks[1];

    // 1. Style document
    const snipStyle = task.snippets.find((s) => s.id === 'SNIP-STYLE-01')!;
    const admStyle = validateMaterialForSupplementation(task, snipStyle, workingDraft);
    assert(admStyle.eligible === false, 'C.1: 历史文风材料被严密判定为不可作为补写事实依据');
    assert(admStyle.reason!.includes('文风'), 'C.2: 明确提示属于历史文风材料');

    // 2. Excluded document
    const snipExcluded = task.snippets.find((s) => s.id === 'SNIP-EXCLUDED-01')!;
    const admExcluded = validateMaterialForSupplementation(task, snipExcluded, workingDraft);
    assert(admExcluded.eligible === false, 'C.3: 已排除文档被判定为不可用');
    assert(admExcluded.reason!.includes('排除'), 'C.4: 明确提示来源文档已排除');

    // 3. Cross-period document
    const snipCross = task.snippets.find((s) => s.id === 'SNIP-CROSS-01')!;
    const admCross = validateMaterialForSupplementation(task, snipCross, workingDraft);
    assert(admCross.eligible === false, 'C.5: 跨期历史材料被判定为不可用');
    assert(admCross.reason!.includes('跨期'), 'C.6: 明确提示统计期间不匹配');

    // 4. No material selected
    const resEmpty = generateMaterialSupplementation(targetBlock, [], { task, currentDraft: workingDraft });
    assert(resEmpty.suggestedText === targetBlock.content, 'C.7: 未选择材料时严格保留原文不改变正文');
    assert(resEmpty.diffExplanation.includes('未勾选') || resEmpty.diffExplanation.includes('未指定'), 'C.8: 给出未勾选/未指定有效材料的说明');

    // 5. Test UI Modal without valid materials
    let navigatedStage = '';
    const taskWithoutMaterials: Task = {
      ...task,
      snippets: [snipStyle, snipExcluded],
    };
    const { container, unmount } = mountTestComponent(
      <MaterialSupplementModal
        isOpen={true}
        onClose={() => {}}
        task={taskWithoutMaterials}
        currentDraft={workingDraft}
        activeBlock={targetBlock}
        activeRole="主笔甲"
        onViewSnippet={() => {}}
        onSelectStage={(stg) => { navigatedStage = stg; }}
        onSupplementSuccess={() => {}}
      />
    );

    const goToBtn = container.querySelector('[data-testid="btn-go-to-materials"]') as HTMLButtonElement;
    assert(goToBtn !== null, 'C.9: 无可用有效材料时提供前往材料与事实页面入口按钮');
    act(() => {
      goToBtn.click();
    });
    assert(navigatedStage === 'material_fact', 'C.10: 点击前往材料与事实页面正确跳转至 material_fact');
    unmount();
  }

  // ================================================================
  // D. 未核准量化阻断
  // ================================================================
  console.log('\n>>> [验收用例 D] 未核准量化阻断 (材料含未核准数值或口径不符时阻断生成):');
  {
    const task = createTestTaskWithCases();
    const workingDraft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    const targetBlock = workingDraft.blocks[1];

    // Snippet with unverified number 98.6%
    const unverifiedSnippet: EvidenceSnippet = {
      id: 'SNIP-UNVERIFIED-NUM',
      sourceDocId: 'DOC-APPOINT-01',
      docName: '政务大厅推行便民服务预约制工作总结',
      location: '第4段',
      period: '2026年1至9月',
      text: '预约满意率达到98.6%，群众获得感显著提升。',
    };

    const taskWithUnverified = {
      ...task,
      snippets: [...task.snippets, unverifiedSnippet],
    };

    const claimCheck = validateSelectedMaterialsQuantitativeClaims(taskWithUnverified, [unverifiedSnippet]);
    assert(claimCheck.valid === false, 'D.1: 准确检测出未核准的量化主张“98.6%”');
    assert(claimCheck.reason!.includes('未核准的量化指标'), 'D.2: 明确说明未在事实库中找到对应核准记录');

    const resUnverified = generateMaterialSupplementation(targetBlock, [unverifiedSnippet], {
      task: taskWithUnverified,
      currentDraft: workingDraft,
    });
    assert(resUnverified.suggestedText === targetBlock.content, 'D.3: 量化主张未核准时安全阻断生成，原文完全保持不变');
    assert(resUnverified.diffExplanation.includes('量化指标'), 'D.4: 明确提示先在材料与事实页面完成核准登记');
  }

  // ================================================================
  // E. 快照依据与最新事实不一致 & 采纳前失效
  // ================================================================
  console.log('\n>>> [验收用例 E] 快照依据与最新事实不一致 (采纳前依据变动/核准快照不一致安全阻断):');
  {
    const task = createTestTaskWithCases();
    const workingDraft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    const targetBlock = workingDraft.blocks[1];
    const snipA = task.snippets.find((s) => s.id === 'SNIP-APPOINT-01')!;

    const suggestion = generateMaterialSupplementation(targetBlock, [snipA], { task, currentDraft: workingDraft });

    // 1. Valid before any change
    const validCheck = validateParagraphSuggestionAcceptance({
      task,
      currentDraft: workingDraft,
      suggestion,
      pendingTextToAdopt: suggestion.suggestedText,
      activeCompletedRunId: suggestion.runId,
      activeRole: '主笔甲',
    });
    assert(validCheck.valid === true, 'E.1: 依据材料完好且快照一致时，采纳校验通过');

    // 2. Document excluded afterwards
    const taskWithDocExcluded: Task = {
      ...task,
      documents: task.documents.map((d) => d.id === 'DOC-APPOINT-01' ? { ...d, excluded: true } : d),
    };
    const checkExcluded = validateParagraphSuggestionAcceptance({
      task: taskWithDocExcluded,
      currentDraft: workingDraft,
      suggestion,
      pendingTextToAdopt: suggestion.suggestedText,
      activeCompletedRunId: suggestion.runId,
      activeRole: '主笔甲',
    });
    assert(checkExcluded.valid === false, 'E.2: 采纳前文档被排除时，旧建议安全失效');
    assert(checkExcluded.reason!.includes('已被排除'), 'E.3: 给出来源文档已被排除的失效说明');

    // 3. Document deleted afterwards
    const taskWithDocDeleted: Task = {
      ...task,
      documents: task.documents.filter((d) => d.id !== 'DOC-APPOINT-01'),
    };
    const checkDeleted = validateParagraphSuggestionAcceptance({
      task: taskWithDocDeleted,
      currentDraft: workingDraft,
      suggestion,
      pendingTextToAdopt: suggestion.suggestedText,
      activeCompletedRunId: suggestion.runId,
      activeRole: '主笔甲',
    });
    assert(checkDeleted.valid === false, 'E.4: 采纳前文档被删除时，旧建议安全失效');
    assert(checkDeleted.reason!.includes('已被删除'), 'E.5: 给出来源文档已被删除的失效说明');

    // 4. Snippet text modified in material library afterwards
    const taskWithSnipEdited: Task = {
      ...task,
      snippets: task.snippets.map((s) => s.id === 'SNIP-APPOINT-01' ? { ...s, text: s.text + '（补充修订）' } : s),
    };
    const checkEdited = validateParagraphSuggestionAcceptance({
      task: taskWithSnipEdited,
      currentDraft: workingDraft,
      suggestion,
      pendingTextToAdopt: suggestion.suggestedText,
      activeCompletedRunId: suggestion.runId,
      activeRole: '主笔甲',
    });
    assert(checkEdited.valid === false, 'E.6: 采纳前材料片段原文被修改时，旧建议安全失效');
    assert(checkEdited.reason!.includes('已被编辑修改'), 'E.7: 给出材料原文与生成时不一致的失效提示');

    // 5. Fact snapshot hash mismatch
    const taskWithUpdatedFacts: Task = {
      ...task,
      factSnapshot: {
        hash: 'NEW-FACT-SNAPSHOT-HASH-999',
        capturedAt: new Date().toISOString(),
        items: [],
      },
    };
    const draftWithOldSnapshot: typeof workingDraft = {
      ...workingDraft,
      snapshotMetadata: {
        ...workingDraft.snapshotMetadata!,
        factSnapshot: {
          hash: 'OLD-FACT-SNAPSHOT-HASH-111',
          capturedAt: '2026-09-01T00:00:00Z',
          items: [],
        },
      },
    };
    const checkMismatch = validateParagraphSuggestionAcceptance({
      task: taskWithUpdatedFacts,
      currentDraft: draftWithOldSnapshot,
      suggestion,
      pendingTextToAdopt: suggestion.suggestedText,
      activeCompletedRunId: suggestion.runId,
      activeRole: '主笔甲',
    });
    assert(checkMismatch.valid === false, 'E.8: 事实快照版本差异时，阻断旧候选采纳并提示更新');
    assert(checkMismatch.reason!.includes('事实快照已更新'), 'E.9: 明确提示事实快照与草稿冻结依据存在版本差异');
  }

  // ================================================================
  // F. 确定性忠实生成与无假冒
  // ================================================================
  console.log('\n>>> [验收用例 F] 确定性忠实生成与无假冒 (段落完整可读，保护已有数据，不支持指令保留原文):');
  {
    const task = createTestTaskWithCases();
    const workingDraft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    const targetBlock = workingDraft.blocks[1];
    const snipA = task.snippets.find((s) => s.id === 'SNIP-APPOINT-01')!;

    // 1. Complete readable paragraph
    const suggestion = generateMaterialSupplementation(targetBlock, [snipA], { task, currentDraft: workingDraft });
    assert(suggestion.suggestedText.length > 50, 'F.1: 候选为完整、可读的段落正文');
    assert(!suggestion.suggestedText.startsWith('结合所选案例'), 'F.2: 未将主笔补写指令当成段落正文输出');
    assert(!suggestion.suggestedText.includes('请补材料'), 'F.3: 未输出“请补材料”敷衍完成');

    // 2. Unsupported instruction
    const unsupportedPrompt = '生成一段AI科幻小说并随意发挥';
    assert(isSupportedSupplementPrompt(unsupportedPrompt) === false, 'F.4: 准确检测出不支持的指令');
    const resUnsupported = generateMaterialSupplementation(targetBlock, [snipA], {
      customPrompt: unsupportedPrompt,
      task,
      currentDraft: workingDraft,
    });
    assert(resUnsupported.suggestedText === targetBlock.content, 'F.5: 不支持的指令严格保留原文');
    assert(resUnsupported.diffExplanation.includes('模拟限制'), 'F.6: 明确说明本地确定性模拟限制，不假装执行成功');

    // 3. Existing numbers protected in original text
    const originalNumbers = targetBlock.content.match(/\d+[\u4e00-\u9fa5%]+/g) || [];
    for (const num of originalNumbers) {
      assert(suggestion.suggestedText.includes(num), `F.7: 原文已有量化指标【${num}】在补写后得到严格保护保留`);
    }
  }

  // ================================================================
  // G. 存证与导出
  // ================================================================
  console.log('\n>>> [验收用例 G] 存证与导出 (证据快照完整，正文与依据导出区分明确，未采用不计入):');
  {
    const task = createTestTaskWithCases();
    const workingDraft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    const targetBlock = workingDraft.blocks[1];
    const snipA = task.snippets.find((s) => s.id === 'SNIP-APPOINT-01')!;

    const suggestion = generateMaterialSupplementation(targetBlock, [snipA], { task, currentDraft: workingDraft });
    const adoptRes = adoptParagraphSuggestion({
      task,
      currentDraft: workingDraft,
      suggestion,
      pendingTextToAdopt: suggestion.suggestedText,
      activeCompletedRunId: suggestion.runId,
      activeRole: '主笔甲',
    });

    const adoptedBlock = adoptRes.targetBlock;
    assert(adoptedBlock.adoptedEvidences !== undefined && adoptedBlock.adoptedEvidences.length === 1, 'G.1: 采纳后段落保存了实际采用的证据存证');
    const evRecord = adoptedBlock.adoptedEvidences![0];
    assert(evRecord.evidenceId === snipA.id, 'G.2: 存证证据ID准确');
    assert(evRecord.sourceDocId === snipA.sourceDocId, 'G.3: 存证源文档ID准确');
    assert(evRecord.snippetText === snipA.text, 'G.4: 存证冻结采纳时材料原文准确');
    assert(evRecord.contentFingerprint.startsWith('MAT-FP-'), 'G.5: 存证证据指纹准确');

    // Draft with adopted block for export
    const draftWithEv: typeof workingDraft = {
      ...workingDraft,
      blocks: workingDraft.blocks.map((b) => b.id === targetBlock.id ? adoptedBlock : b),
    };

    // Export with includeEvidence: true
    const txtWithEv = exportDocumentAsTxt(task, draftWithEv, { includeBody: true, includeEvidence: true, includeReviewLog: false });
    assert(txtWithEv.includes('>>> 材料补写依据：'), 'G.6: 导出包含依据时明确展示材料补写出处');
    assert(txtWithEv.includes(snipA.docName), 'G.7: 导出包含材料来源文档名称');
    assert(txtWithEv.includes('便民服务分时段精准预约'), 'G.8: 导出包含冻结原文引用');

    // Export with includeEvidence: false
    const txtWithoutEv = exportDocumentAsTxt(task, draftWithEv, { includeBody: true, includeEvidence: false, includeReviewLog: false });
    assert(!txtWithoutEv.includes('>>> 材料补写依据：'), 'G.9: 默认不含依据导出不夹带内部补写依据标记');
    assert(!txtWithoutEv.includes('SNIP-APPOINT-01'), 'G.10: 默认正文导出不包含内部片段ID');
  }

  // ================================================================
  // H. 采纳与安全撤销
  // ================================================================
  console.log('\n>>> [验收用例 H] 采纳与安全撤销 (材料补写来源标识，采纳原样写入，撤销恢复依据，保守阻断):');
  {
    const task = createTestTaskWithCases();
    const workingDraft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    const targetBlock = workingDraft.blocks[1];
    const snipA = task.snippets.find((s) => s.id === 'SNIP-APPOINT-01')!;

    const suggestion = generateMaterialSupplementation(targetBlock, [snipA], { task, currentDraft: workingDraft });

    // Ensure review comments exist
    assert(task.reviewComments.length > 0, 'H.1: 任务中包含既有审阅意见');
    const commentStatusBefore = task.reviewComments[0].status;

    // Adopt
    const adoptRes = adoptParagraphSuggestion({
      task,
      currentDraft: workingDraft,
      suggestion,
      pendingTextToAdopt: suggestion.suggestedText,
      activeCompletedRunId: suggestion.runId,
      activeRole: '主笔甲',
    });

    const taskAfterAdopt = adoptRes.updatedTask;
    const log = adoptRes.logEntry;
    assert(log.source === 'material_supplementation', 'H.2: 修改日志来源严格记录为 material_supplementation');
    assert(log.isMaterialSupplementation === true, 'H.3: 日志中 isMaterialSupplementation 为 true');
    assert(log.isReviewerReplacement === false, 'H.4: 严格与审阅替换稿区分 (isReviewerReplacement 为 false)');
    assert(taskAfterAdopt.reviewComments[0].status === commentStatusBefore, 'H.5: 材料入口发起的补写采纳未将未关联审阅意见误标记为已落实');

    // Safe Undo eligibility
    const undoEligibility = validateUndoEligibility(taskAfterAdopt, adoptRes.workingDraft, log.id, '主笔甲');
    assert(undoEligibility.canUndo === true, 'H.6: 采纳后立即校验安全撤销准入通过');

    // Execute safe undo
    const undoRes = undoSafeParagraphModification(taskAfterAdopt, adoptRes.workingDraft, log.id, '主笔甲');
    assert(undoRes.targetBlock.content === targetBlock.content, 'H.7: 撤销后段落正文完整恢复为修改前原文');
    assert(
      !undoRes.targetBlock.adoptedEvidences || undoRes.targetBlock.adoptedEvidences.length === 0,
      'H.8: 撤销后采纳的材料补写依据完整撤回，无遗留引用'
    );
    assert(undoRes.undoneLog.status === 'undone', 'H.9: 撤销记录标记为 undone');

    // Conservative undo blocking if subsequently modified
    const blockModifiedLater = {
      ...adoptRes.targetBlock,
      content: adoptRes.targetBlock.content + '（后续被主笔手工编辑）',
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    };
    const draftModifiedLater = {
      ...adoptRes.workingDraft,
      blocks: adoptRes.workingDraft.blocks.map((b) => b.id === targetBlock.id ? blockModifiedLater : b),
    };
    const undoBlockedCheck = validateUndoEligibility(taskAfterAdopt, draftModifiedLater, log.id, '主笔甲');
    assert(undoBlockedCheck.canUndo === false, 'H.10: 段落后续被手工修改后，安全撤销保守阻断');
    assert(undoBlockedCheck.reason!.includes('后续最新正文') || undoBlockedCheck.reason!.includes('已被后续人工编辑'), 'H.11: 给出明确的后续修改阻断说明');
  }

  // ================================================================
  // I. 界面与交互规范
  // ================================================================
  console.log('\n>>> [验收用例 I] 界面与交互规范 (辅助面板入口、弹窗仅改第N段、Tab循环、Escape按键):');
  {
    const task = createTestTaskWithCases();
    const workingDraft = task.drafts.find((d) => d.id === task.currentDraftId)!;
    const targetBlock = workingDraft.blocks[1];

    let generatedSuggestion: RevisionSuggestion | null = null;
    let isModalOpen = true;

    const { container, unmount } = mountTestComponent(
      <MaterialSupplementModal
        isOpen={isModalOpen}
        onClose={() => { isModalOpen = false; }}
        task={task}
        currentDraft={workingDraft}
        activeBlock={targetBlock}
        activeRole="主笔甲"
        onViewSnippet={() => {}}
        onSelectStage={() => {}}
        onSupplementSuccess={(sug) => { generatedSuggestion = sug; }}
      />
    );

    // 1. Scope notice banner
    const scopeNotice = container.querySelector('[data-testid="label-scope-notice"]');
    assert(scopeNotice !== null && scopeNotice.textContent!.includes('本次仅修改第 2 段'), 'I.1: 弹窗明确显示“本次仅修改第 2 段”');

    // 2. Original block content preview
    const preview = container.querySelector('[data-testid="current-block-content-preview"]');
    assert(preview !== null && preview.textContent!.trim() === targetBlock.content.trim(), 'I.2: 弹窗完整展示当前段落基准原文');

    // 3. Snippet selection checkboxes
    const checkboxA = container.querySelector('[data-testid="checkbox-select-snippet-SNIP-APPOINT-01"]') as HTMLButtonElement;
    assert(checkboxA !== null, 'I.3: 找到预约服务材料片段勾选框');

    act(() => {
      checkboxA.click();
    });

    const countBadge = container.querySelector('[data-testid="selected-snippets-count-badge"]');
    assert(countBadge !== null && countBadge.textContent!.includes('已选 1 项'), 'I.4: 勾选后已选材料计数器准确更新为1项');

    // 4. Clear selection
    const clearBtn = container.querySelector('[data-testid="btn-clear-selected-snippets"]') as HTMLButtonElement;
    assert(clearBtn !== null, 'I.5: 提供清空已选材料按钮');
    act(() => {
      clearBtn.click();
    });
    const countBadgeAfterClear = container.querySelector('[data-testid="selected-snippets-count-badge"]');
    assert(countBadgeAfterClear !== null && countBadgeAfterClear.textContent!.includes('已选 0 项'), 'I.6: 点击清空后已选材料准确清零');

    // Re-select snipA
    act(() => {
      checkboxA.click();
    });

    // 5. Instruction input
    const inputEl = container.querySelector('[data-testid="input-supplement-instruction"]') as HTMLTextAreaElement;
    assert(inputEl !== null, 'I.7: 渲染主笔补写要求输入框');

    // 6. Escape key handler
    act(() => {
      const escEvent = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      dom.window.dispatchEvent(escEvent);
    });
    assert(isModalOpen === false, 'I.8: 真实触发 Escape 键盘按键关闭材料补写弹窗');

    unmount();
  }

  // ================================================================
  // J. 同一 App 完整闭环
  // ================================================================
  console.log('\n>>> [验收用例 J] 同一 App 完整闭环 (挂载App→段落选材料补写→微调→宽屏对比→采纳写入→查看存证→安全撤销):');
  {
    const initialTask = createTestTaskWithCases();
    initialTask.currentStage = 'drafting';
    // Persist as active task
    savePersistedState([initialTask], initialTask.id, '主笔甲');

    const { container, unmount } = mountTestComponent(<App />);

    // 1. Enter drafting stage if not already
    const draftingBtn = container.querySelector('[data-testid="tab-stage-drafting"]') as HTMLButtonElement;
    if (draftingBtn) {
      act(() => {
        draftingBtn.click();
      });
    }

    // 2. Select paragraph 2
    const blockCard2 = container.querySelector('[data-testid="block-card-BLK-02"]') as HTMLElement;
    assert(blockCard2 !== null, 'J.1: App 起草工作区成功渲染第2段卡片');
    act(() => {
      blockCard2.click();
    });

    // 3. Open Material Supplementation Modal
    const openSupplementBtn = container.querySelector('[data-testid="btn-open-material-supplement"]') as HTMLButtonElement;
    assert(openSupplementBtn !== null, 'J.2: 辅助面板中提供“依据材料补写第 2 段”专属入口');

    act(() => {
      openSupplementBtn.click();
    });

    const modal = container.querySelector('[data-testid="material-supplement-modal"]');
    assert(modal !== null, 'J.3: 成功打开材料补写弹窗');

    // 4. Select Snippet A and submit
    const chk = container.querySelector('[data-testid="checkbox-select-snippet-SNIP-APPOINT-01"]') as HTMLButtonElement;
    assert(chk !== null, 'J.4: 弹窗中成功渲染有效材料片段勾选框');
    act(() => {
      chk.click();
    });

    const submitBtn = container.querySelector('[data-testid="btn-submit-material-supplement"]') as HTMLButtonElement;
    assert(submitBtn !== null && !submitBtn.disabled, 'J.5: 生成补写建议按钮使能可点击');

    await act(async () => {
      submitBtn.click();
      // wait for async generation delay
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    // 5. Suggestion editor rendered in inspector
    const suggestionSourceBadge = container.querySelector('[data-testid="badge-suggestion-source"]');
    assert(
      suggestionSourceBadge !== null && suggestionSourceBadge.textContent!.includes('材料补写建议（本地模拟）'),
      'J.6: 生成后建议来源明确展示为【材料补写建议（本地模拟）】'
    );

    // 6. View tabs in suggestion editor
    const tabMaterialText = container.querySelector('[data-testid="tab-material-text-view"]') as HTMLButtonElement;
    assert(tabMaterialText !== null, 'J.7: 提供“材料原文”视图切换标签');
    act(() => {
      tabMaterialText.click();
    });
    const matView = container.querySelector('[data-testid="view-material-text-content"]');
    assert(matView !== null && matView.textContent!.includes('便民服务分时段精准预约'), 'J.8: “材料原文”视图正确展示所选材料片段');

    const tabEvidence = container.querySelector('[data-testid="tab-adopted-evidence-view"]') as HTMLButtonElement;
    assert(tabEvidence !== null, 'J.9: 提供“涉及的依据”视图切换标签');
    act(() => {
      tabEvidence.click();
    });
    const evView = container.querySelector('[data-testid="view-adopted-evidence-content"]');
    assert(evView !== null && evView.textContent!.includes('MAT-FP-'), 'J.10: “涉及的依据”视图展示确定性指纹出处');

    // 7. Fine-tuning in editor
    const tabEditor = container.querySelector('[data-testid="tab-editor-view"]') as HTMLButtonElement;
    assert(tabEditor !== null, 'J.11: 找到待采纳文本编辑标签');
    act(() => {
      tabEditor.click();
    });

    const textareaPending = container.querySelector('[data-testid="textarea-pending-text"]') as HTMLTextAreaElement;
    assert(textareaPending !== null, 'J.12: 找到待采纳文本编辑框');

    const fineTunedText = textareaPending.value + '（经主笔结合实际进一步微调完善）';
    act(() => {
      simulateTextareaChange(textareaPending, fineTunedText);
    });

    const fineTunedBadge = container.querySelector('[data-testid="badge-fine-tuned"]');
    assert(fineTunedBadge !== null, 'J.13: 编辑后动态呈现【已人工微调】标识');

    // 8. Open Wide Review Modal
    const openWideBtn = container.querySelector('[data-testid="btn-open-wide-modal"]') as HTMLButtonElement;
    assert(openWideBtn !== null, 'J.14: 找到宽屏评审按钮');
    act(() => {
      openWideBtn.click();
    });

    const wideModal = container.querySelector('[data-testid="modal-wide-suggestion-review"]');
    assert(wideModal !== null, 'J.15: 宽屏评审弹窗成功展开');

    // Close wide modal with Esc
    act(() => {
      const escEvent = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      dom.window.dispatchEvent(escEvent);
    });

    // 9. Adopt suggestion into draft
    const adoptBtn = container.querySelector('[data-testid="btn-adopt-suggestion"]') as HTMLButtonElement;
    assert(adoptBtn !== null && !adoptBtn.disabled, 'J.16: 找到并使能采纳建议按钮');

    act(() => {
      adoptBtn.click();
    });

    const blockCard2Updated = container.querySelector('[data-testid="block-card-BLK-02"]') as HTMLElement;
    assert(blockCard2Updated.textContent!.includes('经主笔结合实际进一步微调完善'), 'J.17: 采纳后第2段正文真实更新为微调后文本');

    // Check block 1 unchanged
    const blockCard1 = container.querySelector('[data-testid="block-card-BLK-01"]') as HTMLElement;
    assert(!blockCard1.textContent!.includes('经主笔结合实际进一步微调完善'), 'J.18: 其他段落（第1段）正文完好不变');

    // 11. Open Recent Modifications Modal to check evidentiary log
    const openLogsBtn = container.querySelector('[data-testid="btn-open-recent-modifications"]') as HTMLButtonElement;
    assert(openLogsBtn !== null, 'J.19: 找到最近修改存证记录按钮');
    act(() => {
      openLogsBtn.click();
    });

    const logBadge = container.querySelector('[data-testid^="badge-log-source-"]');
    assert(logBadge !== null && logBadge.textContent!.includes('材料补写微调采纳'), 'J.20: 修改记录弹窗中明确展示【材料补写微调采纳】存证徽章');

    // 12. Safe Undo from Recent Modifications Modal
    const undoBtn = container.querySelector('[data-testid^="btn-undo-log-"]') as HTMLButtonElement;
    assert(undoBtn !== null && !undoBtn.disabled, 'J.21: 弹窗中撤销按钮可用');

    act(() => {
      undoBtn.click();
    });

    // Close modal
    const closeLogsBtn = container.querySelector('[data-testid="btn-close-modifications-modal"]') as HTMLButtonElement;
    if (closeLogsBtn) {
      act(() => {
        closeLogsBtn.click();
      });
    }

    // 13. Verify block 2 content restored to baseline
    const blockCard2Restored = container.querySelector('[data-testid="block-card-BLK-02"]') as HTMLElement;
    assert(!blockCard2Restored.textContent!.includes('经主笔结合实际进一步微调完善'), 'J.22: 撤销后微调补写内容成功从正文中撤回');
    assert(blockCard2Restored.textContent!.includes(initialTask.drafts[0].blocks[1].content), 'J.23: 撤销后正文精确恢复为修改前基准原文');

    unmount();
  }

  // ================================================================
  // K. 6 组专项问题回归验证 (材料准入、采纳重验、跨任务回填、结构与灾备、撤销安全、无依据成效)
  // ================================================================
  console.log('\n>>> [验收用例 K] 6 组专项问题回归验证 (P1/P2 六项复核):');
  {
    // K.1: 材料准入严格校验：一季度任务拒收二季度材料、工程验收vs培训、800人vs800人次、10分钟核准
    console.log('--- K.1 材料准入严格校验 ---');
    const q1Task: Task = {
      ...createTestTaskWithCases(),
      startDate: '2026-01-01',
      endDate: '2026-03-31',
    };
    const q2Doc: SourceDocument = {
      id: 'DOC-Q2-01',
      name: '2026年第二季度重点工作总结',
      usage: 'current_fact',
      period: '2026年二季度',
      fileType: 'txt',
      parseStatus: 'parsed',
      source: '业务科',
      content: '二季度工作',
      excluded: false,
    };
    const q2Snip: EvidenceSnippet = {
      id: 'SNIP-Q2-01',
      sourceDocId: 'DOC-Q2-01',
      docName: '2026年第二季度重点工作总结',
      location: '第1段',
      period: '2026年二季度',
      text: '创新推进重点工程协同保障机制，高标准落实各项举措。',
    };
    const q1TaskWithQ2 = {
      ...q1Task,
      documents: [...q1Task.documents, q2Doc],
      snippets: [...q1Task.snippets, q2Snip],
    };
    const checkQ2 = validateMaterialForSupplementation(q1TaskWithQ2, q2Snip);
    assert(checkQ2.eligible === false, 'K.1.1: 一季度公文任务严格拒收同年二季度材料准入');
    assert(checkQ2.reason!.includes('跨期不符'), 'K.1.2: 明确提示材料统计期间与一季度任务跨期不符');

    // “工程验收16场”匹配到“培训16场”阻断
    const trainingFactTask: Task = {
      ...createTestTaskWithCases(),
      facts: [
        {
          id: 'FACT-TRAIN-16',
          metric: '组织专题培训',
          period: '2026年1至9月',
          value: '16',
          unit: '场',
          metricScope: '专业技能培训统计口径',
          primaryEvidenceId: 'SNIP-APPOINT-01',
          evidenceIds: ['SNIP-APPOINT-01'],
          sourceDocId: 'DOC-APPOINT-01',
          hasConflict: false,
          status: 'confirmed',
        },
      ],
    };
    const engSnippet: EvidenceSnippet = {
      id: 'SNIP-ENG-16',
      sourceDocId: 'DOC-APPOINT-01',
      docName: '工程质量监管总结',
      location: '第2段',
      period: '2026年1至9月',
      text: '抓牢安全生产底线，从严落实全过程监管，累计完成重大工程验收16场。',
    };
    const engClaimCheck = validateSelectedMaterialsQuantitativeClaims(trainingFactTask, [engSnippet]);
    assert(engClaimCheck.valid === false, 'K.1.3: “工程验收16场”不可错误匹配事实库中的“培训16场”');

    // “800人”匹配“800人次”阻断 (严格单位匹配)
    const personFactTask: Task = {
      ...createTestTaskWithCases(),
      facts: [
        {
          id: 'FACT-TRAIN-800',
          metric: '组织专业技能培训',
          period: '2026年1至9月',
          value: '800',
          unit: '人次',
          metricScope: '参训人员口径',
          primaryEvidenceId: 'SNIP-APPOINT-01',
          evidenceIds: ['SNIP-APPOINT-01'],
          sourceDocId: 'DOC-APPOINT-01',
          hasConflict: false,
          status: 'confirmed',
        },
      ],
    };
    const personSnippet: EvidenceSnippet = {
      id: 'SNIP-PERSON-800',
      sourceDocId: 'DOC-APPOINT-01',
      docName: '技能培训材料',
      location: '第1段',
      period: '2026年1至9月',
      text: '分级分类开展实操培训，累计参训人员达800人。',
    };
    const personClaimCheck = validateSelectedMaterialsQuantitativeClaims(personFactTask, [personSnippet]);
    assert(personClaimCheck.valid === false, 'K.1.4: “800人”与“800人次”严格区分单位，移除包含匹配');

    // “10分钟”核准检查（移除分钟豁免）
    const minuteSnippet: EvidenceSnippet = {
      id: 'SNIP-MIN-10',
      sourceDocId: 'DOC-APPOINT-01',
      docName: '便民服务总结',
      location: '第3段',
      period: '2026年1至9月',
      text: '创新推出分时段预约机制，群众平均等候时间压缩至10分钟以内。',
    };
    const minuteClaimWithoutFact = validateSelectedMaterialsQuantitativeClaims(createTestTaskWithCases(), [minuteSnippet]);
    assert(minuteClaimWithoutFact.valid === false, 'K.1.5: “10分钟”不再直接豁免跳过，无核准事实时阻断');
    assert(minuteClaimWithoutFact.unverifiedClaims!.some((c) => c.includes('10分钟')), 'K.1.6: 明确将“10分钟”作为未核准量化指标列出');

    // 带核准事实的“10分钟”通过校验
    const taskWith10MinFact: Task = {
      ...createTestTaskWithCases(),
      facts: [
        ...createTestTaskWithCases().facts,
        {
          id: 'FACT-MIN-10',
          metric: '平均等候时间',
          period: '2026年1至9月',
          value: '10',
          unit: '分钟',
          metricScope: '窗口便民服务统计口径',
          primaryEvidenceId: 'SNIP-MIN-10',
          evidenceIds: ['SNIP-MIN-10'],
          sourceDocId: 'DOC-APPOINT-01',
          hasConflict: false,
          status: 'confirmed',
        },
      ],
    };
    const minuteClaimWithFact = validateSelectedMaterialsQuantitativeClaims(taskWith10MinFact, [minuteSnippet]);
    assert(minuteClaimWithFact.valid === true, 'K.1.7: 登记核准的“10分钟”事实记录后顺利通过核验');

    // EVD-03 内置材料中的“2026年1至9月”不再误抽出“1至”
    const taskWithEvd03 = createTestTaskWithCases();
    const evd03 = taskWithEvd03.snippets.find((s) => s.id === 'EVD-03') || {
      id: 'EVD-03',
      sourceDocId: 'SRC-03',
      docName: '培训工作台账',
      location: '第5段',
      period: '2026年1至9月',
      text: '2026年1至9月，组织专题培训16场，累计参训800人次。',
    };
    const evd03Check = validateSelectedMaterialsQuantitativeClaims(taskWithEvd03, [evd03]);
    assert(evd03Check.valid === true, 'K.1.8: EVD-03 培训材料“2026年1至9月”未误抽出“1至”，有效材料顺利通过准入');

    // 同一文档中的“一季度城区培训16场”不可为“三季度农村培训16场”背书
    const docTrainMulti = {
      id: 'DOC-TRAIN-MULTI',
      name: '全市培训工作总结汇编',
      usage: 'current_fact' as const,
      period: '2026年度',
      fileType: 'txt' as const,
      parseStatus: 'parsed' as const,
      source: '宣教科',
      content: '培训汇编',
      excluded: false,
    };
    const snipQ1Urban: EvidenceSnippet = {
      id: 'SNIP-Q1-URBAN',
      sourceDocId: 'DOC-TRAIN-MULTI',
      docName: '全市培训工作总结汇编',
      location: '第1段',
      period: '2026年一季度',
      text: '一季度重点面向城区开展业务轮训，组织专题培训16场。',
    };
    const snipQ3Rural: EvidenceSnippet = {
      id: 'SNIP-Q3-RURAL',
      sourceDocId: 'DOC-TRAIN-MULTI',
      docName: '全市培训工作总结汇编',
      location: '第3段',
      period: '2026年三季度',
      text: '三季度深入基层一线服务，组织开展农村培训16场。',
    };
    const taskWithUrbanFact: Task = {
      ...createTestTaskWithCases(),
      documents: [...createTestTaskWithCases().documents, docTrainMulti],
      snippets: [...createTestTaskWithCases().snippets, snipQ1Urban, snipQ3Rural],
      facts: [
        ...createTestTaskWithCases().facts,
        {
          id: 'FACT-Q1-URBAN-16',
          metric: '组织专题培训',
          period: '2026年一季度',
          value: '16',
          unit: '场',
          metricScope: '城区口径',
          primaryEvidenceId: 'SNIP-Q1-URBAN',
          evidenceIds: ['SNIP-Q1-URBAN'],
          sourceDocId: 'DOC-TRAIN-MULTI',
          hasConflict: false,
          status: 'confirmed',
        },
      ],
    };
    const ruralCheck = validateSelectedMaterialsQuantitativeClaims(taskWithUrbanFact, [snipQ3Rural]);
    assert(ruralCheck.valid === false, 'K.1.9: 同一文档中的“一季度城区培训16场”不可为“三季度农村培训16场”背书，口径期间范围不一致安全阻断');

    // 采纳前依据完整重验亦严格阻断口径不一致的材料
    const workingDraftUrban = taskWithUrbanFact.drafts[0];
    const targetBlockUrban = workingDraftUrban.blocks[1];
    const suggestionRural = generateMaterialSupplementation(targetBlockUrban, [snipQ3Rural], {
      task: taskWithUrbanFact,
      currentDraft: workingDraftUrban,
    });
    const checkRuralAdoption = validateParagraphSuggestionAcceptance({
      task: taskWithUrbanFact,
      currentDraft: workingDraftUrban,
      suggestion: suggestionRural,
      pendingTextToAdopt: suggestionRural.suggestedText,
      activeCompletedRunId: suggestionRural.runId,
      activeRole: '主笔甲',
    });
    assert(checkRuralAdoption.valid === false, 'K.1.10: 采纳校验严格阻断口径不一致的材料依据');

    // 期间等价格式严格一致（归一化起止日期一致）
    assert(arePeriodsStrictlyIdentical('2026年一季度', '2026年1至3月') === true, 'K.1.11: 2026年一季度 与 2026年1至3月 等价格式判定为一致');
    assert(arePeriodsStrictlyIdentical('2026年前三季度', '2026年1至9月') === true, 'K.1.12: 2026年前三季度 与 2026年1至9月 等价格式判定为一致');
    assert(arePeriodsStrictlyIdentical('2026年上半年', '2026年1至6月') === true, 'K.1.13: 2026年上半年 与 2026年1至6月 等价格式判定为一致');
    assert(arePeriodsStrictlyIdentical('2026年全年', '2026年度') === true, 'K.1.14: 2026年全年 与 2026年度 等价格式判定为一致');

    // 期间包含关系严格拒绝（起止日期不完全一致）
    assert(arePeriodsStrictlyIdentical('2026年1至3月', '2026年1至9月') === false, 'K.1.15: 2026年1至3月 与 2026年1至9月 包含关系拒绝判定为一致');
    assert(arePeriodsStrictlyIdentical('2026年1至9月', '2026年1至3月') === false, 'K.1.16: 2026年1至9月 与 2026年1至3月 包含关系拒绝判定为一致');
    assert(arePeriodsStrictlyIdentical('2026年全年', '2026年一季度') === false, 'K.1.17: 2026年全年 与 2026年一季度 包含关系拒绝判定为一致');

    // 期间部分重叠严格拒绝
    assert(arePeriodsStrictlyIdentical('2026年1至4月', '2026年3至6月') === false, 'K.1.18: 2026年1至4月 与 2026年3至6月 部分重叠拒绝判定为一致');
    assert(arePeriodsStrictlyIdentical('2026年2至5月', '2026年1至3月') === false, 'K.1.19: 2026年2至5月 与 2026年1至3月 部分重叠拒绝判定为一致');

    // 期间完全不相交严格拒绝
    assert(arePeriodsStrictlyIdentical('2026年1至3月', '2026年4至6月') === false, 'K.1.20: 2026年1至3月 与 2026年4至6月 完全不相交拒绝判定为一致');
    assert(arePeriodsStrictlyIdentical('2025年', '2026年') === false, 'K.1.21: 2025年 与 2026年 跨年份完全不相交拒绝判定为一致');

    // P1 问题1：无法识别的期间仍被兜底解析为全年
    assert(arePeriodsStrictlyIdentical('2026年1季度', '2026年2季度') === false, 'K.1.21a: 2026年1季度 与 2026年2季度 严格判定不一致');
    assert(arePeriodsStrictlyIdentical('2026年待确认', '2026年度') === false, 'K.1.21b: 未知格式 2026年待确认 严禁兜底解析为全年，与 2026年度 判定不一致');
    assert(arePeriodsStrictlyIdentical('2026年待确认', '2026年待确认') === false, 'K.1.21c: 未知格式均返回解析失败，严禁相同未识别字符串直接放行');
    assert(parsePeriodDateRange('2026年待确认') === null, 'K.1.21d: 无法识别的期间返回 null，严禁兜底返回全年');
    assert(parsePeriodDateRange('2026年2月30日') === null, 'K.1.21e: 不合法日历日期返回 null');
    assert(parsePeriodDateRange('2026年13月') === null, 'K.1.21f: 超出12个月的非法月份返回 null');
    assert(parsePeriodDateRange('2026年9月至3月') === null, 'K.1.21g: 起始时间晚于结束时间的非法区间返回 null');

    // P1 问题2：正文期间提取与元数据解析共用格式定义，移除硬编码2026年，避免误拦与错放
    // 场景1：事实、片段及正文均为 2026年1月，培训16场 -> 量化核验通过 (杜绝误阻断)
    const taskScenario1: Task = {
      ...createTestTaskWithCases(),
      facts: [
        {
          id: 'FACT-TEST-01',
          metric: '专题培训',
          period: '2026年1月',
          value: '16',
          unit: '场',
          metricScope: '专题培训口径',
          primaryEvidenceId: 'SNIP-TEST-01',
          evidenceIds: ['SNIP-TEST-01'],
          sourceDocId: 'DOC-TEST-01',
          hasConflict: false,
          status: 'confirmed',
        },
      ],
      documents: [
        {
          id: 'DOC-TEST-01',
          name: '1月份培训总结',
          period: '2026年1月',
          usage: 'current_fact',
          status: 'verified',
        },
      ],
      snippets: [
        {
          id: 'SNIP-TEST-01',
          sourceDocId: 'DOC-TEST-01',
          docName: '1月份培训总结',
          location: '第1段',
          period: '2026年1月',
          text: '2026年1月，组织专题培训16场。',
        },
      ],
    };
    const quantCheckS1 = validateSelectedMaterialsQuantitativeClaims(taskScenario1, taskScenario1.snippets);
    assert(quantCheckS1.valid === true, 'K.1.21h: 场景1 事实、片段及正文均为 2026年1月，培训16场，量化核验顺利通过');

    // 场景2：事实、片段标注全年，正文写“2026年1月，培训16场” -> 错误通过已修复，安全阻断
    const taskScenario2: Task = {
      ...createTestTaskWithCases(),
      facts: [
        {
          id: 'FACT-TEST-02',
          metric: '专题培训',
          period: '2026年度', // 标注全年
          value: '16',
          unit: '场',
          metricScope: '专题培训口径',
          primaryEvidenceId: 'SNIP-TEST-02',
          evidenceIds: ['SNIP-TEST-02'],
          sourceDocId: 'DOC-TEST-02',
          hasConflict: false,
          status: 'confirmed',
        },
      ],
      documents: [
        {
          id: 'DOC-TEST-02',
          name: '年度培训总结',
          period: '2026年度',
          usage: 'current_fact',
          status: 'verified',
        },
      ],
      snippets: [
        {
          id: 'SNIP-TEST-02',
          sourceDocId: 'DOC-TEST-02',
          docName: '年度培训总结',
          location: '第1段',
          period: '2026年度',
          text: '2026年1月，组织专题培训16场。', // 正文写1月，与事实全年矛盾
        },
      ],
    };
    const quantCheckS2 = validateSelectedMaterialsQuantitativeClaims(taskScenario2, taskScenario2.snippets);
    assert(quantCheckS2.valid === false, 'K.1.21i: 场景2 事实片段标注全年但正文明确写 2026年1月，量化核验安全阻断（杜绝错放）');

    // 场景3：事实、片段及正文均为 2026年4月15日至6月15日 -> 量化核验通过 (杜绝误阻断)
    const taskScenario3: Task = {
      ...createTestTaskWithCases(),
      facts: [
        {
          id: 'FACT-TEST-03',
          metric: '专题培训',
          period: '2026年4月15日至6月15日',
          value: '16',
          unit: '场',
          metricScope: '专题培训口径',
          primaryEvidenceId: 'SNIP-TEST-03',
          evidenceIds: ['SNIP-TEST-03'],
          sourceDocId: 'DOC-TEST-03',
          hasConflict: false,
          status: 'confirmed',
        },
      ],
      documents: [
        {
          id: 'DOC-TEST-03',
          name: '专项行动培训通报',
          period: '2026年4月15日至6月15日',
          usage: 'current_fact',
          status: 'verified',
        },
      ],
      snippets: [
        {
          id: 'SNIP-TEST-03',
          sourceDocId: 'DOC-TEST-03',
          docName: '专项行动培训通报',
          location: '第2段',
          period: '2026年4月15日至6月15日',
          text: '2026年4月15日至6月15日，组织专题培训16场。',
        },
      ],
    };
    const quantCheckS3 = validateSelectedMaterialsQuantitativeClaims(taskScenario3, taskScenario3.snippets);
    assert(quantCheckS3.valid === true, 'K.1.21j: 场景3 事实、片段及正文均为 2026年4月15日至6月15日，量化核验顺利通过');

    // 场景4：存在多个期间且无法确定指标归属时，提示人工核验并阻断
    const taskScenario4: Task = {
      ...createTestTaskWithCases(),
      facts: [
        {
          id: 'FACT-TEST-04',
          metric: '专题培训',
          period: '2026年1季度',
          value: '16',
          unit: '场',
          metricScope: '专题培训口径',
          primaryEvidenceId: 'SNIP-TEST-04',
          evidenceIds: ['SNIP-TEST-04'],
          sourceDocId: 'DOC-TEST-04',
          hasConflict: false,
          status: 'confirmed',
        },
      ],
      documents: [
        {
          id: 'DOC-TEST-04',
          name: '工作简报',
          period: '2026年上半年',
          usage: 'current_fact',
          status: 'verified',
        },
      ],
      snippets: [
        {
          id: 'SNIP-TEST-04',
          sourceDocId: 'DOC-TEST-04',
          docName: '工作简报',
          location: '第3段',
          period: '2026年上半年',
          text: '2026年1季度筹备，2026年2季度开展，共组织专题培训16场。',
        },
      ],
    };
    const quantCheckS4 = validateSelectedMaterialsQuantitativeClaims(taskScenario4, taskScenario4.snippets);
    assert(quantCheckS4.valid === false, 'K.1.21k: 存在多个期间且无法确定指标归属时，量化核验安全阻断');
    assert(quantCheckS4.reason?.includes('人工核验'), 'K.1.21l: 明确提示无法确定指标归属，请人工核验');

    // 独立复测场景：核准事实“2026年1至3月”与材料正文及片段“2026年1至9月”重叠但不完全一致
    const taskPeriodDiscrepancy: Task = {
      ...createTestTaskWithCases(),
      facts: [
        ...createTestTaskWithCases().facts.filter((f) => f.id !== 'FACT-APPOINT-01'),
        {
          id: 'FACT-APPOINT-01',
          metric: '便民预约办理',
          period: '2026年1至3月', // 核准事实仅一季度
          value: '1500',
          unit: '人次',
          metricScope: '政务大厅便民预约口径',
          primaryEvidenceId: 'SNIP-APPOINT-01',
          evidenceIds: ['SNIP-APPOINT-01'],
          sourceDocId: 'DOC-APPOINT-01',
          hasConflict: false,
          status: 'confirmed',
        },
      ],
    };
    const snipAppoint1To9 = taskPeriodDiscrepancy.snippets.find((s) => s.id === 'SNIP-APPOINT-01')!;
    // 片段与文档期间为 2026年1至9月
    const periodDiscrepancyQuantCheck = validateSelectedMaterialsQuantitativeClaims(taskPeriodDiscrepancy, [snipAppoint1To9]);
    assert(periodDiscrepancyQuantCheck.valid === false, 'K.1.22: 核准事实期间(1至3月)与材料片段期间(1至9月)重叠但不完全一致，准入校验安全阻断');

    const draftPeriodDiscrepancy = taskPeriodDiscrepancy.drafts[0];
    const suggestionPeriodDiscrepancy = generateMaterialSupplementation(
      draftPeriodDiscrepancy.blocks[1],
      [snipAppoint1To9],
      { task: taskPeriodDiscrepancy, currentDraft: draftPeriodDiscrepancy }
    );
    assert(suggestionPeriodDiscrepancy.isUnsupportedPrompt === true, 'K.1.23: 期间重叠但不一致时生成被安全阻断，保留原文');

    const checkPeriodDiscrepancyAdoption = validateParagraphSuggestionAcceptance({
      task: taskPeriodDiscrepancy,
      currentDraft: draftPeriodDiscrepancy,
      suggestion: {
        ...suggestionPeriodDiscrepancy,
        selectedSnippetIds: [snipAppoint1To9.id],
        adoptedEvidences: [
          {
            evidenceId: snipAppoint1To9.id,
            sourceDocId: snipAppoint1To9.sourceDocId,
            sourceDocName: snipAppoint1To9.docName,
            snippetLocation: snipAppoint1To9.location,
            snippetText: snipAppoint1To9.text,
            period: '2026年1至9月',
            usage: 'current_fact',
            associatedFactId: 'FACT-APPOINT-01',
            contentFingerprint: 'MAT-FP-TEST',
            capturedAt: new Date().toISOString(),
          },
        ],
      },
      pendingTextToAdopt: suggestionPeriodDiscrepancy.suggestedText,
      activeCompletedRunId: suggestionPeriodDiscrepancy.runId,
      activeRole: '主笔甲',
    });
    assert(checkPeriodDiscrepancyAdoption.valid === false, 'K.1.24: 期间重叠但不一致时采纳校验安全阻断');

    // K.2: 采纳前完整重验依据
    console.log('--- K.2 采纳前完整重验依据 ---');
    const taskBase = createTestTaskWithCases();
    const workingDraft = taskBase.drafts.find((d) => d.id === taskBase.currentDraftId)!;
    const targetBlock = workingDraft.blocks[1];
    const snipA = taskBase.snippets.find((s) => s.id === 'SNIP-APPOINT-01')!;
    const suggestionBase = generateMaterialSupplementation(targetBlock, [snipA], {
      task: taskBase,
      currentDraft: workingDraft,
    });

    // 正常生成候选 → 改变事实期间 → 采纳时按期间原因阻断（避免使用已被生成阶段阻断的候选验证采纳）
    assert(suggestionBase.isUnsupportedPrompt !== true, 'K.2.2a: 基础候选正常生成成功，非生成阻断产物');
    const taskChangedFactPeriod: Task = {
      ...taskBase,
      facts: taskBase.facts.map((f) =>
        f.id === 'FACT-APPOINT-01' ? { ...f, period: '2026年1至3月' } : f
      ),
    };
    const checkFactPeriodChanged = validateParagraphSuggestionAcceptance({
      task: taskChangedFactPeriod,
      currentDraft: workingDraft,
      suggestion: suggestionBase,
      pendingTextToAdopt: suggestionBase.suggestedText,
      activeCompletedRunId: suggestionBase.runId,
      activeRole: '主笔甲',
    });
    assert(checkFactPeriodChanged.valid === false, 'K.2.2b: 正常生成候选后改变事实期间（2026年1至3月 != 2026年1至9月），采纳时按期间原因安全阻断');
    assert(
      checkFactPeriodChanged.reason?.includes('统计期间') && checkFactPeriodChanged.reason?.includes('不一致'),
      'K.2.2c: 采纳校验明确提示关联事实统计期间与依据材料不一致的阻断原因'
    );

    // 来源改为 style_ref
    const taskStyleRef: Task = {
      ...taskBase,
      documents: taskBase.documents.map((d) => d.id === 'DOC-APPOINT-01' ? { ...d, usage: 'style_ref' as const } : d),
    };
    const checkStyleRef = validateParagraphSuggestionAcceptance({
      task: taskStyleRef,
      currentDraft: workingDraft,
      suggestion: suggestionBase,
      pendingTextToAdopt: suggestionBase.suggestedText,
      activeCompletedRunId: suggestionBase.runId,
      activeRole: '主笔甲',
    });
    assert(checkStyleRef.valid === false, 'K.2.1: 生成后来源文档变更为 style_ref 阻断采纳');

    // 来源改为旧年份 2025年
    const taskOldYear: Task = {
      ...taskBase,
      documents: taskBase.documents.map((d) => d.id === 'DOC-APPOINT-01' ? { ...d, period: '2025年' } : d),
    };
    const checkOldYear = validateParagraphSuggestionAcceptance({
      task: taskOldYear,
      currentDraft: workingDraft,
      suggestion: suggestionBase,
      pendingTextToAdopt: suggestionBase.suggestedText,
      activeCompletedRunId: suggestionBase.runId,
      activeRole: '主笔甲',
    });
    assert(checkOldYear.valid === false, 'K.2.2: 生成后来源文档变更为历史旧年份 2025年 阻断采纳');

    // 真实事实维护服务撤销核准、清空事实快照
    const taskRevoked = modifyOrExcludeFact(taskBase, 'FACT-APPOINT-01', { status: 'pending' }, '主笔甲').updatedTask!;
    assert(taskRevoked.factSnapshot === undefined, 'K.2.3: 真实事实维护服务撤销核准后清空了事实快照');
    const checkRevoked = validateParagraphSuggestionAcceptance({
      task: taskRevoked,
      currentDraft: workingDraft,
      suggestion: suggestionBase,
      pendingTextToAdopt: suggestionBase.suggestedText,
      activeCompletedRunId: suggestionBase.runId,
      activeRole: '主笔甲',
    });
    assert(checkRevoked.valid === false, 'K.2.4: 事实快照清空或核准撤销后采纳校验安全阻断');

    // K.3: 补写请求跨任务隔离
    console.log('--- K.3 补写请求跨任务隔离 ---');
    let taskASuccessCalled = false;
    let taskBSuccessCalled = false;
    const taskA = { ...createTestTaskWithCases(), id: 'TASK-ALPHA' };
    const taskB = { ...createTestTaskWithCases(), id: 'TASK-BETA' };

    const modalMount = mountTestComponent(
      <MaterialSupplementModal
        isOpen={true}
        onClose={() => {}}
        task={taskA}
        currentDraft={taskA.drafts[0]}
        activeBlock={taskA.drafts[0].blocks[1]}
        activeRole="主笔甲"
        onViewSnippet={() => {}}
        onSupplementSuccess={() => {
          taskASuccessCalled = true;
        }}
      />
    );

    // 实际选择材料：data-testid="checkbox-select-snippet-SNIP-APPOINT-01"
    const checkboxA = modalMount.container.querySelector('[data-testid="checkbox-select-snippet-SNIP-APPOINT-01"]') as HTMLButtonElement;
    assert(Boolean(checkboxA), 'K.3: 存在材料选择入口 checkbox-select-snippet-SNIP-APPOINT-01');
    act(() => {
      checkboxA.click();
    });

    // 点击生成：data-testid="btn-submit-material-supplement"
    const submitBtnA = modalMount.container.querySelector('[data-testid="btn-submit-material-supplement"]') as HTMLButtonElement;
    assert(Boolean(submitBtnA), 'K.3: 存在补写生成按钮 btn-submit-material-supplement');
    act(() => {
      submitBtnA.click();
    });

    // 确认运行：data-testid="supplement-generating-indicator"
    const generatingIndicator = modalMount.container.querySelector('[data-testid="supplement-generating-indicator"]');
    assert(Boolean(generatingIndicator), 'K.3: 确认进入运行中状态 supplement-generating-indicator');

    // 在请求进行中立即切换为 Task B
    modalMount.rerender(
      <MaterialSupplementModal
        isOpen={true}
        onClose={() => {}}
        task={taskB}
        currentDraft={taskB.drafts[0]}
        activeBlock={taskB.drafts[0].blocks[1]}
        activeRole="主笔甲"
        onViewSnippet={() => {}}
        onSupplementSuccess={() => {
          taskBSuccessCalled = true;
        }}
      />
    );

    // 等待原异步请求在异步 act 中完成
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    assert(taskASuccessCalled === false, 'K.3.1: Task A 的进行中请求已安全中止');
    assert(taskBSuccessCalled === false, 'K.3.2: 任务切换后未发生跨任务回填，Task A 补写未回填至 Task B');
    modalMount.unmount();

    // K.4: 新证据字段贯通容灾恢复与结构校验
    console.log('--- K.4 容灾恢复与结构校验 ---');
    // adoptedEvidences: [null] 结构损坏检测
    const corruptedTaskWithNull = {
      ...taskBase,
      drafts: [
        {
          ...workingDraft,
          blocks: [
            {
              ...workingDraft.blocks[0],
              adoptedEvidences: [null as any],
            },
          ],
        },
      ],
    };
    const structureValid = validateTaskStructure(corruptedTaskWithNull);
    assert(structureValid === false, 'K.4.1: adoptedEvidences: [null] 被准确识别为数据结构损坏');

    // 灾备恢复保留合法证据并隔离损坏项
    const validEvidenceRecord = {
      evidenceId: 'SNIP-APPOINT-01',
      sourceDocId: 'DOC-APPOINT-01',
      sourceDocName: '政务大厅推行便民服务预约制工作总结',
      snippetText: '创新推出“便民服务分时段精准预约”新模式',
      period: '2026年1至9月',
      usage: 'current_fact' as const,
      contentFingerprint: 'MAT-FP-TEST1234',
      capturedAt: new Date().toISOString(),
    };
    const corruptedPayload = JSON.stringify({
      schemaVersion: 2,
      currentTaskId: taskBase.id,
      tasks: [
        {
          ...taskBase,
          drafts: [
            {
              ...workingDraft,
              blocks: [
                {
                  ...workingDraft.blocks[0],
                  content: '第1段恢复测试正文。',
                  adoptedEvidences: [null, validEvidenceRecord],
                },
              ],
            },
          ],
        },
      ],
    });
    setStorageItem(BACKUP_CORRUPTED_KEY, corruptedPayload);
    const recoveryRes = recoverTasksFromCorruptedBackup();
    assert(recoveryRes.success === true, 'K.4.2: 从损坏备份中成功恢复任务');
    const recoveredBlock = recoveryRes.recoveredTasks[0].drafts[0].blocks[0];
    assert(recoveredBlock.adoptedEvidences !== undefined && recoveredBlock.adoptedEvidences.length === 1, 'K.4.3: 灾备恢复保留了合法证据项并剔除了损坏项');
    assert(recoveredBlock.adoptedEvidences![0].evidenceId === 'SNIP-APPOINT-01', 'K.4.4: 恢复后的证据ID完好无损');

    // 证据 usage 为对象时的结构损坏检测与隔离（解决 Objects are not valid as a React child 崩溃隐患）
    const corruptedTaskWithObjectUsage = {
      ...taskBase,
      drafts: [
        {
          ...workingDraft,
          blocks: [
            {
              ...workingDraft.blocks[0],
              adoptedEvidences: [
                {
                  ...validEvidenceRecord,
                  usage: { type: 'corrupted_object' } as any,
                },
              ],
            },
          ],
        },
      ],
    };
    assert(isValidAdoptedEvidenceRecord({ ...validEvidenceRecord, usage: { corrupted: true } }) === false, 'K.4.5: usage 为非枚举对象时被识别为非法证据项');
    assert(validateTaskStructure(corruptedTaskWithObjectUsage) === false, 'K.4.6: 证据 usage 为对象时被标记为数据结构损坏');

    const corruptedUsagePayload = JSON.stringify({
      schemaVersion: 2,
      currentTaskId: taskBase.id,
      tasks: [corruptedTaskWithObjectUsage],
    });
    setStorageItem(BACKUP_CORRUPTED_KEY, corruptedUsagePayload);
    const recUsageRes = recoverTasksFromCorruptedBackup();
    assert(recUsageRes.success === true, 'K.4.7: 从 usage 损坏备份中成功恢复');
    const recUsageBlock = recUsageRes.recoveredTasks[0].drafts[0].blocks[0];
    assert(recUsageBlock.adoptedEvidences === undefined || recUsageBlock.adoptedEvidences.length === 0, 'K.4.8: usage 为对象的损坏证据项被有效隔离剔除');

    // K.5: 采纳后后续修改引用/证据保守阻断撤销
    console.log('--- K.5 采纳后后续修改引用/证据保守阻断撤销 ---');
    const adoptRes = adoptParagraphSuggestion({
      task: taskBase,
      currentDraft: workingDraft,
      suggestion: suggestionBase,
      pendingTextToAdopt: suggestionBase.suggestedText,
      activeCompletedRunId: suggestionBase.runId,
      activeRole: '主笔甲',
    });
    assert(adoptRes.success === true, 'K.5.1: 补写建议初次采纳写入成功');
    const adoptedTask = adoptRes.updatedTask!;
    const logEntry = adoptRes.logEntry!;

    // 仅通过统一修改服务调整引用（正文未变）
    const adjustedTask = applyDraftContentChange(
      adoptedTask,
      adoptedTask.currentDraftId,
      (blocks) =>
        blocks.map((b) =>
          b.id === targetBlock.id ? { ...b, referencedFactIds: [...b.referencedFactIds, 'FACT-PROCURE-01'] } : b
        ),
      '仅调整引用事实',
      '主笔甲'
    ).updatedTask;

    const currentWorkingDraft = adjustedTask.drafts.find((d) => d.id === adjustedTask.currentDraftId);
    const undoCheckAfterRefChange = validateUndoEligibility(adjustedTask, currentWorkingDraft, logEntry.id, '主笔甲');
    assert(undoCheckAfterRefChange.canUndo === false, 'K.5.2: 采纳后正文未变但引用发生后续调整，安全撤销被保守阻断');
    assert(undoCheckAfterRefChange.reason!.includes('后续') || undoCheckAfterRefChange.reason!.includes('调整') || undoCheckAfterRefChange.reason!.includes('修改'), 'K.5.3: 给出依据引用已变更的撤销阻断提示');

    // 通过统一修改服务修改证据 snippetText（保留原指纹）
    const modifiedSnippetTextTask = applyDraftContentChange(
      adoptedTask,
      adoptedTask.currentDraftId,
      (blocks) =>
        blocks.map((b) =>
          b.id === targetBlock.id && b.adoptedEvidences
            ? {
                ...b,
                adoptedEvidences: b.adoptedEvidences.map((ev) => ({
                  ...ev,
                  snippetText: '这是被后续修改过的依据原文', // 原指纹不变
                })),
              }
            : b
        ),
      '仅修改依据文本保留原指纹',
      '主笔甲'
    ).updatedTask;

    const modifiedDraft = modifiedSnippetTextTask.drafts.find((d) => d.id === modifiedSnippetTextTask.currentDraftId);
    const modifiedTargetBlock = modifiedDraft?.blocks.find((b) => b.id === targetBlock.id);
    assert(modifiedTargetBlock?.revisionSeq !== logEntry.appliedRevisionSeq, 'K.5.4: 统一修改服务修改证据文本后修改序号正确递增');

    const undoCheckAfterSnippetChange = validateUndoEligibility(modifiedSnippetTextTask, modifiedDraft, logEntry.id, '主笔甲');
    assert(undoCheckAfterSnippetChange.canUndo === false, 'K.5.5: 修改证据文本保留旧指纹时，撤销校验保守阻断');

    // K.6: 杜绝无依据成效结论与准确说明
    console.log('--- K.6 杜绝无依据成效结论 ---');
    assert(!suggestionBase.suggestedText.includes('有力提升工作推进质效'), 'K.6.1: 正文中未追加无依据的“有力提升工作推进质效”成效套话');
    assert(suggestionBase.diffExplanation.includes('中性表述加工'), 'K.6.2: 差异说明准确区分原文忠实摘录与中性衔接加工，杜绝“全部忠实摘录”虚假声称');
    // K.7: 补写去重与整合、准入提示统一、桌面侧栏与抽屉分流、弹窗焦点隔离
    console.log('--- K.7 补写去重与整合、提示统一、响应式分流、焦点隔离 ---');
    // K.7.1 - K.7.3: 补写去重与整合
    const blockWithTraining = taskBase.drafts[0].blocks[1]; // 包含 16场、800人次
    const snipTraining = taskBase.snippets.find((s) => s.id === 'SNIP-TRAIN-01' || s.id === 'EVD-03') || {
      id: 'EVD-03',
      sourceDocId: 'DOC-TRAIN-01',
      docName: '培训工作台账',
      location: '第5段',
      period: '2026年1至9月',
      text: '2026年1至9月，组织专题培训16场，累计参训800人次。',
    };
    const dupSupplement = generateMaterialSupplementation(blockWithTraining, [snipTraining], {
      task: taskBase,
      currentDraft: workingDraft,
    });
    assert(
      dupSupplement.suggestedText === blockWithTraining.content,
      'K.7.1: 当材料内容与正文既有数据举措重复时，安全保留段落原文，杜绝重复拼接'
    );
    assert(
      !dupSupplement.suggestedText.includes('结合【培训工作台账】实际做法'),
      'K.7.2: 正文绝不夹带“结合【...】实际做法”等模板出处词句'
    );
    assert(
      dupSupplement.diffExplanation.includes('核心内容') || dupSupplement.diffExplanation.includes('已包含'),
      'K.7.3: 差异说明明确告知材料核心内容已在原段中，无新增做法'
    );

    // 有新增内容时整合进原段，出处留在依据区
    assert(
      suggestionBase.suggestedText.includes('便民服务分时段精准预约'),
      'K.7.4: 有新增做法时自然整合进正文原段'
    );
    assert(
      !suggestionBase.suggestedText.includes('结合【'),
      'K.7.5: 正文不包含来源书名号引用，出处严格留存依据区'
    );
    assert(
      suggestionBase.adoptedEvidences.length > 0 && Boolean(suggestionBase.adoptedEvidences[0].sourceDocName),
      'K.7.6: 证据依据区完整记录材料出处文档名称'
    );

    // K.7.7 - K.7.8: 统一阻断原因，杜绝“未支持的自定义指令”误报
    const taskWithUnapproved120: Task = {
      ...taskBase,
      facts: taskBase.facts.map((f) => (f.id === 'FACT-APPOINT-01' ? { ...f, status: 'pending' as const } : f)),
    };
    const checkBlockedReason = validateParagraphSuggestionAcceptance({
      task: taskWithUnapproved120,
      currentDraft: workingDraft,
      suggestion: dupSupplement,
      pendingTextToAdopt: dupSupplement.suggestedText,
      activeCompletedRunId: dupSupplement.runId,
      activeRole: '主笔甲',
    });
    assert(
      checkBlockedReason.valid === false,
      'K.7.7: 无新增内容补写在采纳校验中正确阻断'
    );
    assert(
      !checkBlockedReason.reason!.includes('未支持的自定义指令'),
      'K.7.8: 阻断原因统一：材料补写阻断绝不误报“未支持的自定义指令”'
    );

    // K.7.9: 桌面视口仅更新侧栏不弹抽屉，窄屏视口呼出抽屉
    (dom.window as any).innerWidth = 1280;
    let desktopWorkspaceState = createTestTaskWithCases();
    const mountedDesktopWorkspace = mountTestComponent(
      <DraftingStage
        task={desktopWorkspaceState}
        onUpdateTask={(up) => {
          desktopWorkspaceState = { ...desktopWorkspaceState, ...up };
        }}
        onViewSnippet={() => {}}
        activeRole="主笔甲"
      />
    );
    const p1AiBtnDesktop = mountedDesktopWorkspace.container.querySelector('[aria-label="第1段AI修改建议"]') as HTMLButtonElement;
    assert(Boolean(p1AiBtnDesktop), 'K.7.9: 桌面工作区找到段落AI建议入口');
    act(() => {
      p1AiBtnDesktop.click();
    });
    const drawerOnDesktop = mountedDesktopWorkspace.container.querySelector('[data-testid="drawer-tablet-inspector"]');
    assert(drawerOnDesktop === null, 'K.7.10: 桌面视口点击AI建议更新右侧栏，绝不打开覆盖正文的抽屉');
    mountedDesktopWorkspace.unmount();

    // 窄屏视口 (768px)
    (dom.window as any).innerWidth = 768;
    const mountedTabletWorkspace = mountTestComponent(
      <DraftingStage
        task={desktopWorkspaceState}
        onUpdateTask={() => {}}
        onViewSnippet={() => {}}
        activeRole="主笔甲"
      />
    );
    const p1AiBtnTablet = mountedTabletWorkspace.container.querySelector('[aria-label="第1段AI修改建议"]') as HTMLButtonElement;
    act(() => {
      p1AiBtnTablet.click();
    });
    const drawerOnTablet = mountedTabletWorkspace.container.querySelector('[data-testid="drawer-tablet-inspector"]');
    assert(drawerOnTablet !== null, 'K.7.11: 窄屏视口点击AI建议正常呼出抽屉');
    mountedTabletWorkspace.unmount();

    // K.7.12 - K.7.13: 弹窗焦点管理与紧凑布局
    const modalMountFocus = mountTestComponent(
      <MaterialSupplementModal
        isOpen={true}
        onClose={() => {}}
        task={taskBase}
        currentDraft={taskBase.drafts[0]}
        activeBlock={taskBase.drafts[0].blocks[1]}
        activeRole="主笔甲"
        onViewSnippet={() => {}}
        onSupplementSuccess={() => {}}
      />
    );
    const scopeBar = modalMountFocus.container.querySelector('[data-testid="label-scope-notice"]');
    assert(Boolean(scopeBar), 'K.7.12: 材料补写弹窗具备精炼紧凑的作用范围与原文展示栏');
    const modalEl = modalMountFocus.container.querySelector('[data-testid="material-supplement-modal"]');
    assert(Boolean(modalEl), 'K.7.13: 成功定位材料补写弹窗容器');

    // 焦点隔离拦截：在外部元素触发 focusin 被捕获并恢复到弹窗首个可聚焦元素
    const outsideEl = dom.window.document.createElement('button');
    dom.window.document.body.appendChild(outsideEl);
    act(() => {
      outsideEl.focus();
    });
    const focusablesInModal = modalEl!.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])'
    );
    assert(
      dom.window.document.activeElement === focusablesInModal[0],
      'K.7.14: 弹窗具有完备的焦点隔离（focusin 拦截），绝不穿透至背景元素'
    );
    outsideEl.remove();
    modalMountFocus.unmount();
  }

  console.log('\n================================================================');
  console.log('   🎉 任务20 全部 11 组验收用例 (A-K 包含6组专项问题) 100% 全部通过！');
  console.log('================================================================');
}

runTask20Tests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
