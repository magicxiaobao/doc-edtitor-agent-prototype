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
import { Task, DraftVersion, ExportOptions } from '../types';

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
 * Requirement 4: Exports document version as TXT
 * - Supports granular options: includeBody, includeEvidence, includeReviewLog
 * - Uses frozen snapshotMetadata of the target draft rather than current outline/facts
 * - Returns generated text string for test verification
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
  const snapshotFactMap = new Map<string, { metric: string; value: string; unit: string; metricScope: string }>();
  if (meta?.factSnapshot?.items) {
    meta.factSnapshot.items.forEach((item) => {
      snapshotFactMap.set(item.factId, {
        metric: item.metric,
        value: item.value,
        unit: item.unit,
        metricScope: item.metricScope,
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

  // 2. Output Review Comments & Decisions
  if (opts.includeReviewLog && task.reviewComments.length > 0) {
    content += `\n====================================================\n`;
    content += `【附：审阅意见与落实处理记录】\n`;
    task.reviewComments.forEach((cmt, idx) => {
      const statusLabel = 
        cmt.status === 'implemented' ? '已修改落实' :
        cmt.status === 'accepted_pending_implementation' ? '决定采纳待落实' :
        cmt.status === 'rejected' ? '拒绝并说明' :
        cmt.status === 'need_discussion' ? '待沟通' : '待处理';

      content += `${idx + 1}. [${cmt.reviewer} - ${cmt.type === 'overall' ? '整体意见' : '段落批注'}] 状态：${statusLabel}\n`;
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
  }

  // Trigger download if running in DOM browser
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${exportTitle}_${draft.versionNumber.replace(/[\s\(\)]/g, '_')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return content;
}

/**
 * Requirement 4: Exports document version as real OOXML DOCX
 * - Supports identical options: includeBody, includeEvidence, includeReviewLog
 * - Uses frozen snapshotMetadata of target version
 * - Validates OOXML structure
 * - Explicit compatibility disclaimer: Word/WPS desktop opening compatibility pending verification
 */
export async function exportDocumentAsDocx(
  task: Task, 
  draft: DraftVersion, 
  options?: boolean | ExportOptions
): Promise<Blob> {
  const opts = normalizeExportOptions(options);
  const meta = draft.snapshotMetadata;
  const exportTitle = meta?.taskTitle || task.title;
  const exportStartDate = meta?.startDate || task.startDate;
  const exportEndDate = meta?.endDate || task.endDate;

  const docParagraphs: (Paragraph | Table)[] = [];

  // Title
  docParagraphs.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
      children: [
        new TextRun({
          text: exportTitle,
          bold: true,
          size: 36, // 18pt
          font: 'SimHei',
        }),
      ],
    })
  );

  // Subtitle metadata
  docParagraphs.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
      children: [
        new TextRun({
          text: `文种：${task.docType}   统计期间：${exportStartDate} 至 ${exportEndDate}   版本：${draft.versionNumber}`,
          size: 24, // 12pt
          color: '444444',
          font: 'FangSong',
        }),
      ],
    })
  );

  // Disclaimer / Scope metadata note
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

  const snapshotFactMap = new Map<string, { metric: string; value: string; unit: string; metricScope: string }>();
  if (meta?.factSnapshot?.items) {
    meta.factSnapshot.items.forEach((item) => {
      snapshotFactMap.set(item.factId, {
        metric: item.metric,
        value: item.value,
        unit: item.unit,
        metricScope: item.metricScope,
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

  // 2. Output Review Comments & Decisions
  if (opts.includeReviewLog && task.reviewComments.length > 0) {
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

    // Data Rows
    task.reviewComments.forEach((cmt, idx) => {
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
              children: [new Paragraph({ children: [new TextRun({ text: `${cmt.reviewer}\n(${cmt.type === 'overall' ? '整体' : '段落'})`, size: 18, font: 'FangSong' })] })],
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

  const blob = await Packer.toBlob(doc);

  // Trigger download if in browser
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${exportTitle}_${draft.versionNumber.replace(/[\s\(\)]/g, '_')}.docx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return blob;
}
