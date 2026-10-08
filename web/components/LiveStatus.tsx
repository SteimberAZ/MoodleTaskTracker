/**
 * Visually hidden polite live region. It is always rendered (also while empty), because screen readers only
 * announce changes to a region that already existed; set `message` to announce it, '' or null to clear it.
 */
export default function LiveStatus({ message }: { message?: string | null }) {
  return (
    <p className="sr-only" role="status" aria-live="polite">
      {message ?? ''}
    </p>
  );
}
