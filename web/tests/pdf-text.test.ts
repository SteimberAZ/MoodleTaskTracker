import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeItem {
  str?: string;
  transform?: number[];
  width?: number;
}

const state = vi.hoisted(() => ({
  pages: [] as FakeItem[][],
  numPages: undefined as number | undefined,
  destroy: undefined as unknown as ReturnType<typeof vi.fn>,
  getPage: undefined as unknown as ReturnType<typeof vi.fn>,
  options: undefined as unknown,
}));

vi.mock('unpdf', () => ({
  getDocumentProxy: vi.fn(async (_data: Uint8Array, options: unknown) => {
    state.options = options;
    return {
      numPages: state.numPages ?? state.pages.length,
      getPage: state.getPage,
      loadingTask: { destroy: state.destroy },
    };
  }),
}));

import { MAX_PDF_CHARS, MAX_PDF_ITEMS, MAX_PDF_PAGES, extractPdfPages } from '@/lib/pdf-text';

const item = (str: string, x = 10, y = 700, width = 30): FakeItem => ({ str, transform: [1, 0, 0, 1, x, y], width });
const DATA = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

beforeEach(() => {
  state.pages = [];
  state.numPages = undefined;
  state.options = undefined;
  state.destroy = vi.fn(async () => undefined);
  state.getPage = vi.fn(async (i: number) => ({ getTextContent: async () => ({ items: state.pages[i - 1] }) }));
});

describe('extractPdfPages', () => {
  it('reads every page with stopAtErrors and maps the coordinates', async () => {
    state.pages = [[item('Lunes', 50, 600, 40), item('   '), { type: 'beginMarkedContent' } as FakeItem], [item('Martes', 60, 500, 45)]];
    const pages = await extractPdfPages(DATA);
    expect(state.options).toEqual({ stopAtErrors: true });
    expect(pages).toEqual([
      { items: [{ str: 'Lunes', x: 50, y: 600, width: 40 }] },
      { items: [{ str: 'Martes', x: 60, y: 500, width: 45 }] },
    ]);
    expect(state.getPage).toHaveBeenCalledTimes(2);
    expect(state.destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects too many pages without reading any and still destroys the document', async () => {
    state.numPages = MAX_PDF_PAGES + 1;
    await expect(extractPdfPages(DATA)).rejects.toThrow();
    expect(state.getPage).not.toHaveBeenCalled();
    expect(state.destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects more text items than the cap', async () => {
    state.pages = [Array.from({ length: MAX_PDF_ITEMS + 1 }, () => item('x'))];
    await expect(extractPdfPages(DATA)).rejects.toThrow(/items/);
    expect(state.destroy).toHaveBeenCalledTimes(1);
  });

  it('counts the item cap across pages', async () => {
    state.pages = [Array.from({ length: 3 }, () => item('x')), Array.from({ length: 3 }, () => item('y'))];
    await expect(extractPdfPages(DATA, { maxItems: 5 })).rejects.toThrow(/items/);
  });

  it('rejects more characters than the cap', async () => {
    state.pages = [[item('a'.repeat(MAX_PDF_CHARS)), item('b')]];
    await expect(extractPdfPages(DATA)).rejects.toThrow(/text/);
  });

  it('stops between pages once the soft deadline has passed', async () => {
    state.pages = [[item('uno')], [item('dos')], [item('tres')]];
    let clock = 0;
    state.getPage = vi.fn(async (i: number) => {
      clock += 5_000;
      return { getTextContent: async () => ({ items: state.pages[i - 1] }) };
    });
    await expect(extractPdfPages(DATA, { now: () => clock, deadlineMs: 8_000 })).rejects.toThrow(/deadline/);
    expect(state.getPage).toHaveBeenCalledTimes(2);
    expect(state.destroy).toHaveBeenCalledTimes(1);
  });

  it('ignores a failing destroy', async () => {
    state.pages = [[item('ok')]];
    state.destroy = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(extractPdfPages(DATA)).resolves.toHaveLength(1);
  });
});
