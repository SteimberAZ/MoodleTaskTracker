'use client';

import { useLinkStatus } from 'next/link';

/**
 * Invisible marker. Must be rendered inside a next/link <Link> (useLinkStatus only works in a descendant of the link).
 * It flags that link's navigation in flight, so CSS can swap the list for its skeleton (see skeleton.css).
 */
export default function LinkPending() {
  const { pending } = useLinkStatus();
  return <span className="link-pending" aria-hidden="true" data-pending={pending ? 'true' : undefined} />;
}
