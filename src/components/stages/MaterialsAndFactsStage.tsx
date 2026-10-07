import React, { useState } from 'react';
import { 
  Task, 
  SourceDocument, 
  EvidenceSnippet, 
  Fact, 
  UserRole, 
  MaterialUsage 
} from '../../types';
import { 
  queryMockRag, 
  RagScenario 
} from '../../services/mockRagService';
import { 
  Database, 
  FileText, 
  Search, 
  AlertTriangle, 
  CheckCircle2, 
  XCircle, 
  Plus, 
  ExternalLink, 
  Clock, 
  HelpCircle, 
  Layers, 
  Upload, 
  Check, 
  ShieldAlert,
  ArrowRight
} from 'lucide-react';

interface MaterialsAndFactsStageProps {
  task: Task;
  onUpdateTask: (updated: Partial<Task>) => void;
  onViewSnippet: (snippet: EvidenceSnippet) => void;
  onProceedToNextStage: () => void;
  activeRole: UserRole;
}

export const MaterialsAndFactsStage: React.FC<MaterialsAndFactsStageProps> = ({
  task,
  onUpdateTask,
  onViewSnippet,
  onProceedToNextStage,
  activeRole,
}) => {
  // Tabs: 'materials' | 'facts' | 'rag'
  const [activeTab, setActiveTab] = useState<'facts' | 'materials' | 'rag'>('facts');

  // Conflict modal state
  const [resolvingFact, setResolvingFact] = useState<Fact | null>(null);
  const [conflictChoice, setConflictChoice] = useState<string>('');
  const [conflictReason, setConflictReason] = useState<string>('');

  // Snippet to Fact Modal
  const [snippetForFact, setSnippetForFact] = useState<EvidenceSnippet | null>(null);
  const [snipFactMetric, setSnipFactMetric] = useState('');
  const [snipFactPeriod, setSnipFactPeriod] = useState('');
  const [snipFactValue, setSnipFactValue] = useState('');
  const [snipFactUnit, setSnipFactUnit] = useState('');
  const [snipFactScope, setSnipFactScope] = useState('');

  // Manual Supplement Fact Modal
  const [showAddFactModal, setShowAddFactModal] = useState(false);
  const [newFactMetric, setNewFactMetric] = useState('');
  const [newFactValue, setNewFactValue] = useState('');
  const [newFactUnit, setNewFactUnit] = useState('');
  const [newFactScope, setNewFactScope] = useState('');
  const [newFactNotes, setNewFactNotes] = useState('');

  // Upload/Paste Material Modal
  const [showAddMaterialModal, setShowAddMaterialModal] = useState(false);
  const [matName, setMatName] = useState('');
  const [matSource, setMatSource] = useState('科室处室');
  const [matPeriod, setMatPeriod] = useState('2026年1-9月');
  const [matUsage, setMatUsage] = useState<MaterialUsage>('current_fact');
  const [matFileType, setMatFileType] = useState<'txt' | 'docx' | 'pdf' | 'pasted'>('txt');
  const [matContent, setMatContent] = useState('');

  // RAG query state
  const [ragQuery, setRagQuery] = useState('2026年前三季度单位各项重点任务完成及队伍培训指标情况');
  const [ragScenario, setRagScenario] = useState<RagScenario>('normal');
  const [isRagLoading, setIsRagLoading] = useState(false);
  const [ragResult, setRagResult] = useState<any>(null);
  const [ragError, setRagError] = useState<string | null>(null);

  // Filters for materials & facts
  const [factFilter, setFactFilter] = useState<'all' | 'pending' | 'confirmed' | 'conflict' | 'gap'>('all');
  const [materialFilter, setMaterialFilter] = useState<string>('all');

  // Calculate counts dynamically from task.facts
  const totalFactsCount = task.facts.length;
  const confirmedFactsCount = task.facts.filter((f) => f.status === 'confirmed').length;
  const pendingConflictsCount = task.facts.filter((f) => f.hasConflict && !f.selectedConflictValue && f.status !== 'excluded').length;
  const gapsCount = task.facts.filter((f) => f.status === 'gap').length;

  const handleOpenConflictModal = (fact: Fact) => {
    setResolvingFact(fact);
    // CRITICAL: Do NOT pre-select greater value, do NOT pre-fill canned reason
    setConflictChoice(fact.selectedConflictValue || (fact.status === 'excluded' ? 'exclude' : ''));
    setConflictReason(fact.conflictResolutionReason || '');
  };

  const handleResolveConflict = () => {
    if (!resolvingFact || !conflictChoice) return;

    const updatedFacts = task.facts.map((f) => {
      if (f.id === resolvingFact.id) {
        if (conflictChoice === 'exclude') {
          return {
            ...f,
            status: 'excluded' as const,
            selectedConflictValue: undefined,
            conflictResolutionReason: conflictReason.trim() || '主笔明确排除该冲突指标，不作为本期成效写入正文',
          };
        } else {
          // Find matching candidate to update primaryEvidenceId to the candidate's exact evidenceId!
          const matchedCand = resolvingFact.conflictCandidates?.find((c) => c.value === conflictChoice);
          return {
            ...f,
            status: 'confirmed' as const,
            value: conflictChoice,
            selectedConflictValue: conflictChoice,
            primaryEvidenceId: matchedCand ? matchedCand.evidenceId : f.primaryEvidenceId,
            conflictResolutionReason: conflictReason.trim() || `主笔采信${conflictChoice}${f.unit}口径`,
          };
        }
      }
      return f;
    });

    onUpdateTask({
      facts: updatedFacts,
      // If fact changed, invalidate previous snapshots
      factSnapshot: undefined,
      outlineConfirmed: false,
      outlineSnapshot: undefined,
    });

    setResolvingFact(null);
  };

  const handleToggleFactStatus = (factId: string, currentStatus: string) => {
    const targetFact = task.facts.find((f) => f.id === factId);
    if (!targetFact) return;
    if (targetFact.isHistoricOnly) {
      alert('历史定稿事实严格隔离为文风参考，严禁带入本期事实清单。');
      return;
    }
    if (targetFact.status === 'gap' || targetFact.primaryEvidenceId === 'EVD-06' || targetFact.metricScope?.includes('仅作为线索')) {
      alert('仅有定性检索线索，缺少原文依据与量化数据，不可直接确认为事实。');
      return;
    }

    const updatedFacts = task.facts.map((f) => {
      if (f.id === factId) {
        const nextStatus = currentStatus === 'confirmed' ? ('pending' as const) : ('confirmed' as const);
        return { ...f, status: nextStatus };
      }
      return f;
    });

    // Invalidate downstream snapshots when fact is toggled
    onUpdateTask({
      facts: updatedFacts,
      factSnapshot: undefined,
      outlineConfirmed: false,
      outlineSnapshot: undefined,
    });
  };

  const handleConfirmAllFacts = () => {
    if (pendingConflictsCount > 0) {
      alert('存在未裁决的同口径事实冲突（如120项 vs 128项）。请先裁决采信口径或明确排除后，再确认本次事实清单。');
      return;
    }

    const confirmedFacts = task.facts.filter((f) => f.status === 'confirmed' && !f.isHistoricOnly);

    const snapshotItems = confirmedFacts.map((f) => ({
      factId: f.id,
      metric: f.metric,
      value: f.value,
      unit: f.unit,
      period: f.period,
      metricScope: f.metricScope,
      primaryEvidenceId: f.primaryEvidenceId,
      selectedConflictValue: f.selectedConflictValue,
      conflictResolutionReason: f.conflictResolutionReason,
    }));

    const snapshot = {
      confirmedAt: new Date().toISOString(),
      factIds: confirmedFacts.map((f) => f.id),
      items: snapshotItems,
      hash: `SNAP-${Date.now().toString(36)}`,
    };

    onUpdateTask({
      factSnapshot: snapshot,
      status: task.status === '草稿' ? '事实待确认' : task.status,
    });
  };

  const handleRunRag = async () => {
    setIsRagLoading(true);
    setRagError(null);
    setRagResult(null);

    try {
      const res = await queryMockRag(ragQuery, ragScenario);
      setRagResult(res);
    } catch (err: any) {
      setRagError(err.message || '检索发生异常');
    } finally {
      setIsRagLoading(false);
    }
  };

  const handleCreateSupplementFact = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFactMetric.trim() || !newFactValue.trim()) return;

    const newFact: Fact = {
      id: `FACT-SUPP-${Date.now().toString(36)}`,
      metric: newFactMetric.trim(),
      period: task.startDate.slice(0, 4) + '年1至9月',
      value: newFactValue.trim(),
      unit: newFactUnit.trim(),
      metricScope: newFactScope.trim() || '主笔手工补充业务台账',
      primaryEvidenceId: 'EVD-SUPP',
      evidenceIds: [],
      hasConflict: false,
      status: 'confirmed',
      isAuthorSupplemented: true,
      supplementNotes: newFactNotes.trim() || '主笔结合部门内部沟通记录核实补充',
    };

    onUpdateTask({
      facts: [...task.facts, newFact],
      factSnapshot: undefined,
    });

    setShowAddFactModal(false);
    setNewFactMetric('');
    setNewFactValue('');
    setNewFactUnit('');
    setNewFactScope('');
    setNewFactNotes('');
  };

  const handleAddMaterialSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!matName.trim()) return;

    const isSimulatedDocx = matFileType === 'docx' || matFileType === 'pdf';
    const newDocId = `SRC-${Date.now().toString(36).toUpperCase()}`;

    // Generate stable snippet IDs from text paragraphs if TXT or pasted
    let newSnippets: EvidenceSnippet[] = [];
    if (!isSimulatedDocx && matContent.trim()) {
      const paragraphs = matContent
        .split(/\n+/)
        .map((p) => p.trim())
        .filter(Boolean);

      newSnippets = paragraphs.map((p, idx) => ({
        id: `EVD-${newDocId}-${idx + 1}`,
        sourceDocId: newDocId,
        docName: matName.trim(),
        location: `第${idx + 1}段`,
        period: matPeriod.trim(),
        text: p,
      }));
    }

    const newDoc: SourceDocument = {
      id: newDocId,
      name: matName.trim(),
      source: matSource.trim(),
      period: matPeriod.trim(),
      usage: matUsage,
      fileType: matFileType,
      parseStatus: isSimulatedDocx ? 'pending_parser' : 'parsed',
      content: isSimulatedDocx
        ? `【元数据记录】文件名称：${matName}（${matFileType.toUpperCase()}格式）。状态：待接入内网文档解析服务，当前未提取文本内容。`
        : matContent.trim() || '（无正文内容）',
      paragraphCount: isSimulatedDocx ? 0 : newSnippets.length || 1,
      wordCount: isSimulatedDocx ? 0 : matContent.length,
    };

    onUpdateTask({
      documents: [...task.documents, newDoc],
      snippets: [...task.snippets, ...newSnippets],
    });

    setShowAddMaterialModal(false);
    setMatName('');
    setMatContent('');
  };

  const handleCreateFactFromSnippetSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!snippetForFact || !snipFactMetric.trim() || !snipFactValue.trim()) return;

    const newFact: Fact = {
      id: `FACT-EVD-${Date.now().toString(36).toUpperCase()}`,
      metric: snipFactMetric.trim(),
      period: snipFactPeriod.trim() || snippetForFact.period || task.startDate.slice(0, 4) + '年1至9月',
      value: snipFactValue.trim(),
      unit: snipFactUnit.trim(),
      metricScope: snipFactScope.trim() || `${snippetForFact.docName}原文记载`,
      primaryEvidenceId: snippetForFact.id,
      evidenceIds: [snippetForFact.id],
      hasConflict: false,
      status: 'pending', // Created as pending, awaiting author explicit confirmation
    };

    onUpdateTask({
      facts: [...task.facts, newFact],
      factSnapshot: undefined,
      outlineConfirmed: false,
      outlineSnapshot: undefined,
    });

    setSnippetForFact(null);
    setSnipFactMetric('');
    setSnipFactPeriod('');
    setSnipFactValue('');
    setSnipFactUnit('');
    setSnipFactScope('');
  };

  return (
    <div className="space-y-6">
      {/* Top Banner: Stage Summary & Actions */}
      <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
              <Database className="w-5 h-5 text-blue-700" />
              阶段02：单位材料整合与事实依据确认
            </h2>
            {task.factSnapshot ? (
              <span className="text-xs bg-emerald-100 text-emerald-800 border border-emerald-200 px-2 py-0.5 rounded flex items-center gap-1 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" /> 事实清单已确认
              </span>
            ) : (
              <span className="text-xs bg-amber-100 text-amber-800 border border-amber-200 px-2 py-0.5 rounded flex items-center gap-1 font-medium">
                <Clock className="w-3.5 h-3.5" /> 待主笔核验确认
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-1">
            将单位材料、科室汇报与RAG检索线索沉淀为结构化事实。严格比对统计口径与时间区间，隔离历史年份，裁决指标冲突。
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleConfirmAllFacts}
            disabled={pendingConflictsCount > 0}
            className={`px-4 py-2 rounded text-xs font-semibold shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer ${
              pendingConflictsCount > 0
                ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                : 'bg-emerald-700 hover:bg-emerald-800 text-white'
            }`}
            title={pendingConflictsCount > 0 ? '请先裁决所有同口径冲突指标' : '确认当前事实清单，锁定依据'}
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>确认本次事实清单</span>
          </button>

          <button
            onClick={onProceedToNextStage}
            className="px-4 py-2 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold shadow-xs transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <span>下一步：文风与大纲</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Tabs navigation: 事实清单 | 单位材料库 | 模拟知识库RAG */}
      <div className="flex border-b border-slate-200 bg-white rounded-t-lg px-4 pt-2">
        <button
          onClick={() => setActiveTab('facts')}
          className={`py-2.5 px-4 text-xs font-semibold border-b-2 flex items-center gap-2 cursor-pointer transition-colors ${
            activeTab === 'facts'
              ? 'border-blue-700 text-blue-800'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <span>结构化事实清单</span>
          <span className="bg-slate-100 text-slate-700 text-[10px] px-1.5 py-0.2 rounded font-mono">
            {confirmedFactsCount}/{totalFactsCount}已确认
          </span>
          {pendingConflictsCount > 0 && (
            <span className="bg-amber-100 text-amber-800 text-[10px] px-1.5 py-0.2 rounded font-medium">
              {pendingConflictsCount}冲突待裁决
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('materials')}
          className={`py-2.5 px-4 text-xs font-semibold border-b-2 flex items-center gap-2 cursor-pointer transition-colors ${
            activeTab === 'materials'
              ? 'border-blue-700 text-blue-800'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <span>单位基础材料 ({task.documents.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('rag')}
          className={`py-2.5 px-4 text-xs font-semibold border-b-2 flex items-center gap-2 cursor-pointer transition-colors ${
            activeTab === 'rag'
              ? 'border-blue-700 text-blue-800'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <span className="flex items-center gap-1">
            <Search className="w-3.5 h-3.5 text-blue-600" />
            模拟知识库RAG检索
          </span>
        </button>
      </div>

      {/* TAB 1: 事实清单 */}
      {activeTab === 'facts' && (
        <div className="bg-white rounded-b-lg border border-slate-200 border-t-0 p-5 shadow-2xs space-y-4">
          {/* Status Metric Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 p-3 rounded-lg border border-slate-200 text-xs">
            <div>
              <span className="text-slate-500">已纳入事实候选</span>
              <div className="text-base font-bold text-slate-800 mt-0.5">{totalFactsCount} 项</div>
            </div>
            <div>
              <span className="text-slate-500">已确认事实依据</span>
              <div className="text-base font-bold text-emerald-700 mt-0.5">{confirmedFactsCount} 项</div>
            </div>
            <div>
              <span className="text-slate-500">同口径冲突指标</span>
              <div className={`text-base font-bold mt-0.5 ${pendingConflictsCount > 0 ? 'text-amber-600' : 'text-slate-700'}`}>
                {pendingConflictsCount} 项待裁决
              </div>
            </div>
            <div>
              <span className="text-slate-500">资料与数据缺口</span>
              <div className="text-base font-bold text-blue-700 mt-0.5">{gapsCount} 项待补充</div>
            </div>
          </div>

          {/* Conflict Highlight Banner if conflict pending */}
          {pendingConflictsCount > 0 && (
            <div className="p-4 bg-amber-50 border-l-4 border-amber-500 rounded-r text-xs text-amber-900 space-y-2">
              <div className="flex items-center gap-2 font-bold text-amber-900">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                <span>发现同指标口径冲突：重点任务完成数 (120项 vs 128项)</span>
              </div>
              <p className="text-amber-800">
                科室甲材料申报完成120项，科室乙汇总口径记载完成128项（统计范围相同）。系统不会随意取大值或平均值，必须由主笔人工裁决采纳口径或明确排除。
              </p>
              <button
                onClick={() => {
                  const conflictFact = task.facts.find((f) => f.hasConflict);
                  if (conflictFact) setResolvingFact(conflictFact);
                }}
                className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded text-xs font-semibold shadow-xs transition-colors cursor-pointer"
              >
                立即裁决此冲突
              </button>
            </div>
          )}

          {/* Action Row & Filter */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 pt-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">筛选状态:</span>
              <select
                value={factFilter}
                onChange={(e) => setFactFilter(e.target.value as any)}
                className="text-xs border border-slate-300 rounded px-2 py-1 bg-white text-slate-700"
              >
                <option value="all">全部事实 ({totalFactsCount})</option>
                <option value="confirmed">已确认 ({confirmedFactsCount})</option>
                <option value="pending">待确认</option>
                <option value="conflict">存在冲突 ({pendingConflictsCount})</option>
                <option value="gap">资料缺口 ({gapsCount})</option>
              </select>
            </div>

            <button
              onClick={() => setShowAddFactModal(true)}
              className="inline-flex items-center gap-1 px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-white rounded text-xs font-medium cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>主笔补充事实</span>
            </button>
          </div>

          {/* Facts Table */}
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-left text-xs divide-y divide-slate-200">
              <thead className="bg-slate-50 text-slate-700 font-semibold">
                <tr>
                  <th className="py-2.5 px-3">指标 / 事实描述</th>
                  <th className="py-2.5 px-3">统计期间</th>
                  <th className="py-2.5 px-3">数值与单位</th>
                  <th className="py-2.5 px-3">统计口径与说明</th>
                  <th className="py-2.5 px-3">原始依据</th>
                  <th className="py-2.5 px-3">状态</th>
                  <th className="py-2.5 px-3 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {task.facts
                  .filter((f) => {
                    if (factFilter === 'confirmed') return f.status === 'confirmed';
                    if (factFilter === 'pending') return f.status === 'pending';
                    if (factFilter === 'conflict') return f.hasConflict;
                    if (factFilter === 'gap') return f.status === 'gap';
                    return true;
                  })
                  .map((fact) => {
                    const snippet = task.snippets.find((s) => s.id === fact.primaryEvidenceId);

                    return (
                      <tr key={fact.id} className="hover:bg-slate-50/70 transition-colors">
                        <td className="py-2.5 px-3 font-medium text-slate-800">
                          <div className="flex items-center gap-1.5">
                            <span>{fact.metric}</span>
                            {fact.isAuthorSupplemented && (
                              <span className="text-[10px] bg-purple-100 text-purple-700 px-1 rounded">
                                主笔补充
                              </span>
                            )}
                            {fact.isHistoricOnly && (
                              <span className="text-[10px] bg-slate-200 text-slate-600 px-1 rounded">
                                历史隔离
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="py-2.5 px-3 text-slate-600 whitespace-nowrap">{fact.period}</td>

                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {fact.hasConflict && !fact.selectedConflictValue ? (
                            <span className="text-amber-700 font-bold bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">
                              {fact.value}
                            </span>
                          ) : (
                            <span className="font-semibold text-slate-900">
                              {fact.value} {fact.unit}
                            </span>
                          )}
                        </td>

                        <td className="py-2.5 px-3 text-slate-600 max-w-xs truncate" title={fact.metricScope}>
                          {fact.metricScope}
                          {fact.conflictResolutionReason && (
                            <p className="text-[10px] text-emerald-700 mt-0.5 font-medium">
                              裁决理由：{fact.conflictResolutionReason}
                            </p>
                          )}
                        </td>

                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {snippet ? (
                            <button
                              onClick={() => onViewSnippet(snippet)}
                              className="text-blue-700 hover:text-blue-900 underline flex items-center gap-1 cursor-pointer font-medium"
                              title="点击查看原文位置与段落上下文"
                            >
                              <span>{snippet.id} ({snippet.location})</span>
                              <ExternalLink className="w-3 h-3" />
                            </button>
                          ) : fact.isAuthorSupplemented ? (
                            <span className="text-slate-400">主笔核验备注</span>
                          ) : (
                            <span className="text-amber-600">待补充原文出处</span>
                          )}
                        </td>

                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {fact.status === 'confirmed' ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-800 bg-emerald-100 px-1.5 py-0.5 rounded font-medium">
                              <CheckCircle2 className="w-3 h-3" /> 已确认
                            </span>
                          ) : fact.status === 'gap' ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-blue-800 bg-blue-100 px-1.5 py-0.5 rounded font-medium">
                              <HelpCircle className="w-3 h-3" /> 待补材料
                            </span>
                          ) : fact.status === 'excluded' ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">
                              <XCircle className="w-3 h-3" /> 已排除
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded font-medium">
                              <AlertTriangle className="w-3 h-3" /> 待裁决确认
                            </span>
                          )}
                        </td>

                        <td className="py-2.5 px-3 text-right whitespace-nowrap">
                          {fact.isHistoricOnly ? (
                            <span
                              className="text-[11px] text-slate-400 bg-slate-100 px-2 py-0.5 rounded cursor-not-allowed select-none"
                              title="历史定稿数据严格隔离为文风参考，严禁带入本期事实清单"
                            >
                              历史隔离（严禁确认）
                            </span>
                          ) : fact.hasConflict ? (
                            <button
                              onClick={() => handleOpenConflictModal(fact)}
                              className="text-amber-700 hover:text-amber-900 font-semibold px-2 py-0.5 rounded bg-amber-50 hover:bg-amber-100 border border-amber-200 cursor-pointer"
                            >
                              裁决冲突
                            </button>
                          ) : fact.status === 'gap' ? (
                            <span
                              className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded cursor-not-allowed select-none"
                              title="仅有定性检索线索，缺少原文出处与量化数据，不可直接确认为事实"
                            >
                              线索待核（严禁确认）
                            </span>
                          ) : (
                            <button
                              onClick={() => handleToggleFactStatus(fact.id, fact.status)}
                              className={`text-[11px] font-medium px-2 py-0.5 rounded cursor-pointer ${
                                fact.status === 'confirmed'
                                  ? 'text-slate-600 hover:text-slate-800 bg-slate-100'
                                  : 'text-emerald-700 hover:text-emerald-900 bg-emerald-50 border border-emerald-200'
                              }`}
                            >
                              {fact.status === 'confirmed' ? '撤销为待定' : '确认采纳'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: 单位基础材料 */}
      {activeTab === 'materials' && (
        <div className="bg-white rounded-b-lg border border-slate-200 border-t-0 p-5 shadow-2xs space-y-4">
          <div className="flex justify-between items-center">
            <div>
              <h3 className="text-xs font-bold text-slate-800">已登记单位材料清单</h3>
              <p className="text-[11px] text-slate-500">
                支持TXT与纯文本解析；DOCX/PDF记录元数据并标记“待接入解析”。
              </p>
            </div>
            <button
              onClick={() => setShowAddMaterialModal(true)}
              className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>上传/登记材料</span>
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {task.documents.map((doc) => {
              const usageLabel = {
                current_fact: '本期事实候选',
                history_bg: '历史背景',
                style_ref: '文风参考（旧年份隔离）',
                rag_clue: '检索线索',
              }[doc.usage];

              return (
                <div
                  key={doc.id}
                  className="p-4 border border-slate-200 rounded-lg hover:border-blue-300 transition-colors flex flex-col justify-between space-y-3 bg-slate-50/50"
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <FileText className="w-4 h-4 text-blue-700" />
                        <span className="font-bold text-xs text-slate-800">{doc.name}</span>
                      </div>
                      <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-slate-200 text-slate-700">
                        {doc.id}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
                      <span>来源：{doc.source}</span>
                      <span>期间：{doc.period}</span>
                      <span
                        className={`px-1.5 py-0.2 rounded font-medium ${
                          doc.usage === 'current_fact'
                            ? 'bg-emerald-100 text-emerald-800'
                            : doc.usage === 'style_ref'
                            ? 'bg-purple-100 text-purple-800'
                            : 'bg-blue-100 text-blue-800'
                        }`}
                      >
                        {usageLabel}
                      </span>
                    </div>

                    <div className="mt-2 text-xs text-slate-600 line-clamp-2 bg-white p-2 rounded border border-slate-200/60 font-mono">
                      {doc.content}
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-200 flex items-center justify-between text-xs">
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        doc.parseStatus === 'parsed'
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : 'bg-amber-50 text-amber-700 border border-amber-200'
                      }`}
                    >
                      {doc.parseStatus === 'parsed' ? '已完成文本解析' : '待接入内网解析'}
                    </span>

                    <button
                      onClick={() => {
                        const snippet = task.snippets.find((s) => s.sourceDocId === doc.id);
                        if (snippet) {
                          onViewSnippet(snippet);
                        } else {
                          onViewSnippet({
                            id: `EVD-FULL-${doc.id}`,
                            sourceDocId: doc.id,
                            docName: doc.name,
                            location: '正文全文',
                            period: doc.period,
                            text: doc.content.slice(0, 150),
                          });
                        }
                      }}
                      className="text-blue-700 hover:text-blue-900 font-medium flex items-center gap-1 cursor-pointer"
                    >
                      <span>查看原文与依据</span>
                      <ExternalLink className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 3: 模拟知识库RAG检索 */}
      {activeTab === 'rag' && (
        <div className="bg-white rounded-b-lg border border-slate-200 border-t-0 p-5 shadow-2xs space-y-4">
          <div className="bg-blue-50/70 p-4 rounded-lg border border-blue-200 space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-blue-900 flex items-center gap-1.5">
                <Search className="w-4 h-4 text-blue-700" />
                内网知识库RAG模拟检索调试台
              </h3>
              <span className="text-[11px] bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                类型化接口隔离 · 5种场景模拟
              </span>
            </div>
            <p className="text-xs text-blue-800">
              用于验证原型对不同接口返回情况的容错性：包括正常命中、仅有答案无原文、无结果、超时异常及权限拦截。
            </p>

            <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
              <span className="font-semibold text-slate-700">切换模拟场景：</span>
              {(
                [
                  ['normal', '1. 正常命中原文'],
                  ['clue_only', '2. 仅有生成答案 (CLUE-01)'],
                  ['empty', '3. 无检索结果'],
                  ['timeout', '4. 响应超时 (504)'],
                  ['permission_denied', '5. 无密级权限 (403)'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setRagScenario(key)}
                  className={`px-2.5 py-1 rounded transition-colors cursor-pointer text-xs ${
                    ragScenario === key
                      ? 'bg-blue-700 text-white font-semibold'
                      : 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-100'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Search Box */}
          <div className="flex gap-2">
            <input
              type="text"
              value={ragQuery}
              onChange={(e) => setRagQuery(e.target.value)}
              placeholder="输入待检索单位公文问题..."
              className="flex-1 text-xs p-2.5 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:outline-hidden"
            />
            <button
              onClick={handleRunRag}
              disabled={isRagLoading}
              className="px-5 py-2.5 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold shadow-xs flex items-center gap-1.5 cursor-pointer disabled:opacity-60"
            >
              {isRagLoading ? (
                <span>检索中...</span>
              ) : (
                <>
                  <Search className="w-3.5 h-3.5" />
                  <span>执行检索</span>
                </>
              )}
            </button>
          </div>

          {/* Error Message */}
          {ragError && (
            <div className="p-4 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold">检索失败异常提示：</p>
                <p className="mt-0.5">{ragError}</p>
                <button
                  onClick={handleRunRag}
                  className="mt-2 text-xs font-semibold text-rose-700 underline cursor-pointer"
                >
                  点击重试检索
                </button>
              </div>
            </div>
          )}

          {/* Results display */}
          {ragResult && (
            <div className="border border-slate-200 rounded-lg p-4 bg-slate-50 space-y-3">
              <div className="flex items-center justify-between text-xs font-bold text-slate-800">
                <span>检索返回结果 ({ragResult.snippets.length}条依据)</span>
                <span className="text-slate-500 font-normal">模式：{ragResult.scenario}</span>
              </div>

              {ragResult.scenario === 'empty' && (
                <div className="p-6 text-center text-slate-400 text-xs">
                  未在当前知识库中检索到与“{ragResult.query}”相关的已授权公文依据。
                </div>
              )}

              {ragResult.isClueOnly && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900 space-y-1">
                  <div className="font-bold flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                    【线索状态】仅返回总结答案，无原文段落出处
                  </div>
                  <p>{ragResult.clueOnlyAnswer}</p>
                  <p className="text-[11px] text-amber-700">
                    注：此条目仅作为线索展示，系统禁止自动生成虚构页码，也不会自动转换为已确认事实。
                  </p>
                </div>
              )}

              <div className="space-y-2">
                {ragResult.snippets.map((snip: EvidenceSnippet) => (
                  <div
                    key={snip.id}
                    className="p-3 bg-white border border-slate-200 rounded text-xs flex justify-between items-center"
                  >
                    <div>
                      <div className="font-semibold text-slate-800">{snip.text}</div>
                      <div className="text-[11px] text-slate-500 mt-1">
                        出处：{snip.docName} · {snip.location} ({snip.period})
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => onViewSnippet(snip)}
                        className="px-2 py-1 text-blue-700 hover:bg-blue-50 border border-blue-200 rounded text-xs font-medium cursor-pointer"
                      >
                        定位原文
                      </button>
                      {!ragResult.isClueOnly && (
                        <button
                          onClick={() => {
                            setSnippetForFact(snip);
                            setSnipFactMetric('');
                            setSnipFactPeriod(snip.period || '');
                            setSnipFactValue('');
                            setSnipFactUnit('');
                            setSnipFactScope(snip.docName);
                          }}
                          className="px-2 py-1 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-medium cursor-pointer shadow-2xs"
                        >
                          + 建立事实候选
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Conflict Resolution Modal (120 vs 128) */}
      {resolvingFact && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-amber-50 flex items-center justify-between">
              <h3 className="font-bold text-sm text-amber-900 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                指标口径冲突处理：{resolvingFact.metric}
              </h3>
              <button
                onClick={() => setResolvingFact(null)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <div className="text-slate-600">
                系统检测到针对指标<strong>“{resolvingFact.metric}”</strong>存在两个不同来源的申报数值，且统计范围相同。系统不会随意取大值或平均值，请主笔对比原文后明确采信项：
              </div>

              {/* Side-by-Side Candidates with Raw Snippets */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {resolvingFact.conflictCandidates?.map((cand) => {
                  const isSelected = conflictChoice === cand.value;
                  const candSnippet = task.snippets.find((s) => s.id === cand.evidenceId);
                  const candDoc = task.documents.find((d) => d.id === cand.sourceDocId);

                  return (
                    <div
                      key={cand.value}
                      onClick={() => setConflictChoice(cand.value)}
                      className={`p-3.5 rounded-lg border cursor-pointer transition-all flex flex-col justify-between ${
                        isSelected
                          ? 'border-blue-700 bg-blue-50/70 shadow-xs ring-2 ring-blue-700'
                          : 'border-slate-200 hover:border-slate-300 bg-white'
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-slate-800">
                            {cand.description.split('：')[0]}
                          </span>
                          <span className="text-base font-extrabold text-blue-800 font-mono">
                            {cand.value} {resolvingFact.unit}
                          </span>
                        </div>
                        <p className="mt-1.5 text-slate-600 text-[11px] leading-relaxed">
                          {cand.description}
                        </p>

                        {/* Raw Original Snippet in Candidate Box */}
                        <div className="mt-2.5 p-2 bg-slate-50 border border-slate-200 rounded text-[11px] text-slate-700 font-mono space-y-1">
                          <span className="text-slate-400 font-semibold text-[10px] block">
                            【原文依据片段（{cand.evidenceId}）】
                          </span>
                          <p className="text-slate-800 font-medium italic">
                            “{candSnippet?.text || '（暂未关联原文片段）'}”
                          </p>
                          <span className="text-[10px] text-slate-500 block">
                            定位：{candDoc?.name || cand.sourceDocId} · {candSnippet?.location || ''}
                          </span>
                        </div>
                      </div>

                      <div className="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between text-[11px]">
                        <span className="text-slate-500">主出处将绑定为：</span>
                        <strong className="text-blue-700 font-mono">{cand.evidenceId}</strong>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Option to exclude */}
              <div
                onClick={() => setConflictChoice('exclude')}
                className={`p-3 rounded-lg border cursor-pointer transition-all ${
                  conflictChoice === 'exclude'
                    ? 'border-rose-600 bg-rose-50/70 shadow-xs ring-2 ring-rose-600'
                    : 'border-slate-200 hover:border-slate-300 bg-white'
                }`}
              >
                <div className="font-bold text-xs text-rose-800">排除该事实（不写入本期稿件）</div>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  若口径暂时无法核准，主笔可明确排除该指标，本次正文起草将不引用该数值。
                </p>
              </div>

              {/* Reason input */}
              <div className="space-y-1">
                <div className="flex justify-between items-center">
                  <label className="font-semibold text-slate-700">主笔裁决理由与口径依据记录：</label>
                  <span className="text-[10px] text-slate-400">（必填：由主笔人工核验并记录决策依据）</span>
                </div>
                <textarea
                  rows={2}
                  value={conflictReason}
                  onChange={(e) => setConflictReason(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-blue-500"
                  placeholder="在此输入主笔裁决采纳或排除该口径的具体业务依据..."
                  required
                />
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setResolvingFact(null)}
                  className="px-3 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleResolveConflict}
                  disabled={!conflictChoice || !conflictReason.trim()}
                  className="px-4 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded font-medium shadow-xs cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  确认采信并写入事实
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Manual Fact Modal */}
      {showAddFactModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="font-bold text-sm text-slate-800">主笔手工补充业务事实</h3>
              <button
                onClick={() => setShowAddFactModal(false)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <form onSubmit={handleCreateSupplementFact} className="p-5 space-y-3 text-xs">
              <div className="space-y-1">
                <label className="font-semibold text-slate-700">指标或事实名称</label>
                <input
                  type="text"
                  placeholder="例如：推进数字便民服务事项"
                  value={newFactMetric}
                  onChange={(e) => setNewFactMetric(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700">数值</label>
                  <input
                    type="text"
                    placeholder="例如：35"
                    value={newFactValue}
                    onChange={(e) => setNewFactValue(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700">单位</label>
                  <input
                    type="text"
                    placeholder="例如：个 / 项 / %"
                    value={newFactUnit}
                    onChange={(e) => setNewFactUnit(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">统计口径与说明</label>
                <input
                  type="text"
                  placeholder="说明业务统计范围"
                  value={newFactScope}
                  onChange={(e) => setNewFactScope(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">补充依据说明</label>
                <textarea
                  rows={2}
                  placeholder="注明经口头核实或部门提供台账出处"
                  value={newFactNotes}
                  onChange={(e) => setNewFactNotes(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddFactModal(false)}
                  className="px-3 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded font-medium shadow-xs cursor-pointer"
                >
                  保存补充事实
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Material Modal */}
      {showAddMaterialModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="font-bold text-sm text-slate-800">登记与上传单位材料</h3>
              <button
                onClick={() => setShowAddMaterialModal(false)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <form onSubmit={handleAddMaterialSubmit} className="p-5 space-y-3 text-xs">
              <div className="space-y-1">
                <label className="font-semibold text-slate-700">材料名称</label>
                <input
                  type="text"
                  placeholder="例如：信息中心前三季度信息化建设报告"
                  value={matName}
                  onChange={(e) => setMatName(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700">材料提供科室</label>
                  <input
                    type="text"
                    value={matSource}
                    onChange={(e) => setMatSource(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700">统计期间</label>
                  <input
                    type="text"
                    value={matPeriod}
                    onChange={(e) => setMatPeriod(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700">材料用途</label>
                  <select
                    value={matUsage}
                    onChange={(e) => setMatUsage(e.target.value as any)}
                    className="w-full p-2 border border-slate-300 rounded bg-white focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="current_fact">本期事实候选</option>
                    <option value="history_bg">历史背景参考</option>
                    <option value="style_ref">文风参考（旧年份隔离）</option>
                    <option value="rag_clue">检索线索</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-semibold text-slate-700">文件格式</label>
                  <select
                    value={matFileType}
                    onChange={(e) => setMatFileType(e.target.value as any)}
                    className="w-full p-2 border border-slate-300 rounded bg-white focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="txt">纯文本 TXT (支持直接解析)</option>
                    <option value="pasted">直接粘贴文字 (支持直接解析)</option>
                    <option value="docx">Word DOCX (记录元数据/待接入解析)</option>
                    <option value="pdf">PDF (记录元数据/待接入解析)</option>
                  </select>
                </div>
              </div>

              {matFileType === 'docx' || matFileType === 'pdf' ? (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded text-amber-800 text-xs">
                  📌 提示：当前原型支持登记 DOCX 和 PDF 的元数据；文本内容需待接入生产环境解析服务，本轮可先粘贴文本或使用 TXT 文件。
                </div>
              ) : (
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700">材料文本内容</label>
                  <textarea
                    rows={4}
                    placeholder="在此粘贴文本或上传纯文本内容..."
                    value={matContent}
                    onChange={(e) => setMatContent(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              )}

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddMaterialModal(false)}
                  className="px-3 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded font-medium shadow-xs cursor-pointer"
                >
                  保存登记材料
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create Fact From Snippet Modal */}
      {snippetForFact && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-blue-50 flex items-center justify-between">
              <h3 className="font-bold text-sm text-blue-900 flex items-center gap-1.5">
                <Database className="w-4 h-4 text-blue-700" />
                基于材料片段建立事实候选
              </h3>
              <button
                onClick={() => setSnippetForFact(null)}
                className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
              >
                关闭
              </button>
            </div>

            <form onSubmit={handleCreateFactFromSnippetSubmit} className="p-5 space-y-3.5 text-xs">
              {/* Target Snippet Preview */}
              <div className="p-3 bg-slate-50 border border-slate-200 rounded text-xs space-y-1">
                <span className="text-[10px] text-slate-400 font-mono block">
                  依据来源：{snippetForFact.docName} ({snippetForFact.location}) · {snippetForFact.period}
                </span>
                <p className="font-medium text-slate-800 italic">“{snippetForFact.text}”</p>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">
                  提取指标 / 事实名称 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder="例如：组织专题培训 / 开展专项调研"
                  value={snipFactMetric}
                  onChange={(e) => setSnipFactMetric(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">统计期间</label>
                <input
                  type="text"
                  placeholder="例如：2026年1至9月 / 2027年二季度"
                  value={snipFactPeriod}
                  onChange={(e) => setSnipFactPeriod(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700">
                    数值 <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    placeholder="例如：25 / 120"
                    value={snipFactValue}
                    onChange={(e) => setSnipFactValue(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 font-mono"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700">计量单位</label>
                  <input
                    type="text"
                    placeholder="例如：场 / 项 / 人次 / 次"
                    value={snipFactUnit}
                    onChange={(e) => setSnipFactUnit(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">统计口径与说明</label>
                <input
                  type="text"
                  placeholder="例如：科室专项台账统计范围说明"
                  value={snipFactScope}
                  onChange={(e) => setSnipFactScope(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="p-2.5 bg-amber-50 border border-amber-200 rounded text-[11px] text-amber-800">
                提示：建立后该事实初始状态为“待确认”，需主笔在事实清单中人工核对确认后，方可纳入大纲与正文起草。
              </div>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setSnippetForFact(null)}
                  className="px-3 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded font-medium shadow-xs cursor-pointer"
                >
                  保存并加入事实清单
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
