import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// ClassReminderSetting imports its server action, which pulls in server-only modules.
vi.mock('@/app/horario/actions', () => ({ setClassReminder: vi.fn() }));
// TaskCard renders MuteButton, whose server action pulls in server-only modules.
vi.mock('@/components/MuteButton', () => ({ default: () => null }));
import type { FormState } from '@/app/actions';
import { leadSavedMessage } from '@/components/ClassReminderSetting';
import CopyButton from '@/components/CopyButton';
import LiveStatus from '@/components/LiveStatus';
import { NavPlaceholder } from '@/components/NavLinks';
import ReminderForm, { countFieldErrors } from '@/components/ReminderForm';
import ScheduleDays from '@/components/ScheduleDays';
import TaskCard from '@/components/TaskCard';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('TaskCard overdue badge', () => {
  const task = {
    id: 't1', title: 'Ensayo', course: 'Curso', module: 'assign', status: 'pending', is_dismissed: 0,
    due_timestamp: 1_000, due_date_str: 'ayer', task_url: 'https://evirtual.utm.edu.ec/mod/assign/view.php?id=1',
  } as unknown as Parameters<typeof TaskCard>[0]['task'];

  it('lets the long late-submission badge wrap so it never overflows a 320 px card', () => {
    const html = renderToStaticMarkup(
      createElement(TaskCard, { task, nowSeconds: 2_000, listState: {} as never, overdue: true }),
    );
    expect(html).toContain('class="badge urgente badge-wrap"');
    const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
    expect(css).toMatch(/\.task-top \.badge\.badge-wrap \{[^}]*white-space: normal/);
  });
});

describe('TaskCard without due date', () => {
  const task = {
    id: 't2', title: 'Foro', course: 'Curso', module: 'forum', status: 'pending', is_dismissed: 0,
    due_timestamp: 0, due_date_str: 'Sin fecha límite indicada', task_url: 'https://evirtual.utm.edu.ec/mod/forum/view.php?id=2',
  } as unknown as Parameters<typeof TaskCard>[0]['task'];

  it('shows the undated label, a neutral badge and the Moodle link, without a time element', () => {
    const html = renderToStaticMarkup(createElement(TaskCard, { task, nowSeconds: 2_000, listState: {} as never }));
    expect(html).toContain('Sin fecha de entrega');
    expect(html).toContain('class="badge pausado"');
    expect(html).toContain('Abrir en Moodle');
    expect(html).not.toContain('<time');
  });
});

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

describe('LiveStatus', () => {
  it('stays mounted as a polite status region while empty', () => {
    expect(renderToStaticMarkup(createElement(LiveStatus, {}))).toBe('<p class="sr-only" role="status" aria-live="polite"></p>');
    expect(renderToStaticMarkup(createElement(LiveStatus, { message: 'Copiado' }))).toContain('>Copiado</p>');
  });
});

describe('ScheduleDays heading level', () => {
  const items = [{ index: 0, cls: { subject: 'CÁLCULO', level: 1, parallel: 'A', credits: 4, teacher: null, department: null, weekday: 2, startTime: '07:00', endTime: '09:00', place: null, roomCode: null, roomType: null, floor: null } }];

  it('uses h2 under the page h1 and h3 under a step heading', () => {
    expect(renderToStaticMarkup(createElement(ScheduleDays, { items, headingLevel: 2 }))).toMatch(/<h2 id="day-2" class="schedule-day-title">Martes/);
    expect(renderToStaticMarkup(createElement(ScheduleDays, { items }))).toMatch(/<h3 id="day-2" class="schedule-day-title">Martes/);
  });
});

describe('status messages', () => {
  it('describes the saved class reminder lead time', () => {
    expect(leadSavedMessage(30)).toBe('Aviso de clases: 30 min antes guardado');
    expect(leadSavedMessage(60)).toBe('Aviso de clases: 1 hora antes guardado');
    expect(leadSavedMessage(null)).toBe('Avisos de clases desactivados');
  });

  it('names each copy button after what it copies and keeps its status region mounted', () => {
    const html = renderToStaticMarkup(createElement(CopyButton, { text: 'ABCD-1234' }));
    expect(html).toContain('<button type="button" class="btn">Copiar<span class="sr-only"> ABCD-1234</span></button>');
    expect(html).toContain('<p class="sr-only" role="status" aria-live="polite"></p>');
    const custom = renderToStaticMarkup(createElement(CopyButton, { text: 'x'.repeat(80), label: 'Copiar enlace' }));
    expect(custom).toContain('>Copiar enlace</button>');
  });
});
