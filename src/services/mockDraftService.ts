import { Task, ParagraphBlock } from '../types';

export type RevisionAction = 'compress' | 'expand' | 'formal' | 'highlight';

export interface RevisionSuggestion {
  action: RevisionAction;
  originalText: string;
  suggestedText: string;
  diffExplanation: string;
  factsAffected: string[];
  baseBlockUpdatedAt: string;
}

export function generateDraftFromFactsAndOutline(task: Task): ParagraphBlock[] {
  // Extract confirmed facts
  const taskCountFact = task.facts.find((f) => f.id === 'FACT-01');
  const taskCountValue = taskCountFact?.selectedConflictValue || (taskCountFact?.status === 'confirmed' ? taskCountFact.value : '128');
  
  const trainingCountFact = task.facts.find((f) => f.id === 'FACT-02');
  const trainingCount = trainingCountFact?.status === 'confirmed' ? trainingCountFact.value : '16';

  const attendeeFact = task.facts.find((f) => f.id === 'FACT-03');
  const attendeeCount = attendeeFact?.status === 'confirmed' ? attendeeFact.value : '800';

  const researchFact = task.facts.find((f) => f.id === 'FACT-04');
  const researchCount = researchFact?.status === 'confirmed' ? researchFact.value : '12';

  const blocks: ParagraphBlock[] = [
    {
      id: `BLK-01-${Date.now()}`,
      sectionId: 'SEC-01',
      order: 1,
      content: `2026年1至9月，全系统紧紧围绕年度核心工作目标，强化统筹联动与机制创新。截至9月末，累计完成重点任务${taskCountValue}项，各项既定序时指标平稳达成，重点攻坚成效显著。`,
      referencedFactIds: ['FACT-01'],
      updatedAt: new Date().toISOString(),
    },
    {
      id: `BLK-02-${Date.now()}`,
      sectionId: 'SEC-01',
      order: 2,
      content: `在队伍履职能力建设方面，立足基层实际需要，深化分级分类专业实操培养。前三季度累计组织专题培训${trainingCount}场，累计参训${attendeeCount}人次，有效增强了骨干人员政策理解与规范执行水平。`,
      referencedFactIds: ['FACT-02', 'FACT-03'],
      updatedAt: new Date().toISOString(),
    },
    {
      id: `BLK-03-${Date.now()}`,
      sectionId: 'SEC-01',
      order: 3,
      content: `在大兴调查研究方面，紧扣一线重难点诉求，深入基层点位听取呼声，累计开展专题调研${researchCount}次，推动形成针对性制度改进与业务流程优化举措。`,
      referencedFactIds: ['FACT-04'],
      updatedAt: new Date().toISOString(),
    },
    {
      id: `BLK-04-${Date.now()}`,
      sectionId: 'SEC-02',
      order: 4,
      content: `在看到成绩的同时，对照高质量履职标准仍存在部分短板：一是跨科室常态化沟通机制仍待完善；二是服务满意度虽然定性感受有所提升，但目前尚缺少定量数据测评体系支撑，精准施策能力仍显不足。`,
      referencedFactIds: ['FACT-06'],
      updatedAt: new Date().toISOString(),
    },
    {
      id: `BLK-05-${Date.now()}`,
      sectionId: 'SEC-03',
      order: 5,
      content: `下一步，将聚焦四季度冲刺攻坚：一是锚定未结项关键指标持续发力，确保全面达成年度目标；二是常态化深化专题培训与精准调研成果转化；三是加紧补齐量化测评机制短板，全面提升服务质效与群众获得感。`,
      referencedFactIds: [],
      updatedAt: new Date().toISOString(),
    },
  ];

  return blocks;
}

export function generateParagraphRevision(
  block: ParagraphBlock,
  action: RevisionAction
): RevisionSuggestion {
  let suggestedText = block.content;
  let diffExplanation = '';

  switch (action) {
    case 'compress':
      if (block.content.includes('专题培训') && block.content.includes('800人次')) {
        suggestedText = '深化专业实操培养，前三季度组织专题培训16场、参训800人次，有效提升干部履职规范化水平。';
        diffExplanation = '精炼铺垫修饰语，严格保留“16场、800人次”及“2026年前三季度”统计口径，人次单位未作变动。';
      } else if (block.content.includes('重点任务')) {
        suggestedText = block.content.replace('紧紧围绕年度核心工作目标，强化统筹联动与机制创新。截至9月末，', '统筹有力，前三季度');
        diffExplanation = '删减常规动员修饰，突出关键进度成果。';
      } else {
        suggestedText = block.content.slice(0, Math.floor(block.content.length * 0.75)) + '。';
        diffExplanation = '精简段落篇幅约25%，保留核心表述。';
      }
      break;

    case 'expand':
      suggestedText = block.content + ' 严格对标各项考核细则，建立周例会、月调度跟踪闭环，确保每项推进举措落地生根。';
      diffExplanation = '在段落尾部扩充制度跟踪与日常调度闭环举措，增强说服力。';
      break;

    case 'formal':
      suggestedText = block.content
        .replace('在看到成绩的同时', '在肯定成效的同时，对照高质量内涵式发展要求')
        .replace('下一步', '下一阶段工作规划');
      diffExplanation = '采用标准公文庄重规范句式，提升汇报整体严肃性与严密性。';
      break;

    case 'highlight':
      suggestedText = '【关键攻坚突破】' + block.content;
      diffExplanation = '突出段落核心主旨标识，便于审阅领导快速捕捉重点工作成效。';
      break;
  }

  return {
    action,
    originalText: block.content,
    suggestedText,
    diffExplanation,
    factsAffected: block.referencedFactIds,
    baseBlockUpdatedAt: block.updatedAt,
  };
}
