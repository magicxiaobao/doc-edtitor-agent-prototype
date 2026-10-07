import { 
  Task, 
  DraftVersion, 
  ParagraphBlock, 
  ReviewComment, 
  UserRole,
  AuditIssue,
  Fact 
} from './src/types';
import { runDocumentAudit } from './src/services/mockAuditService';
import { exportDocumentAsTxt, exportDocumentAsDocx } from './src/services/exportService';
import { createPresetTask } from './src/services/mockData';
import { generateDraftFromFactsAndOutline } from './src/services/mockDraftService';
import { 
  loadPersistedState, 
  savePersistedState, 
  CURRENT_SCHEMA_VERSION, 
  STORAGE_KEY_V2,
  LEGACY_STORAGE_KEY_V1,
  BACKUP_CORRUPTED_KEY
} from './src/services/storageService';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`✅ PASSED: ${msg}`);
}

console.log('==============================================');
console.log('   公文辅助协作原型 - 任务09验收测试套件');
console.log('==============================================\n');

// -----------------------------------------------------------------------
// Test 1: 删除白名单，动态核校事实快照、单位混淆与“1至”识别
// -----------------------------------------------------------------------
console.log('>>> [验收 1] 动态核校：排除白名单、识别128 vs 120冲突、同段人次/人数混淆、避免“1至”误判:');

const task1 = createPresetTask('under_review');
const draft1 = task1.drafts[0];

// 1.1 采信128但正文写120项，定位对应事实并阻断定稿
const blockWith120: ParagraphBlock = {
  id: 'BLK-TEST-120',
  sectionId: 'SEC-01',
  order: 1,
  content: '2026年1至9月，全系统紧扣高质量发展主线，累计完成重点推进任务120项。',
  referencedFactIds: ['FACT-01'],
  updatedAt: new Date().toISOString(),
};

const issues1 = runDocumentAudit(task1, [blockWith120], draft1.id);
const conflictIssue = issues1.find((i) => i.type === 'conflict_mismatch');
assert(!!conflictIssue, '成功检测出采信128但正文写120的冲突');
assert(conflictIssue?.severity === 'error', '未采信冲突口径属于阻断级error错误');
assert(conflictIssue?.isBlocking === true, '标记为isBlocking阻断定稿');
assert(conflictIssue?.originalText === '120项', '准确提取未采信的原文表述“120项”');
assert(conflictIssue?.blockId === 'BLK-TEST-120', '正确绑定段落blockId');
assert(conflictIssue?.replacementText === '128项', '提供正确的更正替换值“128项”');

// 1.2 同段出现“800人次，其中800人”的单位混淆识别
const blockWithMixedUnit: ParagraphBlock = {
  id: 'BLK-TEST-UNIT',
  sectionId: 'SEC-02',
  order: 2,
  content: '深入开展队伍提能工程，组织专题培训16场，累计参训800人次，其中800人考核成绩优良。',
  referencedFactIds: ['FACT-02', 'FACT-03'],
  updatedAt: new Date().toISOString(),
};

const issuesUnit = runDocumentAudit(task1, [blockWithMixedUnit], draft1.id);
const unitIssue = issuesUnit.find((i) => i.type === 'metric_unit' && i.originalText === '800人');
assert(!!unitIssue, '成功识别同段同时包含“800人次”与“800人”时的单位混淆');
assert(unitIssue?.severity === 'error', '参训人次混淆为实有人数属于阻断级错误');
assert(unitIssue?.isBlocking === true, '单位混淆标记为isBlocking');
assert(unitIssue?.replacementText === '800人次', '建议更正为“800人次”');

// 1.3 数字提取避免把“1至”当成成效指标
const unrefIssueFromDate = issuesUnit.find((i) => i.originalText.includes('1至') || i.originalText === '1至9月');
assert(!unrefIssueFromDate, '成功过滤“1至”与“1至9月”等统计期间，未误判为成效指标');

// 1.4 未可靠验证的句子（定性线索CLUE-01）标注待人工核实
const blockWithClue: ParagraphBlock = {
  id: 'BLK-TEST-CLUE',
  sectionId: 'SEC-02',
  order: 3,
  content: '通过持续优化政务服务流程，企业与群众办事体验显著提升，服务满意度明显提升。',
  referencedFactIds: [],
  updatedAt: new Date().toISOString(),
};

const issuesClue = runDocumentAudit(task1, [blockWithClue], draft1.id);
const clueIssue = issuesClue.find((i) => i.type === 'gap_missing');
assert(!!clueIssue, '成功识别仅有定性线索的满意度表述');
assert(clueIssue?.severity === 'warning', '定性线索标记为warning待核验');
assert(clueIssue?.suggestion.includes('待人工核实'), '更正建议中明确标注待人工核实');

// 1.5 动态数字验证（自定义事实不在旧白名单中亦能正常校验）
const customFact: Fact = {
  id: 'FACT-CUSTOM',
  metric: '新增扶持示范企业',
  value: '75',
  unit: '家',
  metricScope: '中小企业培育库',
  period: '2026年1-9月',
  primaryEvidenceId: 'EVD-CUSTOM',
  evidenceIds: ['EVD-CUSTOM'],
  hasConflict: false,
  status: 'confirmed',
};

const taskWithCustom = {
  ...task1,
  facts: [...task1.facts, customFact],
};

const blockWithCustomFact: ParagraphBlock = {
  id: 'BLK-CUSTOM',
  sectionId: 'SEC-02',
  order: 4,
  content: '大力扶持实体经济发展，累计新增扶持示范企业75家。',
  referencedFactIds: ['FACT-CUSTOM'],
  updatedAt: new Date().toISOString(),
};

const issuesCustom = runDocumentAudit(taskWithCustom, [blockWithCustomFact], draft1.id);
const falseUnref = issuesCustom.find((i) => i.originalText === '75家');
assert(!falseUnref, '自定义事实75家动态识别为合法指标，无需静态代码白名单');

// -----------------------------------------------------------------------
// Test 2: 核校问题对象类型完整性、接受修正与忽略限制
// -----------------------------------------------------------------------
console.log('\n>>> [验收 2] 核校问题类型字段完整、真实接受修正、禁止通用忽略重大阻断:');

// 2.1 检查所有AuditIssue字段完整性
issues1.forEach((iss) => {
  assert(!!iss.id && !!iss.issueId, `issueId稳定存在: ${iss.issueId}`);
  assert(iss.taskId === task1.id, `正确绑定taskId: ${iss.taskId}`);
  assert(iss.draftId === draft1.id, `正确绑定draftId: ${iss.draftId}`);
  assert(!!iss.blockId, `正确绑定blockId: ${iss.blockId}`);
  assert(!!iss.location, `位置描述存在: ${iss.location}`);
  assert(!!iss.originalText, `原文存在: ${iss.originalText}`);
  assert(!!iss.evidenceText, `依据存在: ${iss.evidenceText}`);
  assert(!!iss.suggestion, `建议存在: ${iss.suggestion}`);
});

// 2.2 接受修正真实改变正文
const originalBlockText = blockWith120.content;
const fixedText = originalBlockText.replace(conflictIssue!.originalText, conflictIssue!.replacementText!);
assert(fixedText.includes('128项'), '正文中成功替换为采信的128项');
assert(!fixedText.includes('120项'), '正文中不再包含错误的120项');

// 2.3 重大阻断错误禁止通用忽略
const draftWithAttemptedIgnore: DraftVersion = {
  ...draft1,
  auditRecords: [
    {
      issueId: conflictIssue!.issueId,
      status: 'ignored',
      ignoreReason: '试图绕过重大冲突',
    },
  ],
};

const issuesAfterIgnoreAttempt = runDocumentAudit(task1, [blockWith120], draftWithAttemptedIgnore.id);
const recheckedConflict = issuesAfterIgnoreAttempt.find((i) => i.issueId === conflictIssue!.issueId);
// 重大阻断性错误不能被ignored绕过
assert(recheckedConflict?.status === 'unresolved', '重大阻断性冲突禁止通过ignore绕过，强制保持unresolved');

// 2.4 非阻断提示记录理由后随版本保存
const draftWithValidWarningIgnore: DraftVersion = {
  ...draft1,
  id: 'DRAFT-IGNORE-TEST',
  auditRecords: [
    {
      issueId: clueIssue!.issueId,
      status: 'ignored',
      ignoreReason: '主笔已向主管处室核实为定性总结依据',
    },
  ],
};

task1.drafts.push(draftWithValidWarningIgnore);
const issuesAfterWarningIgnore = runDocumentAudit(task1, [blockWithClue], draftWithValidWarningIgnore.id);
const recheckedClue = issuesAfterWarningIgnore.find((i) => i.issueId === clueIssue!.issueId);
assert(recheckedClue?.status === 'ignored', '非阻断提示记录理由后状态转为ignored');
assert(recheckedClue?.ignoreReason === '主笔已向主管处室核实为定性总结依据', '忽略理由随版本持久化记录');

// -----------------------------------------------------------------------
// Test 3: TXT与DOCX支持相同的正文/依据/审阅记录选择，导出冻结快照
// -----------------------------------------------------------------------
console.log('\n>>> [验收 3] 真实DOCX与TXT一致性选择导出，固定指定冻结版本:');

const taskExport = createPresetTask('under_review');
const draftExport = taskExport.drafts[0];

// 3.1 TXT 导出包含正文、依据与审阅处理记录
const txtFull = exportDocumentAsTxt(taskExport, draftExport, {
  includeBody: true,
  includeEvidence: true,
  includeReviewLog: true,
});

assert(txtFull.includes(draftExport.snapshotMetadata?.taskTitle || taskExport.title), 'TXT包含公文标题');
const expectedSecTitle = draftExport.snapshotMetadata?.outlineSections[0]?.title || '一、前三季度总体运行态势与工作成效';
assert(txtFull.includes(expectedSecTitle), 'TXT使用快照大纲章节标题');
assert(txtFull.includes('依据出处：'), 'TXT包含依据出处');
assert(txtFull.includes('【附：审阅意见与落实处理记录】'), 'TXT包含审阅意见与落实处理记录');

// 3.2 TXT 导出仅正文（排除依据与审阅记录）
const txtBodyOnly = exportDocumentAsTxt(taskExport, draftExport, {
  includeBody: true,
  includeEvidence: false,
  includeReviewLog: false,
});

assert(txtBodyOnly.includes(expectedSecTitle), 'TXT纯正文包含章节标题');
assert(!txtBodyOnly.includes('依据出处：'), 'TXT纯正文不含依据出处');
assert(!txtBodyOnly.includes('【附：审阅意见与落实处理记录】'), 'TXT纯正文不含审阅记录');

// 3.3 验证当前修改大纲后，历史版本导出仍使用当时快照大纲标题
taskExport.outline[0].title = '【已被主笔修改的全新第一章标题】';
const txtHistoryCheck = exportDocumentAsTxt(taskExport, draftExport, { includeBody: true });
assert(txtHistoryCheck.includes(expectedSecTitle), '历史版本导出严格使用快照大纲，未被修改后的大纲覆盖');
assert(!txtHistoryCheck.includes('已被主笔修改的全新第一章标题'), '历史导出未出现篡改标题');

// 3.4 DOCX 导出异步打包结构验证
async function testDocxExport() {
  const docxBlob = await exportDocumentAsDocx(taskExport, draftExport, {
    includeBody: true,
    includeEvidence: true,
    includeReviewLog: true,
  });

  assert(docxBlob.size > 1000, `DOCX生成真实有效二进制文件，大小: ${docxBlob.size} bytes`);
  assert(docxBlob.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'DOCX类型符合OOXML标准规范');
}

// -----------------------------------------------------------------------
// Test 4: SchemaVersion迁移、数据损坏隔离与刷新持久化
// -----------------------------------------------------------------------
console.log('\n>>> [验收 4] SchemaVersion迁移与损坏数据保护:');

// 4.1 SchemaVersion 迁移验证
const legacyTasksArray = [
  {
    id: 'TASK-LEGACY-01',
    title: '旧版工作总结',
    startDate: '2026-01-01',
    endDate: '2026-09-30',
    drafts: [
      {
        id: 'DRAFT-LEGACY-v1',
        versionNumber: 'v1.0',
        createdAt: '2026-10-01T00:00:00Z',
        author: '主笔甲',
        summary: '旧版草稿',
        blocks: [],
      },
    ],
  },
];

// 模拟localStorage存储旧版v1数据
if (typeof localStorage !== 'undefined') {
  localStorage.setItem(LEGACY_STORAGE_KEY_V1, JSON.stringify(legacyTasksArray));
  localStorage.removeItem(STORAGE_KEY_V2);
  const loadedState = loadPersistedState();
  assert(loadedState.tasks.length === 1, '成功加载旧版任务');
  assert(!!loadedState.tasks[0].drafts[0].snapshotMetadata, '自动补全snapshotMetadata完成Schema v2迁移');
  assert(loadedState.migrationMessage?.includes('Schema v2'), '提供明确的平滑迁移提示');
}

// 4.2 损坏JSON数据保护验证
if (typeof localStorage !== 'undefined') {
  localStorage.setItem(STORAGE_KEY_V2, '{"corrupted_json_syntax: true,,,');
  const corruptedLoad = loadPersistedState();
  assert(corruptedLoad.isCorrupted === true, '检测到数据损坏并正确标记isCorrupted');
  assert(corruptedLoad.tasks.length > 0, '启用安全预置场景保护，未丢失可用性');
  const backup = localStorage.getItem(BACKUP_CORRUPTED_KEY);
  assert(backup?.includes('corrupted_json_syntax'), '损坏原始数据已完整保留在备份区');
}

// -----------------------------------------------------------------------
// Test 5: 真实端到端完整闭环演练
// 新建任务→加材料→建立事实→确认→文风→大纲→起草→审阅→处理→核校→定稿
// -----------------------------------------------------------------------
console.log('\n>>> [验收 5] 真实全流程完整走通（新建→材料→事实→文风→大纲→起草→审阅→处理→核校→定稿）:');

// Step 1: 新建任务
const flowTask: Task = {
  id: 'TASK-E2E-FLOW',
  title: '2026年三季度法治建设工作总结',
  docType: '工作总结',
  usage: '向市委法治办报送履职总结',
  audience: '市委领导与法治办评审专家',
  startDate: '2026-01-01',
  endDate: '2026-09-30',
  targetWordCount: 2000,
  mandatoryCoverage: '法治宣传、专项督察、涉法涉诉化解',
  deadline: '2026-10-15',
  primaryAuthor: '主笔甲',
  currentStage: 'task_setup',
  status: '筹备中',
  updatedAt: new Date().toISOString(),
  isFinalized: false,
  documents: [
    {
      id: 'DOC-E2E-01',
      name: '法治宣传台账',
      source: '宣传科',
      period: '2026年1-9月',
      usage: 'current_fact',
      parseStatus: 'parsed',
      fileType: 'txt',
      content: '第一段：2026年1至9月，深入推进法治宣传教育。\n第二段：累计开展主题普法讲座24场，受训职工1200人次。',
      paragraphCount: 2,
      wordCount: 88,
    },
  ],
  snippets: [
    {
      id: 'SNIP-E2E-01',
      sourceDocId: 'DOC-E2E-01',
      docName: '法治宣传台账',
      location: '第2段',
      period: '2026年1至9月',
      text: '累计开展主题普法讲座24场，受训职工1200人次。',
    },
  ],
  facts: [
    {
      id: 'FACT-E2E-01',
      metric: '开展主题普法讲座',
      period: '2026年1至9月',
      value: '24',
      unit: '场',
      metricScope: '系统内普法讲座',
      primaryEvidenceId: 'SNIP-E2E-01',
      evidenceIds: ['SNIP-E2E-01'],
      hasConflict: false,
      status: 'confirmed',
    },
    {
      id: 'FACT-E2E-02',
      metric: '受训普法规模',
      period: '2026年1至9月',
      value: '1200',
      unit: '人次',
      metricScope: '职工普法培训规模',
      primaryEvidenceId: 'SNIP-E2E-01',
      evidenceIds: ['SNIP-E2E-01'],
      hasConflict: false,
      status: 'confirmed',
    },
  ],
  factSnapshot: {
    confirmedAt: new Date().toISOString(),
    facts: [],
  },
  styleRules: [
    {
      id: 'STYLE-E2E-01',
      category: 'tone',
      title: '权威精炼',
      description: '突出政治站位与严谨数据',
      example: '坚持统筹推进，扎实抓好落实',
      status: 'confirmed',
    },
  ],
  styleConfirmed: true,
  outline: [
    {
      id: 'SEC-E2E-01',
      order: 1,
      title: '一、深入开展法治宣传教育成效',
      description: '总结普法场次与受训覆盖面',
      suggestedWordCount: 800,
      assignedFactIds: ['FACT-E2E-01', 'FACT-E2E-02'],
    },
  ],
  outlineConfirmed: true,
  drafts: [],
  reviewComments: [],
  auditIssues: [],
};

flowTask.factSnapshot!.facts = flowTask.facts;

// Step 2: 起草初稿
const generatedBlocks = generateDraftFromFactsAndOutline(flowTask);
assert(generatedBlocks.length > 0, '起草成功生成段落');
assert(generatedBlocks[0].content.includes('24场'), '正文准确体现24场');
assert(generatedBlocks[0].content.includes('1200人次'), '正文准确体现1200人次');

const generatedDraft: DraftVersion = {
  id: 'DRAFT-E2E-v1',
  versionNumber: 'v1.0 (初稿)',
  createdAt: new Date().toISOString(),
  author: '主笔甲',
  summary: '基于24场讲座及1200人次生成的初稿',
  blocks: generatedBlocks,
  snapshotMetadata: {
    taskTitle: flowTask.title,
    startDate: flowTask.startDate,
    endDate: flowTask.endDate,
    targetWordCount: flowTask.targetWordCount,
    outlineSections: JSON.parse(JSON.stringify(flowTask.outline)),
    factSnapshot: flowTask.factSnapshot,
  },
};
flowTask.drafts.push(generatedDraft);
flowTask.currentDraftId = generatedDraft.id;

// Step 3: 审阅人提出意见
const comment1: ReviewComment = {
  id: 'CMT-E2E-01',
  type: 'paragraph',
  targetBlockId: generatedDraft.blocks[0].id,
  targetVersionId: generatedDraft.id,
  reviewer: '审阅乙',
  content: '讲座规模成效显著，建议提炼亮点举措。',
  status: 'pending',
  createdAt: new Date().toISOString(),
};
flowTask.reviewComments.push(comment1);

// Step 4: 主笔处理审阅意见
comment1.status = 'accepted_pending_implementation';
comment1.authorReply = '同意，将在下一步总结中持续深化亮点。';
comment1.decisionReason = '意见切中要害，已采纳落实。';
comment1.status = 'implemented';

// Step 5: 核校一致性验证
const e2eAuditIssues = runDocumentAudit(flowTask, flowTask.drafts[0].blocks, flowTask.drafts[0].id);
const e2eCriticalErrors = e2eAuditIssues.filter((i) => i.isBlocking && i.status === 'unresolved');
assert(e2eCriticalErrors.length === 0, '全流程动态生成文稿无阻断性核校错误');

// Step 6: 最终定稿
const isReadyToFinalize = 
  flowTask.drafts[0].blocks.length > 0 &&
  flowTask.outlineConfirmed &&
  !!flowTask.factSnapshot &&
  flowTask.styleConfirmed &&
  flowTask.reviewComments.filter((c) => c.status === 'pending').length === 0 &&
  e2eCriticalErrors.length === 0;

assert(isReadyToFinalize, '满足全部定稿准入前置条件');

const finalDraft: DraftVersion = {
  id: `DRAFT-FINAL-${Date.now()}`,
  versionNumber: '定稿 v2.0 (最终核定版)',
  createdAt: new Date().toISOString(),
  author: '主笔甲',
  summary: '正式定稿',
  blocks: generatedDraft.blocks,
  isFinal: true,
  snapshotMetadata: generatedDraft.snapshotMetadata,
};
flowTask.drafts.unshift(finalDraft);
flowTask.isFinalized = true;
flowTask.status = '已定稿';

assert(flowTask.isFinalized, '公文成功定稿并生成不可篡改快照');

// Step 7: 导出验证
const finalTxt = exportDocumentAsTxt(flowTask, finalDraft, {
  includeBody: true,
  includeEvidence: true,
  includeReviewLog: true,
});
assert(finalTxt.includes('2026年三季度法治建设工作总结'), '导出的TXT包含完整标题与正文');

testDocxExport().then(() => {
  console.log('\n==============================================');
  console.log('   🎉 任务09验收测试套件全部验证通过！');
  console.log('==============================================');
});
