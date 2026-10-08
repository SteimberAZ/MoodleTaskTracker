import Link from 'next/link';
import { logout } from '@/app/actions';

/** Small shared navigation: Inicio / Mi cuenta / Admin (admins only) / Salir. */
export default function Nav({ isAdmin }: { isAdmin: boolean }) {
  return (
    <nav className="actions site-nav" aria-label="Principal">
      <Link href="/" className="btn">Inicio</Link>
      <Link href="/cuenta" className="btn">Mi cuenta</Link>
      {isAdmin && <Link href="/admin" className="btn">Admin</Link>}
      <form action={logout}>
        <button type="submit" className="btn">Salir</button>
      </form>
    </nav>
  );
}
