import { getDocumentProxy } from 'unpdf';
import type { PdfPageText } from './sga-schedule';

/** The SGA schedule is 1-2 pages; anything much longer is not the document this feature expects. */
export const MAX_PDF_PAGES = 10;
export const MAX_PDF_BYTES = 2 * 1024 * 1024;
/** A real SGA schedule has a few hundred text items; these caps stop a crafted PDF from exhausting the function. */
export const MAX_PDF_ITEMS = 20_000;
export const MAX_PDF_CHARS = 200_000;
/** Soft deadline, checked between pages, so a slow document fails before the platform kills the function. */
export const PDF_DEADLINE_MS = 8_000;

/** True when the bytes start with the PDF signature (`%PDF-`). The declared MIME type is never trusted. */
export function hasPdfSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

export interface ExtractOptions {
  now?: () => number;
  deadlineMs?: number;
  maxItems?: number;
  maxChars?: number;
}

/** A pdf.js text item (marked-content entries have no `str` and are skipped). */
interface RawTextItem {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
}

/**
 * Text items with their coordinates for every page. Uses `unpdf`'s serverless pdf.js build: no canvas and no
 * worker thread are needed, so it runs inside a Node serverless function. Pages are read one at a time;
 * throws on a PDF it cannot open (corrupt, password protected), that has too many pages, items
 * or characters, or that takes longer than the deadline. The caller maps every throw to one friendly message.
 */
export async function extractPdfPages(data: Uint8Array, options: ExtractOptions = {}): Promise<PdfPageText[]> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.deadlineMs ?? PDF_DEADLINE_MS);
  const maxItems = options.maxItems ?? MAX_PDF_ITEMS;
  const maxChars = options.maxChars ?? MAX_PDF_CHARS;

  // The pdf.js build bundled by unpdf (6.x) has no `isEvalSupported`: it never compiles font code with eval/new Function.
  const pdf = await getDocumentProxy(data, { stopAtErrors: true });
  try {
    if (pdf.numPages > MAX_PDF_PAGES) throw new Error('Too many pages');
    const pages: PdfPageText[] = [];
    let itemCount = 0;
    let charCount = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      if (now() > deadline) throw new Error('PDF deadline exceeded');
      const content = await (await pdf.getPage(i)).getTextContent();
      const items: PdfPageText['items'] = [];
      for (const raw of content.items as RawTextItem[]) {
        if (typeof raw.str !== 'string') continue;
        itemCount += 1;
        charCount += raw.str.length;
        if (itemCount > maxItems) throw new Error('Too many text items');
        if (charCount > maxChars) throw new Error('Too much text');
        if (!raw.str.trim()) continue;
        const transform = Array.isArray(raw.transform) ? raw.transform : [];
        items.push({ str: raw.str, x: Number(transform[4]), y: Number(transform[5]), width: Number(raw.width) });
      }
      pages.push({ items });
    }
    return pages;
  } finally {
    // This pdf.js destroys a document through its loading task (PDFDocumentProxy.destroy was removed).
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}
