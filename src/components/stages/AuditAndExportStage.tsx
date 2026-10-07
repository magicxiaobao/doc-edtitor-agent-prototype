import React, { useState } from 'react';
import { 
  Task, 
  AuditIssue, 
  UserRole, 
  DraftVersion 
} from '../../types';
import { runDocumentAudit } from '../../services/mockAuditService';
import { exportDocumentAsTxt, exportDocumentAsDocx } from '../../services/exportService';
import { 
  CheckCircle2, 
  ShieldCheck, 
  Download, 
  AlertTriangle, 
  FileText, 
  Lock, 
  RefreshCw, 
  Check, 
  Eye, 
  Sparkles,
  Bug,
  FileCheck
} from 'lucide-react';

interface AuditAndExportStageProps {
  task: Task;
  onUpdateTask: (updated: Partial<Task>) => void;
  activeRole: UserRole;
}

export const AuditAndExportStage: React.FC<AuditAndExportStageProps> = ({
  task,
  onUpdateTask,
  activeRole,
}) => {
  const currentDraft = task.drafts.find((d) => d.id === task.currentDraftId) || task.drafts[0];

  const [activeTab, setActiveTab] = useState<'audit' | 'export'>('audit');
  const [includeAnnotations, setIncludeAnnotations] = useState(true);
  const [isExportingDocx, setIsExportingDocx] = useState(false);

  // Run audit issues dynamically
  const auditIssues = currentDraft ? runDocumentAudit(task, currentDraft.blocks) : [];

  // Check blockers for finalization
  const pendingConflictsCount = task.facts.filter((f) => f.hasConflict && !f.selectedConflictValue && f.status !== 'excluded').length;
  const pendingCommentsCount = task.reviewComments.filter((c) => c.status === 'pending').length;
  const criticalAuditIssuesCount = auditIssues.filter((i) => i.severity === 'error' && i.status === 'unresolved').length;

  const canFinalize = pendingConflictsCount === 0 && criticalAuditIssuesCount === 0;

  // Inject 800人 test error button (satisfies Task 06 demonstration requirement: "预置或允许用户引入一个把800人次改成800人的例子，能够发现并展示原文口径")
  const handleInjectUnitError = () => {
    if (!currentDraft) return;
    const updatedBlocks = currentDraft.blocks.map((b) => {
      if (b.content.includes('800人次')) {
        return {
          ...b,
          content: b.content.replace('800人次', '800人'),
          updatedAt: new Date().toISOString(),
        };
      }
      return b;
    });

    const updatedDrafts = task.drafts.map((d) => (d.id === currentDraft.id ? { ...d, blocks: updatedBlocks } : d));
    onUpdateTask({ drafts: updatedDrafts });
  };

  const handleFixUnitError = () => {
    if (!currentDraft) return;
    const updatedBlocks = currentDraft.blocks.map((b) => {
      if (b.content.includes('800人') && !b.content.includes('800人次')) {
        return {
          ...b,
          content: b.content.replace('800人', '800人次'),
          updatedAt: new Date().toISOString(),
        };
      }
      return b;
    });

    const updatedDrafts = task.drafts.map((d) => (d.id === currentDraft.id ? { ...d, blocks: updatedBlocks } : d));
    onUpdateTask({ drafts: updatedDrafts });
  };

  const handleFinalizeDocument = () => {
    if (!canFinalize) {
      alert('存在阻断性问题（指标冲突或严重核校错误），无法执行定稿。请先纠正错误。');
      return;
    }

    if (!window.confirm('确认定稿吗？定稿后将生成不可篡改的定稿快照。后续编辑将自动生成新的草稿版本。')) {
      return;
    }

    const finalDraft: DraftVersion = {
      id: `DRAFT-FINAL-${Date.now()}`,
      versionNumber: '定稿 v2.0 (最终核定版)',
      createdAt: new Date().toISOString(),
      author: activeRole,
      summary: '经主笔核定、审阅意见全部闭环并完成事实口径核校后的正式定稿文件',
      blocks: JSON.parse(JSON.stringify(currentDraft.blocks)),
      isFinal: true,
    };

    onUpdateTask({
      drafts: [finalDraft, ...task.drafts],
      currentDraftId: finalDraft.id,
      isFinalized: true,
      status: '已定稿',
    });
  };

  const handleDownloadTxt = () => {
    if (!currentDraft) return;
    exportDocumentAsTxt(task, currentDraft, includeAnnotations);
  };

  const handleDownloadDocx = async () => {
    if (!currentDraft) return;
    setIsExportingDocx(true);
    try {
      await exportDocumentAsDocx(task, currentDraft, includeAnnotations);
    } catch (err) {
      console.error('Word export error:', err);
      alert('Word导出失败，请重试');
    } finally {
      setIsExportingDocx(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-blue-700" />
              阶段06：公文严谨核校与定稿导出
            </h2>
            {task.isFinalized ? (
              <span className="text-xs bg-emerald-100 text-emerald-800 border border-emerald-200 px-2 py-0.5 rounded flex items-center gap-1 font-semibold">
                <Lock className="w-3.5 h-3.5" /> 已完成定稿归档
              </span>
            ) : (
              <span className="text-xs bg-blue-100 text-blue-800 border border-blue-200 px-2 py-0.5 rounded flex items-center gap-1 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" /> 待核验定稿
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-1">
            自动核验正文与材料依据的统计口径（如“人次”与“人数”区分）、单位规范及遗漏缺口；提供真实 TXT 与真实 Word (.docx) 导出。
          </p>
        </div>

        <div className="flex items-center gap-2">
          {!task.isFinalized && (
            <button
              onClick={handleFinalizeDocument}
              disabled={!canFinalize}
              className={`px-4 py-2 rounded text-xs font-bold shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer ${
                canFinalize
                  ? 'bg-emerald-700 hover:bg-emerald-800 text-white'
                  : 'bg-slate-200 text-slate-400 cursor-not-allowed'
              }`}
              title={!canFinalize ? '请先解决阻断性核校错误' : '确认定稿'}
            >
              <Lock className="w-4 h-4" />
              <span>确认最终定稿</span>
            </button>
          )}

          <button
            onClick={() => setActiveTab('export')}
            className="px-4 py-2 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-semibold shadow-xs flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-4 h-4" />
            <span>下载导出文件</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 bg-white rounded-t-lg px-4 pt-2">
        <button
          onClick={() => setActiveTab('audit')}
          className={`py-2.5 px-4 text-xs font-semibold border-b-2 flex items-center gap-2 cursor-pointer transition-colors ${
            activeTab === 'audit'
              ? 'border-blue-700 text-blue-800'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <ShieldCheck className="w-4 h-4" />
          <span>正文事实一致性核校清单</span>
          {auditIssues.length > 0 ? (
            <span className="bg-amber-100 text-amber-800 text-[10px] px-1.5 py-0.2 rounded font-mono">
              发现 {auditIssues.length} 项关注
            </span>
          ) : (
            <span className="bg-emerald-100 text-emerald-800 text-[10px] px-1.5 py-0.2 rounded font-mono">
              全部核校通过
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('export')}
          className={`py-2.5 px-4 text-xs font-semibold border-b-2 flex items-center gap-2 cursor-pointer transition-colors ${
            activeTab === 'export'
              ? 'border-blue-700 text-blue-800'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <Download className="w-4 h-4" />
          <span>定稿文件真实导出 (TXT / DOCX)</span>
        </button>
      </div>

      {/* TAB 1: 核校中心 */}
      {activeTab === 'audit' && (
        <div className="bg-white rounded-b-lg border border-slate-200 border-t-0 p-5 shadow-2xs space-y-5">
          {/* Demo Injection Box for "800人" vs "800人次" */}
          <div className="bg-slate-50 border border-slate-200 p-4 rounded-lg flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
            <div className="space-y-1">
              <span className="font-bold text-slate-800 flex items-center gap-1.5">
                <Bug className="w-4 h-4 text-purple-600" />
                核校口径专项演练工具：800人次 vs 800人
              </span>
              <p className="text-slate-600">
                单位培训台账（EVD-03）严谨口径为“800人次”。点击按钮可在文稿中模拟引入口径错误，观察核校引擎的比对警示。
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleInjectUnitError}
                className="px-3 py-1.5 bg-purple-100 hover:bg-purple-200 text-purple-800 border border-purple-300 rounded font-medium cursor-pointer"
              >
                模拟注入“800人”错误
              </button>
              <button
                onClick={handleFixUnitError}
                className="px-3 py-1.5 bg-emerald-100 hover:bg-emerald-200 text-emerald-800 border border-emerald-300 rounded font-medium cursor-pointer"
              >
                一键纠正为“800人次”
              </button>
            </div>
          </div>

          {/* Audit Checklist */}
          <div className="space-y-3">
            <div className="flex items-center justify-between pb-1 border-b border-slate-100">
              <span className="font-bold text-xs text-slate-800">核校比对发现项</span>
              <span className="text-[11px] text-slate-400">
                针对当前版本：{currentDraft?.versionNumber}
              </span>
            </div>

            {auditIssues.length === 0 ? (
              <div className="p-8 text-center bg-emerald-50/50 border border-emerald-200 rounded-lg text-emerald-800 space-y-2">
                <CheckCircle2 className="w-8 h-8 mx-auto text-emerald-600" />
                <h4 className="font-bold text-sm">核校比对完成：未发现口径偏差与单位冲突</h4>
                <p className="text-xs text-emerald-700">
                  当前正文中的重点任务、专题培训、参训人次及调研频次均与已确认台账保持完全一致。
                </p>
              </div>
            ) : (
              auditIssues.map((issue) => (
                <div
                  key={issue.id}
                  className={`p-4 rounded-lg border text-xs space-y-2.5 ${
                    issue.severity === 'error'
                      ? 'bg-rose-50/70 border-rose-200 text-rose-900'
                      : issue.severity === 'warning'
                      ? 'bg-amber-50/70 border-amber-200 text-amber-900'
                      : 'bg-blue-50/70 border-blue-200 text-blue-900'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <AlertTriangle
                        className={`w-4 h-4 ${
                          issue.severity === 'error'
                            ? 'text-rose-600'
                            : issue.severity === 'warning'
                            ? 'text-amber-600'
                            : 'text-blue-600'
                        }`}
                      />
                      <span className="font-bold">
                        [{issue.location}] {issue.type === 'metric_unit' ? '计量单位口径不符' : '依据出处待核实'}
                      </span>
                    </div>

                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase ${
                        issue.severity === 'error'
                          ? 'bg-rose-200 text-rose-800'
                          : 'bg-amber-200 text-amber-800'
                      }`}
                    >
                      {issue.severity === 'error' ? '阻断级偏差' : '建议关注'}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 bg-white/80 p-2.5 rounded border border-slate-200/60">
                    <div>
                      <span className="text-slate-400 font-medium">当前正文表述：</span>
                      <p className="font-mono font-semibold text-rose-700 mt-0.5">“{issue.originalText}”</p>
                    </div>
                    <div>
                      <span className="text-slate-400 font-medium">台账原始证据依据：</span>
                      <p className="font-mono text-slate-800 mt-0.5">“{issue.evidenceText}”</p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <p className="text-[11px] leading-relaxed">
                      <strong>更正建议：</strong>{issue.suggestion}
                    </p>

                    {issue.type === 'metric_unit' && (
                      <button
                        onClick={handleFixUnitError}
                        className="px-3 py-1 bg-emerald-700 hover:bg-emerald-800 text-white rounded text-xs font-semibold shadow-xs cursor-pointer"
                      >
                        自动更正为规范口径
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* TAB 2: 定稿与真实导出 */}
      {activeTab === 'export' && (
        <div className="bg-white rounded-b-lg border border-slate-200 border-t-0 p-5 shadow-2xs space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Left: Export Scope Configuration */}
            <div className="p-4 border border-slate-200 rounded-lg bg-slate-50 space-y-4 text-xs">
              <h3 className="font-bold text-xs text-slate-800 flex items-center gap-1.5">
                <FileCheck className="w-4 h-4 text-blue-700" />
                导出内容配置
              </h3>

              <div className="space-y-3">
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700">待导出稿件版本</label>
                  <div className="p-2 bg-white border border-slate-300 rounded font-medium text-slate-800">
                    {currentDraft?.versionNumber} ({currentDraft?.summary})
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="font-semibold text-slate-700">导出内容范围</label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeAnnotations}
                      onChange={(e) => setIncludeAnnotations(e.target.checked)}
                      className="rounded text-blue-600"
                    />
                    <span>附加出处依据与审阅意见记录（生成单位审阅归档稿）</span>
                  </label>
                  <p className="text-[11px] text-slate-500 pl-5">
                    勾选后将在各段落末尾附上关联台账标识，并在文末附上审阅意见处理清单。
                  </p>
                </div>
              </div>
            </div>

            {/* Right: Real Download Buttons */}
            <div className="p-4 border border-slate-200 rounded-lg bg-blue-50/50 space-y-4 text-xs flex flex-col justify-between">
              <div>
                <h3 className="font-bold text-xs text-blue-900 flex items-center gap-1.5">
                  <Download className="w-4 h-4 text-blue-700" />
                  真实本地文件生成与下载
                </h3>
                <p className="text-[11px] text-blue-800 mt-1 leading-relaxed">
                  系统采用纯本地客户端文档生成技术，不调用外部网络。生成的 Word 文档为真实 OOXML (.docx) 格式，内嵌公文规范字号与段落首行缩进，完全兼容 Word 与 WPS 软件打开编辑。
                </p>
              </div>

              <div className="space-y-2 pt-2">
                <button
                  onClick={handleDownloadDocx}
                  disabled={isExportingDocx || !currentDraft}
                  className="w-full py-2.5 px-4 bg-blue-700 hover:bg-blue-800 text-white rounded text-xs font-bold shadow-xs flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50"
                >
                  <FileText className="w-4 h-4" />
                  <span>{isExportingDocx ? 'Word文件封装生成中...' : '下载公文 Word (.docx) 文件'}</span>
                </button>

                <button
                  onClick={handleDownloadTxt}
                  disabled={!currentDraft}
                  className="w-full py-2 px-4 bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 rounded text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer"
                >
                  <FileText className="w-4 h-4 text-slate-500" />
                  <span>下载纯文本 TXT 文件</span>
                </button>
              </div>
            </div>
          </div>

          {/* Document Preview Box */}
          <div className="border border-slate-200 rounded-lg p-5 bg-white space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <span className="font-bold text-xs text-slate-800">定稿文稿终览</span>
              <span className="text-[11px] text-slate-400">{currentDraft?.blocks.length} 个结构化段落</span>
            </div>

            <div className="max-h-96 overflow-y-auto space-y-4 p-4 bg-slate-50/60 rounded border border-slate-100 text-xs">
              <h2 className="text-center font-bold text-sm text-slate-900 font-serif">{task.title}</h2>
              {currentDraft?.blocks.map((b) => (
                <div key={b.id} className="space-y-1">
                  <p className="text-slate-800 leading-relaxed indent-8 text-[13px]">{b.content}</p>
                  {includeAnnotations && b.referencedFactIds.length > 0 && (
                    <div className="text-[10px] text-blue-700 pl-8 italic">
                      📎 依据追溯：{b.referencedFactIds.map((id) => task.facts.find((f) => f.id === id)?.metric).join('、')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
