'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { buildAccountLinks } from '@/lib/nav';
import { ShieldIcon, UserIcon } from './Icons';
import LogoutButton from './LogoutButton';

/**
 * Profile photo at the right end of the header. Tapping it opens a small menu: Mi cuenta, Admin (admins only)
 * and, always last, Cerrar sesión. A disclosure (button + list of links), not an ARIA menu: Tab moves through the
 * entries, Escape or a tap outside closes it, and it closes on every route change.
 */
export default function AccountMenu({ isAdmin, avatarSrc, name }: { isAdmin: boolean; avatarSrc: string; name: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() ?? '/';
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const links = buildAccountLinks(isAdmin, pathname);

  return (
    <div className="account" ref={root}>
      <button
        ref={button}
        type="button"
        className="account-btn"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="Cuenta"
        title={name}
        onClick={() => setOpen((value) => !value)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a private, per-user route; next/image adds nothing */}
        <img src={avatarSrc} alt="" width={36} height={36} className="account-avatar" />
      </button>
      <div id={menuId} className="account-menu" hidden={!open}>
        {name && <p className="account-name">{name}</p>}
        <ul className="plain-list">
          {links.map(({ href, label, icon, current }) => (
            <li key={href}>
              <Link href={href} className="account-menu-item" aria-current={current ? 'page' : undefined}>
                {icon === 'shield' ? <ShieldIcon /> : <UserIcon />}
                <span>{label}</span>
              </Link>
            </li>
          ))}
          <li className="account-menu-last">
            <LogoutButton />
          </li>
        </ul>
      </div>
    </div>
  );
}
