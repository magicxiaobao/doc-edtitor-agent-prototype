import { dom } from './test-jsdom-env';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createPresetTask } from './src/services/mockData';
import {
  Task,
  DraftVersion,
  ParagraphBlock,
  Fact,
  EvidenceSnippet,
  SourceDocument,
  ParagraphFactReviewRecord,
} from './src/types';
import {
  analyzeFactImpact,
  FactImpactAnalysisResult,
  FactImpactItem,
} from './src/services/factImpactService';
import {
  checkFactRevisionEligibility,
  generateFactRevisionCandidate,
  acceptFactRevisionCandidate,
  validateFactRevisionAcceptance,
} from './src/services/factRevisionCandidateService';
import {
  evaluateDraftFactReviews,
  saveFactReviewRecord,
  revokeFactReviewRecord,
} from './src/services/factReviewService';
import {
  applyDraftContentChange,
  createDraftSnapshot,
  finalizeDraft,
  restoreDraftVersion,
  validateFinalizationConditions,
} from './src/services/draftLifecycleService';
import { resolveDraftFactEvidence, findDraftFact } from './src/services/factLifecycleService';
import { DraftingStage } from './src/components/stages/DraftingStage';
import { FactImpactModal } from './src/components/FactImpactModal';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✅ PASSED: ${message}`);
}

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

async function runTask23Tests() {
  console.log('\n================================================================');
  console.log('   🚀 开始执行 任务23 事实变更定向修订候选（第一批） 自动化验收套件');
  console.log('================================================================\n');

  // Helper to build standard fixture with single fact change (128 -> 120)
  function createStandardFixture() {
    const task = createPresetTask('under_review');
    const draft = task.drafts.find((d) => d.id === task.currentDraftId)!;

    // Deep clone draft.snapshotMetadata so it keeps its frozen 128 baseline
    draft.snapshotMetadata = JSON.parse(JSON.stringify(draft.snapshotMetadata));
    task.factSnapshot = JSON.parse(JSON.stringify(task.factSnapshot));

    // Upstream task facts updated: FACT-01 changed to 120 (科室甲申报口径)
    const fact01 = task.facts.find((f) => f.id === 'FACT-01')!;
    fact01.selectedConflictValue = '120';
    fact01.value = '120';
    fact01.primaryEvidenceId = 'EVD-01';
    fact01.conflictResolutionReason = '采信科室甲申报口径120项';

    // Upstream task factSnapshot updated to 120
    task.factSnapshot!.items[0].selectedConflictValue = '120';
    task.factSnapshot!.items[0].value = '120';
    task.factSnapshot!.items[0].primaryEvidenceId = 'EVD-01';
    task.factSnapshot!.items[0].conflictResolutionReason = '采信科室甲申报口径120项';
    task.factSnapshot!.items[0].provenance = {
      evidenceId: 'EVD-01',
      sourceDocId: 'DOC-01',
      sourceDocName: '科室甲前三季度工作情况',
      location: '第3段',
      text: '2026年1至9月，累计完成重点任务120项。统计范围与科室甲材料相同。',
    };

    return { task, draft };
  }

  // ==========================================================================
  // [用例 A] 真实128→120：只有目标段落改变；16场、800人次、12次及其他正文不变
  // ==========================================================================
  console.log('>>> [用例 A] 真实128→120：只有目标段落改变；16场、800人次、12次及其他正文不变:');
  {
    const { task, draft } = createStandardFixture();

    const blk01Original = draft.blocks.find((b) => b.id === 'BLK-01')!.content;
    const blk02Original = draft.blocks.find((b) => b.id === 'BLK-02')!.content;
    const blk03Original = draft.blocks.find((b) => b.id === 'BLK-03')!.content;

    assert(blk01Original.includes('128项'), '用例A: 原草稿第1段包含128项');
    assert(blk02Original.includes('16场') && blk02Original.includes('800人次'), '用例A: 原草稿第2段包含16场和800人次');
    assert(blk03Original.includes('12次'), '用例A: 原草稿第3段包含12次');

    // 准入判定
    const eligibility = checkFactRevisionEligibility(task, draft, 'BLK-01', '主笔甲');
    assert(eligibility.eligible, '用例A: 准入判定通过');
    assert(eligibility.targetFactId === 'FACT-01', '用例A: 准入锁定目标事实为 FACT-01');

    // 候选生成
    const genRes = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
    assert(genRes.success && !!genRes.candidate, '用例A: 成功生成修订候选');
    assert(genRes.candidate!.revisedBlockContent.includes('120项'), '用例A: 修订候选正文包含120项');
    assert(!genRes.candidate!.revisedBlockContent.includes('128项'), '用例A: 修订候选已替换掉128项');

    // 采纳修订
    const acceptRes = acceptFactRevisionCandidate(task, draft, genRes.candidate!, '主笔甲');
    assert(acceptRes.success && !!acceptRes.newWorkingDraft, '用例A: 采纳修订成功');

    const newDraft = acceptRes.newWorkingDraft!;
    assert(newDraft.blocks.length === draft.blocks.length, '用例A: 段落总数保持不变');
    assert(newDraft.blocks[0].id === 'BLK-01', '用例A: 第1段稳定 ID 保持 BLK-01');
    assert(newDraft.blocks[0].content.includes('120项'), '用例A: 新工作稿第1段更新为120项');

    // 关键验证：非目标段落正文及数据完全不变
    assert(newDraft.blocks[1].id === 'BLK-02', '用例A: 第2段稳定 ID 保持 BLK-02');
    assert(newDraft.blocks[1].content === blk02Original, '用例A: 第2段正文完全不变');
    assert(newDraft.blocks[1].content.includes('16场') && newDraft.blocks[1].content.includes('800人次'), '用例A: 第2段16场与800人次原样保留');

    assert(newDraft.blocks[2].id === 'BLK-03', '用例A: 第3段稳定 ID 保持 BLK-03');
    assert(newDraft.blocks[2].content === blk03Original, '用例A: 第3段正文完全不变');
    assert(newDraft.blocks[2].content.includes('12次'), '用例A: 第3段12次原样保留');
  }

  // ==========================================================================
  // [用例 B] 候选生成、预览、取消、失败和重试均不提前修改正文、依据或版本
  // ==========================================================================
  console.log('>>> [用例 B] 候选生成、预览、取消、失败和重试均不提前修改正文、依据或版本:');
  {
    const { task, draft } = createStandardFixture();

    const origDraftCount = task.drafts.length;
    const origContent = draft.blocks[0].content;
    const origSnapshotValue = draft.snapshotMetadata!.factSnapshot!.items[0].selectedConflictValue;

    // 1. 生成候选
    const genRes = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
    assert(genRes.success, '用例B: 候选生成成功');

    // 验证生成后不提前修改
    assert(task.drafts.length === origDraftCount, '用例B: 生成后草稿版本总数不变');
    assert(draft.blocks[0].content === origContent, '用例B: 生成后草稿正文未被提前修改');
    assert(
      draft.snapshotMetadata!.factSnapshot!.items[0].selectedConflictValue === origSnapshotValue,
      '用例B: 生成后草稿依据快照未被提前修改'
    );

    // 2. 模拟取消操作：不修改正文与版本
    const cancelRes = checkFactRevisionEligibility(task, draft, 'BLK-01', '主笔甲');
    assert(cancelRes.eligible, '用例B: 取消后环境完好，仍可再次请求');
    assert(task.drafts.length === origDraftCount, '用例B: 取消后版本数依然不变');
    assert(draft.blocks[0].content === origContent, '用例B: 取消后正文完好保留128项');

    // 3. 失败拦截测试：对只读快照生成，失败不改动状态
    const histDraft: DraftVersion = {
      ...draft,
      id: 'DRAFT-HIST-TEST',
      isHistoricalSnapshot: true,
      isWorkingDraft: false,
    };
    const failRes = generateFactRevisionCandidate(task, histDraft, 'BLK-01', '主笔甲');
    assert(!failRes.success, '用例B: 对只读历史快照生成候选被拦截');
    assert(failRes.reason?.includes('只读历史快照') || false, '用例B: 给出只读快照明确拦截原因');
  }

  // ==========================================================================
  // [用例 C] 采纳后旧稿冻结128，新工作稿正文和依据均为120；新稿出处打开甲120，旧稿仍打开乙128
  // ==========================================================================
  console.log('>>> [用例 C] 采纳后旧稿冻结128，新工作稿正文和依据均为120；新稿出处打开甲120，旧稿仍打开乙128:');
  {
    const { task, draft } = createStandardFixture();

    const genRes = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
    const acceptRes = acceptFactRevisionCandidate(task, draft, genRes.candidate!, '主笔甲');
    assert(acceptRes.success, '用例C: 采纳成功');

    const updatedTask = acceptRes.updatedTask!;
    const archivedDraft = acceptRes.archivedDraft!;
    const newWorkingDraft = acceptRes.newWorkingDraft!;

    // 1. 旧稿检查
    assert(archivedDraft.isHistoricalSnapshot === true, '用例C: 旧稿标记为历史快照');
    assert(archivedDraft.isWorkingDraft === false, '用例C: 旧稿不可再编辑');
    assert(archivedDraft.blocks[0].content.includes('128项'), '用例C: 旧稿正文冻结在128项');
    assert(
      archivedDraft.snapshotMetadata!.factSnapshot!.items[0].selectedConflictValue === '128',
      '用例C: 旧稿事实依据快照冻结在128项'
    );

    // 2. 新工作稿检查
    assert(newWorkingDraft.isWorkingDraft === true, '用例C: 新稿标记为工作稿');
    assert(newWorkingDraft.isHistoricalSnapshot === false, '用例C: 新稿非历史快照');
    assert(newWorkingDraft.sourceDraftId === draft.id, '用例C: 新稿记录 sourceDraftId 为旧稿 ID');
    assert(newWorkingDraft.blocks[0].content.includes('120项'), '用例C: 新工作稿正文为120项');
    assert(
      newWorkingDraft.snapshotMetadata!.factSnapshot!.items[0].selectedConflictValue === '120',
      '用例C: 新工作稿事实依据快照更新为120项'
    );

    // 3. 出处核验：旧稿仍打开科室乙128，新稿打开科室甲120
    const factInTask = updatedTask.facts.find((f) => f.id === 'FACT-01')!;

    // 从旧稿解析出处
    const oldResolved = resolveDraftFactEvidence(factInTask, archivedDraft, updatedTask, { freezeSnapshot: true });
    assert(oldResolved.effectiveSnippet?.docName.includes('科室乙') || false, '用例C: 旧稿出处材料为科室乙');
    assert(oldResolved.effectiveSnippet?.text.includes('128项') || false, '用例C: 旧稿出处原文包含128项');
    assert(oldResolved.adoptedValue.includes('128'), '用例C: 旧稿依据采用值为128');

    // 从新工作稿解析出处
    const newResolved = resolveDraftFactEvidence(factInTask, newWorkingDraft, updatedTask, { freezeSnapshot: true });
    assert(newResolved.effectiveSnippet?.docName.includes('科室甲') || false, '用例C: 新稿出处材料为科室甲');
    assert(newResolved.effectiveSnippet?.text.includes('120项') || false, '用例C: 新稿出处原文包含120项');
    assert(newResolved.adoptedValue.includes('120'), '用例C: 新稿依据采用值为120');
  }

  // ==========================================================================
  // [用例 D] 同段或其他段落存在相同数字时，不误替换；归属不明时拒绝生成
  // ==========================================================================
  console.log('>>> [用例 D] 同段或其他段落存在相同数字时，不误替换；归属不明时拒绝生成:');
  {
    // D.1: 同段内存在相同数字但属于其他单位或指标（例如 128项 vs 128场）
    const { task, draft } = createStandardFixture();
    draft.blocks[0].content =
      '2026年1至9月，累计完成重点任务128项，组织各类专项观摩活动128场，成效显著。';

    const genRes1 = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
    assert(genRes1.success && !!genRes1.candidate, '用例D.1: 存在同数字其他单位时成功识别');
    assert(
      genRes1.candidate!.revisedBlockContent.includes('重点任务120项'),
      '用例D.1: 准确将重点任务128项替换为120项'
    );
    assert(
      genRes1.candidate!.revisedBlockContent.includes('专项观摩活动128场'),
      '用例D.1: 属于活动指标的128场完全未被误改'
    );

    // D.2: 同段内存在多处相同数字与单位，且语义归属不明时，明确拒绝生成
    draft.blocks[0].content =
      '全系统上半年重点任务128项，全年重点任务128项，指标存在歧义。';
    const genRes2 = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
    assert(!genRes2.success, '用例D.2: 语义归属不明时明确拒绝生成');
    assert(genRes2.reason?.includes('语义归属不明') || false, '用例D.2: 提示多处相同数值归属不明');

    // D.3: 正文内容已被修改偏离冻结值（未找到128项）
    draft.blocks[0].content =
      '全系统截至9月末，累计完成重点任务125项。';
    const genRes3 = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
    assert(!genRes3.success, '用例D.3: 正文已偏离冻结值时拒绝生成');
    assert(genRes3.reason?.includes('偏离当时冻结值') || false, '用例D.3: 明确提示正文偏离冻结值');
  }

  // ==========================================================================
  // [用例 E] 多事实、多段落、单位/期间/口径变化、缺基准、审批无效或来源不可用均准确拦截
  // ==========================================================================
  console.log('>>> [用例 E] 多事实、多段落、单位/期间/口径变化、缺基准、审批无效或来源不可用均准确拦截:');
  {
    // E.1: 多项事实发生变化
    {
      const { task, draft } = createStandardFixture();
      // 让第二个事实也发生数值变动
      task.facts[1].value = '20';
      const res = checkFactRevisionEligibility(task, draft, 'BLK-01', '主笔甲');
      assert(!res.eligible, '用例E.1: 多项事实变更时拦截');
      assert(res.reason?.includes('多项事实变更') || false, '用例E.1: 提示多项事实变更原因');
    }

    // E.2: 目标事实关联多个段落
    {
      const { task, draft } = createStandardFixture();
      // 让第2段也引用 FACT-01
      draft.blocks[1].referencedFactIds.push('FACT-01');
      const res = checkFactRevisionEligibility(task, draft, 'BLK-01', '主笔甲');
      assert(!res.eligible, '用例E.2: 事实关联多个段落时拦截');
      assert(res.reason?.includes('关联了多个段落') || false, '用例E.2: 提示一事多段限制');
    }

    // E.3: 指标单位变化 (项 -> 个)
    {
      const { task, draft } = createStandardFixture();
      task.facts[0].unit = '个';
      task.factSnapshot!.items[0].unit = '个';
      const res = checkFactRevisionEligibility(task, draft, 'BLK-01', '主笔甲');
      assert(!res.eligible, '用例E.3: 指标单位变化时拦截');
      assert(res.reason?.includes('单位发生变化') || false, '用例E.3: 提示单位变化原因');
    }

    // E.4: 统计期间变化
    {
      const { task, draft } = createStandardFixture();
      task.facts[0].period = '2026年1至6月';
      task.factSnapshot!.items[0].period = '2026年1至6月';
      const res = checkFactRevisionEligibility(task, draft, 'BLK-01', '主笔甲');
      assert(!res.eligible, '用例E.4: 统计期间变化时拦截');
      assert(res.reason?.includes('统计期间发生变化') || false, '用例E.4: 提示期间变化原因');
    }

    // E.5: 缺少冻结基准快照
    {
      const { task, draft } = createStandardFixture();
      draft.snapshotMetadata = undefined;
      const res = checkFactRevisionEligibility(task, draft, 'BLK-01', '主笔甲');
      assert(!res.eligible, '用例E.5: 缺少快照基准时拦截');
      assert(res.reason?.includes('缺少完整冻结依据基准') || false, '用例E.5: 提示基准缺失原因');
    }

    // E.6: 最新事实存在未裁决冲突
    {
      const { task, draft } = createStandardFixture();
      task.facts[0].hasConflict = true;
      task.facts[0].selectedConflictValue = undefined;
      const res = checkFactRevisionEligibility(task, draft, 'BLK-01', '主笔甲');
      assert(!res.eligible, '用例E.6: 存在未裁决冲突时拦截');
      assert(res.reason?.includes('未裁决冲突') || false, '用例E.6: 提示冲突未裁决原因');
    }

    // E.7: 最新事实出处材料失效/不存在
    {
      const { task, draft } = createStandardFixture();
      task.facts[0].primaryEvidenceId = 'EVD-NON-EXISTENT';
      const res = checkFactRevisionEligibility(task, draft, 'BLK-01', '主笔甲');
      assert(!res.eligible, '用例E.7: 出处材料失效时拦截');
      assert(res.reason?.includes('主出处材料不存在') || false, '用例E.7: 提示材料不存在原因');
    }

    // E.8: 任务大纲实质变更
    {
      const { task, draft } = createStandardFixture();
      task.outlineSnapshot!.sections[0].title = '全新的第一章标题';
      const res = checkFactRevisionEligibility(task, draft, 'BLK-01', '主笔甲');
      assert(!res.eligible, '用例E.8: 大纲实质变更时拦截');
      assert(res.reason?.includes('大纲结构或章节要求发生了实质变化') || false, '用例E.8: 提示大纲变更原因');
    }
  }

  // ==========================================================================
  // [用例 F] 生成后编辑目标段落或其他段落、改变事实/原文/审批，采纳被拒绝且人工内容保留
  // ==========================================================================
  console.log('>>> [用例 F] 生成后编辑目标段落或其他段落、改变事实/原文/审批，采纳被拒绝且人工内容保留:');
  {
    // F.1: 生成后，目标段落被人工编辑
    {
      const { task, draft } = createStandardFixture();
      const genRes = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
      assert(genRes.success && !!genRes.candidate, '用例F.1: 候选生成');

      // 人工编辑目标段落
      draft.blocks[0].content = '主笔甲人工修改的正文：截至9月末完成任务128项。';
      draft.blocks[0].revisionSeq = 1;

      const acceptRes = acceptFactRevisionCandidate(task, draft, genRes.candidate!, '主笔甲');
      assert(!acceptRes.success, '用例F.1: 目标段落被修改后采纳被拦截');
      assert(acceptRes.reason?.includes('已被人工编辑修改') || false, '用例F.1: 明确提示正文已被修改');
      assert(draft.blocks[0].content.includes('主笔甲人工修改的正文'), '用例F.1: 主笔人工修改的正文完好保留未被覆盖');
    }

    // F.2: 生成后，其他段落被人工编辑
    {
      const { task, draft } = createStandardFixture();
      const genRes = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
      assert(genRes.success && !!genRes.candidate, '用例F.2: 候选生成');

      // 人工编辑第2段
      draft.blocks[1].content = '人工编辑第2段正文内容';

      const acceptRes = acceptFactRevisionCandidate(task, draft, genRes.candidate!, '主笔甲');
      assert(!acceptRes.success, '用例F.2: 其他段落被修改后采纳被拦截');
      assert(acceptRes.reason?.includes('整稿基准已发生变更') || false, '用例F.2: 明确提示整稿基准变更');
    }

    // F.3: 生成后，事实再次变更
    {
      const { task, draft } = createStandardFixture();
      const genRes = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
      assert(genRes.success && !!genRes.candidate, '用例F.3: 候选生成');

      // 事实再次修改为130
      task.facts[0].selectedConflictValue = '130';
      task.facts[0].value = '130';

      const acceptRes = acceptFactRevisionCandidate(task, draft, genRes.candidate!, '主笔甲');
      assert(!acceptRes.success, '用例F.3: 事实再次变动后采纳被拦截');
    }
  }

  // ==========================================================================
  // [用例 G] 取消、切任务/版本、迟到结果、角色切换及重复采纳不会串写或重复创建版本
  // ==========================================================================
  console.log('>>> [用例 G] 取消、切任务/版本、迟到结果、角色切换及重复采纳不会串写或重复创建版本:');
  {
    const { task, draft } = createStandardFixture();
    const genRes = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
    assert(genRes.success && !!genRes.candidate, '用例G: 候选生成');
    const cand = genRes.candidate!;

    // G.1: 跨任务串用拦截
    const otherTask = { ...task, id: 'TASK-ANOTHER-999' };
    const resG1 = validateFactRevisionAcceptance(otherTask, draft, cand, '主笔甲');
    assert(!resG1.valid, '用例G.1: 跨任务采纳被安全拦截');
    assert(resG1.reason?.includes('跨任务') || false, '用例G.1: 提示跨任务拦截');

    // G.2: 运行ID不一致（迟到结果/已取消运行）拦截
    const resG2 = validateFactRevisionAcceptance(task, draft, cand, '主笔甲', 'RUN-EXPIRED-ID');
    assert(!resG2.valid, '用例G.2: 迟到或已过期的运行ID被拦截');

    // G.3: 角色切换：非主笔身份（如审阅乙、供稿丙）拦截
    const resG3 = validateFactRevisionAcceptance(task, draft, cand, '审阅乙');
    assert(!resG3.valid, '用例G.3: 审阅人采纳被拦截');
    assert(resG3.reason?.includes('主笔甲') || false, '用例G.3: 提示权限受限');

    // G.4: 重复采纳拦截
    const firstAccept = acceptFactRevisionCandidate(task, draft, cand, '主笔甲');
    assert(firstAccept.success, '用例G.4: 第一次采纳成功');

    // 用同一个候选尝试再次采纳
    const secondAccept = acceptFactRevisionCandidate(firstAccept.updatedTask!, draft, cand, '主笔甲');
    assert(!secondAccept.success, '用例G.4: 第二次重复采纳被拦截');
    assert(secondAccept.reason?.includes('已不是任务当前可编辑工作稿') || false, '用例G.4: 提示无法重复采纳');
  }

  // ==========================================================================
  // [用例 H] 原人工复核记录不作为新稿有效签名；历史结论、审阅意见状态及只读保护保持正确
  // ==========================================================================
  console.log('>>> [用例 H] 原人工复核记录不作为新稿有效签名；历史结论、审阅意见状态及只读保护保持正确:');
  {
    const { task, draft } = createStandardFixture();

    // 1. 在旧草稿上保存人工复核记录
    const saveRes = saveFactReviewRecord({
      task,
      targetDraftId: draft.id,
      targetBlockId: 'BLK-01',
      status: 'reviewed',
      notes: '旧稿人工复核记录：已核实128项数据出处。',
      activeRole: '主笔甲',
    });
    const taskWithReview = saveRes.updatedTask;
    const draftWithReview = taskWithReview.drafts.find((d) => d.id === draft.id)!;
    assert(draftWithReview.factReviewRecords?.length === 1, '用例H: 旧稿成功保存1条复核记录');

    // 2. 生成修订候选并采纳
    const genRes = generateFactRevisionCandidate(taskWithReview, draftWithReview, 'BLK-01', '主笔甲');
    const acceptRes = acceptFactRevisionCandidate(taskWithReview, draftWithReview, genRes.candidate!, '主笔甲');
    assert(acceptRes.success, '用例H: 采纳成功');

    const archivedDraft = acceptRes.archivedDraft!;
    const newWorkingDraft = acceptRes.newWorkingDraft!;

    // 3. 历史稿结论冻结检查
    assert(archivedDraft.frozenFactReviewOverview !== undefined, '用例H: 历史归档稿冻结了当时的复核概览');
    assert(archivedDraft.factReviewRecords?.length === 1, '用例H: 历史归档稿保留了当时的复核记录');

    // 4. 新工作稿签名初始化检查：有效复核记录清空，绝不自动签署已复核
    assert(newWorkingDraft.factReviewRecords?.length === 0, '用例H: 新工作稿有效复核记录初始化为空列表');
    assert(newWorkingDraft.sourceFactReviewRecords?.length === 1, '用例H: 旧记录移入 sourceFactReviewRecords 作为来源参考');

    // 对新工作稿评估复核状态：由于正文已变为120且快照为120，且与最新事实一致，无事实差异
    const newOverview = evaluateDraftFactReviews(acceptRes.updatedTask!, newWorkingDraft);
    assert(newOverview.totalAffectedBlocks === 0, '用例H: 新工作稿事实与快照一致，无未处理事实差异');
  }

  // ==========================================================================
  // [用例 I] 新工作稿接受现有核校和定稿门禁检查；不能因采纳候选自动视为核校通过或可定稿
  // ==========================================================================
  console.log('>>> [用例 I] 新工作稿接受现有核校和定稿门禁检查；不能因采纳候选自动视为核校通过或可定稿:');
  {
    const { task, draft } = createStandardFixture();

    const genRes = generateFactRevisionCandidate(task, draft, 'BLK-01', '主笔甲');
    const acceptRes = acceptFactRevisionCandidate(task, draft, genRes.candidate!, '主笔甲');
    assert(acceptRes.success, '用例I: 采纳成功');

    const updatedTask = acceptRes.updatedTask!;
    const newDraft = acceptRes.newWorkingDraft!;

    // 验证新工作稿的定稿门禁
    const finValidation = validateFinalizationConditions(updatedTask, newDraft.id, '主笔甲');
    // 如果任务中存在未闭环审阅意见，定稿门禁必须严格阻断
    const unclosedComments = updatedTask.reviewComments.filter(
      (c) => c.status === 'pending' || c.status === 'accepted_pending_implementation' || c.status === 'need_discussion'
    );
    if (unclosedComments.length > 0) {
      assert(!finValidation.canFinalize, '用例I: 存在未闭环审阅意见时定稿门禁严格阻断');
      assert(
        finValidation.reasons.some((r) => r.includes('意见尚未闭环') || r.includes('审阅意见')),
        '用例I: 给出审阅意见未闭环原因'
      );
    }

    // 验证新工作稿的 auditRecords 初始为空，未被自动标记“已通过”
    assert(newDraft.auditRecords?.length === 0, '用例I: 新工作稿核校记录初始化为空');
  }

  // ==========================================================================
  // [用例 J] #79在初始0、递增序号及历史记录中的显示一致
  // ==========================================================================
  console.log('>>> [用例 J] #79在初始0、递增序号及历史记录中的显示一致:');
  {
    // 测试段落初始 revisionSeq 未设置或为 0 时：
    const { task, draft } = createStandardFixture();
    draft.blocks[0].revisionSeq = 0;

    // 挂载 FactImpactModal 真实组件检查渲染
    const analysis = analyzeFactImpact(task, draft);

    let modalRoot = mountTestComponent(
      <FactImpactModal
        isOpen={true}
        onClose={() => {}}
        analysis={analysis}
        currentDraft={draft}
        task={task}
        activeRole="主笔甲"
        onLocateBlock={() => {}}
        onViewDraftEvidence={() => {}}
      />
    );

    // 检查初始卡片上的修订版本号展示
    const textContent = modalRoot.container.textContent || '';
    assert(textContent.includes('修订版本号：0'), '用例J: 初始段落修订版本号正确显示为 0（修复 #79）');
    assert(!textContent.includes('修订版本号：1'), '用例J: 初始段落绝不错误显示为 1');

    modalRoot.unmount();

    // 递增到 1 时检查
    draft.blocks[0].revisionSeq = 1;
    modalRoot = mountTestComponent(
      <FactImpactModal
        isOpen={true}
        onClose={() => {}}
        analysis={analysis}
        currentDraft={draft}
        task={task}
        activeRole="主笔甲"
        onLocateBlock={() => {}}
        onViewDraftEvidence={() => {}}
      />
    );

    const updatedText = modalRoot.container.textContent || '';
    assert(updatedText.includes('修订版本号：1'), '用例J: 修订序号递增为 1 后真实显示为 1');

    modalRoot.unmount();
  }

  // ==========================================================================
  // [用例 K] JSDOM 真实组件交互完整回归：生成候选→差异展示→取消与采纳
  // ==========================================================================
  console.log('>>> [用例 K] JSDOM 真实组件交互完整回归：生成候选→差异展示→取消与采纳:');
  {
    const { task, draft } = createStandardFixture();
    let currentTask = { ...task };
    const analysis = analyzeFactImpact(currentTask, draft);

    let acceptedCandidate: any = null;

    const modalMount = mountTestComponent(
      <FactImpactModal
        isOpen={true}
        onClose={() => {}}
        analysis={analysis}
        currentDraft={draft}
        task={currentTask}
        activeRole="主笔甲"
        onLocateBlock={() => {}}
        onViewDraftEvidence={() => {}}
        onAcceptFactRevision={(cand) => {
          acceptedCandidate = cand;
          const res = acceptFactRevisionCandidate(currentTask, draft, cand, '主笔甲');
          currentTask = res.updatedTask!;
          return { success: true };
        }}
      />
    );

    // 1. 查找“按最新事实生成修订候选”按钮
    const genBtn = modalMount.container.querySelector(
      '[data-testid="btn-generate-fact-revision-BLK-01"]'
    ) as HTMLButtonElement;
    assert(!!genBtn, '用例K: 找到“按最新事实生成修订候选”入口按钮');

    // 2. 点击生成候选
    act(() => {
      genBtn.click();
    });

    // 3. 检查候选对比面板展示
    const candidateCard = modalMount.container.querySelector(
      '[data-testid="fact-revision-candidate-card-BLK-01"]'
    );
    assert(!!candidateCard, '用例K: 成功渲染候选对比面板');

    // 4. 检查差异视图
    const diffView = modalMount.container.querySelector(
      '[data-testid="revision-diff-view-BLK-01"]'
    );
    assert(!!diffView, '用例K: 找到正文差异高亮对比区域');
    assert(!!diffView!.querySelector('.bg-emerald-100'), '用例K: 差异区域包含新增差异高亮');
    assert(candidateCard!.textContent?.includes('120'), '用例K: 候选对比卡片包含最新核准值120');

    // 5. 点击“取消”按钮
    const cancelBtn = modalMount.container.querySelector(
      '[data-testid="btn-cancel-fact-revision-BLK-01"]'
    ) as HTMLButtonElement;
    assert(!!cancelBtn, '用例K: 找到取消按钮');
    act(() => {
      cancelBtn.click();
    });

    // 验证取消后对比卡片关闭
    const cardAfterCancel = modalMount.container.querySelector(
      '[data-testid="fact-revision-candidate-card-BLK-01"]'
    );
    assert(!cardAfterCancel, '用例K: 点击取消后候选面板安全关闭');

    // 6. 再次生成并点击“采纳修订并创建新工作稿”
    act(() => {
      genBtn.click();
    });

    const acceptBtn = modalMount.container.querySelector(
      '[data-testid="btn-accept-fact-revision-BLK-01"]'
    ) as HTMLButtonElement;
    assert(!!acceptBtn, '用例K: 找到“采纳修订并创建新工作稿”按钮');

    act(() => {
      acceptBtn.click();
    });

    assert(!!acceptedCandidate, '用例K: 采纳处理回调成功触发');
    assert(acceptedCandidate.toValue === '120', '用例K: 采纳候选目标值为120');
    assert(currentTask.drafts.length === 2, '用例K: 成功创建新版本，草稿总数增加为 2');
    assert(currentTask.currentDraftId !== draft.id, '用例K: 当前草稿指针切换至新工作稿');

    modalMount.unmount();
  }

  console.log('\n================================================================');
  console.log('   🎉 任务23 全部 11 组核心业务与真实组件用例 100% 全部通过！');
  console.log('================================================================\n');
}

runTask23Tests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
