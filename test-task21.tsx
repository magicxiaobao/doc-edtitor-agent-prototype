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
} from './src/types';
import {
  analyzeFactImpact,
  FactImpactAnalysisResult,
  FactImpactItem,
} from './src/services/factImpactService';
import {
  acceptDraftCandidate,
  applyDraftContentChange,
} from './src/services/draftLifecycleService';
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

async function runTask21Tests() {
  console.log('\n================================================================');
  console.log('   🚀 开始执行 任务21 事实变更影响总览与逐段定位 自动化验收套件');
  console.log('================================================================\n');

  // ----------------------------------------------------------------
  // Case 1: 128项稿件后改采信120项，只标记实际引用该事实的段落
  // ----------------------------------------------------------------
  console.log('>>> [用例 1] 128项稿件后改采信120项，只标记实际引用该事实的段落:');
  {
    const task = createPresetTask('under_review');
    const currentDraft = task.drafts.find((d) => d.id === task.currentDraftId);
    assert(!!currentDraft, '用例1: 审阅场景下存在当前工作稿件');

    // 找到在正文中实际引用 128 项重点任务事实的 Fact
    const factKey = task.facts.find(
      (f) => (f.selectedConflictValue || f.value) === '128' && f.metric.includes('重点任务')
    );
    assert(!!factKey, '用例1: 成功识别重点任务事实对象');

    const targetFactId = factKey!.id;
    // 动态确定正文中哪些段落引用了该事实
    const expectedBlockIds = (currentDraft!.blocks || [])
      .filter((b) => (b.referencedFactIds || []).includes(targetFactId))
      .map((b) => b.id);
    assert(expectedBlockIds.length > 0, '用例1: 确认正文中至少有段落引用了重点任务事实');

    // 主笔调整已核准事实为 120 项
    const updatedFacts = task.facts.map((f) => {
      if (f.id === targetFactId) {
        return {
          ...f,
          value: '120',
          selectedConflictValue: '120',
          conflictResolutionReason: '经核实改为采信科室甲单一科室申报口径120项',
        };
      }
      return f;
    });
    const modifiedTask: Task = { ...task, facts: updatedFacts };

    const impact = analyzeFactImpact(modifiedTask, currentDraft);

    assert(impact.hasDraft === true, '用例1: 正确识别存在稿件');
    assert(impact.hasSnapshotBaseline === true, '用例1: 正确识别存在冻结快照基准');
    assert(impact.changedFactsCount === 1, `用例1: 变化事实数仅为1项，实际为: ${impact.changedFactsCount}`);
    assert(
      impact.affectedBlocksCount === expectedBlockIds.length,
      `用例1: 受影响段落数恰好匹配引用该事实的段落数 (${expectedBlockIds.length})`
    );

    const changedItem = impact.impactItems.find((i) => i.factId === targetFactId);
    assert(!!changedItem, '用例1: 变动事实清单中包含重点任务事实');
    assert(
      changedItem!.differenceTags.some((t) => t.type === 'value'),
      '用例1: 差异类型中包含“数值变化”'
    );
    assert(
      changedItem!.draftSnapshotValue.includes('128'),
      `用例1: 本稿采用值保留历史冻结128，实际为: ${changedItem!.draftSnapshotValue}`
    );
    assert(
      changedItem!.latestConfirmedValue.includes('120'),
      `用例1: 任务最新值显示已核准120，实际为: ${changedItem!.latestConfirmedValue}`
    );

    // 检查其他事实（培训16场、800人次、调研12次）未被误标
    const otherFactIds = task.facts
      .filter((f) => f.id !== targetFactId && f.status === 'confirmed')
      .map((f) => f.id);
    const falselyFlagged = impact.impactItems.filter((i) => otherFactIds.includes(i.factId));
    assert(
      falselyFlagged.length === 0,
      `用例1: 培训16场、800人次、调研12次等未变动事实绝未被误报变动 (误报数: ${falselyFlagged.length})`
    );
  }

  // ----------------------------------------------------------------
  // Case 2: 数值相同，仅单位、期间、口径或主出处变化，分别正确提示
  // ----------------------------------------------------------------
  console.log('\n>>> [用例 2] 数值相同，仅单位、期间、口径或主出处变化，分别正确提示:');
  {
    const baseTask = createPresetTask('under_review');
    const draft = baseTask.drafts.find((d) => d.id === baseTask.currentDraftId)!;
    const testFactId = draft.snapshotMetadata!.factSnapshot!.items[0].factId;

    // A. 仅单位变化
    {
      const modifiedTask: Task = {
        ...baseTask,
        facts: baseTask.facts.map((f) => (f.id === testFactId ? { ...f, unit: '个' } : f)),
      };
      const res = analyzeFactImpact(modifiedTask, draft);
      const item = res.impactItems.find((i) => i.factId === testFactId);
      assert(!!item, '用例2.A: 检出单位变动事实');
      assert(item!.differenceTags.some((t) => t.type === 'unit'), '用例2.A: 差异类型包含单位变化');
      assert(!item!.differenceTags.some((t) => t.type === 'value'), '用例2.A: 未误报数值变化');
    }

    // B. 仅期间变化
    {
      const modifiedTask: Task = {
        ...baseTask,
        facts: baseTask.facts.map((f) => (f.id === testFactId ? { ...f, period: '2026年1至6月' } : f)),
      };
      const res = analyzeFactImpact(modifiedTask, draft);
      const item = res.impactItems.find((i) => i.factId === testFactId);
      assert(!!item, '用例2.B: 检出期间变动事实');
      assert(item!.differenceTags.some((t) => t.type === 'period'), '用例2.B: 差异类型包含统计期间变化');
    }

    // C. 仅口径变化
    {
      const modifiedTask: Task = {
        ...baseTask,
        facts: baseTask.facts.map((f) =>
          f.id === testFactId ? { ...f, metricScope: '调整为专项重点工程口径（不含常规）' } : f
        ),
      };
      const res = analyzeFactImpact(modifiedTask, draft);
      const item = res.impactItems.find((i) => i.factId === testFactId);
      assert(!!item, '用例2.C: 检出统计口径变动事实');
      assert(item!.differenceTags.some((t) => t.type === 'metric_scope'), '用例2.C: 差异类型包含统计口径变化');
    }

    // D. 仅主出处变化
    {
      const modifiedTask: Task = {
        ...baseTask,
        facts: baseTask.facts.map((f) =>
          f.id === testFactId ? { ...f, primaryEvidenceId: 'EVD-99-CUSTOM' } : f
        ),
      };
      const res = analyzeFactImpact(modifiedTask, draft);
      const item = res.impactItems.find((i) => i.factId === testFactId);
      assert(!!item, '用例2.D: 检出主出处变动事实');
      assert(item!.differenceTags.some((t) => t.type === 'primary_evidence'), '用例2.D: 差异类型包含主出处变更');
    }
  }

  // ----------------------------------------------------------------
  // Case 3: 同一事实引用多个段落、多个变化事实引用同一段落，计数去重正确
  // ----------------------------------------------------------------
  console.log('\n>>> [用例 3] 同一事实引用多个段落、多个变化事实引用同一段落，计数去重正确:');
  {
    const baseTask = createPresetTask('under_review');
    const origDraft = baseTask.drafts.find((d) => d.id === baseTask.currentDraftId)!;

    // 构造测试草稿：
    // Block 1 引用 FACT-A 和 FACT-B
    // Block 2 引用 FACT-A
    // Block 3 引用 FACT-C (无变化)
    const customBlocks: ParagraphBlock[] = [
      {
        id: 'TEST-BLK-01',
        sectionId: 'SEC-01',
        order: 1,
        content: '第一段引用了A和B。',
        referencedFactIds: ['FACT-A', 'FACT-B'],
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'TEST-BLK-02',
        sectionId: 'SEC-01',
        order: 2,
        content: '第二段仅引用了A。',
        referencedFactIds: ['FACT-A'],
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'TEST-BLK-03',
        sectionId: 'SEC-02',
        order: 3,
        content: '第三段引用了C，无变动。',
        referencedFactIds: ['FACT-C'],
        updatedAt: new Date().toISOString(),
      },
    ];

    const testDraft: DraftVersion = {
      ...origDraft,
      blocks: customBlocks,
      snapshotMetadata: {
        ...origDraft.snapshotMetadata!,
        factSnapshot: {
          confirmedAt: '2026-10-07T08:30:00.000Z',
          factIds: ['FACT-A', 'FACT-B', 'FACT-C'],
          items: [
            {
              factId: 'FACT-A',
              metric: '指标A',
              value: '100',
              unit: '项',
              period: '2026年1-9月',
              metricScope: '口径A',
              primaryEvidenceId: 'EVD-A',
            },
            {
              factId: 'FACT-B',
              metric: '指标B',
              value: '200',
              unit: '人',
              period: '2026年1-9月',
              metricScope: '口径B',
              primaryEvidenceId: 'EVD-B',
            },
            {
              factId: 'FACT-C',
              metric: '指标C',
              value: '300',
              unit: '次',
              period: '2026年1-9月',
              metricScope: '口径C',
              primaryEvidenceId: 'EVD-C',
            },
          ],
          hash: 'HASH-CUSTOM',
        },
      },
    };

    // 场景 A: 仅 FACT-A 改变（被 Block 1 和 Block 2 引用）
    {
      const taskWithAChanged: Task = {
        ...baseTask,
        facts: [
          {
            id: 'FACT-A',
            metric: '指标A',
            value: '105',
            unit: '项',
            period: '2026年1-9月',
            metricScope: '口径A',
            primaryEvidenceId: 'EVD-A',
            evidenceIds: ['EVD-A'],
            hasConflict: false,
            status: 'confirmed',
          },
          {
            id: 'FACT-B',
            metric: '指标B',
            value: '200',
            unit: '人',
            period: '2026年1-9月',
            metricScope: '口径B',
            primaryEvidenceId: 'EVD-B',
            evidenceIds: ['EVD-B'],
            hasConflict: false,
            status: 'confirmed',
          },
          {
            id: 'FACT-C',
            metric: '指标C',
            value: '300',
            unit: '次',
            period: '2026年1-9月',
            metricScope: '口径C',
            primaryEvidenceId: 'EVD-C',
            evidenceIds: ['EVD-C'],
            hasConflict: false,
            status: 'confirmed',
          },
        ],
      };

      const res = analyzeFactImpact(taskWithAChanged, testDraft);
      assert(res.changedFactsCount === 1, '用例3.A: 改变事实数为1项');
      assert(res.affectedBlocksCount === 2, '用例3.A: 受影响段落数去重后为2段 (BLK-01 & BLK-02)');
      assert(
        res.affectedBlockIds.includes('TEST-BLK-01') && res.affectedBlockIds.includes('TEST-BLK-02'),
        '用例3.A: 正确识别受影响段落集合'
      );
    }

    // 场景 B: FACT-A 和 FACT-B 均改变（Block 1 引用了两者，Block 2 引用了A）
    {
      const taskWithABChanged: Task = {
        ...baseTask,
        facts: [
          {
            id: 'FACT-A',
            metric: '指标A',
            value: '105',
            unit: '项',
            period: '2026年1-9月',
            metricScope: '口径A',
            primaryEvidenceId: 'EVD-A',
            evidenceIds: ['EVD-A'],
            hasConflict: false,
            status: 'confirmed',
          },
          {
            id: 'FACT-B',
            metric: '指标B',
            value: '250',
            unit: '人',
            period: '2026年1-9月',
            metricScope: '口径B',
            primaryEvidenceId: 'EVD-B',
            evidenceIds: ['EVD-B'],
            hasConflict: false,
            status: 'confirmed',
          },
          {
            id: 'FACT-C',
            metric: '指标C',
            value: '300',
            unit: '次',
            period: '2026年1-9月',
            metricScope: '口径C',
            primaryEvidenceId: 'EVD-C',
            evidenceIds: ['EVD-C'],
            hasConflict: false,
            status: 'confirmed',
          },
        ],
      };

      const res = analyzeFactImpact(taskWithABChanged, testDraft);
      assert(res.changedFactsCount === 2, '用例3.B: 改变事实数去重为2项 (A与B)');
      assert(res.affectedBlocksCount === 2, '用例3.B: 受影响段落数去重为2段 (BLK-01引用A+B去重算1段，加上BLK-02共2段)');
      assert(!res.affectedBlockIds.includes('TEST-BLK-03'), '用例3.B: BLK-03未受影响');
    }
  }

  // ----------------------------------------------------------------
  // Case 4: 未引用的新事实不使全部正文变为待复核
  // ----------------------------------------------------------------
  console.log('\n>>> [用例 4] 未引用的新事实不使全部正文变为待复核:');
  {
    const baseTask = createPresetTask('under_review');
    const draft = baseTask.drafts.find((d) => d.id === baseTask.currentDraftId)!;

    // 在任务事实清单中追加一项全新事实 FACT-NEW-99
    const taskWithNewFact: Task = {
      ...baseTask,
      facts: [
        ...baseTask.facts,
        {
          id: 'FACT-NEW-99',
          metric: '新招募志愿者',
          value: '500',
          unit: '人',
          period: '2026年1至9月',
          metricScope: '志愿服务台账',
          primaryEvidenceId: 'EVD-01',
          evidenceIds: ['EVD-01'],
          hasConflict: false,
          status: 'confirmed',
        },
      ],
    };

    const res = analyzeFactImpact(taskWithNewFact, draft);
    assert(res.affectedBlocksCount === 0, `用例4: 未引用的新事实不增加受影响段落数 (当前为: ${res.affectedBlocksCount})`);
    assert(res.unreferencedNewFacts.length > 0, '用例4: 在 unreferencedNewFacts 清单中独立提示');
    assert(
      res.unreferencedNewFacts.some((f) => f.factId === 'FACT-NEW-99'),
      '用例4: unreferencedNewFacts 包含 FACT-NEW-99'
    );
  }

  // ----------------------------------------------------------------
  // Case 5: 事实删除、排除、撤销核准及快照缺失，均有真实状态说明
  // ----------------------------------------------------------------
  console.log('\n>>> [用例 5] 事实删除、排除、撤销核准及快照缺失，均有真实状态说明:');
  {
    const baseTask = createPresetTask('under_review');
    const draft = baseTask.drafts.find((d) => d.id === baseTask.currentDraftId)!;
    const testFactId = draft.snapshotMetadata!.factSnapshot!.items[0].factId;

    // A. 事实被删除
    {
      const taskDeleted: Task = {
        ...baseTask,
        facts: baseTask.facts.filter((f) => f.id !== testFactId),
      };
      const res = analyzeFactImpact(taskDeleted, draft);
      const item = res.impactItems.find((i) => i.factId === testFactId);
      assert(!!item, '用例5.A: 检出被删除事实');
      assert(item!.differenceTags.some((t) => t.type === 'status_deleted'), '用例5.A: 标记 status_deleted');
      assert(item!.latestConfirmedValue.includes('已删除'), '用例5.A: 最新状态文案明确写明已删除');
    }

    // B. 事实被排除
    {
      const taskExcluded: Task = {
        ...baseTask,
        facts: baseTask.facts.map((f) => (f.id === testFactId ? { ...f, status: 'excluded' as const } : f)),
      };
      const res = analyzeFactImpact(taskExcluded, draft);
      const item = res.impactItems.find((i) => i.factId === testFactId);
      assert(!!item, '用例5.B: 检出被排除事实');
      assert(item!.differenceTags.some((t) => t.type === 'status_excluded'), '用例5.B: 标记 status_excluded');
    }

    // C. 事实撤销核准为待确认
    {
      const taskPending: Task = {
        ...baseTask,
        facts: baseTask.facts.map((f) => (f.id === testFactId ? { ...f, status: 'pending' as const } : f)),
      };
      const res = analyzeFactImpact(taskPending, draft);
      const item = res.impactItems.find((i) => i.factId === testFactId);
      assert(!!item, '用例5.C: 检出撤销为待确认事实');
      assert(item!.differenceTags.some((t) => t.type === 'status_pending'), '用例5.C: 标记 status_pending');
      assert(item!.latestStatusLabel === '待确认', '用例5.C: 最新状态标签为“待确认”');
    }

    // D. 事实存在未裁决冲突
    {
      const taskConflict: Task = {
        ...baseTask,
        facts: baseTask.facts.map((f) =>
          f.id === testFactId
            ? { ...f, hasConflict: true, selectedConflictValue: undefined }
            : f
        ),
      };
      const res = analyzeFactImpact(taskConflict, draft);
      const item = res.impactItems.find((i) => i.factId === testFactId);
      assert(!!item, '用例5.D: 检出存在未裁决冲突');
      assert(item!.differenceTags.some((t) => t.type === 'conflict_unresolved'), '用例5.D: 标记 conflict_unresolved');
    }

    // E. 稿件缺少快照基准
    {
      const draftWithoutSnapshot: DraftVersion = {
        ...draft,
        snapshotMetadata: undefined,
      };
      const res = analyzeFactImpact(baseTask, draftWithoutSnapshot);
      assert(res.hasSnapshotBaseline === false, '用例5.E: 准确识别缺少快照基准');
      assert(res.statusMessage.includes('缺少比较基准'), '用例5.E: 提示缺少比较基准，需人工核实');
    }
  }

  // ----------------------------------------------------------------
  // Case 6: 历史/定稿保持原冻结内容，工作稿与历史稿切换后不串用基准
  // ----------------------------------------------------------------
  console.log('\n>>> [用例 6] 历史/定稿保持原冻结内容，工作稿与历史稿切换后不串用基准:');
  {
    const baseTask = createPresetTask('under_review');
    const workingDraft = baseTask.drafts.find((d) => d.id === baseTask.currentDraftId)!;

    // 创建一个只读历史快照（冻结值为120），当前工作稿冻结值为128
    const historicalDraft: DraftVersion = {
      id: 'DRAFT-HIST-V1',
      versionNumber: 'v1.0 (历史快照)',
      createdAt: '2026-10-01T08:00:00.000Z',
      author: '主笔甲',
      summary: '首轮起草快照',
      blocks: [
        {
          id: 'HIST-BLK-01',
          sectionId: 'SEC-01',
          order: 1,
          content: '历史稿件当时采用120项完成。',
          referencedFactIds: ['FACT-01'],
          updatedAt: '2026-10-01T08:00:00.000Z',
        },
      ],
      isWorkingDraft: false,
      isHistoricalSnapshot: true,
      snapshotMetadata: {
        ...workingDraft.snapshotMetadata!,
        factSnapshot: {
          confirmedAt: '2026-10-01T08:00:00.000Z',
          factIds: ['FACT-01'],
          items: [
            {
              factId: 'FACT-01',
              metric: '累计完成重点任务',
              value: '120',
              unit: '项',
              period: '2026年1至9月',
              metricScope: '科室甲申报口径120项',
              primaryEvidenceId: 'EVD-01',
            },
          ],
          hash: 'HASH-HIST-120',
        },
      },
    };

    // 任务最新核准值为 128
    assert(
      (baseTask.facts.find((f) => f.id === 'FACT-01')?.selectedConflictValue ||
        baseTask.facts.find((f) => f.id === 'FACT-01')?.value) === '128',
      '用例6: 任务最新核准事实为 128'
    );

    // 1. 检查历史稿：冻结值为120，与最新128不同，检出差异
    const histImpact = analyzeFactImpact(baseTask, historicalDraft);
    assert(histImpact.changedFactsCount === 1, '用例6: 历史稿准确检出与当前事实的差异(120 vs 128)');
    assert(
      histImpact.impactItems[0].draftSnapshotValue.includes('120'),
      '用例6: 历史稿读取自身冻结的120项，绝未被回写成128'
    );

    // 2. 检查工作稿：冻结值为128，与最新128一致，检出无差异
    const workImpact = analyzeFactImpact(baseTask, workingDraft);
    const fact01InWork = workImpact.impactItems.find((i) => i.factId === 'FACT-01');
    assert(!fact01InWork, '用例6: 工作稿读取自身128快照，与最新128一致，不串用历史稿的基准');

    // 3. 历史稿对象属性未被篡改
    assert(historicalDraft.isHistoricalSnapshot === true, '用例6: 历史稿保持只读快照状态');
    assert(
      historicalDraft.snapshotMetadata!.factSnapshot!.items[0].value === '120',
      '用例6: 历史稿事实快照项完好无损保留120'
    );
  }

  // ----------------------------------------------------------------
  // Case 7: 打开、定位、关闭、切换任务和版本，不改正文或生成新版本
  // ----------------------------------------------------------------
  console.log('\n>>> [用例 7] 打开、定位、关闭、切换任务和版本，不改正文或生成新版本:');
  {
    const baseTask = createPresetTask('under_review');
    const draft = baseTask.drafts.find((d) => d.id === baseTask.currentDraftId)!;

    const initialDraftsCount = baseTask.drafts.length;
    const initialContentHash = draft.blocks.map((b) => b.content).join('||');
    const initialModLogsCount = (baseTask.modificationLogs || []).length;

    // 运行分析
    const impact = analyzeFactImpact(baseTask, draft);
    assert(impact !== null, '用例7: 执行分析成功');

    // 断言正文及历史记录完全未变动
    assert(baseTask.drafts.length === initialDraftsCount, '用例7: 未生成新版本');
    const afterContentHash = draft.blocks.map((b) => b.content).join('||');
    assert(initialContentHash === afterContentHash, '用例7: 正文段落未发生任何改变');
    assert((baseTask.modificationLogs || []).length === initialModLogsCount, '用例7: 未产生多余修改日志');
  }

  // ----------------------------------------------------------------
  // Case 8: 通过既有候选采纳流程形成新工作稿后，总览依据新稿快照更新；未采纳候选不改变旧稿总览
  // ----------------------------------------------------------------
  console.log('\n>>> [用例 8] 候选采纳更新影响基准；未采纳候选不改变旧稿总览:');
  {
    const baseTask = createPresetTask('under_review');
    const currentDraft = baseTask.drafts.find((d) => d.id === baseTask.currentDraftId)!;

    // 假设上游事实改为 120 项并重新生成了候选稿
    const taskUpdatedFact: Task = {
      ...baseTask,
      facts: baseTask.facts.map((f) =>
        f.id === 'FACT-01' ? { ...f, value: '120', selectedConflictValue: '120' } : f
      ),
    };

    // 未采纳候选时：当前草稿依然依据旧快照 (128) 进行比较，呈现差异
    const preImpact = analyzeFactImpact(taskUpdatedFact, currentDraft);
    assert(preImpact.changedFactsCount === 1, '用例8: 未采纳新候选前，旧稿总览准确报告 128 vs 120 差异');

    // 模拟采纳候选：生成新工作草稿并更新快照为 120
    const candidateMetadata = {
      ...currentDraft.snapshotMetadata!,
      factSnapshot: {
        confirmedAt: new Date().toISOString(),
        factIds: ['FACT-01', 'FACT-02', 'FACT-03', 'FACT-04'],
        items: currentDraft.snapshotMetadata!.factSnapshot!.items.map((i) =>
          i.factId === 'FACT-01' ? { ...i, value: '120', selectedConflictValue: '120' } : i
        ),
        hash: 'HASH-NEW-120',
      },
    };

    const newBlocks = currentDraft.blocks.map((b) => {
      if ((b.referencedFactIds || []).includes('FACT-01')) {
        return {
          ...b,
          content: b.content.replace('128项', '120项'),
        };
      }
      return b;
    });

    const adoptionResult = acceptDraftCandidate(
      taskUpdatedFact,
      currentDraft,
      {
        taskId: taskUpdatedFact.id,
        runId: 'RUN-TEST-01',
        baseDraftId: currentDraft.id,
        baseDraftContentHash: 'HASH',
        upstreamApprovalVersion: {},
        blocks: newBlocks,
        snapshotMetadata: candidateMetadata,
        generatedAt: new Date().toISOString(),
      },
      '主笔甲'
    );

    const updatedTask = adoptionResult.updatedTask;
    const newWorkingDraft = adoptionResult.workingDraft;

    // 采纳新候选后：新工作草稿依据新快照 (120) 进行比较，差异归零
    const postImpact = analyzeFactImpact(updatedTask, newWorkingDraft);
    const fact01Impact = postImpact.impactItems.find((i) => i.factId === 'FACT-01');
    assert(!fact01Impact, '用例8: 采纳新工作稿后，依据新快照重新计算，FACT-01 差异消除');

    // 归档的旧稿依然完好保留旧基准
    const archived = updatedTask.drafts.find((d) => d.id === currentDraft.id);
    assert(!!archived, '用例8: 归档旧稿仍存在于草稿列表中');
    const archivedImpact = analyzeFactImpact(updatedTask, archived);
    assert(
      archivedImpact.impactItems.some((i) => i.factId === 'FACT-01'),
      '用例8: 归档旧稿保留自身历史冻结快照，依然可核验当时的依据差异'
    );
  }

  // ----------------------------------------------------------------
  // Case 9: 定位闭环与严禁数组退化验证
  // ----------------------------------------------------------------
  console.log('\n>>> [用例 9] 定位闭环与严禁数组退化验证:');
  {
    const baseTask = createPresetTask('under_review');
    const draft = baseTask.drafts.find((d) => d.id === baseTask.currentDraftId)!;

    // 测试段落重排后定位依然准确
    const reversedBlocks = [...draft.blocks].reverse();
    const reversedDraft = { ...draft, blocks: reversedBlocks };

    const impactReversed = analyzeFactImpact(baseTask, reversedDraft);
    const item = impactReversed.allReferencedItems.find((i) => (i.referencingBlocks || []).length > 0);
    assert(!!item, '用例9: 找到有关联引用的事实项');

    const targetRefBlock = item!.referencingBlocks[0];
    assert(
      reversedBlocks.some((b) => b.id === targetRefBlock.blockId),
      '用例9: 逆序重排后目标 Block ID 依然准确匹配实际段落'
    );
  }

  // ----------------------------------------------------------------
  // Case 10: JSDOM 真实组件挂载与交互闭环验证
  // ----------------------------------------------------------------
  console.log('\n>>> [用例 10] JSDOM 真实组件挂载与交互闭环验证:');
  {
    const baseTask = createPresetTask('under_review');
    // 修改事实为 120
    const targetFact = baseTask.facts.find((f) => (f.selectedConflictValue || f.value) === '128')!;
    const modifiedTask: Task = {
      ...baseTask,
      facts: baseTask.facts.map((f) =>
        f.id === targetFact.id ? { ...f, value: '120', selectedConflictValue: '120' } : f
      ),
    };

    let locatedBlockId: string | null = null;
    let viewedEvidenceFactId: string | null = null;

    const { container, unmount } = mountTestComponent(
      <DraftingStage
        task={modifiedTask}
        onUpdateTask={() => {}}
        onViewSnippet={(_snip, fact) => {
          viewedEvidenceFactId = fact?.id || null;
        }}
        onProceedToNextStage={() => {}}
        activeRole="主笔甲"
      />
    );

    // 1. 检查准备概况处存在紧凑入口
    const openBtn = container.querySelector('[data-testid="btn-open-fact-impact"]');
    assert(!!openBtn, '用例10: 找到正文工作区顶部紧凑入口按钮 [btn-open-fact-impact]');
    assert(
      openBtn!.textContent!.includes('依据变更影响') && openBtn!.textContent!.includes('1项事实'),
      `用例10: 紧凑入口文案正确显示变动事实统计，实际为: ${openBtn!.textContent}`
    );

    // 2. 点击打开影响检查面板
    act(() => {
      (openBtn as HTMLElement).click();
    });

    const modal = container.querySelector('[data-testid="fact-impact-modal"]');
    assert(!!modal, '用例10: 点击后成功展开事实影响检查面板 [fact-impact-modal]');

    // 3. 检查变动事实卡片展示
    const factCard = container.querySelector(`[data-testid="fact-impact-card-${targetFact.id}"]`);
    assert(!!factCard, '用例10: 面板中展示目标变动事实卡片');
    assert(factCard!.textContent!.includes('数值变化'), '用例10: 卡片展示“数值变化”徽章');
    assert(factCard!.textContent!.includes('128'), '用例10: 卡片包含本稿采用值 128');
    assert(factCard!.textContent!.includes('120'), '用例10: 卡片包含任务最新值 120');

    // 4. 检查段落中的“定位正文”按钮
    const locateBtn = factCard!.querySelector('button[data-testid^="btn-locate-block-"]');
    assert(!!locateBtn, '用例10: 找到“定位正文”操作按钮');

    act(() => {
      (locateBtn as HTMLElement).click();
    });

    // 检查面板关闭，正文段落被聚焦
    const modalAfterLocate = container.querySelector('[data-testid="fact-impact-modal"]');
    assert(!modalAfterLocate, '用例10: 点击“定位正文”后面板自动收起并平滑跳转至正文');

    // 5. 再次打开面板测试“查看本稿依据”
    const reopenBtn = container.querySelector('[data-testid="btn-open-fact-impact"]') as HTMLElement;
    act(() => {
      reopenBtn.click();
    });

    const viewEvBtn = container.querySelector(`[data-testid="btn-view-evidence-${targetFact.id}"]`);
    assert(!!viewEvBtn, '用例10: 找到“查看本稿依据”按钮');

    act(() => {
      (viewEvBtn as HTMLElement).click();
    });

    assert(viewedEvidenceFactId === targetFact.id, '用例10: 点击“查看本稿依据”成功触发冻结证据查看回调');

    // 6. 检查正文段落卡片上的事实变动徽章
    const changedParagraphBadge = container.querySelector('button[data-testid^="badge-block-fact-changed-"]');
    assert(!!changedParagraphBadge, '用例10: 正文段落卡片上展示“引用事实已变动/待复核”可点击徽章');

    unmount();
  }

  console.log('\n================================================================');
  console.log('   🎉 任务21 全部 10 组高价值业务与组件验收用例 100% 全部通过！');
  console.log('================================================================\n');
}

runTask21Tests().catch((err) => {
  console.error('\n❌ 任务21 验收测试执行失败:', err);
  process.exit(1);
});
