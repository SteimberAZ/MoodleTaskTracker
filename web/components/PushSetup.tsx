'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { disablePush, enablePush, requestTestPush, runInstallPrompt } from '@/lib/push-client';
import { PUSH_SETUP_ID, isSetupLocked, isSetupOpen, pushStatusPill } from '@/lib/push-setup';
import { BellIcon, CheckIcon, ChevronRightIcon, ShareIcon } from './Icons';
import { usePushDevice } from './usePushDevice';

type Busy = 'enable' | 'test' | 'disable' | 'install' | null;
type Notice = { tone: 'ok' | 'error'; text: string };

const BODY_ID = 'push-setup-body';

interface Props {
  vapidPublicKey?: string;
  /** Arrived through an "activate" link (`?activar=1`): start expanded and scroll to the card. */
  activar?: boolean;
  /** Arrived from a tapped notification (`?n=<id>`): start collapsed so the highlighted entry is the focus. */
  focusedNotification?: boolean;
}

/**
 * Collapsible, device-aware setup of Web Push. The header row (bell, title, status pill, chevron) is always
 * there with a stable height; the body depends on the platform, permission and subscription of this device.
 * It starts collapsed when this device is already subscribed and expanded when it needs action (see isSetupOpen).
 */
export default function PushSetup({ vapidPublicKey, activar = false, focusedNotification = false }: Props) {
  const { snapshot, installable, refresh } = usePushDevice(vapidPublicKey);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [override, setOverride] = useState<boolean | null>(null);
  const root = useRef<HTMLElement>(null);

  // Entry points: `?activar=1` (server) or `#activar` (client only) open the card and bring it into view.
  useEffect(() => {
    const byHash = window.location.hash === `#${PUSH_SETUP_ID}`;
    if (byHash) setOverride(true);
    if (activar || byHash) {
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      root.current?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    }
  }, [activar]);

  const state = snapshot?.state ?? null;
  const platform = snapshot?.platform;
  const standalone = snapshot?.standalone ?? false;
  const pending = busy !== null;
  const error = notice?.tone === 'error';
  const open = isSetupOpen({ state, activar, focusedNotification, pending, error, override });
  const locked = isSetupLocked({ pending, error });
  const pill = pushStatusPill(state);

  const GENERIC_ERROR: Notice = { tone: 'error', text: 'Algo salió mal. Inténtalo de nuevo.' };

  async function onEnable() {
    if (busy) return;
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
      await refresh();
    } catch {
      setNotice(GENERIC_ERROR);
    } finally {
      setBusy(null);
    }
  }

  async function onTest() {
    if (busy) return;
    setBusy('test');
    setOverride(true);
    setNotice(null);
    try {
      const result = await requestTestPush();
      setNotice({ tone: result.ok ? 'ok' : 'error', text: result.message });
    } catch {
      setNotice(GENERIC_ERROR);
    } finally {
      setBusy(null);
    }
  }

  async function onDisable() {
    if (busy) return;
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
      await refresh();
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

  const installButton =
    installable && !standalone ? (
      <button type="button" className="btn" onClick={onInstall} disabled={busy !== null}>
        {busy === 'install' ? 'Abriendo…' : 'Instalar app'}
      </button>
    ) : null;

  const noticeBox = (
    <div aria-live="polite">
      {notice && (
        <p className={notice.tone === 'ok' ? 'success' : 'alert'} role={notice.tone === 'ok' ? 'status' : 'alert'}>
          {notice.text}
        </p>
      )}
    </div>
  );

  let body: ReactNode = (
    <p className="muted" role="status" aria-busy="true">
      Comprobando este dispositivo…
    </p>
  );

  if (state === 'unconfigured') {
    body = (
      <>
        <h3 className="card-title">No disponible por ahora</h3>
        <p className="muted">Las notificaciones todavía no están configuradas. Inténtalo más tarde.</p>
      </>
    );
  } else if (state === 'needs-install') {
    body = (
      <>
        <h3 className="card-title">Primero agrega la app a tu pantalla de inicio</h3>
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
        </ol>
        <p className="muted small">Requiere iOS 16.4 o superior.</p>
      </>
    );
  } else if (state === 'unsupported') {
    body = (
      <>
        <h3 className="card-title">Este dispositivo no admite notificaciones</h3>
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
        <h3 className="card-title">Las notificaciones están bloqueadas</h3>
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
          <button type="button" className="btn" onClick={() => void refresh()}>
            Comprobar de nuevo
          </button>
        </div>
      </>
    );
  } else if (state === 'subscribed') {
    body = (
      <>
        <h3 className="card-title">
          <span className="ok-mark" aria-hidden="true"><CheckIcon /></span>
          Activas en este dispositivo
        </h3>
        <p className="muted">Recibirás aquí los avisos de tus tareas y recordatorios. Actívalas también en tus otros dispositivos.</p>
        <div className="actions">
          <button type="button" className="btn primary" onClick={onTest} disabled={busy !== null}>
            {busy === 'test' ? 'Enviando…' : 'Enviar prueba'}
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
        <h3 className="card-title">Recibe avisos en este dispositivo</h3>
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
        {noticeBox}
      </div>
    </section>
  );
}
