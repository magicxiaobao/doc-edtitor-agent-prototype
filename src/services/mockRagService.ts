import { EvidenceSnippet } from '../types';

export type RagScenario = 'normal' | 'clue_only' | 'empty' | 'timeout' | 'permission_denied';

export interface RagQueryResult {
  success: boolean;
  scenario: RagScenario;
  query: string;
  errorMessage?: string;
  snippets: EvidenceSnippet[];
  clueOnlyAnswer?: string;
  isClueOnly?: boolean;
}

export async function queryMockRag(
  query: string,
  scenario: RagScenario,
  signal?: AbortSignal
): Promise<RagQueryResult> {
  // Simulate network delay
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 800);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('查询已被用户取消', 'AbortError'));
      });
    }
  });

  if (signal?.aborted) {
    throw new DOMException('查询已被用户取消', 'AbortError');
  }

  switch (scenario) {
    case 'timeout':
      throw new Error('RAG检索服务响应超时 (504 Gateway Timeout)，请检查内网连接或重试');

    case 'permission_denied':
      throw new Error('无当前知识库文档检索权限 (403 Forbidden)，请联系单位管理员开通密级访问');

    case 'empty':
      return {
        success: true,
        scenario: 'empty',
        query,
        snippets: [],
      };

    case 'clue_only':
      return {
        success: true,
        scenario: 'clue_only',
        query,
        isClueOnly: true,
        clueOnlyAnswer: '服务满意度明显提升。',
        snippets: [
          {
            id: 'CLUE-01',
            sourceDocId: 'CLUE-01',
            docName: '知识库RAG模型概括 (无原文具体段落)',
            location: '检索模型生成答案',
            period: '2026年度',
            text: '服务满意度明显提升。（提示：该答案为模型总结线索，暂无具体单位材料出处与量化百分比，不可直接确认为已核验事实）',
          },
        ],
      };

    case 'normal':
    default:
      return {
        success: true,
        scenario: 'normal',
        query,
        snippets: [
          {
            id: 'EVD-01',
            sourceDocId: 'SRC-01',
            docName: '科室甲前三季度工作情况',
            location: '第3段',
            period: '2026年1至9月',
            text: '2026年1至9月，累计完成重点任务120项。',
          },
          {
            id: 'EVD-02',
            sourceDocId: 'SRC-02',
            docName: '科室乙前三季度汇总',
            location: '第2段',
            period: '2026年1至9月',
            text: '2026年1至9月，累计完成重点任务128项。统计范围与科室甲材料相同。',
          },
          {
            id: 'EVD-03',
            sourceDocId: 'SRC-03',
            docName: '培训工作台账',
            location: '第5段',
            period: '2026年1至9月',
            text: '2026年1至9月，组织专题培训16场，累计参训800人次。',
          },
          {
            id: 'EVD-05',
            sourceDocId: 'SRC-05',
            docName: '专题调研情况汇报',
            location: '第2段',
            period: '2026年1至9月',
            text: '2026年1至9月，开展专题调研12次。',
          },
        ],
      };
  }
}
