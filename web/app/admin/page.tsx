import { requireAdmin } from '@/lib/auth';
import { listInvites, type Invite } from '@/lib/invites';
import { listUsersForAdmin, type AdminUserRow } from '@/lib/users';
import { inviteStatus, inviteStatusLabel } from '@/lib/invite-status';
import { formatGuayaquil } from '@/lib/time';
import {
  countByOwner,
  deviceFailing,
  devicePlatformLabel,
  formatDeviceCount,
  groupByOwner,
  type PushDeviceHealth,
} from '@/lib/push-query';
import { listPushDeviceHealth } from '@/lib/push-subscriptions';
import { getWorkerStatus, serviceSummary, type WorkerStatus } from '@/lib/worker-status';
import { revokeInvite, setActive } from './actions';
import ConfirmButton from '@/components/ConfirmButton';
import CopyButton from '@/components/CopyButton';
import InviteForm from '@/components/InviteForm';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Administración' };

const settled = <T,>(result: PromiseSettledResult<T>): T | null => (result.status === 'fulfilled' ? result.value : null);

function DeviceLine({ device }: { device: PushDeviceHealth }) {
  const failing = deviceFailing(device);
  return (
    <li>
      <strong>{devicePlatformLabel(device.platform)}</strong>
      {' · último aviso entregado: '}
      {formatGuayaquil(device.last_success_at)}
      {(device.failure_count ?? 0) > 0 && (
        <>
          {` · ${device.failure_count} ${device.failure_count === 1 ? 'fallo' : 'fallos'}, el último ${formatGuayaquil(device.last_failure_at)}`}
          {device.last_failure_reason ? ` (${device.last_failure_reason})` : ''}
        </>
      )}
      {failing && (
        <>
          {' '}
          <span className="badge urgente">Fallando</span>
        </>
      )}
    </li>
  );
}

export default async function AdminPage() {
  const admin = await requireAdmin();
  const now = new Date();

  // Independent reads run together; each failure only hides its own section.
  const [invitesResult, usersResult, devicesResult, statusResult] = await Promise.allSettled([
    listInvites(),
    listUsersForAdmin(),
    listPushDeviceHealth(),
    getWorkerStatus(),
  ]);
  const invites: Invite[] = settled(invitesResult) ?? [];
  const users: AdminUserRow[] = settled(usersResult) ?? [];
  const invitesError = invitesResult.status === 'rejected';
  const usersError = usersResult.status === 'rejected';
  // Devices per user; null when the table cannot be read (shown as a dash).
  const devices = settled(devicesResult);
  const pushCounts = devices ? countByOwner(devices) : null;
  const devicesByUser = devices ? groupByOwner(devices) : null;
  const status: WorkerStatus | null = settled(statusResult);
  const service = serviceSummary(status, process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, now);
  const heartbeat = status?.heartbeat ?? null;
  const nameById = new Map(users.map((u) => [u.id, u.fullname || u.username]));

  return (
    <>
      <header className="page-head">
        <h1>Administración</h1>
      </header>

      <section className="card item" aria-labelledby="service-title">
        <h2 id="service-title" className="card-title">Estado del servicio</h2>
        {statusResult.status === 'rejected' && (
          <p className="alert" role="alert">No se pudo leer el estado del servicio.</p>
        )}
        <dl className="meta">
          <div>
            <dt>Worker</dt>
            <dd><span className={`badge ${service.worker.tone}`}>{service.worker.text}</span></dd>
          </div>
          <div>
            <dt>Notificaciones push</dt>
            <dd><span className={`badge ${service.push.tone}`}>{service.push.text}</span></dd>
          </div>
          {heartbeat?.last_push_ok_at && (
            <div><dt>Último push entregado</dt><dd>{formatGuayaquil(heartbeat.last_push_ok_at)}</dd></div>
          )}
          {service.counts && <div><dt>Envíos push</dt><dd className="mono">{service.counts}</dd></div>}
          {service.roundMode && <div><dt>Última ronda</dt><dd>{service.roundMode}</dd></div>}
          {heartbeat && (heartbeat.users_ok !== null || heartbeat.users_err !== null) && (
            <div>
              <dt>Usuarios sincronizados</dt>
              <dd>{`${heartbeat.users_ok ?? 0} bien · ${heartbeat.users_err ?? 0} con error`}</dd>
            </div>
          )}
          {heartbeat?.delivery_lag_seconds !== null && heartbeat?.delivery_lag_seconds !== undefined && (
            <div><dt>Retraso de entrega</dt><dd>{`${Math.round(heartbeat.delivery_lag_seconds)} s`}</dd></div>
          )}
          {heartbeat?.version && <div><dt>Versión</dt><dd className="mono">{heartbeat.version}</dd></div>}
        </dl>
        {service.degraded.length > 0 && (
          <div className="warning">
            <p>El worker está funcionando en modo degradado:</p>
            <ul className="plain-list small">
              {service.degraded.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        )}
        {service.vapidMismatch && (
          <p className="warning">
            La clave VAPID del worker no coincide con la de la web: ningún dispositivo recibirá avisos push hasta que
            coincidan.
          </p>
        )}
      </section>

      <h2 className="section-title">Invitaciones</h2>
      <InviteForm />
      {invitesError && <p className="alert" role="alert">No se pudieron cargar las invitaciones.</p>}
      {!invitesError && invites.length === 0 && <p className="card muted">Aún no hay invitaciones.</p>}
      <ul className="list">
        {invites.map((invite) => {
          const status = inviteStatus(invite, now);
          return (
            <li key={invite.code} className="card item">
              <div className="item-head">
                <h3 className="mono">{invite.code}</h3>
                <span className={`badge ${status.kind === 'disponible' ? 'activo' : 'finalizado'}`}>
                  {inviteStatusLabel(status, (id) => nameById.get(id))}
                </span>
              </div>
              <dl className="meta">
                <div><dt>Creada</dt><dd>{formatGuayaquil(invite.created_at)}</dd></div>
                <div><dt>Vence</dt><dd>{invite.expires_at ? formatGuayaquil(invite.expires_at) : 'Sin vencimiento'}</dd></div>
              </dl>
              {!invite.used_at && (
                // The group name carries the code, so "Copiar" and "Revocar" are not ambiguous in a list of invites.
                <div className="actions" role="group" aria-label={`Invitación ${invite.code}`}>
                  <CopyButton text={invite.code} />
                  <ConfirmButton
                    action={revokeInvite.bind(null, invite.code)}
                    label="Revocar"
                    message={`¿Revocar la invitación ${invite.code}? Ya no se podrá usar.`}
                    danger
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <h2 className="section-title">Usuarios</h2>
      {usersError && <p className="alert" role="alert">No se pudieron cargar los usuarios.</p>}
      <ul className="list">
        {users.map((u) => {
          const userDevices = devicesByUser?.get(u.id) ?? [];
          return (
            <li key={u.id} className={`card item${u.active ? '' : ' finalizado'}`}>
              <div className="item-head">
                <h3>{u.fullname || u.username}</h3>
                <span className={`badge ${u.active ? 'activo' : 'finalizado'}`}>
                  {u.is_admin ? 'admin · ' : ''}
                  {u.active ? 'activo' : 'desactivado'}
                </span>
              </div>
              <dl className="meta">
                <div><dt>Usuario</dt><dd>{u.username}</dd></div>
                <div><dt>Registro</dt><dd>{formatGuayaquil(u.created_at)}</dd></div>
                <div><dt>Último acceso</dt><dd>{formatGuayaquil(u.last_login_at)}</dd></div>
                <div>
                  <dt>Push</dt>
                  <dd>{formatDeviceCount(pushCounts ? (pushCounts.get(u.id) ?? 0) : undefined)}</dd>
                </div>
                {u.last_error && <div><dt>Último error</dt><dd>{u.last_error}</dd></div>}
              </dl>
              {userDevices.length > 0 && (
                <ul className="plain-list muted small" aria-label={`Dispositivos de ${u.fullname || u.username}`}>
                  {userDevices.map((device) => (
                    <DeviceLine key={device.id} device={device} />
                  ))}
                </ul>
              )}
              {u.id !== admin.id && (
                <div className="actions">
                  <ConfirmButton
                    action={setActive.bind(null, u.id, !u.active)}
                    label={u.active ? 'Desactivar' : 'Activar'}
                    message={
                      u.active
                        ? `¿Desactivar a ${u.fullname || u.username}? No podrá iniciar sesión ni recibirá avisos.`
                        : `¿Activar a ${u.fullname || u.username}?`
                    }
                    danger={u.active}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
