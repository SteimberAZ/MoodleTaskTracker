import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AccountSkeleton,
  AdminSkeleton,
  HomeSkeleton,
  LOADING_LABEL,
  NotificationsSkeleton,
  ReminderFormSkeleton,
  RemindersSkeleton,
  ScheduleSkeleton,
  TaskDetailSkeleton,
} from '@/components/Skeletons';

const SKELETONS = {
  HomeSkeleton,
  RemindersSkeleton,
  ScheduleSkeleton,
  NotificationsSkeleton,
  AccountSkeleton,
  AdminSkeleton,
  TaskDetailSkeleton,
  ReminderFormSkeleton,
};

describe.each(Object.entries(SKELETONS))('%s', (_name, Skeleton) => {
  const html = renderToStaticMarkup(createElement(Skeleton));

  it('is a polite status region that announces the loading label', () => {
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(`<span class="skeleton-sr">${LOADING_LABEL}</span>`);
  });

  it('hides every placeholder block from assistive tech', () => {
    expect(html).toContain('aria-hidden="true"');
    // The only text a screen reader may find is the label: placeholder blocks are empty spans.
    const text = html.replace(/<[^>]+>/g, '');
    expect(text).toBe(LOADING_LABEL);
  });

  it('draws shimmering blocks', () => {
    expect(html).toContain('sk-block');
  });
});
