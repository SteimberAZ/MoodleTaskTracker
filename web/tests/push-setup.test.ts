import { describe, expect, it } from 'vitest';
import type { PushState } from '@/lib/push';
import {
  ACTIVATE_NOTIFICATIONS_HREF,
  isSetupLocked,
  isSetupOpen,
  parseActivarParam,
  pushStatusPill,
  type SetupOpenInput,
} from '@/lib/push-setup';

const base: SetupOpenInput = {
  state: 'subscribed',
  activar: false,
  focusedNotification: false,
  pending: false,
  error: false,
  override: null,
};
const open = (over: Partial<SetupOpenInput>) => isSetupOpen({ ...base, ...over });

describe('isSetupOpen', () => {
  it('starts collapsed when this device is already subscribed', () => {
    expect(open({})).toBe(false);
  });

  it('starts expanded when the device is not subscribed (it needs action)', () => {
    for (const state of ['default', 'denied', 'needs-install', 'unsupported', 'unconfigured'] as PushState[]) {
      expect(open({ state })).toBe(true);
    }
  });

  it('stays collapsed while the device is still being checked', () => {
    expect(open({ state: null })).toBe(false);
  });

  it('opens from the activate entry point, even when subscribed or still checking', () => {
    expect(open({ activar: true })).toBe(true);
    expect(open({ activar: true, state: null })).toBe(true);
  });

  it('stays collapsed when opened from a notification, whatever the device state', () => {
    expect(open({ focusedNotification: true, state: 'default' })).toBe(false);
    expect(open({ focusedNotification: true, state: 'denied' })).toBe(false);
  });

  it('the activate entry point wins over a tapped notification', () => {
    expect(open({ activar: true, focusedNotification: true })).toBe(true);
  });

  it('never collapses while a request is pending or an error is showing', () => {
    expect(open({ pending: true, override: false, focusedNotification: true })).toBe(true);
    expect(open({ error: true, override: false })).toBe(true);
    expect(open({ pending: true })).toBe(true);
  });

  it('follows the user choice once they tap the header or start an action', () => {
    expect(open({ override: true })).toBe(true);
    expect(open({ state: 'default', override: false })).toBe(false);
    expect(open({ activar: true, override: false })).toBe(false);
  });
});

describe('isSetupLocked', () => {
  it('locks only while pending or showing an error', () => {
    expect(isSetupLocked({ pending: false, error: false })).toBe(false);
    expect(isSetupLocked({ pending: true, error: false })).toBe(true);
    expect(isSetupLocked({ pending: false, error: true })).toBe(true);
  });
});

describe('pushStatusPill', () => {
  it('has a distinct text for every state', () => {
    expect(pushStatusPill('subscribed')).toEqual({ text: 'Activas ✓', tone: 'activo' });
    expect(pushStatusPill('default').text).toBe('Desactivadas');
    expect(pushStatusPill('needs-install').text).toBe('Instala la app');
    expect(pushStatusPill('denied')).toEqual({ text: 'Bloqueadas', tone: 'urgente' });
    expect(pushStatusPill('unsupported').text).toBe('No disponible');
    expect(pushStatusPill('unconfigured').text).toBe('No disponible');
    expect(pushStatusPill(null).text).toBe('Comprobando…');
  });
});

describe('parseActivarParam', () => {
  it('is true only for 1 / true', () => {
    expect(parseActivarParam('1')).toBe(true);
    expect(parseActivarParam('true')).toBe(true);
    expect(parseActivarParam(['1', '0'])).toBe(true);
    for (const v of [undefined, null, '', '0', 'yes', 'false', ['0', '1']]) expect(parseActivarParam(v)).toBe(false);
  });

  it('matches the link the home banner uses', () => {
    expect(ACTIVATE_NOTIFICATIONS_HREF).toBe('/notificaciones?activar=1');
  });
});
