import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import LoginForm from '@/components/LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  // Only skip the form for a cookie that still maps to an active user; a stale or deactivated
  // session must be able to log in again (redirecting here would loop with requireUser()).
  const user = await getCurrentUser().catch(() => null);
  if (user) redirect('/');
  return <LoginForm />;
}
