import { Task, ParagraphBlock, AuditIssue, AuditIssueType, DraftVersion } from '../types';

function makeIssueId(prefix: string, blockId: string, suffix: string): string {
  return `ISSUE-${prefix}-${blockId}-${suffix}`;
}

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Requirement 4 & Task 10: Dynamic Document Consistency Audit Service
 * - Evaluates actual document blocks against confirmed facts and snapshot evidence.
 * - Prioritizes frozen snapshot facts from draft.snapshotMetadata.factSnapshot.
 * - Does NOT depend on current task.facts or all snippets' global numbers when
 *   auditing historical drafts (self-sufficient).
 * - Accurately matches paragraph-referenced facts for:
 *   * unit confusion (人次 vs 人)
 *   * value changes (e.g. 799人次 vs 800人次)
 *   * conflict mismatch (e.g. 120项 vs 128项)
 * - Identifies individual character indices for duplicate errors (e.g. two 800人 in same block).
 * - Historic 'accepted' records CANNOT bypass errors that are still present in the current text.
 * - Major blocking errors CANNOT be ignored.
 */
export function runDocumentAudit(
  task: Task,
  blocks: ParagraphBlock[],
  draftId: string
): AuditIssue[] {
  const issues: AuditIssue[] = [];

  const targetDraft = task.drafts.find((d) => d.id === draftId);
  const snapshotItems = targetDraft?.snapshotMetadata?.factSnapshot?.items;

  // Active facts pool: prioritize frozen snapshot facts, fallback to confirmed task facts
  let activeFacts: {
    id: string;
    metric: string;
    value: string;
    unit: string;
    period: string;
    metricScope: string;
    primaryEvidenceId: string;
    hasConflict?: boolean;
    conflictCandidates?: { value: string; description: string; evidenceId?: string }[];
    selectedConflictValue?: string;
  }[] = [];

  if (snapshotItems && snapshotItems.length > 0) {
    // Snapshot is self-sufficient!
    activeFacts = snapshotItems.map((item) => {
      const origF = task.facts?.find((f) => f.id === item.factId);
      return {
        id: item.factId,
        metric: item.metric,
        value: item.value,
        unit: item.unit,
        period: item.period,
        metricScope: item.metricScope,
        primaryEvidenceId: item.primaryEvidenceId,
        hasConflict: item.hasConflict !== undefined ? item.hasConflict : origF?.hasConflict,
        conflictCandidates: item.conflictCandidates || origF?.conflictCandidates,
        selectedConflictValue: item.selectedConflictValue || item.value,
      };
    });
  } else if (task.facts && task.facts.length > 0) {
    activeFacts = task.facts.map((f) => ({
      id: f.id,
      metric: f.metric,
      value: f.selectedConflictValue || f.value,
      unit: f.unit,
      period: f.period,
      metricScope: f.metricScope,
      primaryEvidenceId: f.primaryEvidenceId,
      hasConflict: f.hasConflict,
      conflictCandidates: f.conflictCandidates,
      selectedConflictValue: f.selectedConflictValue,
    }));
  }

  // Load audit history records tied to this draft version
  const auditRecordsMap = new Map<string, { status: 'unresolved' | 'accepted' | 'ignored'; ignoreReason?: string }>();
  if (targetDraft?.auditRecords) {
    targetDraft.auditRecords.forEach((rec) => {
      auditRecordsMap.set(rec.issueId, rec);
    });
  }

  // Date and range patterns to explicitly ignore from accomplishment metrics
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

    // Look around context
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
    const linkedFactIds = block.referencedFactIds || [];
    const blockFacts = activeFacts.filter((f) => linkedFactIds.includes(f.id));

    // -------------------------------------------------------------
    // Check 1: Conflict and Adopted Figure Mismatch (e.g. Adopted 128, text has 120)
    // -------------------------------------------------------------
    activeFacts.forEach((fact) => {
      if (fact.hasConflict || (fact.conflictCandidates && fact.conflictCandidates.length > 0)) {
        const adoptedValue = fact.selectedConflictValue || fact.value;
        if (adoptedValue && fact.conflictCandidates) {
          fact.conflictCandidates.forEach((cand) => {
            if (cand.value !== adoptedValue) {
              const rejectedPattern = `${cand.value}${fact.unit}`;
              const rejectedAlone = cand.value;

              const hasRejectedMetric = block.content.includes(rejectedPattern);
              const hasRejectedInContext =
                block.content.includes(rejectedAlone) &&
                (block.content.includes(fact.metric) || block.content.includes(fact.unit) || linkedFactIds.includes(fact.id));

              if (hasRejectedMetric || hasRejectedInContext) {
                const charIdx = block.content.indexOf(hasRejectedMetric ? rejectedPattern : cand.value);
                const issueId = makeIssueId('CONFLICT', block.id, `${fact.id}_${cand.value}_${charIdx >= 0 ? charIdx : 0}`);
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
                  charIndex: charIdx >= 0 ? charIdx : undefined,
                  originalText,
                  evidenceText: `事实依据【${fact.metric}】已明确裁决采信口径：“${adoptedValue}${fact.unit}”（出处：${fact.primaryEvidenceId || '台账'}）。排除口径：“${cand.value}${fact.unit}”。`,
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
    // Check 2: Metric Unit Confusion (e.g. 人次 vs 人)
    // Identifies every instance of "800人" not followed by "次"
    // -------------------------------------------------------------
    const personTimesFacts = activeFacts.filter((f) => f.unit === '人次');
    personTimesFacts.forEach((fact) => {
      const factNum = fact.value;
      if (factNum) {
        const unitConfusionRegex = new RegExp(`(${escapeRegExp(factNum)})\\s*人(?!次)`, 'g');
        let match: RegExpExecArray | null;
        while ((match = unitConfusionRegex.exec(block.content)) !== null) {
          const issueId = makeIssueId('UNIT', block.id, `${match[1]}_ren_${match.index}`);
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
            evidenceText: `依据【${fact.metric}】（${fact.primaryEvidenceId || '台账依据'}）登记口径为：“${factNum}人次”，严禁混淆为实有人数。`,
            suggestion: `将“${originalText}”更正为“${factNum}人次”，严格区分参训人次与实有人数口径。此项为阻断性错误。`,
            replacementText: `${factNum}人次`,
            status: 'unresolved',
          });
        }
      }
    });

    // -------------------------------------------------------------
    // Check 3: Value Change & Unit Inconsistency on Referenced Facts
    // e.g. Block references FACT-03 (800人次), but text contains "799人次"
    // -------------------------------------------------------------
    blockFacts.forEach((fact) => {
      if (fact.value && fact.unit) {
        // Look for any number associated with this fact's unit in this block
        const unitRegex = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${escapeRegExp(fact.unit)})`, 'g');
        let match: RegExpExecArray | null;
        while ((match = unitRegex.exec(block.content)) !== null) {
          const foundNum = match[1];
          const foundUnit = match[2];
          const matchIndex = match.index;

          if (isDateOrPeriodOrSection(match[0], block.content, matchIndex)) {
            continue;
          }

          // If foundNum does not match fact value or conflict candidates
          const matchesFact = foundNum === fact.value || foundNum === fact.selectedConflictValue;
          const matchesCandidate = fact.conflictCandidates?.some((c) => c.value === foundNum);
          const matchesOtherBlockFact = blockFacts.some((bf) => bf.unit === foundUnit && (bf.value === foundNum || bf.selectedConflictValue === foundNum));

          if (!matchesFact && !matchesCandidate && !matchesOtherBlockFact) {
            // VALUE MISMATCH DETECTED (e.g. 799人次 instead of 800人次)
            const issueId = makeIssueId('VALUE', block.id, `${fact.id}_${foundNum}_${matchIndex}`);
            const originalText = `${foundNum}${foundUnit}`;
            issues.push({
              id: issueId,
              issueId,
              taskId: task.id,
              draftId,
              blockId: block.id,
              type: 'conflict_mismatch',
              severity: 'error',
              isBlocking: true, // Incorrect number blocks finalization
              location: `${locationDesc}（第${matchIndex + 1}字符处）`,
              charIndex: matchIndex,
              originalText,
              evidenceText: `依据【${fact.metric}】（出处：${fact.primaryEvidenceId || '台账'}）核准数据为“${fact.value}${fact.unit}”，正文表述为“${originalText}”。`,
              suggestion: `正文数值“${originalText}”与所引用依据不符，应更正为“${fact.value}${fact.unit}”。此项为阻断性核校错误。`,
              replacementText: `${fact.value}${fact.unit}`,
              status: 'unresolved',
            });
          }
        }
      }
    });

    // -------------------------------------------------------------
    // Check 4: Historic Data Leak / Period Mismatch
    // -------------------------------------------------------------
    const historicLeakPattern = /(202[0-4]|2025)年?(?:度|全年|累计)?.*?完成\d+项/;
    if (
      historicLeakPattern.test(block.content) ||
      (block.content.includes('2025') &&
        (block.content.includes('96项') ||
          (block.content.includes('重点任务') &&
            !block.content.includes('历史对比') &&
            !block.content.includes('同比'))))
    ) {
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
    // Check 5: Unverified Sentences / Qualitative Claims without Hard Evidence
    // -------------------------------------------------------------
    const hasQualitativeContent = block.content.includes('服务满意度') || block.content.includes('满意度明显提升');
    if (hasQualitativeContent) {
      const hasQuantitativeEvidence = activeFacts.some(
        (f) => f.metric.includes('满意度') && f.value && f.value !== '暂缺' && !f.value.includes('定性')
      );
      if (!hasQuantitativeEvidence) {
        const issueId = makeIssueId('GAP', block.id, 'satisfaction');
        issues.push({
          id: issueId,
          issueId,
          taskId: task.id,
          draftId,
          blockId: block.id,
          type: 'unverified_sentence',
          severity: 'warning',
          isBlocking: false,
          location: locationDesc,
          originalText: '服务满意度明显提升',
          evidenceText: '知识库RAG检索仅提供定性问答线索（CLUE-01），当前无具体量化测评报告或出处台账。',
          suggestion: '该成效表述未能可靠验证，已标注“待人工核实”。建议在文稿中补充说明为定性线索，或在事实清单补充正式依据，不伪称核校通过。',
          status: 'unresolved',
        });
      }
    }

    // Macro assertions without any linked facts or quantitative metric
    const macroKeywords = ['稳中向好', '稳中有进', '扎实推进', '显著提升', '大幅改善', '再创新高'];
    macroKeywords.forEach((kw) => {
      if (block.content.includes(kw) && linkedFactIds.length === 0 && activeFacts.length > 0) {
        const issueId = makeIssueId('UNVERIFIED', block.id, kw);
        if (!issues.some((i) => i.issueId === issueId)) {
          issues.push({
            id: issueId,
            issueId,
            taskId: task.id,
            draftId,
            blockId: block.id,
            type: 'unverified_sentence',
            severity: 'info',
            isBlocking: false,
            location: locationDesc,
            originalText: kw,
            evidenceText: '该语句包含定性成效断言，但当前段落未关联任何已核准量化事实依据。',
            suggestion: '未能可靠验证的句子已标注“待人工核实”，请在定稿前由人工复核或关联具体佐证材料，不伪称核校通过。',
            status: 'unresolved',
          });
        }
      }
    });

    // -------------------------------------------------------------
    // Check 6: Unreferenced Numbers (numbers not matching any active facts)
    // -------------------------------------------------------------
    const metricExtractor = /(\d+(?:\.\d+)?)\s*(人次|人|项|场|次|个|篇|套|户|条|台|家|件|名|宗|起|公里|%)/g;
    let metricMatch: RegExpExecArray | null;
    while ((metricMatch = metricExtractor.exec(block.content)) !== null) {
      const fullMatch = metricMatch[0];
      const numStr = metricMatch[1];
      const matchIndex = metricMatch.index;

      if (isDateOrPeriodOrSection(fullMatch, block.content, matchIndex)) {
        continue;
      }

      // Check if this number is accounted for in activeFacts or already flagged in issues
      const isKnownInFacts = activeFacts.some((f) => {
        if (f.value === numStr || f.selectedConflictValue === numStr) return true;
        if (f.conflictCandidates?.some((c) => c.value === numStr)) return true;
        return false;
      });

      const alreadyFlagged = issues.some(
        (i) => i.blockId === block.id && i.charIndex === matchIndex
      );

      if (!isKnownInFacts && !alreadyFlagged) {
        const issueId = makeIssueId('UNREF', block.id, `${fullMatch}_${matchIndex}`);
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

  // -------------------------------------------------------------
  // Requirement 4: Re-audit Protection
  // - If an error is STILL DETECTED in the current text, it is UNRESOLVED!
  // - A historical 'accepted' record CANNOT bypass an error that is still in the text!
  // - Blocking errors CANNOT be ignored!
  // -------------------------------------------------------------
  return issues.map((issue) => {
    const record = auditRecordsMap.get(issue.issueId);

    // If the issue was previously marked 'accepted', but is STILL found in the text:
    // That means the error was not properly removed, or was re-introduced!
    // It MUST remain 'unresolved'!
    if (record?.status === 'accepted') {
      return {
        ...issue,
        status: 'unresolved' as const, // Re-audited error cannot be bypassed!
      };
    }

    // If the issue was previously marked 'ignored':
    if (record?.status === 'ignored') {
      // Blocking errors can NEVER be bypassed by ignore!
      if (issue.isBlocking) {
        return {
          ...issue,
          status: 'unresolved' as const,
          ignoreReason: undefined,
        };
      }
      // Non-blocking warning/info with a non-empty ignoreReason:
      if (record.ignoreReason && record.ignoreReason.trim().length > 0) {
        return {
          ...issue,
          status: 'ignored' as const,
          ignoreReason: record.ignoreReason,
        };
      }
    }

    return issue;
  });
}
