import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import TaskFilters from '@/components/TaskFilters';
import { ListPendingSkeleton } from '@/components/Skeletons';

describe('ListPendingSkeleton', () => {
  it('renders a hidden-from-AT tasks skeleton list', () => {
    const html = renderToStaticMarkup(createElement(ListPendingSkeleton, { variant: 'tasks' }));
    expect(html).toContain('class="list-pending"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('class="list"');
  });

  it('renders a history skeleton with day group and list', () => {
    const html = renderToStaticMarkup(createElement(ListPendingSkeleton, { variant: 'history' }));
    expect(html).toContain('class="list-pending"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('class="hist-list"');
  });
});

describe('TaskFilters pending marker', () => {
  it('puts a LinkPending marker inside every filter link', () => {
    const html = renderToStaticMarkup(createElement(TaskFilters, { active: 'pendientes', counts: null }));
    const links = html.split('</a>').filter((chunk) => chunk.includes('<a '));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toContain('class="link-pending"');
    }
    expect(html.split('link-pending').length - 1).toBe(links.length);
  });
});
