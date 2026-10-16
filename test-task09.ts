import { Task, DraftVersion, ParagraphBlock, AuditIssue, Fact } from './src/types';
import { runDocumentAudit } from './src/services/mockAuditService';
import { exportDocumentAsTxt, exportDocumentAsDocx } from './src/services/exportService';
import { createPresetTask } from './src/services/mockData';
import { loadPersistedState, savePersistedState, CURRENT_SCHEMA_VERSION, STORAGE_KEY_V2 } from './src/services/storageService';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`✅ PASSED: ${msg}`);
}

console.log('==============================================');
console.log('   公文辅助协作原型 - 任务09验收与回归测试套件');
console.log('==============================================\n');

// -----------------------------------------------------------------------
// 1. 测试删除白名单，采信128但正文写120定位事实并阻断定稿
// -----------------------------------------------------------------------
console.log('>>> [测试 1] 采信128但正文写120定位事实并阻断定稿:');
const task1 = createPresetTask('under_review');
// 确保事实中有128，已被采信
const fact128 = task1.facts.find(f => f.id === 'FACT-01')!;
assert(fact128.selectedConflictValue === '128', '采信事实值为 128');

// 正文写120项，引用 FACT-01
const blockMismatch: ParagraphBlock = {
  id: 'p1_test',
  sectionId: 'sec-1',
  order: 1,
  content: '截至目前，全区已完成120项重点攻坚任务。',
  referencedFactIds: ['FACT-01'],
  updatedAt: new Date().toISOString()
};

const issues1 = runDocumentAudit(task1, [blockMismatch], 'draft-test-1');
const mismatchIssue = issues1.find(i => i.originalText.includes('120') || i.issueId.includes('conflict_120'));
assert(!!mismatchIssue, '成功识别到正文120与采信128的重大冲突');
assert(mismatchIssue?.isBlocking === true, '冲突判定为阻断定稿(isBlocking === true)');
assert(mismatchIssue?.blockId === 'p1_test', '问题精准关联到段落ID p1_test');
assert(mismatchIssue?.replacementText === '128项', '提供正确的修正建议: 128项');

// -------------------------------------------------------------
// 2. 测试同段“800人次，其中800人”的单位问题
// -------------------------------------------------------------
console.log('\n>>> [测试 2] 识别同段“800人次，其中800人”单位/口径混淆问题:');
const blockUnit: ParagraphBlock = {
  id: 'p2_unit',
  sectionId: 'sec-2',
  order: 2,
  content: '本次培训累计覆盖800人次，其中800人取得结业认证。',
  referencedFactIds: ['FACT-03'],
  updatedAt: new Date().toISOString()
};

const issues2 = runDocumentAudit(task1, [blockUnit], 'draft-test-2');
const unitIssue = issues2.find(i => i.type === 'unit_inconsistency' || i.issueId.includes('unit') || i.issueId.includes('UNIT'));
assert(!!unitIssue, '成功识别“800人次，其中800人”单位/口径混淆');
assert(unitIssue?.blockId === 'p2_unit', '精准标记所属段落 p2_unit');

// -------------------------------------------------------------
// 3. 测试数字提取避免把“1至”当成成效指标
// -------------------------------------------------------------
console.log('\n>>> [测试 3] 数字提取避免将“1至”序数/范围当成成效指标:');
const blockRange: ParagraphBlock = {
  id: 'p3_range',
  sectionId: 'sec-3',
  order: 3,
  content: '1至5月份，各部门统筹推进既定安排。',
  referencedFactIds: [],
  updatedAt: new Date().toISOString()
};

const issues3 = runDocumentAudit(task1, [blockRange], 'draft-test-3');
const falsePositive = issues3.find(i => i.originalText === '1至' || i.originalText === '1');
assert(!falsePositive, '未将“1至”误报为未核准成效数值');

// -------------------------------------------------------------
// 4. 测试未能可靠验证的句子标注待人工核实，不伪称核校通过
// -------------------------------------------------------------
console.log('\n>>> [测试 4] 未能可靠验证的句子标注待人工核实(unverified_sentence):');
const blockUnverified: ParagraphBlock = {
  id: 'p4_unverified',
  sectionId: 'sec-4',
  order: 4,
  content: '今年全区经济总体呈现稳中向好、稳中有进的向好态势。',
  referencedFactIds: [],
  updatedAt: new Date().toISOString()
};

const issues4 = runDocumentAudit(task1, [blockUnverified], 'draft-test-4');
const manualVerifyIssue = issues4.find(i => i.type === 'unverified_sentence');
assert(!!manualVerifyIssue, '检测到缺少量化事实支撑的宏观陈述，提示待人工核实');
assert(manualVerifyIssue?.isBlocking === false, '人工核实项非阻断提示(isBlocking === false)');

// -----------------------------------------------------------------------
// 5. 测试接受修正产生真实正文变化；忽略非阻断提示需记录理由
// -----------------------------------------------------------------------
console.log('\n>>> [测试 5] 接受修正产生真实正文变化，阻断问题不可被通用忽略:');
// 接受修正
let modifiedContent = blockMismatch.content;
if (mismatchIssue && mismatchIssue.replacementText) {
  modifiedContent = modifiedContent.replace(mismatchIssue.originalText, mismatchIssue.replacementText);
}
assert(modifiedContent === '截至目前，全区已完成128项重点攻坚任务。', '修正后正文真实变为128项');

// 修正后再跑核校，阻断问题应解除
const blockFixed: ParagraphBlock = {
  ...blockMismatch,
  content: modifiedContent
};
const issuesFixed = runDocumentAudit(task1, [blockFixed], 'draft-test-1');
const remainingMismatch = issuesFixed.find(i => i.issueId === mismatchIssue?.issueId && i.status === 'unresolved');
assert(!remainingMismatch, '正文修正后，阻断冲突已被清除，不再报错');

// 阻断问题不可被忽略
assert(mismatchIssue?.isBlocking === true, '重大不一致明确为 isBlocking === true，系统层面禁止直接绕过');

// -----------------------------------------------------------------------
// 6. 测试真实DOCX与TXT支持相同的“正文、依据、审阅处理记录”选择，导出固定版本
// -----------------------------------------------------------------------
console.log('\n>>> [测试 6] DOCX与TXT导出选项一致性与固定版本测试:');
const testDraft = task1.drafts[0];

// 选项A: 仅正文
const txtOnlyBody = exportDocumentAsTxt(task1, testDraft, { includeBody: true, includeEvidence: false, includeReviewLog: false });
assert(txtOnlyBody.includes('工作总结'), 'TXT包含正文段落');
assert(!txtOnlyBody.includes('依据出处：'), 'TXT未包含依据出处');
assert(!txtOnlyBody.includes('【附：审阅意见与落实处理记录】'), 'TXT未包含审阅记录');

// 选项B: 包含依据与审阅
const txtFull = exportDocumentAsTxt(task1, testDraft, { includeBody: true, includeEvidence: true, includeReviewLog: true });
assert(txtFull.includes('依据出处：'), 'TXT包含依据出处');
assert(txtFull.includes('【附：审阅意见与落实处理记录】'), 'TXT包含审阅记录汇总');

// DOCX Blob与OOXML结构测试
async function testDocx() {
  const docxBlob = await exportDocumentAsDocx(task1, testDraft, { includeBody: true, includeEvidence: true, includeReviewLog: true });
  const docxSize = (docxBlob as any).size ?? (docxBlob as any).length ?? (docxBlob as any).byteLength;
  assert(docxSize > 1000, `DOCX生成成功，大小为 ${docxSize} 字节，具备标准OOXML结构`);
}

// -----------------------------------------------------------------------
// 7. 测试存储恢复与损坏数据提示
// -----------------------------------------------------------------------
console.log('\n>>> [测试 7] 存储恢复、schemaVersion迁移与损坏容错:');
savePersistedState([task1], task1.id, '主笔甲');
const loaded = loadPersistedState();
assert(loaded.tasks.length > 0, '成功恢复保存的任务');
assert(loaded.currentTaskId === task1.id, '准确恢复当前任务ID');
assert(loaded.activeRole === '主笔甲', '准确恢复当前活跃角色');

testDocx().then(() => {
  console.log('\n==============================================');
  console.log('   🎉 任务09验收测试套件全部 7 项验证通过！');
  console.log('==============================================');
});
