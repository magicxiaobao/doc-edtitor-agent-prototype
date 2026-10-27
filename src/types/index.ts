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

export interface FactEvidenceProvenance {
  evidenceId: string;        // e.g. "EVD-02"
  sourceDocId: string;       // e.g. "SRC-02"
  sourceDocName: string;     // e.g. "科室乙前三季度汇总"
  location?: string;         // e.g. "第2段"
  text: string;              // 冻结的原文片段
  period?: string;           // e.g. "2026年1至9月"
  capturedAt?: string;       // 冻结捕获时间 (ISO string)
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
  provenance?: FactEvidenceProvenance; // 冻结的来源材料与原文快照（可选，兼容历史数据）
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
  adoptedEvidences?: AdoptedEvidenceRecord[];
  hasFactConflict?: boolean;
  hasUnverifiedData?: boolean;
  hasPendingReviewComment?: boolean;
  updatedAt: string;
  revisionSeq?: number;
}

export interface AdoptedEvidenceRecord {
  evidenceId: string;
  sourceDocId: string;
  sourceDocName: string;
  snippetLocation?: string;
  snippetText: string;
  period: string;
  usage: MaterialUsage;
  associatedFactId?: string;
  metric?: string;
  metricScope?: string;
  contentFingerprint: string;
  capturedAt: string;
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
  sourceCommentId?: string;
  sourceCommentReviewer?: string;
  sourceCommentSummary?: string;
  sourceCommentType?: ReviewSuggestionType;
  isReviewerReplacement?: boolean;
  isMaterialSupplementation?: boolean;
  selectedSnippetIds?: string[];
  selectedFactIds?: string[];
  adoptedEvidences?: AdoptedEvidenceRecord[];
  materialFingerprint?: string;
  materialPrompt?: string;
  upstreamApprovalVersion?: {
    factSnapshotConfirmedAt?: string;
    factSnapshotHash?: string;
    styleConfirmedAt?: string;
    styleHash?: string;
    outlineConfirmedAt?: string;
    outlineHash?: string;
  };
}

export interface FactRevisionCandidate {
  id: string;                          // 候选ID (e.g. FACT-REV-...)
  runId: string;                       // 关联运行ID
  taskId: string;                      // 关联任务ID
  sourceDraftId: string;               // 来源工作稿ID
  sourceDraftVersionNumber?: string;   // 来源版本号
  targetBlockId: string;               // 目标段落稳定ID
  targetBlockOrder: number;            // 目标段落序号
  targetSectionTitle?: string;         // 目标章节标题
  targetFactId: string;                // 目标事实ID
  createdAt: string;                   // 生成时间 (ISO)

  // 原正文与基准快照
  originalBlockContent: string;
  originalRevisionSeq: number;
  originalReferencedFactIds: string[];
  originalAdoptedEvidences?: AdoptedEvidenceRecord[];

  // 修订候选正文
  revisedBlockContent: string;

  // 整稿基准指纹（核验生成后整稿正文是否被人工修改）
  baseDraftContentHash: string;

  contextFingerprint: string; // 正文/修订/引用、实际原文及审批内容的完整生成上下文

  // 事实指标与变动数值
  metric: string;
  unit: string;
  fromValue: string;
  toValue: string;

  // 出处材料变动
  fromEvidenceId?: string;
  fromDocName: string;
  fromLocation?: string;
  toEvidenceId?: string;
  toDocName: string;
  toLocation?: string;

  // 审批与快照依据上下文
  upstreamContext: {
    factSnapshotConfirmedAt?: string;
    factSnapshotHash?: string;
    styleConfirmedAt?: string;
    styleHash?: string;
    outlineConfirmedAt?: string;
    outlineHash?: string;
  };

  explanation: string;
}

export interface AuditRecord {
  issueId: string;
  status: 'unresolved' | 'accepted' | 'ignored';
  ignoreReason?: string;
  resolvedAt?: string;
}

export type ModificationSource =
  | 'ai_suggestion'
  | 'ai_suggestion_fine_tuned'
  | 'manual_edit'
  | 'review_implementation'
  | 'reviewer_replacement'
  | 'reviewer_replacement_fine_tuned'
  | 'material_supplementation'
  | 'material_supplementation_fine_tuned'
  | 'fact_change_revision';

export interface ReviewCommentSnapshotBeforeChange {
  status: ReviewCommentStatus;
  authorReply?: string;
  decisionReason?: string;
  resolutionType?: 'text_modified' | 'strategy_decided' | 'rejected' | 'communicated';
  implementationDraftId?: string;
  implementationVersionNumber?: string;
  implementationBlockId?: string;
  implementedAt?: string;
}

export interface ReviewCommentSnapshotAfterChange {
  status: ReviewCommentStatus;
  authorReply?: string;
  decisionReason?: string;
  resolutionType?: 'text_modified' | 'strategy_decided' | 'rejected' | 'communicated';
  implementationDraftId?: string;
  implementationVersionNumber?: string;
  implementationBlockId?: string;
  implementedAt?: string;
  currentBlockId?: string;
  targetBlockId?: string;
  reboundAt?: string;
}

export interface ParagraphModificationLog {
  id: string;                          // 操作ID (e.g. MOD-LOG-...)
  taskId: string;                      // 关联任务ID
  draftId: string;                     // 关联稿件版本ID
  blockId: string;                     // 目标段落ID
  blockOrder?: number;                 // 目标段落序号
  timestamp: string;                   // 操作时间 (ISO string)
  source: ModificationSource;          // 来源类型
  sourceDescription: string;           // 来源说明 (例如：采纳经微调的第2段建议)
  beforeContent: string;               // 修改前正文
  afterContent: string;                // 实际写入的正文
  aiOriginalSuggestedText?: string;    // AI生成原始建议（人工微调时不被覆盖）
  reviewerOriginalReplacementText?: string; // 审阅人原始替换正文（人工微调时不被覆盖）
  isReviewerReplacement?: boolean;     // 来源是否为审阅人替换稿
  isFineTuned?: boolean;               // 是否经人工微调
  isMaterialSupplementation?: boolean; // 来源是否为材料补写
  adoptedEvidences?: AdoptedEvidenceRecord[]; // 采纳时实际采用的材料依据存证快照
  previousAdoptedEvidences?: AdoptedEvidenceRecord[]; // 采纳前的材料依据存证快照（用于安全撤销精准恢复）
  previousReferencedFactIds?: string[]; // 采纳前的事实引用列表（用于安全撤销精准恢复）
  postAdoptedReferencedFactIds?: string[]; // 采纳后的完整事实引用快照（用于检测后续引用是否被单独修改）
  postAdoptedEvidences?: AdoptedEvidenceRecord[]; // 采纳后的完整材料依据快照（用于检测后续证据是否被单独修改）
  associatedCommentId?: string;        // 关联审阅意见ID
  associatedCommentReviewer?: string;  // 关联审阅人
  previousCommentState?: ReviewCommentSnapshotBeforeChange; // 采纳前意见状态存证（用于安全撤销时精准恢复）
  postAdoptionCommentState?: ReviewCommentSnapshotAfterChange; // 采纳后意见状态存证（核验后续是否被再次编辑、回复或重绑）
  appliedBlockUpdatedAt?: string;      // 采纳写入时目标段落的 updatedAt 时间戳（核验后续正文是否被再次修改）
  appliedRevisionSeq?: number;         // 采纳时的修改序号
  status: 'applied' | 'undone';        // 状态：已应用 / 已安全撤销
  undoneAt?: string;                   // 撤销时间
  undoneBy?: string;                   // 撤销操作人
  undoUnavailableReason?: string;
  undoReason?: string;                 // 撤销原因/说明
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
  reviewBaselineIds?: string[]; // 此内容分支实际经历的审阅基准，保存快照时一并冻结
  auditRecords?: AuditRecord[];
  snapshotMetadata?: SnapshotMetadata;
  frozenReviewComments?: ReviewComment[]; // 冻结的历史审阅记录快照（防止后续意见混入旧版本）
  factReviewRecords?: ParagraphFactReviewRecord[]; // 事实变更逐段人工复核留痕记录
  sourceFactReviewRecords?: ParagraphFactReviewRecord[]; // 派生来源版本的复核留痕（只读参考，新工作稿需重新核对）
  frozenFactReviewOverview?: DraftFactReviewOverview; // 保存版本时的结论，不随任务最新事实重算
  factReviewRecovery?: Record<string, unknown>; // 隔离异常可选字段，正文仍可加载
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

export interface RebindRecord {
  reboundAt: string;
  reboundBy: string;
  fromBlockId?: string;
  fromBlockOrder?: number;
  toBlockId: string;
  toBlockOrder: number;
  targetDraftId?: string;
  reason?: string;
  reboundParagraphText?: string;       // 重绑时目标段落的基准正文，用于后续检测正文变化
}

export interface ReviewNavigationIntent {
  taskId: string;
  commentId: string;
  targetDraftId?: string;
  timestamp?: number;
}

export type ReviewSuggestionType = 'instruction' | 'replacement';

export interface ReviewComment {
  id: string;
  type: 'overall' | 'paragraph';
  targetBlockId?: string;              // 提出意见时的原始目标段落ID（原始存证）
  targetBlockOrder?: number;           // 提出意见时的原始目标段落序号（原始存证）
  targetVersionId: string;             // 意见针对的基准版本ID（例如 v1.0 提交审阅基准快照）
  targetVersionNumber?: string;        // 意见针对的版本号
  baseParagraphText?: string;          // 提出意见时的基准原文（原始存证，不可在重新绑定时被覆盖）
  reboundParagraphText?: string;       // 重新绑定时目标段落的正文（重绑基准，用于后续正文变动复核检测）
  currentBlockId?: string;             // 当前有效/重新绑定的目标段落ID
  currentBlockOrder?: number;          // 当前有效/重新绑定的目标段落序号
  rebindRecord?: RebindRecord;         // 人工重新指定段落的操作存证记录
  reviewer: string;
  content: string;
  status: ReviewCommentStatus;
  authorReply?: string;
  suggestedChange?: string;
  suggestionType?: ReviewSuggestionType; // 'instruction' (修改方向) | 'replacement' (建议替换正文)
  createdAt: string;
  locationOutdated?: boolean;
  implementationDraftId?: string;     // 落实版本ID
  implementationVersionNumber?: string; // 落实版本号
  implementationBlockId?: string;     // 落实段落ID
  implementedAt?: string;              // 落实时间
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
  reviewBaseDraftId?: string;          // 本轮审阅基准草稿/快照ID
  currentReviewRound?: number;         // 当前审阅轮次（例如第1轮、第2轮）
  reviewComments: ReviewComment[];
  auditIssues: AuditIssue[];
  modificationLogs?: ParagraphModificationLog[]; // 最近修改记录（与版本历史分开，至多20条）
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

export type FactReviewStatus = 'reviewed' | 'deferred' | 'revoked';

export type FactReviewAction = 'review' | 'defer' | 'revoke';

export type FactReviewDisplayStatus =
  | 'pending'      // 待复核
  | 'reviewed'     // 已记录人工复核
  | 'deferred'     // 暂缓处理
  | 'invalidated'; // 原复核已失效，需重新核对

export interface FactEvidenceSummaryAtReview {
  factId: string;
  metric: string;
  snapshotValue: string;
  snapshotPeriod: string;
  snapshotMetricScope: string;
  snapshotPrimaryEvidenceId?: string;
  snapshotDocName: string;
  snapshotLocation: string;
  snapshotProvenanceText?: string;
  hasFrozenSnapshot: boolean;

  latestConfirmedValue: string;
  latestPeriod: string;
  latestMetricScope: string;
  latestPrimaryEvidenceId?: string;
  latestStatus: string;
  latestDocName: string;
  latestLocation: string;
  latestSnippetText?: string;
  hasConflict: boolean;
  selectedConflictValue?: string;
}

export interface ParagraphFactReviewRecord {
  id: string; // e.g. "FR-REC-..."
  taskId: string;
  draftId: string;
  blockId: string;
  blockOrder: number;
  sectionId: string;
  sectionTitle: string;
  status: FactReviewStatus;
  reviewedBy: UserRole;
  reviewedAt: string;
  notes: string;
  paragraphContentAtReview: string;
  paragraphRevisionSeqAtReview: number;
  referencedFactIdsAtReview: string[];
  adoptedEvidenceIdsAtReview: string[];
  factsSummaryAtReview: FactEvidenceSummaryAtReview[];
  contextFingerprint?: string; // 相关正文、引用及两侧依据的规范化内容；旧记录缺失时要求重核
  revocation?: {
    revokedAt: string;
    revokedBy: UserRole;
    reason: string;
  };
}

export interface BlockFactReviewEvaluation {
  blockId: string;
  blockOrder: number;
  sectionId: string;
  sectionTitle: string;
  changedFacts: any[];
  record?: ParagraphFactReviewRecord;
  displayStatus: FactReviewDisplayStatus;
  displayStatusLabel: string;
  invalidatedReason?: string;
  limitations: string[];
  isPending: boolean;
  isReviewed: boolean;
}

export interface DraftFactReviewOverview {
  totalAffectedBlocks: number;
  reviewedCount: number;
  pendingCount: number;
  deferredCount: number;
  invalidatedCount: number;
  unreviewedCount: number;
  blockEvaluations: BlockFactReviewEvaluation[];
}
