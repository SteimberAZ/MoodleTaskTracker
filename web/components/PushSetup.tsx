'use client';

import { useState } from 'react';
import { disablePush, enablePush, requestTestPush, runInstallPrompt } from '@/lib/push-client';
import { CheckIcon, ShareIcon } from './Icons';
import { usePushDevice } from './usePushDevice';

type Busy = 'enable' | 'test' | 'disable' | 'install' | null;
type Notice = { tone: 'ok' | 'error'; text: string };

/** Device-aware setup of Web Push: what to show depends on the platform, permission and subscription of this device. */
export default function PushSetup({ vapidPublicKey }: { vapidPublicKey?: string }) {
  const { snapshot, installable, refresh } = usePushDevice(vapidPublicKey);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  if (!snapshot) {
    return (
      <p className="muted" role="status" aria-busy="true">
        Comprobando este dispositivo…
      </p>
    );
  }
  const { state, platform, standalone } = snapshot;

  const GENERIC_ERROR: Notice = { tone: 'error', text: 'Algo salió mal. Inténtalo de nuevo.' };

  async function onEnable() {
    if (busy) return;
    setBusy('enable');
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

  if (state === 'unconfigured') {
    return (
      <section className="card push-card">
        <h2 className="card-title">No disponible por ahora</h2>
        <p className="muted">Las notificaciones todavía no están configuradas. Inténtalo más tarde.</p>
      </section>
    );
  }

  if (state === 'needs-install') {
    return (
      <section className="card push-card" aria-labelledby="install-title">
        <h2 id="install-title" className="card-title">Primero agrega la app a tu pantalla de inicio</h2>
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
      </section>
    );
  }

  if (state === 'unsupported') {
    return (
      <section className="card push-card">
        <h2 className="card-title">Este dispositivo no admite notificaciones</h2>
        <p className="muted">
          {platform === 'ios'
            ? 'Necesitas iOS 16.4 o superior para recibir notificaciones desde la app instalada. Actualiza tu iPhone o iPad e inténtalo de nuevo.'
            : 'Tu navegador no admite notificaciones push. Prueba con una versión reciente de Chrome, Edge, Firefox o Safari.'}
        </p>
      </section>
    );
  }

  if (state === 'denied') {
    return (
      <section className="card push-card" aria-labelledby="denied-title">
        <h2 id="denied-title" className="card-title">Las notificaciones están bloqueadas</h2>
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
      </section>
    );
  }

  if (state === 'subscribed') {
    return (
      <section className="card push-card" aria-labelledby="active-title">
        <h2 id="active-title" className="card-title">
          <span className="ok-mark" aria-hidden="true"><CheckIcon /></span>
          Activas en este dispositivo
        </h2>
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
        {noticeBox}

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
      </section>
    );
  }

  // state === 'default'
  return (
    <section className="card push-card" aria-labelledby="enable-title">
      <h2 id="enable-title" className="card-title">Recibe avisos en este dispositivo</h2>
      <p className="muted">
        Te avisaremos de tus tareas y recordatorios aunque la app esté cerrada. Tu navegador te pedirá permiso.
      </p>
      <div className="actions">
        <button type="button" className="btn primary big" onClick={onEnable} disabled={busy !== null}>
          {busy === 'enable' ? 'Activando…' : 'Activar notificaciones'}
        </button>
        {installButton}
      </div>
      {noticeBox}
    </section>
  );
}
