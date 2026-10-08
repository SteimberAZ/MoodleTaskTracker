import { describe, expect, it } from 'vitest';
import {
  claimInviteQuery,
  isSafeId,
  ownedRowQuery,
  ownedTaskQuery,
  ownedTasksInQuery,
  releaseInviteQuery,
  revokeInviteQuery,
  scopedQuery,
  userByIdentityQuery,
  userFilter,
} from '@/lib/queries';

const USER = '3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e';
const ROW = '11111111-2222-3333-4444-555555555555';

describe('user scoping', () => {
  it('always puts the user_id filter first', () => {
    expect(userFilter(USER)).toBe(`user_id=eq.${USER}`);
    expect(scopedQuery(USER, 'select=*', 'order=next_fire_at.asc')).toBe(
      `?user_id=eq.${USER}&select=*&order=next_fire_at.asc`,
    );
    expect(scopedQuery(USER)).toBe(`?user_id=eq.${USER}`);
  });

  it('scopes single-row access by id AND owner', () => {
    expect(ownedRowQuery(USER, ROW, 'select=*', 'limit=1')).toBe(
      `?user_id=eq.${USER}&id=eq.${ROW}&select=*&limit=1`,
    );
    expect(ownedTaskQuery(USER, 'abc123def456', 'limit=1')).toBe(`?user_id=eq.${USER}&id=eq.abc123def456&limit=1`);
  });

  it('refuses ids that could inject extra filters', () => {
    expect(() => userFilter('x&user_id=neq.1')).toThrow();
    expect(() => userFilter('')).toThrow();
    expect(() => ownedRowQuery(USER, 'abc&user_id=neq.1')).toThrow();
    expect(() => ownedTaskQuery(USER, 'abc&or=(id.neq.0)')).toThrow();
    expect(isSafeId('a'.repeat(65))).toBe(false);
  });

  it('builds an owner-scoped IN list and drops unsafe ids', () => {
    const q = ownedTasksInQuery(USER, ['aaa', 'bbb', 'aaa', 'bad id"]'], 'select=id');
    expect(q).toBe(`?user_id=eq.${USER}&id=in.(${encodeURIComponent('"aaa","bbb"')})&select=id`);
  });
});

describe('invite queries', () => {
  it('claims only unused, unexpired invites', () => {
    const q = claimInviteQuery('ABC234', '2026-10-07T12:00:00.000Z');
    expect(q).toContain('code=eq.ABC234');
    expect(q).toContain('used_at=is.null');
    expect(q).toContain('or=(expires_at.is.null,expires_at.gt.2026-10-07T12%3A00%3A00.000Z)');
  });

  it('releases only invites not tied to a user, and revokes only unused ones', () => {
    expect(releaseInviteQuery('ABC234')).toBe('code=eq.ABC234&used_by=is.null');
    expect(revokeInviteQuery('ABC234')).toBe('code=eq.ABC234&used_at=is.null');
  });

  it('encodes the lookup of a user by Moodle identity', () => {
    expect(userByIdentityQuery('https://evirtual.utm.edu.ec', 42)).toBe(
      'moodle_url=eq.https%3A%2F%2Fevirtual.utm.edu.ec&site_userid=eq.42',
    );
    expect(() => userByIdentityQuery('https://x', 1.5)).toThrow();
  });
});
