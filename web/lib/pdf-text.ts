import { extractTextItems, getDocumentProxy } from 'unpdf';
import type { PdfPageText } from './sga-schedule';

/** The SGA schedule is 1-2 pages; anything much longer is not the document this feature expects. */
export const MAX_PDF_PAGES = 10;
export const MAX_PDF_BYTES = 2 * 1024 * 1024;

/** True when the bytes start with the PDF signature (`%PDF-`). The declared MIME type is never trusted. */
export function hasPdfSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

/**
 * Text items with their coordinates for every page. Uses `unpdf`'s serverless pdf.js build: no canvas and no
 * worker thread are needed, so it runs inside a Node serverless function. Throws on a PDF it cannot open
 * (corrupt, password protected) or that has too many pages.
 */
export async function extractPdfPages(data: Uint8Array): Promise<PdfPageText[]> {
  const pdf = await getDocumentProxy(data);
  try {
    if (pdf.numPages > MAX_PDF_PAGES) throw new Error('Too many pages');
    const { items } = await extractTextItems(pdf);
    return items.map((page) => ({
      items: page.filter((i) => i.str.trim()).map((i) => ({ str: i.str, x: i.x, y: i.y, width: i.width })),
    }));
  } finally {
    await pdf.cleanup().catch(() => undefined);
  }
}
