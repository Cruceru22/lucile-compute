/**
 * Render a generated report to a PDF buffer (TASK A8).
 *
 * Uses `pdfkit` (Node-only; PDF generation is impractical in Deno, which is why
 * report rendering lives in the compute service per the task). Pure given its
 * input — no I/O beyond building the in-memory buffer.
 */
import PDFDocument from 'pdfkit';

import type { GeneratedReport } from './reportInterpreter.js';

/** Render the report to a PDF Buffer. */
export function renderReportPdf(report: GeneratedReport, subtitle?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: report.title } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Cover / title.
    doc.fontSize(26).fillColor('#1b1b2f').text(report.title, { align: 'left' });
    if (subtitle) {
      doc.moveDown(0.3).fontSize(12).fillColor('#6E6E8A').text(subtitle);
    }
    doc
      .moveDown(0.6)
      .fontSize(9)
      .fillColor('#9aa0b5')
      .text(
        'Grounded in your deterministically computed chart. Every factual claim was verified against that chart before this report was produced.',
      );
    doc.moveDown(1);

    // Sections.
    for (const section of report.sections) {
      doc.moveDown(0.6);
      doc.fontSize(16).fillColor('#3a2f6b').text(section.heading);
      doc.moveDown(0.3);
      doc.fontSize(11).fillColor('#222').text(section.body, { align: 'left', lineGap: 3 });
    }

    // Footer note.
    doc.moveDown(1.2);
    doc
      .fontSize(8)
      .fillColor('#9aa0b5')
      .text(
        'AstroApp does not provide medical, legal, or financial advice. For entertainment and self-reflection.',
      );

    doc.end();
  });
}
