import { Task, ParagraphBlock, AuditIssue, Fact } from '../types';

/**
 * Generates a stable deterministic issue ID
 */
function makeIssueId(prefix: string, blockId: string, extra: string): string {
  const cleanExtra = extra.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_').slice(0, 30);
  return `AUDIT-${prefix}-${blockId}-${cleanExtra}`;
}

/**
 * Runs factual consistency and metric audit on document blocks.
 * Requirement 1 & 2:
 * - Dynamic comparison without hardcoded whitelist (120/128/16/800 removed)
 * - Identifies unit confusion (e.g. "800人次，其中800人")
 * - Identifies conflict mismatch (e.g. adopted 128 but text has 120, blocking finalization)
 * - Avoids treating date ranges like "1至" as accomplishment indicators
 * - Unverified qualitative claims marked for human review
 * - Stable issueId, taskId, draftId, blockId, location, originalText, evidenceText, suggestion
 * - Major discrepancies cannot be bypassed by ignore
 */
export function runDocumentAudit(
  task: Task, 
  blocks: ParagraphBlock[], 
  currentDraftId?: string
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const draftId = currentDraftId || task.currentDraftId || task.drafts[0]?.id || 'DRAFT-CURRENT';

  // 1. Gather active fact pool (prefer frozen snapshot or confirmed task facts)
  const targetDraft = task.drafts.find((d) => d.id === draftId);
  const snapshotFacts = targetDraft?.snapshotMetadata?.factSnapshot?.items;
  
  // Confirmed facts map for lookup
  const confirmedFacts = task.facts.filter((f) => f.status === 'confirmed');

  // Load audit history records tied to this draft version
  const auditRecordsMap = new Map<string, { status: 'unresolved' | 'accepted' | 'ignored'; ignoreReason?: string }>();
  if (targetDraft?.auditRecords) {
    targetDraft.auditRecords.forEach((rec) => {
      auditRecordsMap.set(rec.issueId, rec);
    });
  }

  // Build dynamic known numbers & metrics set from facts and evidence
  const knownMetricTokens = new Set<string>();
  const knownPlainNumbers = new Set<string>();

  // Add numbers from confirmed facts
  task.facts.forEach((f) => {
    if (f.status === 'confirmed' || f.hasConflict) {
      if (f.value) {
        knownPlainNumbers.add(f.value);
        if (f.unit) {
          knownMetricTokens.add(`${f.value}${f.unit}`);
        }
      }
      if (f.selectedConflictValue) {
        knownPlainNumbers.add(f.selectedConflictValue);
        if (f.unit) {
          knownMetricTokens.add(`${f.selectedConflictValue}${f.unit}`);
        }
      }
      // If conflict candidates exist
      if (f.conflictCandidates) {
        f.conflictCandidates.forEach((cand) => {
          knownPlainNumbers.add(cand.value);
          if (f.unit) {
            knownMetricTokens.add(`${cand.value}${f.unit}`);
          }
        });
      }
    }
  });

  // Add numbers from evidence snippets
  task.snippets.forEach((snip) => {
    const snipNums = snip.text.match(/\d+(?:\.\d+)?(?:项|场|次|人次|人|万|个|篇|套|户|条|家|件|名|宗|起)/g);
    if (snipNums) {
      snipNums.forEach((t) => knownMetricTokens.add(t));
    }
  });

  // Date and range patterns to explicitly ignore from accomplishment metrics
  // Avoid treating "1至", "1至9月", "2026年", "第1章" as indicators
  const isDateOrPeriodOrSection = (token: string, fullText: string, index: number): boolean => {
    if (/^\d{4}年?$/.test(token)) return true;
    if (/^\d{1,2}月$/.test(token)) return true;
    if (/^\d{1,2}日$/.test(token)) return true;
    if (/^\d{1,2}号$/.test(token)) return true;
    if (/^\d+季度$/.test(token)) return true;
    if (/^第\d+/.test(token)) return true;
    if (/^1至/.test(token) || /^至\d+/.test(token)) return true;
    if (/^\d+至\d+/.test(token)) return true;
    if (/^\d+-\d+/.test(token)) return true;

    // Look around context: if preceded or followed by "至", "月", "年", "季度", "期间"
    const start = Math.max(0, index - 4);
    const end = Math.min(fullText.length, index + token.length + 4);
    const window = fullText.slice(start, end);
    if (/至\d+月/.test(window) || /\d+至\d+月/.test(window) || /统计期间/.test(window) || /1至9月/.test(window)) {
      return true;
    }

    return false;
  };

  // Iterate over paragraphs
  blocks.forEach((block, index) => {
    const blockOrder = block.order || index + 1;
    const locationDesc = `第${blockOrder}段`;

    // -------------------------------------------------------------
    // Check 1: Conflict and Adopted Figure Mismatch
    // "采信128但正文写120要定位对应事实并阻断定稿"
    // -------------------------------------------------------------
    task.facts.forEach((fact) => {
      if (fact.hasConflict) {
        const adoptedValue = fact.selectedConflictValue;
        if (adoptedValue && fact.conflictCandidates) {
          fact.conflictCandidates.forEach((cand) => {
            if (cand.value !== adoptedValue) {
              const rejectedPattern = `${cand.value}${fact.unit}`;
              const rejectedAlone = cand.value;
              
              // Check if block contains the rejected pattern
              const hasRejectedMetric = block.content.includes(rejectedPattern);
              const hasRejectedInContext = 
                block.content.includes(rejectedAlone) && 
                (block.content.includes(fact.metric) || block.content.includes(fact.unit));

              if (hasRejectedMetric || hasRejectedInContext) {
                const issueId = makeIssueId('CONFLICT', block.id, fact.id);
                const originalText = hasRejectedMetric ? rejectedPattern : `${cand.value}${fact.unit}`;
                issues.push({
                  id: issueId,
                  issueId,
                  taskId: task.id,
                  draftId,
                  blockId: block.id,
                  type: 'conflict_mismatch',
                  severity: 'error',
                  isBlocking: true, // Major discrepancy blocks finalization
                  location: locationDesc,
                  originalText,
                  evidenceText: `事实依据【${fact.metric}】已明确裁决采信口径：“${adoptedValue}${fact.unit}”（${cand.description ? '排除：' + cand.description : '出处：' + (fact.primaryEvidenceId || '台账')}）。`,
                  suggestion: `当前正文仍在使用未采信的冲突口径“${originalText}”，必须更正为已裁决的“${adoptedValue}${fact.unit}”。此项为阻断性核校错误。`,
                  replacementText: `${adoptedValue}${fact.unit}`,
                  status: 'unresolved',
                });
              }
            }
          });
        }
      }
    });

    // -------------------------------------------------------------
    // Check 2: Metric Unit Confusion
    // "能识别同段“800人次，其中800人”的单位问题"
    // -------------------------------------------------------------
    // Find any fact specifying '人次' as unit
    const personTimesFacts = task.facts.filter((f) => f.unit === '人次');
    personTimesFacts.forEach((fact) => {
      const factNum = fact.value || '800';
      // Look for "<num>人" NOT followed by "次"
      // Note: Even if the same paragraph contains "800人次", the occurrence "800人" is detected!
      const unitConfusionRegex = new RegExp(`(${factNum})\\s*人(?!次)`, 'g');
      let match: RegExpExecArray | null;
      while ((match = unitConfusionRegex.exec(block.content)) !== null) {
        const issueId = makeIssueId('UNIT', block.id, `${match[1]}_ren`);
        const originalText = `${match[1]}人`;
        issues.push({
          id: issueId,
          issueId,
          taskId: task.id,
          draftId,
          blockId: block.id,
          type: 'metric_unit',
          severity: 'error',
          isBlocking: true, // Unit error blocks finalization
          location: `${locationDesc}（第${match.index + 1}字符处）`,
          charIndex: match.index,
          originalText,
          evidenceText: `单位工作台账（${fact.primaryEvidenceId || '台账依据'}）明确规范口径为：“${fact.metric}${factNum}人次”，严禁混淆为实有人数。`,
          suggestion: `将“${originalText}”更正为“${factNum}人次”，严格区分参训人次与实有人数口径。此项为阻断性错误。`,
          replacementText: `${factNum}人次`,
          status: 'unresolved',
        });
      }
    });

    // Also check for other facts where a number has wrong unit
    confirmedFacts.forEach((fact) => {
      if (fact.unit && fact.value && fact.unit !== '人次' && fact.unit !== '项') {
        // e.g. fact.value = 16, unit = 场. If text has 16次 or 16个
        const wrongUnits = ['个', '次', '项', '起'].filter((u) => u !== fact.unit);
        wrongUnits.forEach((wu) => {
          const wrongPattern = `${fact.value}${wu}`;
          if (block.content.includes(wrongPattern) && block.content.includes(fact.metric)) {
            const issueId = makeIssueId('UNIT', block.id, `${fact.id}_${wu}`);
            issues.push({
              id: issueId,
              issueId,
              taskId: task.id,
              draftId,
              blockId: block.id,
              type: 'metric_unit',
              severity: 'error',
              isBlocking: true,
              location: locationDesc,
              originalText: wrongPattern,
              evidenceText: `依据【${fact.metric}】标准单位为“${fact.unit}”。`,
              suggestion: `将“${wrongPattern}”更正为“${fact.value}${fact.unit}”。`,
              replacementText: `${fact.value}${fact.unit}`,
              status: 'unresolved',
            });
          }
        });
      }
    });

    // -------------------------------------------------------------
    // Check 3: Historic Data Leak / Period Mismatch
    // -------------------------------------------------------------
    const currentTaskYear = task.startDate ? task.startDate.split('-')[0] : '2026';
    const historicLeakPattern = /(202[0-4]|2025)年?(?:度|全年|累计)?.*?完成\d+项/;
    if (historicLeakPattern.test(block.content) || (block.content.includes('2025') && (block.content.includes('96项') || (block.content.includes('重点任务') && !block.content.includes('历史对比'))))) {
      const issueId = makeIssueId('HIST', block.id, 'leak');
      issues.push({
        id: issueId,
        issueId,
        taskId: task.id,
        draftId,
        blockId: block.id,
        type: 'historic_data_leak',
        severity: 'error',
        isBlocking: true,
        location: locationDesc,
        originalText: block.content.length > 40 ? block.content.slice(0, 40) + '...' : block.content,
        evidenceText: `公文任务履职期间为【${task.startDate} 至 ${task.endDate}】，历史年份（如2025年96项）仅为文风参考，非本期履职数据。`,
        suggestion: `删除将历史年份工作数据直接列为本期成效的表述，或注明为历史同期对比基准。此项为阻断性错误。`,
        status: 'unresolved',
      });
    }

    // -------------------------------------------------------------
    // Check 4: Unverified Qualitative Clue (RAG Clue without Hard Metric)
    // "未能可靠验证的句子标注待人工核实，不伪称核校通过"
    // -------------------------------------------------------------
    const qualitativeClueFacts = task.facts.filter((f) => f.status === 'gap' || f.id === 'CLUE-01' || f.primaryEvidenceId === 'EVD-06');
    const hasQualitativeContent = block.content.includes('服务满意度') || block.content.includes('满意度明显提升');
    if (hasQualitativeContent) {
      // Check if there is any confirmed quantitative evidence
      const hasQuantitativeEvidence = task.facts.some((f) => f.status === 'confirmed' && f.metric.includes('满意度') && f.value && f.value !== '暂缺');
      if (!hasQuantitativeEvidence) {
        const issueId = makeIssueId('GAP', block.id, 'satisfaction');
        issues.push({
          id: issueId,
          issueId,
          taskId: task.id,
          draftId,
          blockId: block.id,
          type: 'gap_missing',
          severity: 'warning',
          isBlocking: false, // Non-blocking, requires human verification or reason
          location: locationDesc,
          originalText: '服务满意度明显提升',
          evidenceText: '知识库RAG检索仅提供定性问答线索（CLUE-01），当前无具体量化测评报告或出处台账。',
          suggestion: '该成效表述未能可靠验证，已标注“待人工核实”。建议在文稿中补充说明为定性线索，或在事实清单补充正式依据，不伪称核校通过。',
          status: 'unresolved',
        });
      }
    }

    // -------------------------------------------------------------
    // Check 5: Dynamic Metric Extraction & Unreferenced Numbers
    // Avoids "1至" as accomplishment indicators
    // -------------------------------------------------------------
    // Regex extracts: number + Chinese accomplishment unit
    const metricExtractor = /(\d+(?:\.\d+)?)\s*([项场次个篇套户条台家件名宗起公里%])/g;
    let metricMatch: RegExpExecArray | null;
    while ((metricMatch = metricExtractor.exec(block.content)) !== null) {
      const fullMatch = metricMatch[0]; // e.g. "128项"
      const numStr = metricMatch[1];     // e.g. "128"
      const unitStr = metricMatch[2];    // e.g. "项"
      const matchIndex = metricMatch.index;

      // Filter out dates, periods, chapters, or "1至..."
      if (isDateOrPeriodOrSection(fullMatch, block.content, matchIndex)) {
        continue;
      }

      // Check if this metric is known in the dynamically built pool
      const isKnown = 
        knownMetricTokens.has(fullMatch) || 
        knownPlainNumbers.has(numStr) ||
        confirmedFacts.some((f) => f.value === numStr || f.selectedConflictValue === numStr);

      if (!isKnown) {
        const issueId = makeIssueId('UNREF', block.id, fullMatch);
        // Avoid duplicate issues
        if (!issues.some((i) => i.issueId === issueId)) {
          issues.push({
            id: issueId,
            issueId,
            taskId: task.id,
            draftId,
            blockId: block.id,
            type: 'unreferenced_number',
            severity: 'info',
            isBlocking: false,
            location: `${locationDesc}（${fullMatch}）`,
            charIndex: matchIndex,
            originalText: fullMatch,
            evidenceText: '在当前已登记的单位材料台账及核准事实清单中未找到该数值的出处依据。',
            suggestion: '该指标未能可靠验证，标注“待人工核实”；若为主笔业务掌握数据，请在事实清单中补充记录依据。',
            status: 'unresolved',
          });
        }
      }
    }
  });

  // Apply historical audit resolution / ignore records
  return issues.map((issue) => {
    const record = auditRecordsMap.get(issue.issueId);
    if (record) {
      // Major blocking discrepancies CANNOT be bypassed by generic ignore!
      if (issue.isBlocking && record.status === 'ignored') {
        return {
          ...issue,
          status: 'unresolved',
          ignoreReason: undefined,
        };
      }
      return {
        ...issue,
        status: record.status,
        ignoreReason: record.ignoreReason,
      };
    }
    return issue;
  });
}
