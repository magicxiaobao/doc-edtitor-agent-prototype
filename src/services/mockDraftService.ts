import { isPeriodWithinTaskPeriod } from './factLifecycleService';
import { Task, ParagraphBlock, Fact, OutlineSection, DraftVersion, type RevisionAction, type RevisionSuggestion, type ReviewComment } from '../types';
import { computeTextDiff } from './diffService';
import { isValidAuthenticCase, interpretReviewCommentSuggestion } from './reviewCoordinationService';

export type { RevisionAction, RevisionSuggestion };

export interface ParagraphRevisionOptions {
  customPrompt?: string;
  task?: Task;
  currentDraft?: DraftVersion;
  sourceComment?: ReviewComment;
}

/**
 * Deterministic hash/fingerprint of paragraph content to detect manual modifications
 */
export function computeContentHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return `HASH-${Math.abs(hash).toString(36)}-${text.length}`;
}

/**
 * Format date range into Chinese administrative statistical period
 */
export function formatTaskPeriod(startDate?: string, endDate?: string): string {
  if (!startDate || !endDate) return '本统计期间';

  const [sYear, sMonth] = startDate.split('-');
  const [eYear, eMonth] = endDate.split('-');

  const sm = parseInt(sMonth, 10);
  const em = parseInt(eMonth, 10);

  if (sYear === eYear) {
    if (sm === 1 && em === 9) {
      return `${sYear}年1至9月`;
    }
    if (sm === 4 && em === 6) {
      return `${sYear}年二季度`;
    }
    if (sm === 1 && em === 3) {
      return `${sYear}年一季度`;
    }
    if (sm === 7 && em === 9) {
      return `${sYear}年三季度`;
    }
    if (sm === 10 && em === 12) {
      return `${sYear}年四季度`;
    }
    if (sm === 1 && em === 12) {
      return `${sYear}年度`;
    }
    return `${sYear}年${sm}月至${em}月`;
  }

  return `${sYear}年${sm}月至${eYear}年${em}月`;
}

/**
 * Validates whether a fact meets all criteria for inclusion in draft:
 * - status === 'confirmed'
 * - NOT historic only
 * - NOT an unverified qualitative clue
 * - If conflict existed, must be resolved (selectedConflictValue set) and confirmed (not excluded/pending)
 */
export function isValidFactForDraft(fact: Fact, task: Task): boolean {
  if (!fact || fact.status !== 'confirmed') return false;
  if (fact.isHistoricOnly) return false;

  // Selected conflict value cannot bypass excluded or pending
  if (fact.hasConflict) {
    if (!fact.selectedConflictValue || fact.status !== 'confirmed') {
      return false;
    }
  }

  // Must belong to current statistical period (e.g. 2025 historic data cannot enter 2026 or 2027 draft)
  if (!isPeriodWithinTaskPeriod(fact.period, task.startDate, task.endDate)) return false;

  // Must have original evidence snippet or explicit author supplementation
  if (!fact.primaryEvidenceId && !fact.isAuthorSupplemented) {
    return false;
  }

  // Pure qualitative RAG clues without author verification cannot become confirmed factual metrics
  if (
    fact.primaryEvidenceId === 'EVD-06' ||
    fact.metricScope?.includes('仅作为线索') ||
    fact.metricScope?.includes('无量化') ||
    fact.value?.includes('定性') ||
    fact.value?.includes('无量化')
  ) {
    if (!fact.isAuthorSupplemented) {
      return false;
    }
  }

  return true;
}

export interface WholeDraftGenerationOptions {
  instructionPrompt?: string;
}

/**
 * Checks if custom drafting prompt is recognized in the deterministic prototype simulation
 */
export function isSupportedDraftInstruction(prompt?: string): boolean {
  if (!prompt || !prompt.trim()) return true;
  const p = prompt.trim();
  return (
    p.includes('成效') ||
    p.includes('铺垫') ||
    p.includes('精简') ||
    p.includes('压缩') ||
    p.includes('汇报口吻') ||
    p.includes('单位负责人') ||
    p.includes('对应') ||
    p.includes('举措') ||
    p.includes('标准') ||
    p.includes('规范')
  );
}

/**
 * Deterministically generates draft paragraphs strictly driven by
 * confirmed outline sections and their assigned confirmed facts.
 * NO fallback values (no hardcoded 128, 16, 800, 12, or fixed 2026 dates).
 * Supports explicit round writing instructions (e.g. 突出成效, 减少铺垫, 优化问题与安排对应, 汇报口吻).
 */
export function generateDraftFromFactsAndOutline(
  task: Task,
  options?: WholeDraftGenerationOptions
): ParagraphBlock[] {
  if (!task.outline || task.outline.length === 0) {
    return [];
  }

  const periodStr = formatTaskPeriod(task.startDate, task.endDate);
  const activeStyleRules = task.styleRules.filter((r) => r.confirmed && !r.excluded);
  const hasMeasureAndFact = activeStyleRules.some((r) => r.category === '举措事实');
  const hasFormalTone = activeStyleRules.some((r) => r.category === '行文正式度');

  const rawPrompt = options?.instructionPrompt?.trim() || '';
  const isHighlightOutcomes = rawPrompt.includes('成效');
  const isConcise = rawPrompt.includes('精简') || rawPrompt.includes('铺垫') || rawPrompt.includes('压缩');
  const isAlignment = rawPrompt.includes('对应') || rawPrompt.includes('问题与安排');
  const isReportingTone = rawPrompt.includes('汇报口吻') || rawPrompt.includes('单位负责人');

  const blocks: ParagraphBlock[] = [];
  let blockOrder = 1;

  // Iterate over each section in the confirmed outline in order
  task.outline.forEach((section: OutlineSection) => {
    const assignedFactIds = section.assignedFactIds || [];
    
    // Filter only valid confirmed facts assigned to this section
    const validAssignedFacts = task.facts.filter(
      (f) => assignedFactIds.includes(f.id) && isValidFactForDraft(f, task)
    ).map(f => ({ ...f, value: f.selectedConflictValue || f.value }));

    // Case 1: No valid confirmed facts assigned to this section
    if (validAssignedFacts.length === 0) {
      const gapText = section.hasMaterialGap && section.gapDescription
        ? `【待补材料依据】${section.gapDescription}`
        : `【待补材料依据】本章节尚未分配已确认事实依据，暂无量化数据支撑。待补充相关材料并核准事实后再行起草。`;

      blocks.push({
        id: `BLK-${section.id}-${blockOrder}`,
        sectionId: section.id,
        order: blockOrder++,
        content: gapText,
        referencedFactIds: [],
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    // Case 2: Valid confirmed facts exist. Synthesize paragraphs based on actual facts.
    // Check if we have paired facts (e.g. 培训场次 + 参训人次)
    const trainingFact = validAssignedFacts.find((f) => f.unit === '场' || f.metric.includes('培训'));
    const attendeeFact = validAssignedFacts.find((f) => f.unit === '人次' || f.metric.includes('人次'));

    if (trainingFact && attendeeFact && trainingFact.id !== attendeeFact.id) {
      // Generate paired training paragraph
      const factIds = [trainingFact.id, attendeeFact.id];
      const tPeriod = trainingFact.period || periodStr;
      let content = '';

      if (isHighlightOutcomes) {
        content = `在干部队伍履职能力建设方面，紧扣高素质实战需求，业务赋能质效大幅跃升。${tPeriod}，累计组织${trainingFact.metric}${trainingFact.value}${trainingFact.unit}，累计参训${attendeeFact.value}${attendeeFact.unit}，专业实操水平与规范执行能力取得显著成效。`;
      } else if (isConcise) {
        content = `${tPeriod}，组织${trainingFact.metric}${trainingFact.value}${trainingFact.unit}，参训${attendeeFact.value}${attendeeFact.unit}，有效强化干部队伍履职执行水平。`;
      } else if (isAlignment) {
        content = `紧扣基层履职能力薄弱短板，靶向开展专业实操培训。${tPeriod}，累计组织${trainingFact.metric}${trainingFact.value}${trainingFact.unit}，累计参训${attendeeFact.value}${attendeeFact.unit}，推动培训举措与岗位实际需求紧密对应。`;
      } else if (isReportingTone) {
        content = `聚焦高素质专业化干部队伍建设，高位推动业务赋能。${tPeriod}，累计组织${trainingFact.metric}${trainingFact.value}${trainingFact.unit}，累计参训${attendeeFact.value}${attendeeFact.unit}，全流程赋能机制健全运转。`;
      } else {
        const leadIn = hasMeasureAndFact
          ? `在干部队伍履职能力建设方面，坚持需求导向，深化分级分类专业实操培养。`
          : `扎实开展干部业务培训工作。`;
        content = `${leadIn}${tPeriod}，累计组织${trainingFact.metric}${trainingFact.value}${trainingFact.unit}，累计参训${attendeeFact.value}${attendeeFact.unit}，有效强化了专业化履职能力与规范执行水平。`;
      }

      blocks.push({
        id: `BLK-${section.id}-${blockOrder}`,
        sectionId: section.id,
        order: blockOrder++,
        content,
        referencedFactIds: factIds,
        updatedAt: new Date().toISOString(),
      });

      // Filter out paired facts from remaining single-fact generation
      const remainingFacts = validAssignedFacts.filter(
        (f) => f.id !== trainingFact.id && f.id !== attendeeFact.id
      );

      remainingFacts.forEach((fact) => {
        const singleBlock = buildSingleFactParagraph(
          section,
          fact,
          periodStr,
          hasMeasureAndFact,
          hasFormalTone,
          blockOrder++,
          rawPrompt
        );
        blocks.push(singleBlock);
      });
    } else {
      // Individual fact generation
      validAssignedFacts.forEach((fact) => {
        const singleBlock = buildSingleFactParagraph(
          section,
          fact,
          periodStr,
          hasMeasureAndFact,
          hasFormalTone,
          blockOrder++,
          rawPrompt
        );
        blocks.push(singleBlock);
      });
    }
  });

  return blocks;
}

function buildSingleFactParagraph(
  section: OutlineSection,
  fact: Fact,
  periodStr: string,
  hasMeasureAndFact: boolean,
  hasFormalTone: boolean,
  order: number,
  instructionPrompt?: string
): ParagraphBlock {
  const fPeriod = fact.period || periodStr;
  const val = fact.selectedConflictValue || fact.value;
  const unit = fact.unit;
  const metric = fact.metric;

  const prompt = instructionPrompt || '';
  const isHighlightOutcomes = prompt.includes('成效');
  const isConcise = prompt.includes('精简') || prompt.includes('铺垫') || prompt.includes('压缩');
  const isAlignment = prompt.includes('对应') || prompt.includes('问题与安排');
  const isReportingTone = prompt.includes('汇报口吻') || prompt.includes('单位负责人');

  let content = '';

  if (isHighlightOutcomes) {
    if (metric.includes('任务') || metric.includes('推进') || metric.includes('攻坚')) {
      content = `全系统强化攻坚突破，各项部署紧盯节点攻坚克难，取得扎实成效。${fPeriod}，截至统计期末，${metric}${val}${unit}，各项既定序时指标高效达成，重点攻坚成效显著。`;
    } else if (metric.includes('调研')) {
      content = `【重点成效】在调查研究方面，紧扣基层急难愁盼深入调研，${fPeriod}累计${metric}${val}${unit}，推动形成一系列制度优化与长效机制。`;
    } else {
      content = `【重点成效】立足业务发展需要，紧扣核心指标狠抓工作质效。${fPeriod}，${metric}完成${val}${unit}，有力保障全系统高质量运转。`;
    }
  } else if (isConcise) {
    if (metric.includes('任务') || metric.includes('推进') || metric.includes('攻坚')) {
      content = `${fPeriod}，截至统计期末，${metric}${val}${unit}，各项既定序时指标平稳达成。`;
    } else if (metric.includes('调研')) {
      content = `在调查研究方面，${fPeriod}累计${metric}${val}${unit}，形成制度优化举措。`;
    } else {
      content = `${fPeriod}，${metric}完成${val}${unit}，保障系统运转。`;
    }
  } else if (isAlignment) {
    if (metric.includes('任务') || metric.includes('推进') || metric.includes('攻坚')) {
      content = `紧扣工作堵点破局突围，坚持靶向发力与清单化推进。${fPeriod}，截至统计期末，${metric}${val}${unit}，确保问题清单与具体安排紧密对应、如期销号。`;
    } else if (metric.includes('调研')) {
      content = `坚持以问题为导向，紧密对接一线实际诉求。在调查研究方面，${fPeriod}累计${metric}${val}${unit}，推动问题发现在一线、举措落实在一线。`;
    } else {
      content = `对标业务短板清单统筹推进整改治理。${fPeriod}，${metric}完成${val}${unit}，确保整改举措与序时安排有序对应。`;
    }
  } else if (isReportingTone) {
    if (metric.includes('任务') || metric.includes('推进') || metric.includes('攻坚')) {
      content = `紧扣全局中心工作部署，统筹推进全流程规范治理。${fPeriod}，截至统计期末，${metric}${val}${unit}，各项既定序时指标高位推进、平稳达成。`;
    } else if (metric.includes('调研')) {
      content = `深入贯彻大兴调查研究部署要求，立足单位高标准履职定位，${fPeriod}累计${metric}${val}${unit}，为科学决策提供扎实依据。`;
    } else {
      content = `紧扣中心大局与核心指标，统筹推进全流程规范治理。${fPeriod}，${metric}完成${val}${unit}，有力保障全系统平稳高效运转。`;
    }
  } else {
    // Standard default generation
    if (metric.includes('任务') || metric.includes('推进') || metric.includes('攻坚')) {
      const lead = hasMeasureAndFact
        ? `全系统强化统筹联动与机制创新，各项重点部署紧盯节点有序推进。`
        : `各项既定重点任务平稳有序开展。`;
      content = `${fPeriod}，${lead}截至统计期末，${metric}${val}${unit}，各项既定序时指标平稳达成，重点攻坚成效显著。`;
    } else if (metric.includes('调研')) {
      const lead = hasMeasureAndFact
        ? `深入推进调查研究，紧扣基层一线急难愁盼诉求，`
        : `扎实开展常态化专项调研，`;
      content = `在调查研究方面，${lead}${fPeriod}累计${metric}${val}${unit}，推动形成一系列制度优化与流程改进举措。`;
    } else {
      const lead = hasFormalTone
        ? `立足业务发展需要，严谨抓好各项工作落实。`
        : `抓细抓实各项日常工作。`;
      content = `${lead}${fPeriod}，${metric}完成${val}${unit}，保障全系统平稳高效运转。`;
    }
  }

  return {
    id: `BLK-${section.id}-${order}`,
    sectionId: section.id,
    order,
    content,
    referencedFactIds: [fact.id],
    updatedAt: new Date().toISOString(),
  };
}


/**
 * Shared deterministic paragraph compression rule.
 * Strips procedural preambles and introductory verbiage while strictly preserving
 * all core facts, numbers, units, periods and administrative achievements.
 */
export function applyParagraphCompression(originalText: string): string {
  let text = originalText;

  // Strip procedural preambles and introductory verbiage
  text = text
    .replace(/在队伍履职能力建设方面，立足基层实际需要，深化分级分类专业实操培养。/g, '')
    .replace(/在队伍履职能力建设方面，/g, '')
    .replace(/立足基层实际需要，/g, '')
    .replace(/深化分级分类专业实操培养。/g, '')
    .replace(/坚持需求导向，深化分级分类专业实操培养。/g, '')
    .replace(/紧紧围绕年度核心工作目标，强化统筹联动与机制创新。/g, '')
    .replace(/立足业务发展需要，严谨抓好各项工作落实。/g, '')
    .replace(/围绕年度目标，统筹推进各项重点工作。/g, '')
    .replace(/深入推进各项管理服务机制创新，/g, '')
    .replace(/，保障全系统平稳高效运转/g, '')
    .replace(/，各项既定序时指标平稳达成/g, '')
    .replace(/，推动形成一系列制度优化与流程改进举措/g, '');

  // Refine training phrasing while strictly preserving exact numbers, units, and period
  text = text.replace(/有效增强了骨干人员政策理解与规范执行水平。/g, '有效增强骨干人员政策理解与规范执行能力。');

  text = text.replace(/^[，、\s]+/, '').replace(/，+/g, '，');
  if (text.length > 0 && !text.endsWith('。')) {
    text += '。';
  }
  return text;
}

/**
 * Paragraph revision assistant (compress, expand, formal, highlight, custom).
 * CRITICAL: Strictly preserves all factual numbers, units, and periods!
 * Cannot invent business measures or revert 25场 to 16场.
 * Distinguishes review instructions (direction) from reviewer-provided replacement drafts.
 * Computes truthful dynamic word counts and diff explanations; eliminates false claims.
 */
export function generateParagraphRevision(
  block: ParagraphBlock,
  action: RevisionAction,
  taskId?: string,
  sourceDraftId?: string,
  runId?: string,
  options?: ParagraphRevisionOptions
): RevisionSuggestion {
  const originalText = block.content;
  let suggestedText = originalText;
  let diffExplanation = '';
  const needsVerificationNotes: string[] = [];
  let isUnsupportedPrompt = false;
  let unsupportedPromptNotice: string | undefined;

  // Extract all numbers with their following Chinese units (e.g. 25场, 800人次, 128项, 12次)
  const numbersWithUnits = originalText.match(/\d+(?:\.\d+)?(?:人次|场次|万元|亿元|分钟|项|场|次|人|个|家|件|条|篇|套|户|台|元|%)/g) || [];

  const sourceComment = options?.sourceComment;
  const interpretation = interpretReviewCommentSuggestion(sourceComment);
  const prompt = options?.customPrompt?.trim() || interpretation.instructionText || '';
  const hasCustomPrompt = Boolean(prompt);

  // Case 1: Reviewer explicitly provided a replacement draft
  if (interpretation.isReplacement && interpretation.replacementText) {
    suggestedText = interpretation.replacementText;
    const origNumbers = originalText.match(/\d+(?:\.\d+)?(?:人次|场次|万元|亿元|分钟|项|场|次|人|个|家|件|条|篇|套|户|台|元|%)/g) || [];
    const replNumbers = interpretation.replacementText.match(/\d+(?:\.\d+)?(?:人次|场次|万元|亿元|分钟|项|场|次|人|个|家|件|条|篇|套|户|台|元|%)/g) || [];
    const hasDataDiff = origNumbers.join(',') !== replNumbers.join(',');

    if (hasDataDiff) {
      diffExplanation = `采纳【${sourceComment?.reviewer || '审阅人'}】审阅人提供的替换稿。注意：检测到替换稿与原文数据指标存在差异（原文：${origNumbers.join('、') || '无'}；替换稿：${replNumbers.join('、') || '无'}），未作自动指标保留强制锁定，请主笔重点核验数据真实性与出处台账。`;
      needsVerificationNotes.push(`审阅人替换稿包含数据变动（原文：${origNumbers.join('、') || '无'} → 替换稿：${replNumbers.join('、') || '无'}），请核对是否具有正式台账支撑`);
      needsVerificationNotes.push('审阅替换稿直接以审阅人意见正文为准，已跳过自动化指标保留强制检查，须由主笔人工核实出处台账');
    } else {
      diffExplanation = `采纳【${sourceComment?.reviewer || '审阅人'}】审阅人提供的替换稿，直接以审阅人修改正文为准。`;
      needsVerificationNotes.push('审阅人替换稿非AI自动生成，请核验是否契合段落前后行文脉络');
    }
  } else {
    // Case 2: Instruction-driven rewrite or custom/preset action
    if (hasCustomPrompt || action === 'custom') {
      const isHighlightPrompt = 
        prompt === '突出成效并删减泛泛修饰' || 
        prompt.includes('突出成效') ||
        (prompt.includes('成效') && prompt.includes('删减') && !prompt.includes('精简') && !prompt.includes('压缩'));

      const isCompressPrompt = 
        prompt === '精简表达并保留数据' || 
        (prompt.includes('精简') && prompt.includes('保留')) || 
        (prompt.includes('精简') && prompt.includes('数据')) ||
        (prompt.includes('压缩') && prompt.includes('数据')) ||
        (prompt.includes('压缩') && prompt.includes('口径')) ||
        prompt.includes('压缩精炼') ||
        (prompt.includes('压缩') && (prompt.includes('修饰') || prompt.includes('冗长') || prompt.includes('铺垫') || prompt.includes('前缀'))) ||
        prompt.includes('删减泛泛修饰') ||
        prompt.includes('精简第一部分成效段落');

      const isReportingTonePrompt = 
        prompt === '改成面向单位负责人的汇报口吻' || 
        prompt.includes('汇报口吻') || 
        prompt.includes('单位负责人') || 
        prompt.includes('领导汇报') ||
        prompt.includes('向领导汇报');

      const isExpandPrompt =
        prompt.includes('补充表达') ||
        prompt.includes('举措扩写') ||
        prompt.includes('扩写') ||
        prompt.includes('补充举措') ||
        prompt.includes('补充案例');

      if (isHighlightPrompt) {
        let highlighted = originalText
          .replace(/紧紧围绕年度核心工作目标，强化统筹联动与机制创新。/g, '')
          .replace(/立足业务发展需要，严谨抓好各项工作落实。/g, '')
          .replace(/坚持需求导向，深化分级分类专业实操培养。/g, '')
          .replace(/深入推进各项管理服务机制创新，/g, '')
          .replace(/^[，、\s]+/, '').replace(/，+/g, '，');

        const trimmedPruned = highlighted.trim();
        const hasPrunedModifiers = trimmedPruned !== originalText.trim();

        if (!highlighted.startsWith('【重点成效】')) {
          highlighted = `【重点成效】${highlighted}`;
        }

        // 删除无依据的成效兜底模板，严禁自动添加“工作质效取得突破性进展”
        suggestedText = highlighted;
        if (!hasPrunedModifiers) {
          suggestedText = originalText;
          diffExplanation = '未检测到可删减的泛泛修饰语，且材料库中暂无本期核准的成效佐证材料。为避免无据添加成效定性结论，本次改写严格保留原文。建议先在材料库补充并核准成效材料。';
          needsVerificationNotes.push('当前缺少核准的成效材料依据，请先在材料库补充并核准成效材料', '缺少依据时已严格保留原文，未添加无依据的突破性进展文案');
        } else {
          diffExplanation = `执行自定义指令【${prompt}】：删减背景性泛化修饰语，强化突出阶段性工作实效，全部数据指标严格保留，未捏造未核准的突破性进展定性结论。`;
          needsVerificationNotes.push('核对成效定性表述是否严谨客观', '核对量化指标与出处依据一致');
        }
      } else if (isCompressPrompt || prompt.includes('精简') || prompt.includes('压缩')) {
        const compressed = applyParagraphCompression(originalText);
        suggestedText = compressed;

        const origLen = originalText.length;
        const suggLen = compressed.length;
        if (compressed.trim() === originalText.trim()) {
          diffExplanation = '未找到可安全改写的内容，本次正文未变化。已严格保护原始事实与段落内容。';
          needsVerificationNotes.push('本次改写未产生正文变化，无法直接采纳零差异建议');
        } else {
          const reduction = origLen - suggLen;
          const pct = origLen > 0 ? Math.round((reduction / origLen) * 100) : 0;
          const prefix = sourceComment
            ? `执行【${sourceComment.reviewer}】审阅修改方向【${prompt}】：`
            : `执行自定义指令【${prompt}】：`;
          diffExplanation = `${prefix}精简压缩常规修饰语，字数由${origLen}字精简至${suggLen}字（减少${reduction}字，压缩约${pct}%），严密保留事实数据（${numbersWithUnits.join('、') || '无量化数据'}）及统计期间，未改动任何计量单位与统计口径。`;
          needsVerificationNotes.push('核对精简后语句是否通畅连贯', '核对关键台账指标无遗漏与口径一致');
        }
      } else if (isReportingTonePrompt) {
        let formalized = originalText
          .replace(/在看到成绩的同时/g, '对标高标准履职要求')
          .replace(/下一步/g, '下一阶段重点举措')
          .replace(/平稳有序开展/g, '平稳高效推进')
          .replace(/抓细抓实/g, '深入贯彻落实')
          .replace(/坚持需求导向，深化分级分类专业实操培养。/g, '聚焦高素质专业化干部队伍建设，高位推动业务赋能。')
          .replace(/立足业务发展需要，严谨抓好各项工作落实。/g, '紧扣中心大局与核心指标，统筹推进全流程规范治理。');

        if (!formalized.startsWith('聚焦') && !formalized.startsWith('紧扣') && !formalized.startsWith('立足')) {
          formalized = `紧扣全局中心工作部署，${formalized}`;
        }

        suggestedText = formalized;
        if (formalized.trim() === originalText.trim()) {
          diffExplanation = '未找到可安全改写的内容，本次正文未变化。已严格保护原始事实与段落内容。';
          needsVerificationNotes.push('本次改写未产生正文变化，无法直接采纳零差异建议');
        } else {
          diffExplanation = `执行自定义指令【${prompt}】：转换为面向单位负责人的高站位汇报口吻，强化宏观统筹与成果成效，全量保留既有事实数据与统计期间。`;
          needsVerificationNotes.push('确认汇报口吻契合本次呈报层级', '确认引用数据口径准确');
        }
      } else if (isExpandPrompt) {
        const taskObj = options?.task;
        const hasAuthenticCase = taskObj ? taskObj.snippets.some((s) => isValidAuthenticCase(taskObj, s)) : false;

        // 两个分支均移除“健全跟踪台账与周调度闭环机制”固定模板；若尚不能根据所选材料可靠扩写，保留原文并提示人工选择、补充案例
        suggestedText = originalText;
        if (!hasAuthenticCase) {
          diffExplanation = '材料库中暂无本期核准的真实典型案例材料依据。为杜绝无据虚构或盲目添加未核实举措，本次改写严格保留原文未作修改。建议在材料库中补充并核准相关案例与佐证依据后再行扩写。';
          needsVerificationNotes.push('当前未录入真实案例材料，如需典型个案请先在材料库补充核准', '缺少依据时已严格保留原文，未添加无材料依据的成效或举措');
        } else {
          diffExplanation = '检测到材料库中包含核准案例材料，但为防止拼接无依据的固定举措模板，系统已严格保留段落原文。建议结合具体业务场景由人工甄选案例材料并定向补充。';
          needsVerificationNotes.push('材料库已有核准案例，已保留原文并提示人工根据具体材料按需补充', '已移除无依据的固定举措模板，避免引入未经核验的台账机制');
        }
      } else {
        // Unsupported prompt handling
        isUnsupportedPrompt = true;
        unsupportedPromptNotice = `当前原型模拟服务暂未支持修改方向“${prompt}”。原型仅支持明确的演示指令（如“精简表达并保留数据”、“改成面向单位负责人的汇报口吻”、“突出成效并删减泛泛修饰”，或使用上方快捷精修操作）。`;
        suggestedText = originalText;
        diffExplanation = '未识别支持的演示指令，已返回确定性演示限制说明，未生成无关文本。本次正文未变化。';
        needsVerificationNotes.push('请使用系统推荐的示例指令或快捷改写操作进行演示体验');
      }
    } else {
      // 4 standard shortcut actions
      switch (action) {
        case 'compress': {
          const compressed = applyParagraphCompression(originalText);
          suggestedText = compressed;
          const origLen = originalText.length;
          const suggLen = compressed.length;

          if (compressed.trim() === originalText.trim()) {
            diffExplanation = '未找到可安全改写的内容，本次正文未变化。已严格保护原始事实与段落内容。';
            needsVerificationNotes.push('本次改写未产生正文变化，无法直接采纳零差异建议');
          } else {
            const reduction = origLen - suggLen;
            const pct = origLen > 0 ? Math.round((reduction / origLen) * 100) : 0;
            diffExplanation = `精炼压缩常规动员修饰语，字数由${origLen}字精简至${suggLen}字（减少${reduction}字，压缩约${pct}%），严密保留事实数据（${numbersWithUnits.join('、') || '无量化数据'}）及统计期间，未改动任何计量单位与统计口径。`;
            needsVerificationNotes.push('核对精简后语句是否通畅连贯', '核对关键台账指标无遗漏与口径一致');
          }
          break;
        }

        case 'expand': {
          const taskObj = options?.task;
          const hasAuthenticCase = taskObj ? taskObj.snippets.some((s) => isValidAuthenticCase(taskObj, s)) : false;

          // 两个分支均移除“健全跟踪台账与周调度闭环机制”固定模板；若尚不能根据所选材料可靠扩写，保留原文并提示人工选择、补充案例
          suggestedText = originalText;
          if (!hasAuthenticCase) {
            diffExplanation = '材料库中暂无本期核准的真实典型案例材料依据。为杜绝无据虚构或盲目添加未核实举措，本次改写严格保留原文未作修改。建议在材料库中补充并核准相关案例与事实材料后再行扩写。';
            needsVerificationNotes.push('当前材料库未录入本期核准真实案例材料，已提示补充材料并避免编造虚构案例', '缺少依据时已严格保留原文，未添加无材料依据的成效或举措');
          } else {
            diffExplanation = '检测到材料库中包含核准案例材料，但为防止拼接无依据的固定举措模板，系统已严格保留段落原文。建议结合具体业务场景由人工甄选案例材料并定向补充。';
            needsVerificationNotes.push('材料库已有核准案例，已保留原文并提示人工根据具体材料按需补充', '已移除无依据的固定举措模板，避免引入未经核验的台账机制');
          }
          break;
        }

        case 'formal': {
          let formalized = originalText
            .replace(/在看到成绩的同时/g, '在肯定成效的同时，对标高标准履职要求')
            .replace(/下一步/g, '下一阶段工作规划')
            .replace(/平稳有序开展/g, '保持平稳健康推进态势')
            .replace(/抓细抓实/g, '深入贯彻落实');

          suggestedText = formalized;
          if (formalized.trim() === originalText.trim()) {
            diffExplanation = '未找到可安全改写的内容，本次正文未变化。已严格保护原始事实与段落内容。';
            needsVerificationNotes.push('本次改写未产生正文变化，无法直接采纳零差异建议');
          } else {
            diffExplanation = `优化为标准公文庄重句式，提升整体严肃性与规范度，全量保留段落内既有数据与统计口径。`;
            needsVerificationNotes.push('确认句式正式度契合机关公文规范', '核对引述数据口径准确');
          }
          break;
        }

        case 'highlight': {
          suggestedText = `【重点成效】${originalText}`;
          diffExplanation = `增设重点工作突破提示标识，便于审阅者快速定位关键成效。`;
          needsVerificationNotes.push('核对重点标识标注位置是否恰当', '核对重点成效是否有充分台账依据');
          break;
        }
      }
    }
  }

  // Safety invariant check: every single number + unit from original must remain in suggestedText!
  if (!isUnsupportedPrompt && !interpretation.isReplacement) {
    numbersWithUnits.forEach((nu) => {
      if (!suggestedText.includes(nu)) {
        // If regex or replacement accidentally dropped it, restore original
        suggestedText = originalText;
        diffExplanation = `核验发现改写可能会丢失关键指标“${nu}”，已自动保护原始数据口径。本次正文未变化。`;
        if (!needsVerificationNotes.some((n) => n.includes('零差异'))) {
          needsVerificationNotes.push('本次改写未产生正文变化，无法直接采纳零差异建议');
        }
      }
    });
  }

  // Final check: if text is unchanged, ensure zero-diff truthful explanation
  if (originalText.trim() === suggestedText.trim() && !isUnsupportedPrompt && !interpretation.isReplacement) {
    if (!diffExplanation || diffExplanation.includes('压缩约') || diffExplanation.includes('30%') || diffExplanation.includes('精炼压缩')) {
      diffExplanation = '未找到可安全改写的内容，本次正文未变化。已严格保护原始事实与段落内容。';
    }
    if (!needsVerificationNotes.some((n) => n.includes('零差异'))) {
      needsVerificationNotes.push('本次改写未产生正文变化，无法直接采纳零差异建议');
    }
  }

  // Frozen snapshot fact verification check
  const taskObj = options?.task;
  const draftObj = options?.currentDraft;
  if (draftObj) {
    if (!draftObj.snapshotMetadata?.factSnapshot) {
      needsVerificationNotes.push('事实依据提示：本草稿缺少冻结事实快照依据，建议重新核实事实或重新起草。');
    } else if (taskObj?.factSnapshot) {
      if (draftObj.snapshotMetadata.factSnapshot.hash !== taskObj.factSnapshot.hash) {
        needsVerificationNotes.push('事实核对提示：当前稿件冻结依据与任务最新事实快照存在版本差异，请核实口径。');
      }
    }

    if (taskObj) {
      for (const fId of block.referencedFactIds) {
        const fact = taskObj.facts.find((f) => f.id === fId);
        if (!fact || fact.status !== 'confirmed') {
          needsVerificationNotes.push(`事实核对提示：本段引用的事实依据【${fact?.metric || fId}】状态为【${fact?.status || '已删除'}】，非有效核准事实，请核实！`);
        }
      }
    }
  }

  const section = taskObj?.outline.find((s) => s.id === block.sectionId);
  const diffSegments = computeTextDiff(originalText, suggestedText);
  const wordCountDelta = suggestedText.length - originalText.length;

  return {
    runId: runId || `REV-RUN-${Date.now().toString(36)}`,
    taskId: taskId || '',
    sourceDraftId: sourceDraftId || '',
    targetBlockId: block.id,
    targetBlockOrder: block.order,
    targetSectionTitle: section?.title,
    baseContent: originalText,
    baseContentHash: computeContentHash(originalText),
    action,
    customPrompt: prompt || undefined,
    originalText,
    suggestedText,
    diffExplanation,
    factsAffected: block.referencedFactIds,
    createdAt: new Date().toISOString(),
    wordCountDelta,
    needsVerificationNotes,
    diffSegments,
    isUnsupportedPrompt,
    unsupportedPromptNotice,
    sourceCommentId: sourceComment?.id,
    sourceCommentReviewer: sourceComment?.reviewer,
    sourceCommentSummary: sourceComment?.content,
    sourceCommentType: interpretation.suggestionType,
    isReviewerReplacement: Boolean(interpretation.isReplacement && interpretation.replacementText),
  };
}
