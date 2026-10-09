// Unified types for 公文辅助协作原型
// Schema version 1.0

export type UserRole = '主笔甲' | '审阅乙' | '审阅丁' | '供稿丙';

export type TaskStage = 
  | 'task_setup'       // 任务要求
  | 'material_fact'    // 材料与事实
  | 'style_outline'    // 文风与大纲
  | 'drafting'         // 正文起草
  | 'review'           // 审阅修改
  | 'final_export';    // 核校与导出

export type TaskStatus = 
  | '草稿' 
  | '事实待确认' 
  | '大纲待确认' 
  | '起草中' 
  | '审阅中' 
  | '已定稿'
  | '待恢复';

export type MaterialUsage = 
  | 'current_fact'   // 本期事实候选
  | 'history_bg'     // 历史背景
  | 'style_ref'      // 文风参考
  | 'rag_clue';      // 检索线索

export type ParseStatus = 'parsed' | 'pending_parser';

export type FileType = 'txt' | 'docx' | 'pdf' | 'pasted';

export interface SourceDocument {
  id: string; // e.g. "SRC-01"
  name: string;
  source: string; // e.g. "科室甲"
  period: string; // e.g. "2026年1-9月"
  usage: MaterialUsage;
  parseStatus: ParseStatus;
  fileType: FileType;
  content: string;
  paragraphCount?: number;
  wordCount?: number;
  excluded?: boolean;
}

export interface EvidenceSnippet {
  id: string; // e.g. "EVD-01"
  sourceDocId: string;
  docName: string;
  location: string; // e.g. "第3段"
  period: string;
  text: string;
}

export interface ConflictCandidate {
  value: string;
  sourceDocId: string;
  evidenceId: string;
  description: string;
}

export interface Fact {
  id: string; // e.g. "FACT-01"
  metric: string; // e.g. "累计完成重点任务"
  period: string; // e.g. "2026年1至9月"
  value: string; // e.g. "120"
  unit: string; // e.g. "项"
  metricScope: string; // e.g. "重点任务台账统计口径"
  primaryEvidenceId: string;
  evidenceIds: string[];
  sourceDocId?: string;
  createdByRole?: UserRole; // 提交人角色（供稿丙提交为pending候选）
  hasConflict: boolean;
  conflictCandidates?: ConflictCandidate[];
  selectedConflictValue?: string;
  conflictResolutionReason?: string;
  status: 'pending' | 'confirmed' | 'excluded' | 'gap';
  isAuthorSupplemented?: boolean;
  supplementNotes?: string;
  isHistoricOnly?: boolean; // 2025年96项等
  gapDescription?: string;
}

export interface FactItemSnapshot {
  factId: string;
  metric: string;
  value: string;
  unit: string;
  period: string;
  metricScope: string;
  primaryEvidenceId: string;
  selectedConflictValue?: string;
  conflictResolutionReason?: string;
  hasConflict?: boolean;
  conflictCandidates?: { value: string; description: string; evidenceId?: string }[];
}

export interface FactSnapshot {
  confirmedAt: string;
  factIds: string[];
  items: FactItemSnapshot[];
  hash: string;
}

export interface StyleRule {
  id: string;
  title: string;
  category: '标题结构' | '举措事实' | '问题举措对应' | '行文正式度';
  description: string;
  sampleSnippet: string;
  sampleDocId: string;
  confirmed: boolean;
  excluded?: boolean;
}

export interface StyleSnapshot {
  confirmedAt: string;
  activeRuleIds: string[];
  hash: string;
}

export interface OutlineSectionSnapshot {
  sectionId: string;
  title: string;
  suggestedWordCount: number;
  assignedFactIds: string[];
}

export interface OutlineSnapshot {
  confirmedAt: string;
  sections: OutlineSectionSnapshot[];
  hash: string;
}

export interface OutlineSection {
  id: string;
  order: number;
  title: string;
  purpose: string;
  suggestedWordCount: number;
  assignedFactIds: string[];
  uncoveredRequirements: string[];
  hasMaterialGap: boolean;
  gapDescription?: string;
  confirmed: boolean;
}

export interface ParagraphBlock {
  id: string;
  sectionId: string;
  order: number;
  content: string;
  referencedFactIds: string[];
  hasFactConflict?: boolean;
  hasUnverifiedData?: boolean;
  hasPendingReviewComment?: boolean;
  updatedAt: string;
}

export type RevisionAction = 'compress' | 'expand' | 'formal' | 'highlight' | 'custom';

export interface DiffSegment {
  type: 'equal' | 'added' | 'removed';
  text: string;
}

export interface RevisionSuggestion {
  runId: string;
  taskId: string;
  sourceDraftId: string;
  targetBlockId: string;
  targetBlockOrder?: number;
  targetSectionTitle?: string;
  baseContent: string;
  baseContentHash: string;
  action: RevisionAction;
  customPrompt?: string;
  originalText: string;
  suggestedText: string;
  diffExplanation: string;
  factsAffected: string[];
  createdAt: string;
  wordCountDelta?: number;
  needsVerificationNotes?: string[];
  diffSegments?: DiffSegment[];
  isUnsupportedPrompt?: boolean;
  unsupportedPromptNotice?: string;
}

export interface AuditRecord {
  issueId: string;
  status: 'unresolved' | 'accepted' | 'ignored';
  ignoreReason?: string;
  resolvedAt?: string;
}

export interface SnapshotMetadata {
  taskTitle: string;
  startDate: string;
  endDate: string;
  targetWordCount: number;
  factSnapshot?: FactSnapshot;
  styleSnapshot?: StyleSnapshot;
  outlineSnapshot?: OutlineSnapshot;
  outlineSections: OutlineSection[];
}

export interface DraftVersion {
  id: string;
  versionNumber: string;
  createdAt: string;
  author: string;
  summary: string;
  blocks: ParagraphBlock[];
  isFinal?: boolean;
  finalizedAt?: string;
  isHistoricalSnapshot?: boolean;
  isWorkingDraft?: boolean;
  sourceDraftId?: string; // 记录派生此工作稿的来源历史版本/定稿快照ID
  auditRecords?: AuditRecord[];
  snapshotMetadata?: SnapshotMetadata;
  frozenReviewComments?: ReviewComment[]; // 冻结的历史审阅记录快照（防止后续意见混入旧版本）
}

export type CoordinationStrategy = 'compress' | 'expand_case' | 'balanced';

export interface CoordinationDiffResult {
  strategy: CoordinationStrategy;
  baseDraftId?: string;
  baseContentHash?: string;
  createdAt?: string;
  originalWordCount: number;
  targetWordCount: number;
  strategyExplanation: string;
  candidateBlocks: ParagraphBlock[];
  diffPreview: { blockId: string; originalText: string; proposedText: string }[];
  hasRealCaseMaterial: boolean;
  selectedCaseSnippet?: EvidenceSnippet;
}

export interface FinalizationValidationResult {
  canFinalize: boolean;
  reasons: string[];
  checks: {
    hasDraftText: boolean;
    isAuthor: boolean;
    isUpstreamValid: boolean;
    pendingConflictsResolved: boolean;
    commentsClosed: boolean;
    criticalAuditPassed: boolean;
    isWorkingDraft: boolean;
  };
}

export type ReviewCommentStatus =
  | 'pending'                          // 待处理
  | 'accepted_pending_implementation'  // 决定采纳待落实
  | 'implemented'                      // 已修改/已落实
  | 'rejected'                         // 拒绝并说明
  | 'need_discussion';                 // 待沟通

export interface ReviewComment {
  id: string;
  type: 'overall' | 'paragraph';
  targetBlockId?: string;
  targetBlockOrder?: number;
  targetVersionId: string;
  baseParagraphText?: string;          // 提出意见时的基准原文
  reviewer: string;
  content: string;
  status: ReviewCommentStatus;
  authorReply?: string;
  suggestedChange?: string;
  createdAt: string;
  locationOutdated?: boolean;
  implementationDraftId?: string;     // 落实版本ID
  implementationBlockId?: string;     // 落实段落ID
  decisionReason?: string;             // 采纳决定/拒绝/协调理由
  resolutionType?: 'text_modified' | 'strategy_decided' | 'rejected' | 'communicated';
}

export type AuditIssueType = 
  | 'metric_unit' 
  | 'unit_inconsistency'
  | 'period_mismatch' 
  | 'unreferenced_number' 
  | 'gap_missing' 
  | 'historic_data_leak'
  | 'conflict_mismatch'
  | 'unverified_statement'
  | 'unverified_sentence';

export interface AuditIssue {
  id: string;                          // 兼容已有代码
  issueId: string;                     // 稳定 issueId
  taskId: string;                      // 绑定所属任务ID
  draftId: string;                     // 绑定所属草稿ID
  blockId: string;                     // 绑定段落ID
  type: AuditIssueType;
  severity: 'error' | 'warning' | 'info';
  isBlocking: boolean;                 // 重大不一致阻断定稿，不可通用忽略
  location: string;                    // 具体位置，如“第2段第1句”
  originalText: string;                // 原文
  evidenceText: string;                // 依据出处
  suggestion: string;                  // 更正建议
  replacementText?: string;            // 自动修正文本
  status: 'unresolved' | 'accepted' | 'ignored';
  ignoreReason?: string;               // 忽略非阻断提示理由
  charIndex?: number;                  // 字符偏移量
}

export interface ExportOptions {
  includeBody?: boolean;               // 正文
  includeEvidence?: boolean;           // 依据出处
  includeReviewLog?: boolean;          // 审阅处理记录
}

export interface Task {
  id: string;
  title: string;
  docType: '工作总结' | '汇报材料' | '专项报告';
  usage: string;
  audience: string;
  startDate: string;
  endDate: string;
  targetWordCount: number;
  mandatoryCoverage: string;
  deadline: string;
  primaryAuthor: string;
  currentStage: TaskStage;
  status: TaskStatus;
  updatedAt: string;
  isFinalized: boolean;
  schemaVersion: number;

  // Domain data attached to task
  documents: SourceDocument[];
  snippets: EvidenceSnippet[];
  facts: Fact[];
  factSnapshot?: FactSnapshot;
  styleRules: StyleRule[];
  styleConfirmed: boolean;
  styleSnapshot?: StyleSnapshot;
  outline: OutlineSection[];
  outlineConfirmed: boolean;
  outlineSnapshot?: OutlineSnapshot;
  drafts: DraftVersion[];
  currentDraftId: string;
  reviewComments: ReviewComment[];
  auditIssues: AuditIssue[];
}

export interface DraftCandidate {
  taskId: string;
  runId: string;
  baseDraftId: string;
  baseDraftContentHash: string; // Hash of currentDraft blocks at generation start to detect subsequent manual edits
  upstreamApprovalVersion: {
    factSnapshotConfirmedAt?: string;
    factSnapshotHash?: string;
    styleConfirmedAt?: string;
    styleHash?: string;
    outlineConfirmedAt?: string;
    outlineHash?: string;
  };
  blocks: ParagraphBlock[];
  snapshotMetadata: SnapshotMetadata;
  generatedAt: string;
  instructionPrompt?: string; // 本轮写作要求（例如“突出成效，减少铺垫”）
  requestSummary?: string;    // 请求摘要说明
  isUnsupportedPrompt?: boolean;
  unsupportedPromptNotice?: string;
}

export type CandidateComparisonViewMode = 'split' | 'diff' | 'candidate' | 'current';

export interface AlignedParagraphRow {
  type: 'identical' | 'modified' | 'added' | 'removed';
  blockId: string;
  currentBlock?: ParagraphBlock;
  candidateBlock?: ParagraphBlock;
  diffSegments?: DiffSegment[];
}
