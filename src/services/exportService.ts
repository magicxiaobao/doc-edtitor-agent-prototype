import { 
  Document, 
  Packer, 
  Paragraph, 
  TextRun, 
  HeadingLevel, 
  AlignmentType, 
  Table, 
  TableRow, 
  TableCell, 
  WidthType, 
  BorderStyle,
  convertInchesToTwip
} from 'docx';
import { Task, DraftVersion, ExportOptions, ReviewComment } from '../types';

/**
 * Normalizes boolean or ExportOptions
 */
export function normalizeExportOptions(options?: boolean | ExportOptions): Required<ExportOptions> {
  if (typeof options === 'boolean') {
    return {
      includeBody: true,
      includeEvidence: options,
      includeReviewLog: options,
    };
  }
  return {
    includeBody: options?.includeBody ?? true,
    includeEvidence: options?.includeEvidence ?? true,
    includeReviewLog: options?.includeReviewLog ?? true,
  };
}

/**
 * Requirement 4 & Task 10: Exports document version as TXT
 * - Supports granular options: includeBody, includeEvidence, includeReviewLog (all 8 combinations!)
 * - When includeBody is false and includeEvidence is true, outputs standalone evidence list.
 * - Uses frozen snapshotMetadata of the target draft rather than current outline/facts.
 * - Returns generated text string for test verification.
 */
export function exportDocumentAsTxt(
  task: Task, 
  draft: DraftVersion, 
  options?: boolean | ExportOptions
): string {
  const opts = normalizeExportOptions(options);
  const meta = draft.snapshotMetadata;
  const exportTitle = meta?.taskTitle || task.title;
  const exportStartDate = meta?.startDate || task.startDate;
  const exportEndDate = meta?.endDate || task.endDate;

  let content = `【${exportTitle}】\n`;
  content += `文种：${task.docType} | 统计期间：${exportStartDate} 至 ${exportEndDate}\n`;
  content += `版本：${draft.versionNumber} | 拟稿人：${draft.author} | 生成时间：${new Date(draft.createdAt).toLocaleString('zh-CN')}\n`;
  content += `【导出配置】正文：${opts.includeBody ? '包含' : '不含'} | 依据：${opts.includeEvidence ? '包含' : '不含'} | 审阅记录：${opts.includeReviewLog ? '包含' : '不含'}\n`;
  content += `====================================================\n\n`;

  // Group by outline section: prefer historical outline sections from snapshotMetadata
  const sectionsMap = new Map<string, string>();
  const outlineList = meta?.outlineSections || task.outline;
  outlineList.forEach((sec) => sectionsMap.set(sec.id, sec.title));

  // Prepare snapshot facts map
  const snapshotFactMap = new Map<string, { metric: string; value: string; unit: string; metricScope: string; period?: string; primaryEvidenceId?: string }>();
  if (meta?.factSnapshot?.items) {
    meta.factSnapshot.items.forEach((item) => {
      snapshotFactMap.set(item.factId, {
        metric: item.metric,
        value: item.value,
        unit: item.unit,
        metricScope: item.metricScope,
        period: item.period,
        primaryEvidenceId: item.primaryEvidenceId,
      });
    });
  }

  // 1. Output Body & Evidence
  if (opts.includeBody) {
    let currentSecId = '';
    draft.blocks.forEach((block) => {
      if (block.sectionId && block.sectionId !== currentSecId) {
        currentSecId = block.sectionId;
        const secTitle = sectionsMap.get(block.sectionId) || `章节 ${block.sectionId}`;
        content += `\n${secTitle}\n----------------------------------------------------\n`;
      }

      content += `    ${block.content}\n\n`;

      if (opts.includeEvidence && block.referencedFactIds.length > 0) {
        const referencedFacts = block.referencedFactIds
          .map((fId) => {
            const snapF = snapshotFactMap.get(fId);
            if (snapF) return `[事实依据: ${snapF.metric} ${snapF.value}${snapF.unit} (口径: ${snapF.metricScope})]`;
            const taskF = task.facts.find((f) => f.id === fId);
            if (taskF) return `[事实依据: ${taskF.metric} ${taskF.value}${taskF.unit} (口径: ${taskF.metricScope})]`;
            return null;
          })
          .filter(Boolean)
          .join(' ');

        if (referencedFacts) {
          content += `    >>> 依据出处：${referencedFacts}\n\n`;
        }
      }
    });
  }

  // Standalone Evidence Section when includeBody is false but includeEvidence is true
  if (opts.includeEvidence && !opts.includeBody) {
    content += `【事实依据清单与出处溯源】\n----------------------------------------------------\n`;
    if (meta?.factSnapshot?.items && meta.factSnapshot.items.length > 0) {
      meta.factSnapshot.items.forEach((item, idx) => {
        content += `${idx + 1}. [${item.factId}] ${item.metric}：${item.value}${item.unit} | 期间：${item.period} | 口径：${item.metricScope} (主出处：${item.primaryEvidenceId || '台账'})\n`;
      });
    } else if (task.facts.length > 0) {
      task.facts.forEach((f, idx) => {
        content += `${idx + 1}. [${f.id}] ${f.metric}：${f.selectedConflictValue || f.value}${f.unit} | 期间：${f.period} | 口径：${f.metricScope} (主出处：${f.primaryEvidenceId || '台账'})\n`;
      });
    } else {
      content += `暂无已核准的事实依据。\n`;
    }
    content += `\n`;
  }

  // 2. Output Review Comments & Decisions
  if (opts.includeReviewLog) {
    content += `\n====================================================\n`;
    content += `【附：审阅意见与落实处理记录】\n`;

    if (draft.frozenReviewComments !== undefined) {
      if (draft.frozenReviewComments.length > 0) {
        draft.frozenReviewComments.forEach((cmt, idx) => {
          const statusLabel = 
            cmt.status === 'implemented' ? '已修改落实' :
            cmt.status === 'accepted_pending_implementation' ? '决定采纳待落实' :
            cmt.status === 'rejected' ? '拒绝并说明' :
            cmt.status === 'need_discussion' ? '待沟通' : '待处理';

          const targetVersionInfo = cmt.targetVersionId ? ` 针对版本：${cmt.targetVersionId}` : '';
          content += `${idx + 1}. [${cmt.reviewer} - ${cmt.type === 'overall' ? '整体意见' : '段落批注'}]${targetVersionInfo} | 状态：${statusLabel}\n`;
          content += `   意见内容：${cmt.content}\n`;
          if (cmt.suggestedChange) {
            content += `   修改建议：${cmt.suggestedChange}\n`;
          }
          if (cmt.decisionReason) {
            content += `   研判理由：${cmt.decisionReason}\n`;
          }
          if (cmt.authorReply) {
            content += `   主笔答复：${cmt.authorReply}\n`;
          }
          if (cmt.implementationDraftId) {
            content += `   落实版本：${cmt.implementationDraftId}${cmt.implementationBlockId ? ' (段落: ' + cmt.implementationBlockId + ')' : ''}\n`;
          }
          content += `\n`;
        });
      } else {
        content += `（本版本生成/定稿时无审阅意见记录）\n`;
      }
    } else if (draft.isHistoricalSnapshot || draft.isFinal) {
      // 缺少冻结记录的历史或定稿版本，明确标记“无法还原当时审阅状态”，避免把当前记录当成历史记录
      content += `【提示】此历史/定稿版本未包含冻结审阅记录快照，无法还原当时审阅状态；为防止后续意见混入，不直接采用当前审阅记录。\n`;
    } else {
      // 当前活动工作稿：输出当前全部审阅意见与落实处理
      if (task.reviewComments.length > 0) {
        task.reviewComments.forEach((cmt, idx) => {
          const statusLabel = 
            cmt.status === 'implemented' ? '已修改落实' :
            cmt.status === 'accepted_pending_implementation' ? '决定采纳待落实' :
            cmt.status === 'rejected' ? '拒绝并说明' :
            cmt.status === 'need_discussion' ? '待沟通' : '待处理';

          const targetVersionInfo = cmt.targetVersionId ? ` 针对版本：${cmt.targetVersionId}` : '';
          content += `${idx + 1}. [${cmt.reviewer} - ${cmt.type === 'overall' ? '整体意见' : '段落批注'}]${targetVersionInfo} | 状态：${statusLabel}\n`;
          content += `   意见内容：${cmt.content}\n`;
          if (cmt.suggestedChange) {
            content += `   修改建议：${cmt.suggestedChange}\n`;
          }
          if (cmt.decisionReason) {
            content += `   研判理由：${cmt.decisionReason}\n`;
          }
          if (cmt.authorReply) {
            content += `   主笔答复：${cmt.authorReply}\n`;
          }
          if (cmt.implementationDraftId) {
            content += `   落实版本：${cmt.implementationDraftId}${cmt.implementationBlockId ? ' (段落: ' + cmt.implementationBlockId + ')' : ''}\n`;
          }
          content += `\n`;
        });
      } else {
        content += `（本版本无待处理或已登记的审阅意见记录）\n`;
      }
    }

    if (draft.auditRecords && draft.auditRecords.length > 0) {
      content += `\n【附：核校更正与忽略存证记录】\n`;
      draft.auditRecords.forEach((rec, idx) => {
        content += `${idx + 1}. 核校项：${rec.issueId} | 状态：${rec.status === 'accepted' ? '已更正采纳' : rec.status === 'ignored' ? '已忽略存证' : '待处理'}${rec.ignoreReason ? ' (理由：' + rec.ignoreReason + ')' : ''}\n`;
      });
    }
  }

  // When all 3 options are false
  if (!opts.includeBody && !opts.includeEvidence && !opts.includeReviewLog) {
    content += `（已依据导出选项排除正文、依据出处及审阅处理记录，仅保留文稿版本元数据）\n`;
  }

  // Trigger download if running in DOM browser
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${exportTitle}_${draft.versionNumber}_${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return content;
}

/**
 * Requirement 4 & Task 10: Exports document version as DOCX
 * - Generates valid ECMA-376 OOXML document structure
 * - Supports granular options: includeBody, includeEvidence, includeReviewLog (all 8 combinations!)
 * - Standalone evidence table if includeBody is false and includeEvidence is true
 * - Uses frozen snapshotMetadata of the target draft
 */
export async function exportDocumentAsDocx(
  task: Task, 
  draft: DraftVersion, 
  options?: boolean | ExportOptions
): Promise<Blob | Buffer> {
  const opts = normalizeExportOptions(options);
  const meta = draft.snapshotMetadata;
  const exportTitle = meta?.taskTitle || task.title;
  const exportStartDate = meta?.startDate || task.startDate;
  const exportEndDate = meta?.endDate || task.endDate;

  const docParagraphs: (Paragraph | Table)[] = [];

  // Title: 2号方正小标宋 (22pt = size 44)
  docParagraphs.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 300 },
      children: [
        new TextRun({
          text: exportTitle,
          bold: true,
          size: 44,
          font: 'SimSun',
        }),
      ],
    })
  );

  // Subtitle / Metadata
  docParagraphs.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 150 },
      children: [
        new TextRun({
          text: `文种：${task.docType}   |   统计期间：${exportStartDate} 至 ${exportEndDate}`,
          size: 24, // 12pt
          color: '555555',
          font: 'KaiTi',
        }),
      ],
    })
  );

  docParagraphs.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
      children: [
        new TextRun({
          text: `公文版本：${draft.versionNumber}   |   拟稿人：${draft.author}   |   归档时间：${new Date(draft.createdAt).toLocaleString('zh-CN')}`,
          size: 22, // 11pt
          color: '555555',
          font: 'KaiTi',
        }),
      ],
    })
  );

  // Scope metadata note
  docParagraphs.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [
        new TextRun({
          text: `【导出范围】正文：${opts.includeBody ? '包含' : '不含'} | 依据：${opts.includeEvidence ? '包含' : '不含'} | 审阅处理记录：${opts.includeReviewLog ? '包含' : '不含'}`,
          size: 20, // 10pt
          color: '666666',
          font: 'FangSong',
        }),
      ],
    })
  );

  // Sections and blocks - using snapshot sections
  const sectionsMap = new Map<string, string>();
  const outlineList = meta?.outlineSections || task.outline;
  outlineList.forEach((sec) => sectionsMap.set(sec.id, sec.title));

  const snapshotFactMap = new Map<string, { metric: string; value: string; unit: string; metricScope: string; period?: string; primaryEvidenceId?: string }>();
  if (meta?.factSnapshot?.items) {
    meta.factSnapshot.items.forEach((item) => {
      snapshotFactMap.set(item.factId, {
        metric: item.metric,
        value: item.value,
        unit: item.unit,
        metricScope: item.metricScope,
        period: item.period,
        primaryEvidenceId: item.primaryEvidenceId,
      });
    });
  }

  // 1. Output Body & Evidence
  if (opts.includeBody) {
    let currentSecId = '';
    for (const block of draft.blocks) {
      if (block.sectionId && block.sectionId !== currentSecId) {
        currentSecId = block.sectionId;
        const secTitle = sectionsMap.get(block.sectionId) || `章节 ${block.sectionId}`;
        docParagraphs.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 300, after: 150 },
            children: [
              new TextRun({
                text: secTitle,
                bold: true,
                size: 28, // 14pt
                font: 'SimHei',
              }),
            ],
          })
        );
      }

      docParagraphs.push(
        new Paragraph({
          alignment: AlignmentType.BOTH,
          spacing: { line: 360, before: 100, after: 100 },
          indent: { firstLine: 480 }, // 首行缩进两字符
          children: [
            new TextRun({
              text: block.content,
              size: 28, // 3号/4号字仿宋
              font: 'FangSong',
            }),
          ],
        })
      );

      if (opts.includeEvidence && block.referencedFactIds.length > 0) {
        const referencedFacts = block.referencedFactIds
          .map((fId) => {
            const snapF = snapshotFactMap.get(fId);
            if (snapF) return `【依据】${snapF.metric}: ${snapF.value}${snapF.unit} (${snapF.metricScope})`;
            const taskF = task.facts.find((f) => f.id === fId);
            if (taskF) return `【依据】${taskF.metric}: ${taskF.value}${taskF.unit} (${taskF.metricScope})`;
            return null;
          })
          .filter(Boolean)
          .join('；');

        if (referencedFacts) {
          docParagraphs.push(
            new Paragraph({
              spacing: { after: 150 },
              indent: { left: 480 },
              children: [
                new TextRun({
                  text: `📎 出处追溯：${referencedFacts}`,
                  size: 20,
                  italics: true,
                  color: '1E40AF',
                  font: 'FangSong',
                }),
              ],
            })
          );
        }
      }
    }
  }

  // Standalone Evidence Table when includeBody is false and includeEvidence is true
  if (opts.includeEvidence && !opts.includeBody) {
    docParagraphs.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 300, after: 150 },
        children: [
          new TextRun({
            text: '【事实依据清单与出处溯源】',
            bold: true,
            size: 28,
            font: 'SimHei',
          }),
        ],
      })
    );

    const factTableRows: TableRow[] = [];
    factTableRows.push(
      new TableRow({
        tableHeader: true,
        children: [
          new TableCell({ width: { size: 15, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: '事实编号', bold: true, size: 20, font: 'SimHei' })] })] }),
          new TableCell({ width: { size: 30, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: '指标名称与数值', bold: true, size: 20, font: 'SimHei' })] })] }),
          new TableCell({ width: { size: 20, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: '统计期间', bold: true, size: 20, font: 'SimHei' })] })] }),
          new TableCell({ width: { size: 35, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: '口径说明与出处', bold: true, size: 20, font: 'SimHei' })] })] }),
        ],
      })
    );

    const itemsToRender = meta?.factSnapshot?.items || task.facts.map((f) => ({
      factId: f.id,
      metric: f.metric,
      value: f.selectedConflictValue || f.value,
      unit: f.unit,
      period: f.period,
      metricScope: f.metricScope,
      primaryEvidenceId: f.primaryEvidenceId,
    }));

    itemsToRender.forEach((item) => {
      factTableRows.push(
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: item.factId, size: 18, font: 'FangSong' })] })] }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: `${item.metric}：${item.value}${item.unit}`, size: 18, font: 'FangSong' })] })] }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: item.period || '2026年1-9月', size: 18, font: 'FangSong' })] })] }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: `${item.metricScope} (${item.primaryEvidenceId || '台账'})`, size: 18, font: 'FangSong' })] })] }),
          ],
        })
      );
    });

    docParagraphs.push(
      new Table({
        rows: factTableRows,
        width: { size: 100, type: WidthType.PERCENTAGE },
      })
    );
  }

  // 2. Output Review Comments & Decisions
  if (opts.includeReviewLog) {
    docParagraphs.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 500, after: 200 },
        children: [
          new TextRun({
            text: '附：审阅意见与落实处理记录',
            bold: true,
            size: 28,
            font: 'SimHei',
          }),
        ],
      })
    );

    // Build Table for Review Comments
    const tableRows: TableRow[] = [];

    // Header Row
    tableRows.push(
      new TableRow({
        tableHeader: true,
        children: [
          new TableCell({
            width: { size: 10, type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text: '序号', bold: true, size: 20, font: 'SimHei' })] })],
          }),
          new TableCell({
            width: { size: 15, type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text: '审阅人/类型', bold: true, size: 20, font: 'SimHei' })] })],
          }),
          new TableCell({
            width: { size: 15, type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text: '当前状态', bold: true, size: 20, font: 'SimHei' })] })],
          }),
          new TableCell({
            width: { size: 35, type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text: '审阅意见与修改建议', bold: true, size: 20, font: 'SimHei' })] })],
          }),
          new TableCell({
            width: { size: 25, type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text: '主笔研判与落实情况', bold: true, size: 20, font: 'SimHei' })] })],
          }),
        ],
      })
    );

    let reviewCommentsToExport: ReviewComment[] = [];
    let isMissingHistoricalReviewSnapshot = false;
    let emptyReviewNotice = '（本版本无待处理或已登记的审阅意见记录）';

    if (draft.frozenReviewComments !== undefined) {
      reviewCommentsToExport = draft.frozenReviewComments;
      emptyReviewNotice = '（本版本生成/定稿时无审阅意见记录）';
    } else if (draft.isHistoricalSnapshot || draft.isFinal) {
      isMissingHistoricalReviewSnapshot = true;
    } else {
      reviewCommentsToExport = task.reviewComments;
    }

    if (isMissingHistoricalReviewSnapshot) {
      docParagraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: '【提示】此历史/定稿版本未包含冻结审阅记录快照，系统无法还原该版本历史时刻的审阅与答复状态；为保证审计真实性，不直接混入当前最新审阅记录。',
              size: 20,
              font: 'FangSong',
              color: '666666',
            }),
          ],
          spacing: { after: 200 },
        })
      );
    } else if (reviewCommentsToExport.length > 0) {
      reviewCommentsToExport.forEach((cmt, idx) => {
        const statusLabel = 
          cmt.status === 'implemented' ? '已修改落实' :
          cmt.status === 'accepted_pending_implementation' ? '决定采纳待落实' :
          cmt.status === 'rejected' ? '拒绝并说明' :
          cmt.status === 'need_discussion' ? '待沟通' : '待处理';

        const replyContent = [
          cmt.decisionReason ? `【研判理由】${cmt.decisionReason}` : '',
          cmt.authorReply ? `【答复】${cmt.authorReply}` : '',
          cmt.implementationDraftId ? `【落实版本】${cmt.implementationDraftId}` : '',
        ].filter(Boolean).join('\n') || '尚未处理';

        const suggestionContent = [
          cmt.content,
          cmt.suggestedChange ? `【建议文案】${cmt.suggestedChange}` : '',
        ].filter(Boolean).join('\n');

        tableRows.push(
          new TableRow({
            children: [
              new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: `${idx + 1}`, size: 18, font: 'FangSong' })] })],
              }),
              new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: `${cmt.reviewer}\n(${cmt.type === 'overall' ? '整体' : '段落'})\n[针对: ${cmt.targetVersionId || '未指定'}]`, size: 18, font: 'FangSong' })] })],
              }),
              new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: statusLabel, size: 18, font: 'FangSong' })] })],
              }),
              new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: suggestionContent, size: 18, font: 'FangSong' })] })],
              }),
              new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: replyContent, size: 18, font: 'FangSong' })] })],
              }),
            ],
          })
        );
      });

      docParagraphs.push(
        new Table({
          rows: tableRows,
          width: { size: 100, type: WidthType.PERCENTAGE },
        })
      );
    } else {
      docParagraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: emptyReviewNotice,
              size: 20,
              font: 'FangSong',
              color: '666666',
            }),
          ],
          spacing: { after: 200 },
        })
      );
    }

    if (draft.auditRecords && draft.auditRecords.length > 0) {
      docParagraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 300, after: 150 },
          children: [new TextRun({ text: '附：核校更正与忽略存证记录', bold: true, size: 24, font: 'SimHei' })],
        })
      );

      draft.auditRecords.forEach((rec, idx) => {
        docParagraphs.push(
          new Paragraph({
            spacing: { line: 280, before: 60, after: 60 },
            indent: { left: 480 },
            children: [
              new TextRun({
                text: `${idx + 1}. 核校项：${rec.issueId} | 状态：${rec.status === 'accepted' ? '已更正采纳' : rec.status === 'ignored' ? '已忽略存证' : '待处理'}${rec.ignoreReason ? ' (理由：' + rec.ignoreReason + ')' : ''}`,
                size: 20,
                font: 'FangSong',
              }),
            ],
          })
        );
      });
    }
  }

  // End of Document note with compatibility disclaimer
  docParagraphs.push(
    new Paragraph({
      spacing: { before: 400 },
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: '（公文正文已按标准结构生成，文档符合 ECMA-376 OOXML 标准；实际 Word/WPS 客户端排版表现以本地运行打开为准）',
          size: 18,
          color: '888888',
          italics: true,
          font: 'FangSong',
        }),
      ],
    })
  );

  // Build document
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
            },
          },
        },
        children: docParagraphs,
      },
    ],
  });

  // Support both browser (Blob) and Node (Buffer) environments
  let result: Blob | Buffer;
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    result = await Packer.toBlob(doc);
    const url = URL.createObjectURL(result as Blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${exportTitle}_${draft.versionNumber}_${Date.now()}.docx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } else {
    result = await Packer.toBuffer(doc);
    (result as any).size = result.length;
  }

  return result;
}
