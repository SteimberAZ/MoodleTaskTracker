import type { ReactNode } from 'react';

/*
 * Loading skeletons for the route `loading.tsx` files. Each page skeleton mirrors the structure of the real page and
 * reuses its layout classes (.section, .list, .card, .chips, .pager...), so content replaces it without a layout jump.
 * Styles live in app/skeleton.css. Server components only: no state, no effects.
 */

/** Announced by screen readers while a page streams in; also asserted by the tests. */
export const LOADING_LABEL = 'Cargando…';

/** One shimmering placeholder block; `className` sets its shape and width (see skeleton.css). */
function Sk({ className }: { className: string }) {
  return <span className={`sk-block ${className}`} />;
}

/** Live-region wrapper: announces "Cargando…" once and hides every placeholder block from assistive tech. */
export function SkeletonShell({ children }: { children: ReactNode }) {
  return (
    <div className="sk-root" role="status" aria-busy="true">
      <span className="skeleton-sr">{LOADING_LABEL}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

/* ------------------------------ Shared pieces ------------------------------ */

function Repeat({ times, children }: { times: number; children: (index: number) => ReactNode }) {
  return <>{Array.from({ length: times }, (_, i) => children(i))}</>;
}

function TaskCardSkeleton() {
  return (
    <li className="card task-card">
      <div className="task-top">
        <Sk className="sk-chip" />
        <Sk className="sk-badge" />
      </div>
      <Sk className="sk-title sk-w-80" />
      <Sk className="sk-text-sm sk-w-50" />
      <Sk className="sk-text-sm sk-w-60" />
      <div className="card-actions">
        <Sk className="sk-btn" />
        <Sk className="sk-btn" />
      </div>
    </li>
  );
}

function ReminderCardSkeleton() {
  return (
    <li className="card reminder-card">
      <div className="task-top">
        <Sk className="sk-badge" />
      </div>
      <Sk className="sk-title sk-w-70" />
      <Sk className="sk-text-sm sk-w-50" />
      <Sk className="sk-text-sm sk-w-60" />
      <div className="card-actions">
        <Sk className="sk-btn" />
        <Sk className="sk-btn" />
        <Sk className="sk-btn" />
      </div>
    </li>
  );
}

/** Mirrors <Pagination>: Anterior / page status / Siguiente. */
function PagerSkeleton() {
  return (
    <div className="pager sk-pager">
      <Sk className="sk-btn" />
      <span className="pager-status">
        <Sk className="sk-pager-status" />
      </span>
      <Sk className="sk-btn" />
    </div>
  );
}

function TimezoneNoteSkeleton() {
  return <Sk className="sk-text-sm sk-w-30" />;
}

function PageHeadSkeleton({ lines = 0 }: { lines?: number }) {
  return (
    <header className="page-head">
      <Sk className="sk-h1 sk-w-50" />
      <Repeat times={lines}>{(i) => <Sk key={i} className={`sk-text ${i === lines - 1 ? 'sk-w-60' : 'sk-w-90'}`} />}</Repeat>
    </header>
  );
}

/** A `.card.item` section: title, a couple of text lines and one action. */
function InfoCardSkeleton({ lines = 2, action = true }: { lines?: number; action?: boolean }) {
  return (
    <section className="card item">
      <Sk className="sk-h2 sk-w-50" />
      <Repeat times={lines}>{(i) => <Sk key={i} className={`sk-text ${i === lines - 1 ? 'sk-w-70' : 'sk-w-100'}`} />}</Repeat>
      {action && (
        <div className="actions">
          <Sk className="sk-btn sk-w-50" />
        </div>
      )}
    </section>
  );
}

function RemindersTabsSkeleton() {
  return (
    <div className="segmented-tabs sk-tabs">
      <Sk className="sk-tab" />
      <Sk className="sk-tab" />
    </div>
  );
}

/* ------------------------------ Pages ------------------------------ */

/** `/` Tareas: title, three filter chips, task cards, pager. */
export function HomeSkeleton() {
  return (
    <SkeletonShell>
      <section className="section">
        <div className="section-head">
          <Sk className="sk-h1 sk-w-30" />
        </div>
        <div className="chips">
          <Repeat times={3}>{(i) => <Sk key={i} className="sk-filter" />}</Repeat>
        </div>
        <ul className="list">
          <Repeat times={5}>{(i) => <TaskCardSkeleton key={i} />}</Repeat>
        </ul>
        <PagerSkeleton />
      </section>
      <TimezoneNoteSkeleton />
    </SkeletonShell>
  );
}

/** `/recordatorios`: tabs, title with the "Nuevo" button, intro, reminder cards, pager, schedule link card. */
export function RemindersSkeleton() {
  return (
    <SkeletonShell>
      <RemindersTabsSkeleton />
      <section className="section">
        <div className="section-head">
          <Sk className="sk-h1 sk-w-50" />
          <Sk className="sk-btn sk-btn-sm" />
        </div>
        <div className="section-intro">
          <Sk className="sk-text sk-w-100" />
          <Sk className="sk-text sk-w-70" />
        </div>
        <ul className="list">
          <Repeat times={4}>{(i) => <ReminderCardSkeleton key={i} />}</Repeat>
        </ul>
        <PagerSkeleton />
      </section>
      <section className="card item section">
        <Sk className="sk-h2 sk-w-50" />
        <Sk className="sk-text sk-w-90" />
        <div className="actions">
          <Sk className="sk-btn sk-w-60" />
        </div>
      </section>
      <TimezoneNoteSkeleton />
    </SkeletonShell>
  );
}

/** `/horario`: tabs, title, the schedule day groups and the class reminder card. */
export function ScheduleSkeleton() {
  return (
    <SkeletonShell>
      <RemindersTabsSkeleton />
      <section className="section">
        <header className="page-head">
          <Sk className="sk-h1 sk-w-60" />
          <Sk className="sk-text sk-w-40" />
        </header>
        <div className="schedule-days">
          <Repeat times={2}>
            {(d) => (
              <div key={d} className="schedule-day">
                <Sk className="sk-title sk-w-30" />
                <div className="class-list">
                  <Repeat times={2}>
                    {(c) => (
                      <div key={c} className="class-item">
                        <div className="sk-meta-row">
                          <Sk className="sk-text" />
                          <Sk className="sk-text-sm" />
                        </div>
                        <div className="class-body">
                          <Sk className="sk-text sk-w-70" />
                          <Sk className="sk-text-sm sk-w-50" />
                        </div>
                      </div>
                    )}
                  </Repeat>
                </div>
              </div>
            )}
          </Repeat>
        </div>
      </section>
      <InfoCardSkeleton lines={2} action={false} />
      <TimezoneNoteSkeleton />
    </SkeletonShell>
  );
}

function HistoryItemSkeleton() {
  return (
    <li className="card hist-item">
      <Sk className="sk-icon" />
      <div className="sk-hist-main">
        <Sk className="sk-title sk-w-70" />
        <Sk className="sk-text-sm sk-w-100" />
        <Sk className="sk-text-sm sk-w-40" />
      </div>
    </li>
  );
}

/** `/notificaciones`: header, push setup card, history with filter chips and day groups. */
export function NotificationsSkeleton() {
  return (
    <SkeletonShell>
      <PageHeadSkeleton lines={2} />
      {/* The push setup card starts collapsed: one 44px header row (.push-toggle: title, status pill, chevron). */}
      <section className="card push-card push-collapsible">
        <Sk className="sk-toggle-row" />
      </section>
      <section className="section">
        <div className="section-head">
          <Sk className="sk-h2 sk-w-40" />
        </div>
        <div className="chips hist-chips">
          <Repeat times={3}>{(i) => <Sk key={i} className="sk-pill" />}</Repeat>
        </div>
        <div className="hist-day">
          <Sk className="sk-text-sm sk-w-30" />
          <ul className="hist-list">
            <Repeat times={4}>{(i) => <HistoryItemSkeleton key={i} />}</Repeat>
          </ul>
        </div>
      </section>
      <TimezoneNoteSkeleton />
    </SkeletonShell>
  );
}

/**
 * `/cuenta`: header and the profile / push / ntfy cards. Every block is sized from the real page (see the `sk-card-title`,
 * `sk-para`, `sk-dt` and `sk-note` rules in skeleton.css) so the cards keep their height, and the page its scrollability,
 * when the content swaps in. The ntfy card in particular is the tallest one; it must not be a short placeholder.
 */
export function AccountSkeleton() {
  return (
    <SkeletonShell>
      <PageHeadSkeleton />
      <section className="card item">
        <Sk className="sk-card-title sk-w-30" />
        <div className="meta">
          <div className="sk-lines">
            <Sk className="sk-dt sk-w-60" />
            <Repeat times={2}>{(i) => <Sk key={i} className="sk-text sk-w-90" />}</Repeat>
          </div>
          <div className="sk-lines">
            <Sk className="sk-dt sk-w-60" />
            <Sk className="sk-text sk-w-90" />
          </div>
        </div>
      </section>
      <section className="card item">
        <Sk className="sk-card-title sk-w-70" />
        <div className="sk-lines">
          <Sk className="sk-para sk-w-100" />
          <Sk className="sk-para sk-w-60" />
        </div>
        <div className="actions">
          <Sk className="sk-btn sk-btn-xl" />
        </div>
      </section>
      <section className="card item">
        <Sk className="sk-card-title sk-w-50" />
        <div className="sk-lines">
          <Sk className="sk-para sk-w-100" />
          <Sk className="sk-para sk-w-70" />
        </div>
        <Sk className="sk-switch" />
        <div className="meta">
          <div className="sk-lines">
            <Sk className="sk-dt sk-w-50" />
            <Repeat times={3}>{(i) => <Sk key={i} className="sk-text sk-w-100" />}</Repeat>
          </div>
          <div className="sk-lines">
            <Repeat times={2}>{(i) => <Sk key={i} className="sk-dt sk-w-70" />}</Repeat>
            <Repeat times={4}>{(i) => <Sk key={i} className="sk-text sk-w-100" />}</Repeat>
          </div>
        </div>
        <div className="actions">
          <Sk className="sk-btn sk-btn-xl" />
        </div>
        <div className="actions">
          <Sk className="sk-btn sk-btn-lg" />
        </div>
        <div className="sk-lines">
          <Sk className="sk-note sk-w-100" />
          <Sk className="sk-note sk-w-60" />
        </div>
      </section>
    </SkeletonShell>
  );
}

/** `/admin`: header, invites (form plus cards) and users (cards). */
export function AdminSkeleton() {
  return (
    <SkeletonShell>
      <PageHeadSkeleton />
      <Sk className="sk-h2 sk-w-30 section-title" />
      <div className="sk-form">
        <Sk className="sk-input" />
        <Sk className="sk-btn sk-btn-md" />
      </div>
      <ul className="list">
        <Repeat times={2}>
          {(i) => (
            <li key={i} className="card item">
              <div className="item-head">
                <Sk className="sk-h2 sk-w-50" />
                <Sk className="sk-chip" />
              </div>
              <div className="meta">
                <div className="sk-meta-row">
                  <Sk className="sk-text-sm" />
                  <Sk className="sk-text" />
                </div>
                <div className="sk-meta-row">
                  <Sk className="sk-text-sm" />
                  <Sk className="sk-text" />
                </div>
              </div>
            </li>
          )}
        </Repeat>
      </ul>
      <Sk className="sk-h2 sk-w-30 section-title" />
      <ul className="list">
        <Repeat times={3}>
          {(i) => (
            <li key={i} className="card item">
              <div className="item-head">
                <Sk className="sk-h2 sk-w-60" />
                <Sk className="sk-chip" />
              </div>
              <div className="meta">
                <div className="sk-meta-row">
                  <Sk className="sk-text-sm" />
                  <Sk className="sk-text" />
                </div>
                <div className="sk-meta-row">
                  <Sk className="sk-text-sm" />
                  <Sk className="sk-text" />
                </div>
              </div>
            </li>
          )}
        </Repeat>
      </ul>
    </SkeletonShell>
  );
}

/** `/tareas/[id]`: back link, title block, info card, description, automatic alerts, actions. */
export function TaskDetailSkeleton() {
  return (
    <SkeletonShell>
      <article className="detail">
        <Sk className="sk-back" />
        <header className="detail-head">
          <div className="task-top">
            <Sk className="sk-chip" />
          </div>
          <Sk className="sk-h1 sk-w-90" />
          <Sk className="sk-text sk-w-50" />
        </header>
        <section className="card detail-card">
          <div className="meta">
            <Repeat times={3}>
              {(i) => (
                <div key={i} className="sk-meta-row">
                  <Sk className="sk-text-sm" />
                  <Sk className="sk-text" />
                </div>
              )}
            </Repeat>
          </div>
        </section>
        <section className="card detail-card">
          <Sk className="sk-h2 sk-w-30" />
          <Sk className="sk-text sk-w-100" />
          <Sk className="sk-text sk-w-100" />
          <Sk className="sk-text sk-w-70" />
        </section>
        <section className="card detail-card">
          <Sk className="sk-h2 sk-w-50" />
          <div className="auto-list">
            <Repeat times={3}>
              {(i) => (
                <div key={i} className="sk-auto-row">
                  <Sk className="sk-icon" />
                  <Sk className="sk-text sk-w-60" />
                </div>
              )}
            </Repeat>
          </div>
        </section>
        <div className="detail-actions">
          <Sk className="sk-btn" />
          <Sk className="sk-btn" />
        </div>
      </article>
    </SkeletonShell>
  );
}

/** `/reminders/new` and `/reminders/[id]/edit`: back link, title and the reminder form fields. */
export function ReminderFormSkeleton() {
  return (
    <SkeletonShell>
      <Sk className="sk-back" />
      <Sk className="sk-h1 sk-w-60 sk-form-title" />
      <div className="sk-form">
        <div className="sk-field">
          <Sk className="sk-text-sm sk-w-30" />
          <Sk className="sk-input" />
        </div>
        <div className="sk-field">
          <Sk className="sk-text-sm sk-w-30" />
          <Sk className="sk-textarea" />
        </div>
        <div className="sk-field">
          <Sk className="sk-text-sm sk-w-50" />
          <Sk className="sk-input" />
        </div>
        <div className="sk-field">
          <Sk className="sk-text-sm sk-w-40" />
          <Sk className="sk-input" />
        </div>
        <div className="sk-field">
          <Sk className="sk-text-sm sk-w-40" />
          <Sk className="sk-input" />
        </div>
        <div className="sk-field">
          <Sk className="sk-text-sm sk-w-30" />
          <Sk className="sk-input" />
        </div>
        <div className="actions">
          <Sk className="sk-btn sk-btn-lg" />
          <Sk className="sk-btn sk-btn-md" />
        </div>
      </div>
    </SkeletonShell>
  );
}
