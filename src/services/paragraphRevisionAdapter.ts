import { 
  Task, 
  ParagraphBlock, 
  DraftVersion, 
  RevisionAction, 
  RevisionSuggestion 
} from '../types';
import { generateParagraphRevision } from './mockDraftService';

export interface RevisionAsyncRequest {
  block: ParagraphBlock;
  action: RevisionAction;
  customPrompt?: string;
  task: Task;
  currentDraft?: DraftVersion;
  runId: string;
  signal?: AbortSignal;
  simulateFailure?: boolean;
  delayMs?: number;
}

/**
 * Asynchronous adapter wrapping the deterministic local mock revision generator.
 * Provides cancellable asynchronous lifecycle simulation, simulated failure/retry,
 * and maintains task/block boundaries.
 */
export async function requestParagraphRevisionAsync(
  req: RevisionAsyncRequest
): Promise<RevisionSuggestion> {
  const {
    block,
    action,
    customPrompt,
    task,
    currentDraft,
    runId,
    signal,
    simulateFailure = false,
    delayMs = 350,
  } = req;

  // Immediate check if already aborted
  if (signal?.aborted) {
    throw new DOMException('生成请求已取消', 'AbortError');
  }

  // Simulate network/AI generation delay
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal?.aborted) {
        reject(new DOMException('生成请求已取消', 'AbortError'));
      } else {
        resolve();
      }
    }, delayMs);

    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('生成请求已取消', 'AbortError'));
        },
        { once: true }
      );
    }
  });

  if (simulateFailure) {
    throw new Error('模拟接口调用失败：服务临时繁忙或连接超时，请点击重试。');
  }

  // Deterministically generate revision
  const suggestion = generateParagraphRevision(
    block,
    action,
    task.id,
    currentDraft?.id,
    runId,
    {
      customPrompt,
      task,
      currentDraft,
    }
  );

  return suggestion;
}
