import type { PushState } from './push';

/**
 * Pure rules of the collapsible "Notificaciones en este dispositivo" card on /notificaciones:
 * when it starts open, what its status pill says and how the "activate" entry points reach it.
 */

/** Entry point used by the home banner (and any "activate" link): opens the card expanded and scrolls to it. */
export const ACTIVATE_NOTIFICATIONS_HREF = '/notificaciones?activar=1';

/** DOM id of the card, also usable as a `#activar` anchor. */
export const PUSH_SETUP_ID = 'activar';

/** `?activar=1` (or `true`), first value when repeated. */
export function parseActivarParam(raw: string | string[] | undefined | null): boolean {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === '1' || value === 'true';
}

export interface SetupOpenInput {
  /** Push state of this device; null until the first check finishes. */
  state: PushState | null;
  /** Arrived through an "activate" entry point (`?activar=1` or `#activar`). */
  activar: boolean;
  /** Arrived from a tapped notification (`?n=<id>`): the highlighted entry is the focus, not the setup. */
  focusedNotification: boolean;
  /** A request (enable, test, disable, install) is in flight. */
  pending: boolean;
  /** The last request failed and its message is showing. */
  error: boolean;
  /** What the user chose by tapping the header or starting an action; null while they have not. */
  override: boolean | null;
}

/**
 * Whether the card is expanded. Precedence: a pending request or a visible error always keeps it open
 * (progress and results must never hide), then the user's own choice, then the "activate" entry point,
 * then a tapped notification (collapsed), and finally the device: collapsed when already subscribed
 * (or still being checked), expanded when it needs action.
 */
export function isSetupOpen(input: SetupOpenInput): boolean {
  if (input.pending || input.error) return true;
  if (input.override !== null) return input.override;
  if (input.activar) return true;
  if (input.focusedNotification) return false;
  if (input.state === null) return false;
  return input.state !== 'subscribed';
}

/** True when the card cannot be collapsed right now (pending request or visible error). */
export function isSetupLocked(input: Pick<SetupOpenInput, 'pending' | 'error'>): boolean {
  return input.pending || input.error;
}

export type PillTone = 'neutral' | 'activo' | 'pausado' | 'urgente' | 'finalizado';

export interface StatusPill {
  text: string;
  tone: PillTone;
}

/** Short status shown in the collapsed header. Meaning never relies on color: every state has its own text. */
export function pushStatusPill(state: PushState | null): StatusPill {
  switch (state) {
    case 'subscribed':
      return { text: 'Activas ✓', tone: 'activo' };
    case 'default':
      return { text: 'Desactivadas', tone: 'pausado' };
    case 'needs-install':
      return { text: 'Instala la app', tone: 'pausado' };
    case 'denied':
      return { text: 'Bloqueadas', tone: 'urgente' };
    case 'unsupported':
    case 'unconfigured':
      return { text: 'No disponible', tone: 'finalizado' };
    default:
      return { text: 'Comprobando…', tone: 'neutral' };
  }
}
