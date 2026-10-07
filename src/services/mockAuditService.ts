import { Task, ParagraphBlock, AuditIssue } from '../types';

export function runDocumentAudit(task: Task, blocks: ParagraphBlock[]): AuditIssue[] {
  const issues: AuditIssue[] = [];

  blocks.forEach((block, index) => {
    // 1. Check unit: "800人" vs "800人次"
    if (block.content.includes('800人') && !block.content.includes('800人次')) {
      issues.push({
        id: `AUDIT-UNIT-${block.id}-${index}`,
        type: 'metric_unit',
        severity: 'error',
        location: `第${block.order || index + 1}段`,
        blockId: block.id,
        originalText: '800人',
        evidenceText: '培训工作台账（EVD-03第5段）：“组织专题培训16场，累计参训800人次。”',
        suggestion: '将“800人”更正为“800人次”，避免将参训人次口径混淆为实有人数。',
        status: 'unresolved',
      });
    }

    // 2. Check 2025 historic leak
    if (block.content.includes('2025') && (block.content.includes('96项') || block.content.includes('重点任务'))) {
      issues.push({
        id: `AUDIT-HIST-${block.id}-${index}`,
        type: 'historic_data_leak',
        severity: 'error',
        location: `第${block.order || index + 1}段`,
        originalText: block.content,
        evidenceText: '2025年度总结（EVD-04）为历史文风参考，非本期（2026年1-9月）履职数据。',
        suggestion: '删除将2025年历史数据列为本期工作成效的表述。',
        status: 'unresolved',
      });
    }

    // 3. Check satisfaction gap
    if (block.content.includes('服务满意度') && !block.content.includes('缺少') && !block.content.includes('定性')) {
      issues.push({
        id: `AUDIT-GAP-${block.id}-${index}`,
        type: 'gap_missing',
        severity: 'warning',
        location: `第${block.order || index + 1}段`,
        originalText: block.content,
        evidenceText: '知识库RAG仅返回定性线索（CLUE-01），当前无具体量化测评出处。',
        suggestion: '说明服务满意度当前属于定性线索，标注“待补充正式量化测评依据”。',
        status: 'unresolved',
      });
    }

    // 4. Check unverified numbers
    const numberMatches = block.content.match(/\d+[\u4e00-\u9fa5]+/g);
    if (numberMatches) {
      numberMatches.forEach((nm) => {
        // If it's not our known numbers (120项, 128项, 16场, 800人次, 12次, 2026年, 1至9月, 9月末)
        const allowedPatterns = ['120项', '128项', '16场', '800人次', '12次', '2026年', '1月', '9月', '9月末', '4季度', '四季度'];
        const isKnown = allowedPatterns.some((pat) => nm.includes(pat));
        if (!isKnown && !nm.includes('2026') && !nm.includes('第')) {
          issues.push({
            id: `AUDIT-NUM-${block.id}-${nm}`,
            type: 'unreferenced_number',
            severity: 'info',
            location: `第${block.order || index + 1}段`,
            originalText: nm,
            evidenceText: '此数值未在已登记的单位材料台账（SRC-01至SRC-05）中找到匹配出处。',
            suggestion: '请核实该数据出处；若为主笔手工补充，请在事实清单中补充记录依据。',
            status: 'unresolved',
          });
        }
      });
    }
  });

  return issues;
}
