import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType, BorderStyle } from 'docx';
import { Task, DraftVersion } from '../types';

export function exportDocumentAsTxt(task: Task, draft: DraftVersion, includeAnnotations = false): void {
  let content = `【${task.title}】\n`;
  content += `文种：${task.docType} | 统计期间：${task.startDate} 至 ${task.endDate}\n`;
  content += `版本：${draft.versionNumber} | 拟稿人：${draft.author} | 生成时间：${new Date(draft.createdAt).toLocaleString('zh-CN')}\n`;
  content += `====================================================\n\n`;

  // Group by outline section if available
  const sectionsMap = new Map<string, string>();
  task.outline.forEach((sec) => sectionsMap.set(sec.id, sec.title));

  let currentSecId = '';
  draft.blocks.forEach((block, idx) => {
    if (block.sectionId && block.sectionId !== currentSecId) {
      currentSecId = block.sectionId;
      const secTitle = sectionsMap.get(block.sectionId) || `章节 ${block.sectionId}`;
      content += `\n${secTitle}\n----------------------------------------------------\n`;
    }

    content += `    ${block.content}\n\n`;

    if (includeAnnotations && block.referencedFactIds.length > 0) {
      const referencedFacts = task.facts
        .filter((f) => block.referencedFactIds.includes(f.id))
        .map((f) => `[事实依据: ${f.metric} ${f.value}${f.unit} (口径: ${f.metricScope})]`)
        .join(' ');
      content += `    >>> 依据出处：${referencedFacts}\n\n`;
    }
  });

  if (includeAnnotations && task.reviewComments.length > 0) {
    content += `\n====================================================\n`;
    content += `【附：审阅意见处理记录】\n`;
    task.reviewComments.forEach((cmt, idx) => {
      content += `${idx + 1}. [${cmt.reviewer} - ${cmt.type === 'overall' ? '整体意见' : '段落批注'}] 状态：${cmt.status}\n`;
      content += `   意见内容：${cmt.content}\n`;
      if (cmt.authorReply) {
        content += `   主笔答复：${cmt.authorReply}\n`;
      }
      content += `\n`;
    });
  }

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${task.title}_${draft.versionNumber.replace(/[\s\(\)]/g, '_')}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function exportDocumentAsDocx(task: Task, draft: DraftVersion, includeAnnotations = false): Promise<void> {
  const docParagraphs: Paragraph[] = [];

  // Title
  docParagraphs.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
      children: [
        new TextRun({
          text: task.title,
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
      spacing: { after: 400 },
      children: [
        new TextRun({
          text: `文种：${task.docType}   统计期间：${task.startDate} 至 ${task.endDate}   版本：${draft.versionNumber}`,
          size: 24, // 12pt
          color: '555555',
          font: 'FangSong',
        }),
      ],
    })
  );

  // Sections and blocks
  const sectionsMap = new Map<string, string>();
  task.outline.forEach((sec) => sectionsMap.set(sec.id, sec.title));

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

    if (includeAnnotations && block.referencedFactIds.length > 0) {
      const referencedFacts = task.facts
        .filter((f) => block.referencedFactIds.includes(f.id))
        .map((f) => `【依据】${f.metric}: ${f.value}${f.unit} (${f.metricScope})`)
        .join('；');

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

  // Create real docx file
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: docParagraphs,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${task.title}_${draft.versionNumber.replace(/[\s\(\)]/g, '_')}.docx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
