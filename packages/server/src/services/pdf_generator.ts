import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ethers } from 'ethers';
import type { DebugSession } from './debug_service.js';

// Professional color palette
const COLORS = {
  primary: '#2563EB', // Blue
  success: '#10B981', // Green
  warning: '#F59E0B', // Amber
  error: '#EF4444', // Red
  critical: '#DC2626', // Dark Red
  text: '#1F2937', // Dark Gray
  textLight: '#6B7280', // Medium Gray
  background: '#F9FAFB', // Light Gray
  border: '#E5E7EB', // Border Gray
};

export class PDFGenerator {
  private reportsDir: string;

  constructor() {
    // Store reports in OS temp directory for global package compatibility
    this.reportsDir = path.join(os.tmpdir(), 'dogtrace-reports');
    if (!fs.existsSync(this.reportsDir)) {
      fs.mkdirSync(this.reportsDir, { recursive: true });
    }
  }

  getReportsDir(): string {
    return this.reportsDir;
  }

  async saveTransactionReport(
    session: DebugSession,
    txHash: string
  ): Promise<{ pdfPath: string; pdfUrl: string }> {
    const filename = `transaction-${txHash.slice(0, 10)}-${Date.now()}.pdf`;
    const pdfPath = path.join(this.reportsDir, filename);
    const pdfUrl = `/reports/${filename}`;

    return new Promise((resolve, reject) => {
      const doc = this.generateTransactionReport(session);
      const writeStream = fs.createWriteStream(pdfPath);

      doc.pipe(writeStream);
      doc.end();

      writeStream.on('finish', () => {
        resolve({ pdfPath, pdfUrl });
      });

      writeStream.on('error', reject);
    });
  }

  private generateTransactionReport(session: DebugSession): PDFKit.PDFDocument {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      info: {
        Title: `Transaction Report - ${session.transaction.hash}`,
        Author: 'DogTrace',
        Subject: 'Smart Contract Transaction Analysis',
      },
    });

    // Single compact page with all critical info
    this.addCompactReport(doc, session);

    return doc;
  }

  /**
   * Generate compact single-page transaction report
   */
  private addCompactReport(doc: PDFKit.PDFDocument, session: DebugSession) {
    const margin = 40;
    let y = margin;

    // Branding
    doc
      .fontSize(11)
      .fillColor(COLORS.primary)
      .font('Helvetica-Bold')
      .text('DOGTRACE', doc.page.width - 110, margin - 5, {
        align: 'right',
        width: 70,
      });

    // Header
    doc
      .fontSize(18)
      .fillColor(COLORS.primary)
      .font('Helvetica-Bold')
      .text('Transaction Debug Report', margin, y, { continued: true });

    // Status badge
    const statusColor = session.result.success ? COLORS.success : COLORS.error;
    const statusText = session.result.success ? 'SUCCESS' : 'FAILED';

    doc.fontSize(12).fillColor(statusColor).text(` • ${statusText}`);

    y += 35;

    // Transaction hash (full, selectable)
    doc
      .fontSize(8)
      .fillColor(COLORS.textLight)
      .font('Helvetica')
      .text('Transaction Hash:', margin, y);

    y += 12;
    doc
      .fontSize(9)
      .fillColor(COLORS.text)
      .font('Courier')
      .text(session.transaction.hash, margin, y);

    y += 25;

    // Key metrics in compact grid
    const metrics = [
      ['From', session.transaction.from],
      ['To', session.transaction.to || 'Contract Creation'],
      ['Block', session.transaction.blockNumber.toString()],
      [
        'Gas Used',
        `${session.result.gasUsed} / ${session.transaction.gasLimit} (${((session.result.gasUsed / session.transaction.gasLimit) * 100).toFixed(1)}%)`,
      ],
    ];

    metrics.forEach(([label, value]) => {
      // Label
      doc
        .fontSize(8)
        .fillColor(COLORS.textLight)
        .font('Helvetica')
        .text(label + ':', margin, y);

      // Value on same line
      doc
        .fontSize(8)
        .fillColor(COLORS.text)
        .font('Courier')
        .text(value || 'N/A', margin + 70, y);

      y += 14;
    });

    // If failed, show error and code
    if (!session.result.success) {
      y += 15;

      // Error message
      y += 10;

      doc
        .fontSize(10)
        .fillColor(COLORS.critical)
        .font('Helvetica-Bold')
        .text(session.result.error || 'Transaction reverted', margin + 10, y, {
          width: doc.page.width - 2 * margin - 20,
        });

      y += 20;

      // Show function code with revert line highlighted
      if (session.result.revertLocation?.functionContext) {
        y += 10;
        const funcCtx = session.result.revertLocation.functionContext;
        const loc = session.result.revertLocation;

        // Function header
        doc
          .fontSize(9)
          .fillColor(COLORS.text)
          .font('Helvetica-Bold')
          .text(`Function: ${funcCtx.functionName}()`, margin, y);

        y += 20;

        // Code block with highlight
        doc.fontSize(8).font('Courier');

        const lines = funcCtx.code.split('\n');
        lines.forEach((line, index) => {
          const lineNum = funcCtx.startLine + index;
          const isRevertLine = lineNum === loc.line;

          // Highlight revert line
          if (isRevertLine) {
            const highlightWidth = doc.page.width - 2 * margin;
            doc.rect(margin, y - 2, highlightWidth, 14).fill('#FEE2E2');
          }

          // Line number
          doc
            .fillColor(COLORS.textLight)
            .font('Courier')
            .fontSize(8)
            .text(lineNum.toString().padStart(4), margin, y);

          // Code
          doc
            .fillColor(isRevertLine ? COLORS.critical : COLORS.text)
            .font(isRevertLine ? 'Courier-Bold' : 'Courier')
            .fontSize(8)
            .text(line, margin + 35, y);

          y += 12;

          // Stop if we're running out of space
          if (y > doc.page.height - 100) {
            doc.text('... (truncated)', margin + 35, y);
            return;
          }
        });

        y += 10;
      }
    }

    // Storage changes (compact)
    if (
      session.analysis?.storageChanges &&
      session.analysis.storageChanges.length > 0
    ) {
      y += 20;

      doc
        .fontSize(11)
        .fillColor(COLORS.primary)
        .font('Helvetica-Bold')
        .text('Storage Changes', margin, y);

      y += 18;

      const changes = session.analysis.storageChanges.slice(0, 10); // Max 10

      changes.forEach((change) => {
        const varInfo = session.storageLayout?.[change.slotNumber];
        const varName = varInfo ? varInfo.name : `Slot ${change.slotNumber}`;

        // Variable name
        doc
          .fontSize(10)
          .fillColor(COLORS.text)
          .font('Helvetica')
          .text(`${varName}:`, margin + 5, y);

        // Attempt string decoding
        const oldDecoded = this.tryDecodeString(change.oldValue);
        const newDecoded = this.tryDecodeString(change.newValue);

        let oldValueText: string;
        let newValueText: string;

        if (oldDecoded.isString || newDecoded.isString) {
          oldValueText = oldDecoded.isString
            ? oldDecoded.value
            : change.oldValueDecimal === '0'
              ? '""'
              : oldDecoded.value;
          newValueText = newDecoded.isString
            ? newDecoded.value
            : change.newValueDecimal === '0'
              ? '""'
              : newDecoded.value;
        } else {
          oldValueText = change.oldValueDecimal;
          newValueText = change.newValueDecimal;
        }

        const arrow = ' -> ';

        doc
          .fontSize(10)
          .fillColor(COLORS.textLight)
          .font('Courier')
          .text(oldValueText + arrow, margin + 80, y, { continued: true });

        doc.fillColor(COLORS.success).text(newValueText);

        y += 14;

        if (y > doc.page.height - 60) {
          doc
            .fontSize(7)
            .fillColor(COLORS.textLight)
            .text(
              `... and ${session.analysis!.storageChanges.length - changes.length} more`,
              margin + 5,
              y
            );
          return;
        }
      });
    }

    // Footer
    doc
      .fontSize(7)
      .fillColor(COLORS.textLight)
      .text(
        `Generated by DogTrace • ${new Date().toLocaleString()}`,
        margin,
        doc.page.height - 50,
        { align: 'center', width: doc.page.width - 2 * margin }
      );
  }

  /**
   * Decode Solidity short string from storage value
   * Strings < 32 bytes are stored inline with length*2 in last byte
   */
  private tryDecodeString(hexValue: string): {
    isString: boolean;
    value: string;
  } {
    try {
      const hex = hexValue.startsWith('0x') ? hexValue.slice(2) : hexValue;
      const paddedHex = hex.padStart(64, '0');
      const lastByte = parseInt(paddedHex.slice(-2), 16);

      // Check for short string format
      if (lastByte > 0 && lastByte % 2 === 0 && lastByte < 64) {
        const length = lastByte / 2;
        const stringHex = paddedHex.slice(0, length * 2);

        try {
          const decoded = ethers.toUtf8String('0x' + stringHex);
          if (/^[\x20-\x7E]*$/.test(decoded)) {
            return { isString: true, value: `"${decoded}"` };
          }
        } catch {}
      }

      if (BigInt(hexValue) === BigInt(0)) {
        return { isString: false, value: '0' };
      }

      return { isString: false, value: BigInt(hexValue).toString() };
    } catch (e) {
      return { isString: false, value: BigInt(hexValue).toString() };
    }
  }
}
