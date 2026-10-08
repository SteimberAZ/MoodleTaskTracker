import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FormState } from '@/app/actions';
import { NavPlaceholder } from '@/components/NavLinks';
import ReminderForm, { countFieldErrors } from '@/components/ReminderForm';

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

describe('ReminderForm error state', () => {
  const initial = { title: '', message: '', amount: '0', unit: 'minutes', startsAt: '', endsAt: '', taskId: '' };
  const render = (initialState: FormState) =>
    renderToStaticMarkup(
      createElement(ReminderForm, {
        action: async (s: FormState) => s,
        initial,
        submitLabel: 'Guardar',
        tasks: [],
        initialState,
      }),
    );

  it('marks each invalid field and points it at its message', () => {
    const html = render({ errors: { title: 'El título es obligatorio.', startsAt: 'Fecha no válida.' }, values: initial });
    expect(html).toMatch(/<input id="rf-title"[^>]*aria-invalid="true"[^>]*aria-describedby="rf-title-error"/);
    expect(html).toContain('<span id="rf-title-error" class="field-error">El título es obligatorio.</span>');
    expect(html).toMatch(/<input id="rf-startsAt"[^>]*aria-describedby="rf-startsAt-error"/);
    expect(html).not.toMatch(/<input id="rf-endsAt"[^>]*aria-invalid/);
  });

  it('renders an alert summary with the number of fields to fix', () => {
    const html = render({ errors: { title: 'x', endsAt: 'y' } });
    expect(html).toContain('<p class="alert" role="alert">Revisa 2 campos.</p>');
  });

  it('shares one frequency message between the amount and the unit', () => {
    const html = render({ errors: { amount: 'Mínimo 5 minutos.', unit: 'Unidad no válida.' } });
    expect(html).toMatch(/<input id="rf-amount"[^>]*aria-labelledby="rf-frequency-legend rf-amount-prefix"/);
    expect(html).toMatch(/<input id="rf-amount"[^>]*aria-describedby="rf-amount-error"/);
    expect(html).toMatch(/<select id="rf-unit"[^>]*aria-describedby="rf-amount-error"/);
    expect(html.match(/class="field-error"/g)).toHaveLength(1);
    expect(countFieldErrors({ amount: 'a', unit: 'b' })).toBe(1);
    expect(html).toContain('Revisa 1 campo.');
  });

  it('keeps errors out of the labels and renders no summary without field errors', () => {
    const html = render({ error: 'No se pudo guardar.' });
    expect(html).toContain('<p class="alert" role="alert" tabindex="-1">No se pudo guardar.</p>');
    expect(html).not.toContain('Revisa');
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toMatch(/<label[^>]*>[^<]*<span/);
  });
});
