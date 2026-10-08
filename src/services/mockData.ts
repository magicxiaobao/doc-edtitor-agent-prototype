import { Task, SourceDocument, EvidenceSnippet, Fact, StyleRule, OutlineSection, DraftVersion, ReviewComment } from '../types';

export const INITIAL_DOCUMENTS: SourceDocument[] = [
  {
    id: 'SRC-01',
    name: '科室甲前三季度工作情况',
    source: '科室甲',
    period: '2026年1-9月',
    usage: 'current_fact',
    parseStatus: 'parsed',
    fileType: 'txt',
    content: `第一段：2026年以来，科室甲紧紧围绕全系统年度工作要点，持续强化责任落实，抓细抓实各项日常工作与关键指标攻坚。

第二段：深入推动管理服务机制创新，优化办理程序，协调各工作小组按照既定目标有序推进，确保各项业务平稳高效运转。

第三段：2026年1至9月，累计完成重点任务120项。相关工作按序时进度平稳开展，各业务环节衔接顺畅，基础保障有力。`,
    paragraphCount: 3,
    wordCount: 168,
  },
  {
    id: 'SRC-02',
    name: '科室乙前三季度汇总',
    source: '科室乙',
    period: '2026年1-9月',
    usage: 'current_fact',
    parseStatus: 'parsed',
    fileType: 'txt',
    content: `第一段：为全面梳理前三季度全系统业务指标运行态势，科室乙会同相关业务线条对已申报及结项事项进行复核与合并统计。

第二段：2026年1至9月，累计完成重点任务128项。统计范围与科室甲材料相同。

第三段：经复核，因部分关联交叉任务在汇总环节予以归集，故此数据涵盖了全口径重点推进项目。后续将持续加强协同。`,
    paragraphCount: 3,
    wordCount: 172,
  },
  {
    id: 'SRC-03',
    name: '培训工作台账',
    source: '教育培训处',
    period: '2026年1-9月',
    usage: 'current_fact',
    parseStatus: 'parsed',
    fileType: 'txt',
    content: `第一段：立足业务实际与干部队伍履职需要，年初制定了专项业务培训规划方案。

第二段：重点围绕履职规范、业务流程、信息化系统实操等开展分级分类培训。

第三段：统筹师资力量，强化培训考评与效果跟踪，确保学以致用。

第四段：培训覆盖各业务骨干及一线工作人员，参训纪律良好。

第五段：2026年1至9月，组织专题培训16场，累计参训800人次。`,
    paragraphCount: 5,
    wordCount: 154,
  },
  {
    id: 'SRC-04',
    name: '2025年度工作总结',
    source: '综合档案室',
    period: '2025年度',
    usage: 'style_ref',
    parseStatus: 'parsed',
    fileType: 'txt',
    content: `第一段：2025年是推进各项战略任务的关键之年。在各部门共同努力下，全系统呈现稳中有进、向上向好的良好势头。

第二段：突出政治引领，筑牢思想根基，全力以赴抓好重点改革攻坚。

第三段：2025年全年累计完成重点任务96项。围绕年度目标，统筹推进各项重点工作。

第四段：坚持问题导向，正视当前在服务精细度、数字化协同等方面的短板弱项，扎实谋划下一步举措。`,
    paragraphCount: 4,
    wordCount: 178,
  },
  {
    id: 'SRC-05',
    name: '专题调研情况汇报',
    source: '政策研究室',
    period: '2026年1-9月',
    usage: 'current_fact',
    parseStatus: 'parsed',
    fileType: 'txt',
    content: `第一段：为切实掌握基层一线实际困难与服务诉求，研究室牵头制定了大兴调查研究实施方案。

第二段：2026年1至9月，开展专题调研12次。深入基层点位听取诉求，形成多篇对策分析专报。

第三段：推动调研成果转化为制度成果与流程改进方案，切实提升一线办事满意度。`,
    paragraphCount: 3,
    wordCount: 142,
  },
  {
    id: 'CLUE-01',
    name: '知识库RAG检索回答',
    source: '知识库RAG问答',
    period: '2026年度',
    usage: 'rag_clue',
    parseStatus: 'parsed',
    fileType: 'txt',
    content: `【检索回答】：服务满意度明显提升。
【说明】：该结果由知识库检索问答生成，当前无原文具体出处与量化百分比，仅作为线索参考，不可直接作为已核验事实入稿。`,
    paragraphCount: 1,
    wordCount: 65,
  },
];

export const INITIAL_SNIPPETS: EvidenceSnippet[] = [
  {
    id: 'EVD-01',
    sourceDocId: 'SRC-01',
    docName: '科室甲前三季度工作情况',
    location: '第3段',
    period: '2026年1至9月',
    text: '2026年1至9月，累计完成重点任务120项。',
  },
  {
    id: 'EVD-02',
    sourceDocId: 'SRC-02',
    docName: '科室乙前三季度汇总',
    location: '第2段',
    period: '2026年1至9月',
    text: '2026年1至9月，累计完成重点任务128项。统计范围与科室甲材料相同。',
  },
  {
    id: 'EVD-03',
    sourceDocId: 'SRC-03',
    docName: '培训工作台账',
    location: '第5段',
    period: '2026年1至9月',
    text: '2026年1至9月，组织专题培训16场，累计参训800人次。',
  },
  {
    id: 'EVD-04',
    sourceDocId: 'SRC-04',
    docName: '2025年度工作总结',
    location: '第3段',
    period: '2025年度',
    text: '2025年全年累计完成重点任务96项。围绕年度目标，统筹推进各项重点工作。',
  },
  {
    id: 'EVD-05',
    sourceDocId: 'SRC-05',
    docName: '专题调研情况汇报',
    location: '第2段',
    period: '2026年1至9月',
    text: '2026年1至9月，开展专题调研12次。',
  },
  {
    id: 'EVD-06',
    sourceDocId: 'CLUE-01',
    docName: '知识库RAG检索回答',
    location: '问答摘要（无原文具体出处）',
    period: '2026年度',
    text: '服务满意度明显提升。',
  },
];

export const INITIAL_FACTS: Fact[] = [
  {
    id: 'FACT-01',
    metric: '累计完成重点任务',
    period: '2026年1至9月',
    value: '120 / 128 (存在口径冲突)',
    unit: '项',
    metricScope: '科室甲材料记载120项；科室乙汇总口径记载128项（统计范围相同）',
    primaryEvidenceId: 'EVD-01',
    evidenceIds: ['EVD-01', 'EVD-02'],
    hasConflict: true,
    conflictCandidates: [
      {
        value: '120',
        sourceDocId: 'SRC-01',
        evidenceId: 'EVD-01',
        description: '科室甲申报口径：按单一科室台账统计，完成120项',
      },
      {
        value: '128',
        sourceDocId: 'SRC-02',
        evidenceId: 'EVD-02',
        description: '科室乙汇总口径：全口径合并统计，统计范围相同，完成128项',
      },
    ],
    status: 'pending',
  },
  {
    id: 'FACT-02',
    metric: '组织专题培训',
    period: '2026年1至9月',
    value: '16',
    unit: '场',
    metricScope: '全系统干部职工专题业务培训台账',
    primaryEvidenceId: 'EVD-03',
    evidenceIds: ['EVD-03'],
    hasConflict: false,
    status: 'confirmed',
  },
  {
    id: 'FACT-03',
    metric: '专题培训参训规模',
    period: '2026年1至9月',
    value: '800',
    unit: '人次',
    metricScope: '专题培训实名参训人次统计（注：单位为人次，非人数）',
    primaryEvidenceId: 'EVD-03',
    evidenceIds: ['EVD-03'],
    hasConflict: false,
    status: 'confirmed',
  },
  {
    id: 'FACT-04',
    metric: '开展专题调研',
    period: '2026年1至9月',
    value: '12',
    unit: '次',
    metricScope: '深入基层专项调研工作记录',
    primaryEvidenceId: 'EVD-05',
    evidenceIds: ['EVD-05'],
    hasConflict: false,
    status: 'confirmed',
  },
  {
    id: 'FACT-05',
    metric: '历史年度重点任务 (参考用，不可入本期)',
    period: '2025年度',
    value: '96',
    unit: '项',
    metricScope: '2025历史定稿文风参考，旧年份隔离（禁止计入2026成绩）',
    primaryEvidenceId: 'EVD-04',
    evidenceIds: ['EVD-04'],
    hasConflict: false,
    isHistoricOnly: true,
    status: 'excluded',
  },
  {
    id: 'FACT-06',
    metric: '服务满意度提升情况',
    period: '2026年度',
    value: '定性提升（无量化数据）',
    unit: '%',
    metricScope: 'RAG仅返回“服务满意度明显提升”，无具体原文出处与量化比例',
    primaryEvidenceId: 'EVD-06',
    evidenceIds: ['EVD-06'],
    hasConflict: false,
    status: 'gap',
    gapDescription: '缺少量化测评百分比及正式测评报告支撑，建议补充问卷或系统统计出处',
  },
];

export const INITIAL_STYLE_RULES: StyleRule[] = [
  {
    id: 'STYLE-01',
    title: '标题突出工作动作与主旨',
    category: '标题结构',
    description: '各层级标题应以动词或动宾短语提炼核心举措（如“聚焦统筹协同、提升治理效能”），结构整齐工整。',
    sampleSnippet: '围绕年度目标，统筹推进各项重点工作。',
    sampleDocId: 'SRC-04',
    confirmed: true,
  },
  {
    id: 'STYLE-02',
    title: '成绩段落采用“举措+事实依据”结构',
    category: '举措事实',
    description: '叙述工作成效时，先阐明工作抓手与具体做法，紧接准确数据支撑，避免空洞修饰。',
    sampleSnippet: '深入推动管理服务机制创新，优化办理程序，协调各工作小组按照既定目标有序推进。',
    sampleDocId: 'SRC-01',
    confirmed: true,
  },
  {
    id: 'STYLE-03',
    title: '突出问题与下一步工作安排严格对应',
    category: '问题举措对应',
    description: '剖析问题要客观深刻，针对查摆出的短板，下一步工作安排需有一对一的解决措施。',
    sampleSnippet: '坚持问题导向，正视当前在服务精细度、数字化协同等方面的短板弱项，扎实谋划下一步举措。',
    sampleDocId: 'SRC-04',
    confirmed: true,
  },
  {
    id: 'STYLE-04',
    title: '行文平实严谨，避免商业口号化用语',
    category: '行文正式度',
    description: '采用单位标准公文规范用语，严谨客观，不使用夸张或营销化表述。',
    sampleSnippet: '全系统呈现稳中有进、向上向好的良好势头。突出政治引领，筑牢思想根基。',
    sampleDocId: 'SRC-04',
    confirmed: true,
  },
];

export const INITIAL_OUTLINE: OutlineSection[] = [
  {
    id: 'SEC-01',
    order: 1,
    title: '一、前三季度总体运行态势与工作成效',
    purpose: '全面总结2026年前三季度总体履职进展，展示重点任务、业务培训和专题调研的核心成效。',
    suggestedWordCount: 1200,
    assignedFactIds: ['FACT-01', 'FACT-02', 'FACT-03', 'FACT-04'],
    uncoveredRequirements: [],
    hasMaterialGap: false,
    confirmed: true,
  },
  {
    id: 'SEC-02',
    order: 2,
    title: '二、存在的主要短板与突出问题',
    purpose: '客观分析当前工作中在协调机制、数字化支撑及基层满意度深化方面存在的困难与短板。',
    suggestedWordCount: 800,
    assignedFactIds: ['FACT-06'],
    uncoveredRequirements: ['服务满意度量化数据待补充'],
    hasMaterialGap: true,
    gapDescription: '服务满意度尚缺量化评估支撑材料',
    confirmed: true,
  },
  {
    id: 'SEC-03',
    order: 3,
    title: '三、四季度重点攻坚方向与工作安排',
    purpose: '围绕全年目标冲刺，提出冲刺攻坚重点任务、深化常态化培训调研的针对性举措。',
    suggestedWordCount: 1000,
    assignedFactIds: [],
    uncoveredRequirements: [],
    hasMaterialGap: false,
    confirmed: true,
  },
];

export function createPresetTask(scenario: 'blank' | 'conflict_pending' | 'ready_to_draft' | 'under_review'): Task {
  const baseTask: Task = {
    id: `TASK-${Date.now().toString(36)}`,
    title: '某单位2026年前三季度工作总结',
    docType: '工作总结',
    usage: '向单位主要负责人及上级主管机关作前三季度工作推进情况专题汇报',
    audience: '单位主要领导、班子成员及各科室负责人',
    startDate: '2026-01-01',
    endDate: '2026-09-30',
    targetWordCount: 3000,
    mandatoryCoverage: '重点任务完成进度、队伍培训人次、专项调研开展成效、存在突出问题及四季度工作举措',
    deadline: '2026-10-15',
    primaryAuthor: '主笔甲',
    currentStage: 'task_setup',
    status: '草稿',
    updatedAt: new Date().toISOString(),
    isFinalized: false,
    schemaVersion: 1,
    documents: JSON.parse(JSON.stringify(INITIAL_DOCUMENTS)),
    snippets: JSON.parse(JSON.stringify(INITIAL_SNIPPETS)),
    facts: JSON.parse(JSON.stringify(INITIAL_FACTS)),
    styleRules: JSON.parse(JSON.stringify(INITIAL_STYLE_RULES)),
    styleConfirmed: false,
    outline: JSON.parse(JSON.stringify(INITIAL_OUTLINE)),
    outlineConfirmed: false,
    drafts: [],
    currentDraftId: '',
    reviewComments: [],
    auditIssues: [],
  };

  if (scenario === 'blank') {
    baseTask.id = 'TASK-EMPTY';
    baseTask.title = '新建空白汇报材料任务';
    baseTask.docType = '汇报材料';
    baseTask.usage = '待主笔完善写作任务背景与要求';
    baseTask.audience = '单位分管领导';
    baseTask.targetWordCount = 2000;
    baseTask.mandatoryCoverage = '业务推进要点、需协调解决事项';
    baseTask.currentStage = 'task_setup';
    baseTask.status = '草稿';
    baseTask.documents = [];
    baseTask.snippets = [];
    baseTask.facts = [];
    baseTask.styleConfirmed = false;
    baseTask.outlineConfirmed = false;
    baseTask.drafts = [];
    return baseTask;
  }

  if (scenario === 'conflict_pending') {
    baseTask.id = 'TASK-CONFLICT';
    baseTask.title = '某单位2026年前三季度工作总结 (冲突待裁决)';
    baseTask.currentStage = 'material_fact';
    baseTask.status = '事实待确认';
    // FACT-01 remains pending with conflict
    baseTask.facts[0].status = 'pending';
    baseTask.facts[0].selectedConflictValue = undefined;
    baseTask.styleConfirmed = false;
    baseTask.outlineConfirmed = false;
    return baseTask;
  }

  if (scenario === 'ready_to_draft') {
    baseTask.id = 'TASK-READY';
    baseTask.title = '某单位2026年前三季度工作总结 (事实大纲已确认)';
    baseTask.currentStage = 'drafting';
    baseTask.status = '起草中';
    // Resolve conflict to 128 -> primary evidence MUST be EVD-02
    baseTask.facts[0].status = 'confirmed';
    baseTask.facts[0].value = '128';
    baseTask.facts[0].selectedConflictValue = '128';
    baseTask.facts[0].metricScope = '科室乙汇总口径：全口径合并统计，统计范围相同，完成128项';
    baseTask.facts[0].primaryEvidenceId = 'EVD-02';
    baseTask.facts[0].conflictResolutionReason = '经核实，科室乙采用全系统全口径汇总标准，涵盖交叉归集任务，统计范围一致，采信科室乙汇总口径128项。';
    baseTask.factSnapshot = {
      confirmedAt: '2026-10-07T08:30:00.000Z',
      factIds: ['FACT-01', 'FACT-02', 'FACT-03', 'FACT-04'],
      items: [
        {
          factId: 'FACT-01',
          metric: '累计完成重点任务',
          value: '128',
          unit: '项',
          period: '2026年1至9月',
          metricScope: '科室乙汇总口径：全口径合并统计，统计范围相同，完成128项',
          primaryEvidenceId: 'EVD-02',
          selectedConflictValue: '128',
          conflictResolutionReason: '采信科室乙汇总口径128项',
          hasConflict: true,
          conflictCandidates: [
            { value: '120', description: '科室甲直报口径：累计完成重点任务120项', evidenceId: 'EVD-01' },
            { value: '128', description: '科室乙汇总口径：全口径合并统计，完成128项', evidenceId: 'EVD-02' },
          ],
        },
        {
          factId: 'FACT-02',
          metric: '组织专题培训',
          value: '16',
          unit: '场',
          period: '2026年1至9月',
          metricScope: '全系统干部职工专题业务培训台账',
          primaryEvidenceId: 'EVD-03',
        },
        {
          factId: 'FACT-03',
          metric: '专题培训参训规模',
          value: '800',
          unit: '人次',
          period: '2026年1至9月',
          metricScope: '专题培训实名参训人次统计',
          primaryEvidenceId: 'EVD-03',
        },
        {
          factId: 'FACT-04',
          metric: '开展专题调研',
          value: '12',
          unit: '次',
          period: '2026年1至9月',
          metricScope: '深入基层专项调研工作记录',
          primaryEvidenceId: 'EVD-05',
        },
      ],
      hash: 'SNAPSHOT-HASH-CONFIRMED-128',
    };
    baseTask.styleConfirmed = true;
    baseTask.styleSnapshot = {
      confirmedAt: '2026-10-07T08:35:00.000Z',
      activeRuleIds: baseTask.styleRules.filter((r) => r.confirmed).map((r) => r.id),
      hash: 'STYLE-HASH-CONFIRMED',
    };
    baseTask.outlineConfirmed = true;
    baseTask.outlineSnapshot = {
      confirmedAt: '2026-10-07T08:40:00.000Z',
      sections: baseTask.outline.map((s) => ({
        sectionId: s.id,
        title: s.title,
        suggestedWordCount: s.suggestedWordCount,
        assignedFactIds: s.assignedFactIds,
      })),
      hash: 'OUTLINE-HASH-CONFIRMED',
    };
    return baseTask;
  }

  // scenario === 'under_review'
  baseTask.id = 'TASK-REVIEW';
  baseTask.title = '某单位2026年前三季度工作总结 (审阅修改中)';
  baseTask.currentStage = 'review';
  baseTask.status = '审阅中';
  baseTask.facts[0].status = 'confirmed';
  baseTask.facts[0].value = '128';
  baseTask.facts[0].selectedConflictValue = '128';
  baseTask.facts[0].primaryEvidenceId = 'EVD-02';
  baseTask.facts[0].conflictResolutionReason = '经核实采纳科室乙汇总口径128项。';
  baseTask.factSnapshot = {
    confirmedAt: '2026-10-07T08:30:00.000Z',
    factIds: ['FACT-01', 'FACT-02', 'FACT-03', 'FACT-04', 'FACT-06'],
    items: [
      {
        factId: 'FACT-01',
        metric: '累计完成重点任务',
        value: '128',
        unit: '项',
        period: '2026年1至9月',
        metricScope: '科室乙汇总口径：完成128项',
        primaryEvidenceId: 'EVD-02',
        selectedConflictValue: '128',
        conflictResolutionReason: '采信科室乙汇总口径128项',
        hasConflict: true,
        conflictCandidates: [
          { value: '120', description: '科室甲直报口径：完成120项', evidenceId: 'EVD-01' },
          { value: '128', description: '科室乙汇总口径：完成128项', evidenceId: 'EVD-02' },
        ],
      },
      {
        factId: 'FACT-02',
        metric: '组织专题培训',
        value: '16',
        unit: '场',
        period: '2026年1至9月',
        metricScope: '全系统干部职工专题业务培训台账',
        primaryEvidenceId: 'EVD-03',
      },
      {
        factId: 'FACT-03',
        metric: '专题培训参训规模',
        value: '800',
        unit: '人次',
        period: '2026年1至9月',
        metricScope: '专题培训实名参训人次统计（注：单位为人次，非人数）',
        primaryEvidenceId: 'EVD-03',
      },
      {
        factId: 'FACT-04',
        metric: '开展专题调研',
        value: '12',
        unit: '次',
        period: '2026年1至9月',
        metricScope: '深入基层专项调研工作记录',
        primaryEvidenceId: 'EVD-05',
      },
      {
        factId: 'FACT-06',
        metric: '服务满意度明显提升',
        value: '定性提升',
        unit: '定性',
        period: '2026年1至9月',
        metricScope: '仅作为定性检索线索（缺少量化测评报告支撑）',
        primaryEvidenceId: 'EVD-06',
      },
    ],
    hash: 'SNAPSHOT-HASH-CONFIRMED-128',
  };
  baseTask.styleConfirmed = true;
  baseTask.outlineConfirmed = true;
  baseTask.styleSnapshot = {
    confirmedAt: '2026-10-07T08:35:00.000Z',
    activeRuleIds: baseTask.styleRules.filter((r) => r.confirmed).map((r) => r.id),
    hash: 'STYLE-HASH-CONFIRMED',
  };
  baseTask.outlineSnapshot = {
    confirmedAt: '2026-10-07T08:40:00.000Z',
    sections: baseTask.outline.map((s) => ({
      sectionId: s.id,
      title: s.title,
      suggestedWordCount: s.suggestedWordCount,
      assignedFactIds: s.assignedFactIds,
    })),
    hash: 'OUTLINE-HASH-CONFIRMED',
  };

  const draftBlocks = [
    {
      id: 'BLK-01',
      sectionId: 'SEC-01',
      order: 1,
      content: '2026年1至9月，全系统紧紧围绕年度核心工作目标，强化统筹联动与机制创新。截至9月末，累计完成重点任务128项，各项既定序时指标平稳达成，重点攻坚成效显著。',
      referencedFactIds: ['FACT-01'],
      updatedAt: '2026-10-07T09:00:00.000Z',
    },
    {
      id: 'BLK-02',
      sectionId: 'SEC-01',
      order: 2,
      content: '在队伍履职能力建设方面，立足基层实际需要，深化分级分类专业实操培养。前三季度累计组织专题培训16场，累计参训800人次，有效增强了骨干人员政策理解与规范执行水平。',
      referencedFactIds: ['FACT-02', 'FACT-03'],
      updatedAt: '2026-10-07T09:00:00.000Z',
    },
    {
      id: 'BLK-03',
      sectionId: 'SEC-01',
      order: 3,
      content: '在大兴调查研究方面，紧扣一线重难点诉求，深入基层点位听取呼声，累计开展专题调研12次，推动形成针对性制度改进与业务流程优化举措。',
      referencedFactIds: ['FACT-04'],
      updatedAt: '2026-10-07T09:00:00.000Z',
    },
    {
      id: 'BLK-04',
      sectionId: 'SEC-02',
      order: 4,
      content: '在看到成绩的同时，对照高质量履职标准仍存在部分短板：一是跨科室常态化沟通机制仍待完善；二是服务满意度虽然定性感受有所提升，但目前尚缺少定量数据测评体系支撑，精准施策能力仍显不足。',
      referencedFactIds: ['FACT-06'],
      updatedAt: '2026-10-07T09:00:00.000Z',
    },
    {
      id: 'BLK-05',
      sectionId: 'SEC-03',
      order: 5,
      content: '下一步，将聚焦四季度冲刺攻坚：一是锚定未结项关键指标持续发力，确保全面达成年度目标；二是常态化深化专题培训与精准调研成果转化；三是加紧补齐量化测评机制短板，全面提升服务质效与群众获得感。',
      referencedFactIds: [],
      updatedAt: '2026-10-07T09:00:00.000Z',
    },
  ];

  const initialDraft: DraftVersion = {
    id: 'DRAFT-v1.0',
    versionNumber: 'v1.0 (初稿审阅快照)',
    createdAt: '2026-10-07T09:15:00.000Z',
    author: '主笔甲',
    summary: '根据已确认的128项重点任务及三章大纲生成的初稿版本，已提交审阅',
    blocks: draftBlocks,
    isWorkingDraft: true,
    isHistoricalSnapshot: false,
    isFinal: false,
    snapshotMetadata: {
      taskTitle: baseTask.title,
      startDate: baseTask.startDate,
      endDate: baseTask.endDate,
      targetWordCount: baseTask.targetWordCount,
      factSnapshot: baseTask.factSnapshot,
      styleSnapshot: baseTask.styleSnapshot,
      outlineSnapshot: baseTask.outlineSnapshot,
      outlineSections: JSON.parse(JSON.stringify(baseTask.outline)),
    },
  };

  baseTask.drafts = [initialDraft];
  baseTask.currentDraftId = initialDraft.id;

  baseTask.reviewComments = [
    {
      id: 'CMT-01',
      type: 'overall',
      targetVersionId: initialDraft.id,
      reviewer: '审阅乙',
      content: '汇报材料需面向局领导，篇幅建议压缩到2000字以内，重点突出工作成果与突破性举措，精简铺垫表述。',
      status: 'pending',
      suggestedChange: '精简第一部分成效段落，删减泛泛修饰语。',
      createdAt: '2026-10-07T09:30:00.000Z',
    },
    {
      id: 'CMT-02',
      type: 'overall',
      targetVersionId: initialDraft.id,
      reviewer: '审阅丁',
      content: '成效部分需要更加丰满，建议增加两个典型推进案例和一线具体成效数据，以生动展现工作亮点。',
      status: 'pending',
      suggestedChange: '在调研及培训段落后增加具体案例剖析。',
      createdAt: '2026-10-07T09:45:00.000Z',
    },
    {
      id: 'CMT-03',
      type: 'paragraph',
      targetBlockId: 'BLK-02',
      targetBlockOrder: 2,
      targetVersionId: initialDraft.id,
      baseParagraphText: draftBlocks[1].content,
      reviewer: '审阅乙',
      content: '培训段落表述较为冗长，可压缩精炼，同时务必保持“16场、800人次”的严谨口径，不要随意改成人数。',
      status: 'pending',
      authorReply: '',
      suggestedChange: '压缩前缀修饰，保留16场、800人次。',
      createdAt: '2026-10-07T10:00:00.000Z',
    },
  ];

  return baseTask;
}
