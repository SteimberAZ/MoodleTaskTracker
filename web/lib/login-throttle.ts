import { createHash } from 'node:crypto';
import { moodleErrorMessage } from './moodle';

/**
 * Login throttle backed by the `moodle_login_begin` / `moodle_login_finish` RPCs, so the login form cannot be
 * used as a password oracle against UTM Moodle accounts. `begin` reserves the attempt atomically before the
 * password reaches Moodle (concurrent attempts cannot all pass a read-only check), on two keys: the username
 * plus the client (blocks after 5 failures in 15 minutes) and the username alone (blocks after 20), so one
 * client cannot lock a student out from everywhere. `finish` settles the reservation. The database only ever
 * sees hashes. Without the new RPCs (migration not applied yet) it falls back to the older
 * `moodle_login_gate` / `moodle_login_result` pair on the username key. Every other RPC failure (timeout)
 * fails open: the attempt is allowed and a single warning is logged, so a missing migration never locks
 * people out.
 */
export const THROTTLED_MESSAGE = 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.';

/** Domains whose addresses Moodle also accepts as the bare username (`e123@utm.edu.ec` = `e123`). */
const INSTITUTIONAL_DOMAINS = ['utm.edu.ec'];

/** One identity per account: trimmed, lowercased, without an institutional e-mail domain. */
export function canonicalUsername(username: string): string {
  const value = username.trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at > 0 && INSTITUTIONAL_DOMAINS.includes(value.slice(at + 1))) return value.slice(0, at);
  return value;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** sha256 hex of the canonical username: the per-account key. */
export function throttleKey(username: string): string {
  return sha256(canonicalUsername(username));
}

export interface ThrottleKeys {
  /** Username + client: the hard block. */
  key: string;
  /** Username alone: the looser per-account ceiling. */
  userKey: string;
}

/** Both keys of one attempt. `client` is the requester's address (only its hash, mixed with the user, is stored). */
export function throttleKeys(username: string, client: string): ThrottleKeys {
  const user = canonicalUsername(username);
  return { key: sha256(`${user}\n${client.trim().toLowerCase() || 'unknown'}`), userKey: sha256(user) };
}

export type ThrottleDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** `blockedSeconds` is the RPC's answer: 0 (or anything not a positive number) means allowed. */
export function decide(blockedSeconds: number | null | undefined): ThrottleDecision {
  if (typeof blockedSeconds !== 'number' || !Number.isFinite(blockedSeconds) || blockedSeconds <= 0) {
    return { allowed: true };
  }
  return { allowed: false, retryAfterSeconds: Math.ceil(blockedSeconds) };
}

/** Only a rejected username/password counts against the key; network errors and other Moodle errors do not. */
export function isCredentialFailure(message: string): boolean {
  return message === moodleErrorMessage('invalidlogin');
}

/** How an attempt ended: `released` (Moodle unreachable, another error) only frees the reservation. */
export type LoginOutcome = 'success' | 'failure' | 'released';

/** Calls a PostgREST RPC (`POST /rest/v1/rpc/<fn>` with a JSON body). */
export type RpcCall = (fn: string, args: Record<string, unknown>) => Promise<Response>;

export interface LoginThrottle {
  begin(keys: ThrottleKeys): Promise<ThrottleDecision>;
  finish(keys: ThrottleKeys, outcome: LoginOutcome): Promise<void>;
}

/** PostgREST answers 404 (PGRST202) for a function that is not deployed. */
const isMissingFunction = (res: Response) => res.status === 404;

export function createLoginThrottle(rpc: RpcCall, warn: (...args: unknown[]) => void = console.warn): LoginThrottle {
  let warned = false;
  let legacy = false; // the atomic RPCs are missing: use moodle_login_gate / moodle_login_result
  const failOpen = (fn: string, detail: string | number) => {
    if (warned) return;
    warned = true;
    // Status or error name only: never a key or a response body.
    warn('Login throttle unavailable, allowing the attempt', fn, detail);
  };
  const errorName = (error: unknown) => (error instanceof Error ? error.name : 'unknown');

  async function blockedSeconds(fn: string, args: Record<string, unknown>): Promise<number | 'missing' | null> {
    const res = await rpc(fn, args);
    if (!res.ok) {
      if (isMissingFunction(res)) return 'missing';
      failOpen(fn, res.status);
      return null;
    }
    const text = await res.text();
    const value = text ? Number(JSON.parse(text)) : Number.NaN;
    if (!Number.isFinite(value)) {
      failOpen(fn, 'unexpected response');
      return null;
    }
    return value;
  }

  async function gate(fn: string, args: Record<string, unknown>): Promise<ThrottleDecision | 'missing'> {
    try {
      const value = await blockedSeconds(fn, args);
      if (value === 'missing') return 'missing';
      return value === null ? { allowed: true } : decide(value);
    } catch (error) {
      failOpen(fn, errorName(error));
      return { allowed: true };
    }
  }

  async function call(fn: string, args: Record<string, unknown>): Promise<void> {
    try {
      const res = await rpc(fn, args);
      if (!res.ok) failOpen(fn, res.status);
    } catch (error) {
      failOpen(fn, errorName(error));
    }
  }

  return {
    async begin(keys) {
      if (!legacy) {
        const decision = await gate('moodle_login_begin', { p_key_hash: keys.key, p_user_key_hash: keys.userKey });
        if (decision !== 'missing') return decision;
        legacy = true;
      }
      const decision = await gate('moodle_login_gate', { p_key_hash: keys.userKey });
      if (decision !== 'missing') return decision;
      failOpen('moodle_login_gate', 404);
      return { allowed: true };
    },

    async finish(keys, outcome) {
      if (!legacy) {
        await call('moodle_login_finish', { p_key_hash: keys.key, p_user_key_hash: keys.userKey, p_outcome: outcome });
        return;
      }
      if (outcome === 'released') return; // the older RPCs reserve nothing
      await call('moodle_login_result', { p_key_hash: keys.userKey, p_success: outcome === 'success' });
    },
  };
}
