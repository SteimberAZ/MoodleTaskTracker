import { StatsSkeleton } from '@/components/Skeletons';

/** Streamed fallback while the page data loads; the header and tab bar from the layout stay visible. */
export default function Loading() {
  return <StatsSkeleton />;
}
