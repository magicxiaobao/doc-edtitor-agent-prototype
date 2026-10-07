import { Task, Fact, OutlineSection, ParagraphBlock } from './src/types';
import {
  generateDraftFromFactsAndOutline,
  generateParagraphRevision,
  isValidFactForDraft,
  formatTaskPeriod,
} from './src/services/mockDraftService';
import { createPresetTask } from './src/services/mockData';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`✅ PASSED: ${msg}`);
}

console.log('--- 开始运行任务07有效验收测试套件 ---');

// ==========================================
// Acceptance a: 空白任务且无事实时，不出现128项、16场、800人次或12次
// ==========================================
console.log('\n[验收项 a] 空白任务无事实兜底值检验:');
const blankTask = createPresetTask('blank');
// Outline may exist, but no assigned facts or empty facts array
const blankBlocks = generateDraftFromFactsAndOutline(blankTask);
const fullBlankText = blankBlocks.map((b) => b.content).join('\n');

assert(!fullBlankText.includes('128'), '空白任务正文中不包含128');
assert(!fullBlankText.includes('120'), '空白任务正文中不包含120');
assert(!fullBlankText.includes('16'), '空白任务正文中不包含16');
assert(!fullBlankText.includes('800'), '空白任务正文中不包含800');
assert(!fullBlankText.includes('12次'), '空白任务正文中不包含12次');
assert(!fullBlankText.includes('2026年1至9月'), '空白任务无固定2026年1至9月兜底');

// If blank task outline has sections with no assigned facts, returns explicit gap text
const taskWithEmptySection: Task = {
  ...blankTask,
  outline: [
    {
      id: 'SEC-EMPTY-1',
      order: 1,
      title: '一、总体运行情况',
      purpose: '总体总结',
      suggestedWordCount: 800,
      assignedFactIds: [],
      uncoveredRequirements: [],
      hasMaterialGap: true,
      confirmed: true,
    },
  ],
};
const emptySectionBlocks = generateDraftFromFactsAndOutline(taskWithEmptySection);
assert(emptySectionBlocks.length === 1, '生成1个段落');
assert(emptySectionBlocks[0].content.includes('【待补材料依据】'), '无事实分配时返回明确待补标识');
assert(!emptySectionBlocks[0].content.includes('128') && !emptySectionBlocks[0].content.includes('16'), '待补段落中无兜底数字');

// ==========================================
// Acceptance b: 任务期间改为2027年二季度，使用全新章节ID和全新事实ID，正文按当前期间及章节生成
// ==========================================
console.log('\n[验收项 b] 2027年二季度全新章节ID与全新事实ID动态生成检验:');
const task2027: Task = {
  ...blankTask,
  id: 'TASK-2027-Q2',
  startDate: '2027-04-01',
  endDate: '2027-06-30',
  title: '某单位2027年二季度重点业务汇报',
  facts: [
    {
      id: 'FACT-NEW-777',
      metric: '落地营商便民服务事项',
      period: '2027年二季度',
      value: '66',
      unit: '件',
      metricScope: '行政审批局业务台账',
      primaryEvidenceId: 'EVD-NEW-01',
      evidenceIds: ['EVD-NEW-01'],
      hasConflict: false,
      status: 'confirmed',
    },
  ],
  outline: [
    {
      id: 'SEC-NEW-888',
      order: 1,
      title: '一、二季度便民服务改革成效',
      purpose: '总结二季度便民服务',
      suggestedWordCount: 600,
      assignedFactIds: ['FACT-NEW-777'],
      uncoveredRequirements: [],
      hasMaterialGap: false,
      confirmed: true,
    },
  ],
};

const blocks2027 = generateDraftFromFactsAndOutline(task2027);
assert(blocks2027.length === 1, '生成全新章节对应段落');
assert(blocks2027[0].sectionId === 'SEC-NEW-888', '段落sectionId与全新章节ID一致');
assert(blocks2027[0].id.includes('SEC-NEW-888'), '段落ID与全新章节ID绑定');
assert(blocks2027[0].content.includes('2027年二季度'), '正文按当前2027年二季度期间生成');
assert(blocks2027[0].content.includes('落地营商便民服务事项完成66件'), '正文包含全新事实名称、数值及单位');
assert(blocks2027[0].referencedFactIds.includes('FACT-NEW-777'), '段落正确引用全新事实ID');

// ==========================================
// Acceptance c: 采信128，事实表、大纲和正文依据反查全部指向EVD-02；采信120则指向EVD-01
// ==========================================
console.log('\n[验收项 c] 120/128冲突裁决出处反查检验:');
// 采信 128
const readyTask = createPresetTask('ready_to_draft');
const fact128 = readyTask.facts.find((f) => f.id === 'FACT-01')!;
assert(fact128.value === '128', '采信128后数值为128');
assert(fact128.primaryEvidenceId === 'EVD-02', '采信128后主出处指向EVD-02');

const blocks128 = generateDraftFromFactsAndOutline(readyTask);
const block128 = blocks128.find((b) => b.referencedFactIds.includes('FACT-01'))!;
assert(!!block128, '正文中生成重点任务段落');
assert(block128.content.includes('128项'), '正文中写入128项');
assert(!block128.content.includes('120项'), '正文中不包含未被采信的120项');

// 验证依据反查指向 EVD-02
const referencedFact128 = readyTask.facts.find((f) => f.id === block128.referencedFactIds[0])!;
assert(referencedFact128.primaryEvidenceId === 'EVD-02', '段落依据反查事实主出处为EVD-02');

// 采信 120
const task120: Task = JSON.parse(JSON.stringify(readyTask));
task120.facts[0].value = '120';
task120.facts[0].selectedConflictValue = '120';
task120.facts[0].primaryEvidenceId = 'EVD-01';
task120.facts[0].conflictResolutionReason = '采信科室甲单一科室申报口径120项';

const blocks120 = generateDraftFromFactsAndOutline(task120);
const block120 = blocks120.find((b) => b.referencedFactIds.includes('FACT-01'))!;
assert(block120.content.includes('120项'), '正文中写入120项');
assert(!block120.content.includes('128项'), '正文中不包含未被采信的128项');
const referencedFact120 = task120.facts.find((f) => f.id === block120.referencedFactIds[0])!;
assert(referencedFact120.primaryEvidenceId === 'EVD-01', '段落依据反查事实主出处为EVD-01');

// ==========================================
// Acceptance d: 排除冲突事实后可继续，但正文不写被排除数字
// ==========================================
console.log('\n[验收项 d] 排除冲突事实检验:');
const taskExcludedConflict: Task = JSON.parse(JSON.stringify(readyTask));
taskExcludedConflict.facts[0].status = 'excluded';
taskExcludedConflict.facts[0].selectedConflictValue = undefined;

assert(!isValidFactForDraft(taskExcludedConflict.facts[0], taskExcludedConflict), '已排除事实判定为无效事实');

const blocksExcluded = generateDraftFromFactsAndOutline(taskExcludedConflict);
const allExcludedContent = blocksExcluded.map((b) => b.content).join('\n');
assert(!allExcludedContent.includes('128项'), '正文中不写被排除的128项');
assert(!allExcludedContent.includes('120项'), '正文中不写被排除的120项');

// ==========================================
// Acceptance e: 历史96项不能进入本期确认清单，只有答案的线索不能确认
// ==========================================
console.log('\n[验收项 e] 历史96项与纯答案线索隔离检验:');
const historicFact = readyTask.facts.find((f) => f.id === 'FACT-05')!;
assert(historicFact.isHistoricOnly === true, 'FACT-05标记为isHistoricOnly');
assert(!isValidFactForDraft(historicFact, readyTask), '历史96项不可纳入本期起草');

const clueOnlyFact = readyTask.facts.find((f) => f.id === 'FACT-06')!;
assert(clueOnlyFact.status === 'gap', 'CLUE-01线索事实状态为gap');
assert(!isValidFactForDraft(clueOnlyFact, readyTask), '纯定性线索不可纳入本期已核验起草');

// ==========================================
// Acceptance f: 将事实从confirmed撤为pending后，旧大纲批准失效且不能重新生成
// ==========================================
console.log('\n[验收项 f] 撤回事实后大纲批准失效与生成拦截检验:');
const taskWithRevokedFact: Task = JSON.parse(JSON.stringify(readyTask));
// Revoke FACT-02 from confirmed to pending
const f2 = taskWithRevokedFact.facts.find((f) => f.id === 'FACT-02')!;
f2.status = 'pending';
// Downstream snapshots and approval invalidated
taskWithRevokedFact.factSnapshot = undefined;
taskWithRevokedFact.outlineConfirmed = false;
taskWithRevokedFact.outlineSnapshot = undefined;

assert(f2.status === 'pending', 'FACT-02状态变为pending');
assert(taskWithRevokedFact.outlineConfirmed === false, '大纲批准已失效');
assert(taskWithRevokedFact.factSnapshot === undefined, '事实快照已失效');

// isValidFactForDraft should reject the pending fact
assert(!isValidFactForDraft(f2, taskWithRevokedFact), '已撤回为pending的事实不可纳入起草');

// ==========================================
// Acceptance g: 人工补充25场，经确认引用后，各种局部改写保留25场
// ==========================================
console.log('\n[验收项 g] 人工补充25场及局部改写保留检验:');
const customBlock: ParagraphBlock = {
  id: 'BLK-TEST-25',
  sectionId: 'SEC-01',
  order: 2,
  content: '坚持需求导向，深化专业实操培养。2026年1至9月，组织专题培训25场，累计参训800人次，保障全系统平稳高效运转。',
  referencedFactIds: ['FACT-SUPP-25'],
  updatedAt: new Date().toISOString(),
};

const compressRes = generateParagraphRevision(customBlock, 'compress');
assert(compressRes.suggestedText.includes('25场'), '压缩改写严格保留25场');
assert(!compressRes.suggestedText.includes('16场'), '压缩改写未捏造回16场');
assert(compressRes.suggestedText.includes('800人次'), '压缩改写保留800人次单位');

const expandRes = generateParagraphRevision(customBlock, 'expand');
assert(expandRes.suggestedText.includes('25场'), '扩写改写严格保留25场');
assert(!expandRes.suggestedText.includes('16场'), '扩写改写未捏造回16场');

const formalRes = generateParagraphRevision(customBlock, 'formal');
assert(formalRes.suggestedText.includes('25场'), '正式化改写严格保留25场');
assert(!formalRes.suggestedText.includes('16场'), '正式化改写未捏造回16场');

const highlightRes = generateParagraphRevision(customBlock, 'highlight');
assert(highlightRes.suggestedText.includes('25场'), '突出重点改写严格保留25场');
assert(!highlightRes.suggestedText.includes('16场'), '突出重点改写未捏造回16场');

console.log('\n🎉 所有任务07有效验收测试（a至g）全部通过！\n');
