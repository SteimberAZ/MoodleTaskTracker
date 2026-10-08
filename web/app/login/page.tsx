import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { MAX_USERNAME } from '@/lib/moodle';
import { safeNext } from '@/lib/safe-next';
import LoginForm from '@/components/LoginForm';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Iniciar sesión' };

type SearchParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const next = safeNext(first(params.next));
  const username = (first(params.u) ?? '').trim().slice(0, MAX_USERNAME);
  // Only skip the form for a cookie that still maps to an active user; a stale or deactivated
  // session must be able to log in again (redirecting here would loop with requireUser()).
  const user = await getCurrentUser().catch(() => null);
  if (user) redirect(next);
  return <LoginForm next={next} initialUsername={username} />;
}
