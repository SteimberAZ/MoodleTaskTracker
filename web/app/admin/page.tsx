import { requireAdmin } from '@/lib/auth';
import { listInvites, type Invite } from '@/lib/invites';
import { listUsersForAdmin, type AdminUserRow } from '@/lib/users';
import { inviteStatus, inviteStatusLabel } from '@/lib/invite-status';
import { formatGuayaquil } from '@/lib/time';
import { revokeInvite, setActive } from './actions';
import Nav from '@/components/Nav';
import ConfirmButton from '@/components/ConfirmButton';
import CopyButton from '@/components/CopyButton';
import InviteForm from '@/components/InviteForm';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const admin = await requireAdmin();
  const now = new Date();

  let invites: Invite[] = [];
  let users: AdminUserRow[] = [];
  let invitesError = false;
  let usersError = false;
  try {
    invites = await listInvites();
  } catch {
    invitesError = true;
  }
  try {
    users = await listUsersForAdmin();
  } catch {
    usersError = true;
  }

  const nameById = new Map(users.map((u) => [u.id, u.fullname || u.username]));

  return (
    <>
      <Nav isAdmin />
      <header className="topbar">
        <h1>Administración</h1>
      </header>

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
                <div className="actions">
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
        {users.map((u) => (
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
              {u.last_error && <div><dt>Último error</dt><dd>{u.last_error}</dd></div>}
            </dl>
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
        ))}
      </ul>
    </>
  );
}
