import { createHash } from 'node:crypto';
import { moodleErrorMessage } from './moodle';

/**
 * Per-username login throttle backed by the `moodle_login_gate` / `moodle_login_result` RPCs, so the login
 * form cannot be used as an unlimited password oracle against UTM Moodle accounts. The database only ever
 * sees a hash of the normalised username. Every RPC failure (function not deployed yet, timeout) fails open:
 * the attempt is allowed and a single warning is logged, so a missing migration never locks people out.
 */
export const THROTTLED_MESSAGE = 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.';

/** sha256 hex of the trimmed, lowercased username. */
export function throttleKey(username: string): string {
  return createHash('sha256').update(username.trim().toLowerCase(), 'utf8').digest('hex');
}

export type ThrottleDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** `blockedSeconds` is the gate's answer: 0 (or anything not a positive number) means allowed. */
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

/** Calls a PostgREST RPC (`POST /rest/v1/rpc/<fn>` with a JSON body). */
export type RpcCall = (fn: string, args: Record<string, unknown>) => Promise<Response>;

export interface LoginThrottle {
  gate(keyHash: string): Promise<ThrottleDecision>;
  record(keyHash: string, success: boolean): Promise<void>;
}

export function createLoginThrottle(rpc: RpcCall, warn: (...args: unknown[]) => void = console.warn): LoginThrottle {
  let warned = false;
  const failOpen = (fn: string, detail: string | number) => {
    if (warned) return;
    warned = true;
    // Status or error name only: never the key or a response body.
    warn('Login throttle unavailable, allowing the attempt', fn, detail);
  };
  const errorName = (error: unknown) => (error instanceof Error ? error.name : 'unknown');

  return {
    async gate(keyHash) {
      try {
        const res = await rpc('moodle_login_gate', { p_key_hash: keyHash });
        if (!res.ok) {
          failOpen('moodle_login_gate', res.status);
          return { allowed: true };
        }
        const text = await res.text();
        const value = text ? Number(JSON.parse(text)) : NaN;
        if (!Number.isFinite(value)) {
          failOpen('moodle_login_gate', 'unexpected response');
          return { allowed: true };
        }
        return decide(value);
      } catch (error) {
        failOpen('moodle_login_gate', errorName(error));
        return { allowed: true };
      }
    },

    async record(keyHash, success) {
      try {
        const res = await rpc('moodle_login_result', { p_key_hash: keyHash, p_success: success });
        if (!res.ok) failOpen('moodle_login_result', res.status);
      } catch (error) {
        failOpen('moodle_login_result', errorName(error));
      }
    },
  };
}
