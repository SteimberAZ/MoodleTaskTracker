import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { avatarDeletePath, avatarReadPath, avatarSrc, avatarUpsert, parseAvatarDataUrl, AVATAR_MAX_CHARS } from '@/lib/avatar';

vi.mock('@/app/actions', () => ({ logout: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/admin' }));

const USER = '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e';
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1];
const WEBP = [0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];

describe('parseAvatarDataUrl', () => {
  it('accepts WebP, JPEG and PNG whose bytes match their type', () => {
    expect(parseAvatarDataUrl(`data:image/png;base64,${b64(PNG)}`)?.mime).toBe('image/png');
    expect(parseAvatarDataUrl(`data:image/jpeg;base64,${b64(JPEG)}`)?.mime).toBe('image/jpeg');
    expect(parseAvatarDataUrl(`data:image/webp;base64,${b64(WEBP)}`)?.bytes.length).toBe(12);
  });

  it('rejects SVG, mismatched signatures, junk and oversized input', () => {
    const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(parseAvatarDataUrl(`data:image/svg+xml;base64,${svg}`)).toBeNull();
    expect(parseAvatarDataUrl(`data:image/png;base64,${b64(JPEG)}`)).toBeNull();
    expect(parseAvatarDataUrl(`data:image/png;base64,${svg}`)).toBeNull();
    expect(parseAvatarDataUrl('data:image/png;base64,***')).toBeNull();
    expect(parseAvatarDataUrl(`data:image/png;base64,${'A'.repeat(AVATAR_MAX_CHARS)}`)).toBeNull();
    expect(parseAvatarDataUrl(null)).toBeNull();
    expect(parseAvatarDataUrl('')).toBeNull();
  });
});

describe('avatar queries', () => {
  it('reads, writes and deletes only the session user row', () => {
    expect(avatarReadPath(USER)).toBe(`moodle_avatars?user_id=eq.${USER}&select=image&limit=1`);
    expect(avatarDeletePath(USER)).toBe(`moodle_avatars?user_id=eq.${USER}`);
    expect(avatarUpsert(USER, 'data:x', 'T')).toEqual({
      path: 'moodle_avatars?on_conflict=user_id',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: { user_id: USER, image: 'data:x', updated_at: 'T' },
    });
    expect(() => avatarReadPath('nope')).toThrow();
  });

  it('builds a per-user, versioned image URL', () => {
    expect(avatarSrc(USER, '1791480000000')).toBe(`/api/avatar?u=${USER}&v=1791480000000`);
    expect(avatarSrc(USER, undefined)).toBe(`/api/avatar?u=${USER}&v=0`);
    expect(avatarSrc(USER, '"><script>')).toBe(`/api/avatar?u=${USER}&v=0`);
  });
});

describe('AccountMenu', () => {
  it('shows the photo button and keeps logout as the last entry', async () => {
    const { default: AccountMenu } = await import('@/components/AccountMenu');
    const html = renderToStaticMarkup(createElement(AccountMenu, { isAdmin: true, avatarSrc: '/api/avatar?u=x&v=0', name: 'Ana' }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('src="/api/avatar?u=x&amp;v=0"');
    const order = ['Mi cuenta', 'Admin', 'Cerrar sesión'].map((label) => html.indexOf(label));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const adminLink = (html.match(/<a [^>]*>/g) ?? []).find((tag) => tag.includes('href="/admin"'));
    expect(adminLink).toContain('aria-current="page"');
  });

  it('has no Admin entry for regular users', async () => {
    const { default: AccountMenu } = await import('@/components/AccountMenu');
    const html = renderToStaticMarkup(createElement(AccountMenu, { isAdmin: false, avatarSrc: '/a', name: 'Ana' }));
    expect(html).not.toContain('>Admin<');
    expect(html).toContain('Cerrar sesión');
  });
});
