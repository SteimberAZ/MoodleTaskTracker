'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { relativeLabel } from '@/lib/notification-log';
import { deliveryFailing, type PushServerStatus, type PushState } from '@/lib/push';
import { disablePush, enablePush, requestTestPush, runInstallPrompt, waitForTestDelivery } from '@/lib/push-client';
import { PUSH_SETUP_ID, isSetupLocked, isSetupOpen, pushStatusPill, type StatusPill } from '@/lib/push-setup';
import { BellIcon, CheckIcon, ChevronRightIcon, ShareIcon } from './Icons';
import { usePushDevice } from './usePushDevice';

type Busy = 'enable' | 'test' | 'disable' | 'install' | 'check' | null;
type Notice = { tone: 'ok' | 'error' | 'warning'; text: string };

const BODY_ID = 'push-setup-body';
const NOTICE_CLASS: Record<Notice['tone'], string> = { ok: 'success', error: 'alert', warning: 'warning' };

interface Props {
  vapidPublicKey?: string;
  /** Arrived through an "activate" link (`?activar=1`): start expanded and scroll to the card. */
  activar?: boolean;
  /** Arrived from a tapped notification (`?n=<id>`): start collapsed so the highlighted entry is the focus. */
  focusedNotification?: boolean;
}

/** The header pill, including the states that only exist once the server was asked. Never "Activas" when it fails. */
function devicePill(state: PushState | null, server: PushServerStatus | null): StatusPill {
  if (state === 'stale') return { text: 'Hay que renovar', tone: 'urgente' };
  if (state === 'unsynced') return { text: 'Sin registrar', tone: 'urgente' };
  if (state === 'subscribed' && server && deliveryFailing(server)) return { text: 'Con fallos', tone: 'urgente' };
  return pushStatusPill(state);
}

/**
 * Collapsible, device-aware setup of Web Push. The header row (bell, title, status pill, chevron) is always
 * there with a stable height; the body depends on the platform, permission and subscription of this device,
 * and on what the server knows about it (registered, last delivery, recent failures).
 * It starts collapsed when this device is already subscribed and expanded when it needs action (see isSetupOpen).
 * Results are announced through one persistent live region, outside the state branches.
 */
export default function PushSetup({ vapidPublicKey, activar = false, focusedNotification = false }: Props) {
  const router = useRouter();
  const { snapshot, installable, refresh } = usePushDevice(vapidPublicKey);
  const [busy, setBusy] = useState<Busy>(null);
  const [watching, setWatching] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [override, setOverride] = useState<boolean | null>(null);
  const root = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Set by a user-initiated enable/disable: the next card's heading receives focus once it renders.
  const focusNext = useRef(false);
  const watch = useRef<AbortController | null>(null);

  // Entry points: `?activar=1` (server) or `#activar` (client only) open the card and bring it into view.
  useEffect(() => {
    const byHash = window.location.hash === `#${PUSH_SETUP_ID}`;
    if (byHash) setOverride(true);
    if (activar || byHash) {
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      root.current?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    }
  }, [activar]);

  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    heading.current?.focus();
  }, [snapshot]);

  useEffect(() => () => watch.current?.abort(), []);

  const state = snapshot?.state ?? null;
  const server = snapshot?.server ?? null;
  const platform = snapshot?.platform;
  const standalone = snapshot?.standalone ?? false;
  const pending = busy !== null;
  const error = notice?.tone === 'error';
  const open = isSetupOpen({ state, activar, focusedNotification, pending, error, override });
  const locked = isSetupLocked({ pending, error });
  const pill = devicePill(state, server);

  const GENERIC_ERROR: Notice = { tone: 'error', text: 'Algo salió mal. Inténtalo de nuevo.' };

  function stopWatching() {
    watch.current?.abort();
    watch.current = null;
    setWatching(false);
  }

  async function onEnable() {
    if (busy) return;
    stopWatching();
    setBusy('enable');
    setOverride(true); // progress and result stay visible inside the card
    setNotice(null);
    try {
      // enablePush calls Notification.requestPermission() before awaiting anything (iOS needs the click's gesture).
      const result = await enablePush(vapidPublicKey ?? '');
      setNotice(
        result.ok
          ? { tone: 'ok', text: 'Listo: las notificaciones están activas en este dispositivo.' }
          : { tone: 'error', text: result.message },
      );
      focusNext.current = true;
      await refresh();
      if (result.ok) router.refresh(); // the server-side "no devices" notice and history follow
    } catch {
      setNotice(GENERIC_ERROR);
    } finally {
      setBusy(null);
    }
  }

  /** Follows a requested test until the server records a delivery after it, or 90 s pass. */
  async function followTest(endpoint: string, requestedAtMs: number) {
    stopWatching();
    const controller = new AbortController();
    watch.current = controller;
    setWatching(true);
    try {
      const outcome = await waitForTestDelivery(endpoint, requestedAtMs, { signal: controller.signal });
      if (outcome === 'aborted') return;
      setNotice(
        outcome === 'delivered'
          ? { tone: 'ok', text: 'Entregada ✓ La prueba llegó al servicio de notificaciones de este dispositivo.' }
          : {
              tone: 'warning',
              text: 'El servidor de avisos no respondió. Si la prueba no aparece, inténtalo de nuevo más tarde.',
            },
      );
      // The client router cache keeps pages for a while: refresh so the history shows the test entry.
      router.refresh();
      void refresh();
    } finally {
      if (watch.current === controller) {
        watch.current = null;
        setWatching(false);
      }
    }
  }

  async function onTest() {
    if (busy || watching) return;
    setBusy('test');
    setOverride(true);
    setNotice(null);
    try {
      const result = await requestTestPush();
      if (!result.ok) {
        setNotice({ tone: 'error', text: result.message });
        return;
      }
      setNotice(
        result.warning
          ? { tone: 'warning', text: result.message }
          : { tone: 'ok', text: `${result.message} Esperando la confirmación del servidor…` },
      );
      void followTest(result.endpoint, result.requestedAtMs);
    } catch {
      setNotice(GENERIC_ERROR);
    } finally {
      setBusy(null);
    }
  }

  async function onDisable() {
    if (busy) return;
    stopWatching();
    setBusy('disable');
    setOverride(true);
    setNotice(null);
    try {
      const result = await disablePush();
      setNotice(
        result.ok
          ? { tone: 'ok', text: 'Notificaciones desactivadas en este dispositivo.' }
          : { tone: 'error', text: 'No se pudo desactivar del todo. Inténtalo de nuevo.' },
      );
      focusNext.current = true;
      await refresh();
      router.refresh();
    } catch {
      setNotice(GENERIC_ERROR);
    } finally {
      setBusy(null);
    }
  }

  async function onRecheck() {
    if (busy) return;
    setBusy('check');
    setNotice(null);
    try {
      const next = await refresh();
      if (next.state === 'denied') {
        setNotice({ tone: 'warning', text: 'Siguen bloqueadas. Permítelas en los ajustes del dispositivo y vuelve a comprobar.' });
      } else {
        focusNext.current = true;
      }
    } catch {
      setNotice(GENERIC_ERROR);
    } finally {
      setBusy(null);
    }
  }

  async function onInstall() {
    if (busy) return;
    setBusy('install');
    setOverride(true);
    try {
      await runInstallPrompt();
      await refresh();
    } catch {
      setNotice(GENERIC_ERROR);
    } finally {
      setBusy(null);
    }
  }

  const title = (children: ReactNode) => (
    <h3 ref={heading} tabIndex={-1} className="card-title">
      {children}
    </h3>
  );

  const installButton =
    installable && !standalone ? (
      <button type="button" className="btn" onClick={onInstall} disabled={busy !== null}>
        {busy === 'install' ? 'Abriendo…' : 'Instalar app'}
      </button>
    ) : null;

  const enableButton = (label: string, primary = true) => (
    <button type="button" className={`btn${primary ? ' primary' : ''}`} onClick={onEnable} disabled={busy !== null}>
      {busy === 'enable' ? 'Activando…' : label}
    </button>
  );

  let body: ReactNode = (
    <p className="muted" aria-busy="true">
      Comprobando este dispositivo…
    </p>
  );

  if (state === 'unconfigured') {
    body = (
      <>
        {title('No disponible por ahora')}
        <p className="muted">Las notificaciones todavía no están configuradas. Inténtalo más tarde.</p>
      </>
    );
  } else if (state === 'needs-install') {
    body = (
      <>
        {title('Primero agrega la app a tu pantalla de inicio')}
        <p>En iPhone y iPad las notificaciones solo funcionan desde la app instalada.</p>
        <ol className="how-to">
          <li>
            Toca <strong>Compartir</strong> <span className="inline-icon"><ShareIcon /></span> en la barra de Safari.
          </li>
          <li>
            Elige <strong>«Añadir a pantalla de inicio»</strong>.
          </li>
          <li>
            Abre <strong>mineral tareas</strong> desde el ícono nuevo y vuelve a esta página.
          </li>
          <li>Si te lo pide, vuelve a iniciar sesión dentro de la app.</li>
        </ol>
        <p className="muted small">Requiere iOS 16.4 o superior.</p>
      </>
    );
  } else if (state === 'unsupported') {
    body = (
      <>
        {title('Este dispositivo no admite notificaciones')}
        <p className="muted">
          {platform === 'ios'
            ? 'Necesitas iOS 16.4 o superior para recibir notificaciones desde la app instalada. Actualiza tu iPhone o iPad e inténtalo de nuevo.'
            : 'Tu navegador no admite notificaciones push. Prueba con una versión reciente de Chrome, Edge, Firefox o Safari.'}
        </p>
      </>
    );
  } else if (state === 'denied') {
    body = (
      <>
        {title('Las notificaciones están bloqueadas')}
        <p>Para activarlas tienes que permitirlas en los ajustes de tu dispositivo:</p>
        <ul className="how-to">
          {platform === 'ios' && (
            <li>
              <strong>iPhone / iPad:</strong> Ajustes → Notificaciones → mineral tareas → Permitir notificaciones.
            </li>
          )}
          {platform === 'android' && (
            <li>
              <strong>Android:</strong> mantén presionado el ícono de la app → Información de la app → Notificaciones →
              Permitir.
            </li>
          )}
          {platform === 'desktop' && (
            <li>
              <strong>Computadora:</strong> haz clic en el candado junto a la dirección → Notificaciones → Permitir.
            </li>
          )}
        </ul>
        <p className="muted small">Al volver a esta página se actualizará sola.</p>
        <div className="actions">
          <button type="button" className="btn" onClick={onRecheck} disabled={busy !== null}>
            {busy === 'check' ? 'Comprobando…' : 'Comprobar de nuevo'}
          </button>
        </div>
      </>
    );
  } else if (state === 'stale') {
    body = (
      <>
        {title('Hay que renovar la activación')}
        <p className="muted">
          Este dispositivo se activó con una clave anterior y ya no recibe avisos. Renueva la activación para volver a
          recibirlos.
        </p>
        <div className="actions">
          {enableButton('Renovar activación')}
          {installButton}
        </div>
      </>
    );
  } else if (state === 'unsynced') {
    body = (
      <>
        {title('Este dispositivo no quedó registrado')}
        <p className="muted">
          El navegador tiene las notificaciones activas, pero el servidor no tiene este dispositivo, así que no te
          llegarán avisos.
        </p>
        <div className="actions">
          {enableButton('Reintentar')}
          {installButton}
        </div>
      </>
    );
  } else if (state === 'subscribed') {
    const failing = server ? deliveryFailing(server) : false;
    const lastOk = server?.last_success_at ? (relativeLabel(server.last_success_at, new Date()) ?? 'hace más de un mes') : null;
    body = (
      <>
        {title(
          <>
            <span className="ok-mark" aria-hidden="true"><CheckIcon /></span>
            Activas en este dispositivo
          </>,
        )}
        <p className="muted">Recibirás aquí los avisos de tus tareas y recordatorios. Actívalas también en tus otros dispositivos.</p>
        {server && (
          <p className="muted small">
            {lastOk ? `Último aviso entregado: ${lastOk}` : 'Aún no se ha entregado ningún aviso a este dispositivo.'}
          </p>
        )}
        {failing && (
          <div className="warning" style={{ display: 'grid', gap: 10 }}>
            <p style={{ margin: 0 }}>Los últimos avisos no llegaron a este dispositivo. Reactívalo para volver a intentarlo.</p>
            <div className="actions">{enableButton('Reactivar', false)}</div>
          </div>
        )}
        <div className="actions">
          <button type="button" className="btn primary" onClick={onTest} disabled={busy !== null || watching}>
            {busy === 'test' ? 'Enviando…' : watching ? 'Esperando confirmación…' : 'Enviar prueba'}
          </button>
          <button type="button" className="btn" onClick={onDisable} disabled={busy !== null}>
            {busy === 'disable' ? 'Desactivando…' : 'Desactivar en este dispositivo'}
          </button>
          {installButton}
        </div>

        {(platform === 'android' || platform === 'ios') && (
          <details className="help-box">
            <summary>¿No te llegan?</summary>
            {platform === 'android' ? (
              <ul>
                <li>
                  Quita la optimización de batería para Chrome: <strong>Ajustes → Apps → Chrome → Batería → Sin
                  restricciones</strong>.
                </li>
                <li>No uses «Forzar detención» en Chrome: mientras esté detenido no recibirás avisos.</li>
              </ul>
            ) : (
              <ul>
                <li>
                  Requiere iOS 16.4 o superior y abrir la app desde el ícono de la pantalla de inicio; si borras el
                  ícono, vuelve a activarlas.
                </li>
              </ul>
            )}
          </details>
        )}
      </>
    );
  } else if (state === 'default') {
    body = (
      <>
        {title('Recibe avisos en este dispositivo')}
        <p className="muted">
          Te avisaremos de tus tareas y recordatorios aunque la app esté cerrada. Tu navegador te pedirá permiso.
        </p>
        <div className="actions">
          <button type="button" className="btn primary big" onClick={onEnable} disabled={busy !== null}>
            {busy === 'enable' ? 'Activando…' : 'Activar notificaciones'}
          </button>
          {installButton}
        </div>
      </>
    );
  }

  return (
    <section ref={root} id={PUSH_SETUP_ID} className="card push-card push-collapsible" aria-labelledby="push-setup-title">
      <h2 id="push-setup-title" className="push-head">
        <button
          type="button"
          className="push-toggle"
          aria-expanded={open}
          aria-controls={BODY_ID}
          aria-disabled={locked || undefined}
          onClick={() => {
            if (!locked) setOverride(!open);
          }}
        >
          <span className="push-toggle-icon" aria-hidden="true"><BellIcon /></span>
          <span className="push-toggle-title">Notificaciones en este dispositivo</span>
          <span className={`badge ${pill.tone}`}>{pill.text}</span>
          <span className="push-chevron" aria-hidden="true"><ChevronRightIcon /></span>
        </button>
      </h2>
      <div id={BODY_ID} className="push-body" hidden={!open}>
        {body}
      </div>
      {/* One persistent live region: only its text changes, so every result is announced. */}
      <div role="status" aria-live="polite" style={notice ? { marginTop: 14 } : undefined}>
        {notice && <p className={NOTICE_CLASS[notice.tone]}>{notice.text}</p>}
      </div>
    </section>
  );
}
