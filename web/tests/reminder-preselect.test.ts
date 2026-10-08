import { describe, expect, it, vi } from 'vitest';
import { parsePreselectParam, resolvePreselect } from '@/lib/reminder-preselect';

describe('parsePreselectParam', () => {
  it('accepts task-id shaped values', () => {
    expect(parsePreselectParam('0a1b2c3d4e5f')).toBe('0a1b2c3d4e5f');
    expect(parsePreselectParam([' abc_DEF-1 ', 'other'])).toBe('abc_DEF-1');
  });

  it('rejects anything else', () => {
    for (const bad of [undefined, null, '', '   ', 'a b', 'abc&user_id=neq.1', 'x'.repeat(65), '../etc', '<script>']) {
      expect(parsePreselectParam(bad)).toBeNull();
    }
  });
});

describe('resolvePreselect', () => {
  it('returns the task only when the owner-scoped lookup finds it', async () => {
    const lookup = vi.fn(async (id: string) => (id === 'mine123' ? { id, title: 'T' } : null));
    expect(await resolvePreselect('mine123', lookup)).toEqual({ id: 'mine123', title: 'T' });
    expect(await resolvePreselect('foreign9', lookup)).toBeNull();
  });

  it('never calls the lookup with an invalid id', async () => {
    const lookup = vi.fn(async () => ({ id: 'x' }));
    expect(await resolvePreselect('bad id', lookup)).toBeNull();
    expect(await resolvePreselect(undefined, lookup)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('ignores a lookup that returns another id or throws', async () => {
    expect(await resolvePreselect('abc', async () => ({ id: 'different' }))).toBeNull();
    expect(
      await resolvePreselect('abc', async () => {
        throw new Error('db down');
      }),
    ).toBeNull();
  });
});
