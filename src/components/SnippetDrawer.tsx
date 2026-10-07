import React from 'react';
import { EvidenceSnippet, SourceDocument } from '../types';
import { X, FileText, Calendar, MapPin, Tag } from 'lucide-react';

interface SnippetDrawerProps {
  snippet: EvidenceSnippet | null;
  documents: SourceDocument[];
  onClose: () => void;
}

export const SnippetDrawer: React.FC<SnippetDrawerProps> = ({ snippet, documents, onClose }) => {
  if (!snippet) return null;

  const doc = documents.find((d) => d.id === snippet.sourceDocId);

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-slate-900/40 backdrop-blur-xs flex justify-end animate-in fade-in duration-200">
      <div className="w-full max-w-xl bg-white h-full shadow-2xl flex flex-col border-l border-slate-200">
        {/* Header */}
        <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center space-x-2">
            <FileText className="w-5 h-5 text-blue-700" />
            <div>
              <h3 className="font-semibold text-slate-800 text-base">原始材料出处追溯</h3>
              <p className="text-xs text-slate-500">依据标识：{snippet.id}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-colors cursor-pointer"
            title="关闭抽屉"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Snippet Details */}
        <div className="p-4 bg-blue-50/70 border-b border-blue-100">
          <div className="text-xs font-semibold uppercase tracking-wider text-blue-800 mb-1 flex items-center gap-1">
            <Tag className="w-3.5 h-3.5" /> 关联证据片段
          </div>
          <div className="p-3 bg-white border border-blue-200 rounded text-slate-800 text-sm font-medium leading-relaxed shadow-xs">
            {snippet.text}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-3 text-xs text-slate-600">
            <span className="flex items-center gap-1">
              <FileText className="w-3.5 h-3.5 text-slate-400" />
              文档：<strong className="text-slate-800">{snippet.docName}</strong>
            </span>
            <span className="flex items-center gap-1">
              <MapPin className="w-3.5 h-3.5 text-slate-400" />
              位置：<strong className="text-slate-800">{snippet.location}</strong>
            </span>
            <span className="flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5 text-slate-400" />
              期间：<strong className="text-slate-800">{snippet.period}</strong>
            </span>
          </div>
        </div>

        {/* Document Full Text Context */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-slate-700">材料上下文全文</h4>
            <span className="text-xs text-slate-400">
              {doc ? `来源：${doc.source} (${doc.period})` : '外部知识库检索摘要'}
            </span>
          </div>

          {doc ? (
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-md text-sm text-slate-700 leading-relaxed space-y-3 font-normal">
              {doc.content.split('\n\n').map((paragraph, idx) => {
                const isTarget = paragraph.includes(snippet.text) || (snippet.location && paragraph.startsWith(snippet.location.slice(0, 3)));
                return (
                  <p
                    key={idx}
                    className={`p-2 rounded transition-colors ${
                      isTarget
                        ? 'bg-amber-100/80 border-l-4 border-amber-500 text-slate-900 font-medium'
                        : 'text-slate-600'
                    }`}
                  >
                    {paragraph}
                  </p>
                );
              })}
            </div>
          ) : (
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-md text-sm text-slate-600">
              {snippet.text}
            </div>
          )}

          <div className="mt-4 p-3 bg-slate-100 rounded text-xs text-slate-500 space-y-1">
            <p className="font-medium text-slate-700">📌 依据核验说明：</p>
            <p>1. 系统始终保留原始证据片段与文档位置索引，主笔采纳或补充不修改原始材料原文。</p>
            <p>2. 历史年份（如2025年）材料仅供文风与行文参考，不得作为本期（2026年）事实依据。</p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-slate-200 bg-slate-50 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-800 hover:bg-slate-900 text-white text-xs font-medium rounded transition-colors cursor-pointer"
          >
            关闭返回
          </button>
        </div>
      </div>
    </div>
  );
};
