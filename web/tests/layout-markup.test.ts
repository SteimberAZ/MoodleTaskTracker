import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NavPlaceholder } from '@/components/NavLinks';

describe('NavPlaceholder (header Suspense fallback)', () => {
  it('keeps a .site-nav element so the body:has(.site-nav) padding does not shift when the nav streams in', () => {
    for (const variant of ['inline', 'bar'] as const) {
      const html = renderToStaticMarkup(createElement(NavPlaceholder, { variant }));
      expect(html).toMatch(new RegExp(`class="site-nav site-nav--${variant} nav-placeholder"`));
    }
  });

  it('reserves the logout slot in the header only', () => {
    expect(renderToStaticMarkup(createElement(NavPlaceholder, { variant: 'inline' }))).toContain('logout-placeholder');
    expect(renderToStaticMarkup(createElement(NavPlaceholder, { variant: 'bar' }))).not.toContain('logout-placeholder');
  });

  it('is empty for assistive tech: no text, no links, every element hidden', () => {
    const html = renderToStaticMarkup(createElement(NavPlaceholder, { variant: 'inline' }));
    expect(html.replace(/<[^>]+>/g, '')).toBe('');
    expect(html).not.toContain('<a');
    const tags = html.match(/<(div|span)\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toContain('aria-hidden="true"');
  });
});
