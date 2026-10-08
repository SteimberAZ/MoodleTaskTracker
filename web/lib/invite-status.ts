export interface InviteLike {
  expires_at: string | null;
  used_at: string | null;
  used_by: string | null;
}

export type InviteStatus =
  | { kind: 'disponible' }
  | { kind: 'usada'; usedBy: string | null }
  | { kind: 'vencida' };

/** A used invite stays "usada" even if it also had an expiry date in the past. */
export function inviteStatus(invite: InviteLike, now: Date): InviteStatus {
  if (invite.used_at) return { kind: 'usada', usedBy: invite.used_by };
  if (invite.expires_at && new Date(invite.expires_at).getTime() <= now.getTime()) return { kind: 'vencida' };
  return { kind: 'disponible' };
}

/** Spanish label: "disponible", "vencida" or "usada por <name>". */
export function inviteStatusLabel(status: InviteStatus, nameOf: (userId: string) => string | undefined): string {
  if (status.kind === 'usada') {
    const name = status.usedBy ? nameOf(status.usedBy) : undefined;
    return name ? `usada por ${name}` : 'usada';
  }
  return status.kind;
}

/** Optional expiry in whole days (1-365); empty means no expiry. Returns undefined when invalid. */
export function parseExpiryDays(raw: string): number | null | undefined {
  const text = raw.trim();
  if (!text) return null;
  if (!/^\d{1,3}$/.test(text)) return undefined;
  const days = Number(text);
  return days >= 1 && days <= 365 ? days : undefined;
}
