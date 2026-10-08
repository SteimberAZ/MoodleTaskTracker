import { logout } from '@/app/actions';
import { LogOutIcon } from './Icons';

/**
 * Logout control at the right end of the header. A POST form bound to the `logout` server action
 * (never a GET link, so a prefetch or a crawler cannot end the session).
 * Phones: icon-only 44px button. Wide screens: icon plus the "Salir" text.
 */
export default function LogoutButton() {
  return (
    <form action={logout} className="logout-form">
      <button type="submit" className="logout-btn" aria-label="Cerrar sesión" title="Cerrar sesión">
        <LogOutIcon />
        <span className="logout-label" aria-hidden="true">Salir</span>
      </button>
    </form>
  );
}
