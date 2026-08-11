import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { db } from '@/db/client'
import { resolveSession } from './team'

export const SESSION_COOKIE = 'lounge_session'

export async function requireSession(): Promise<{ memberId: string; email: string }> {
  const store = await cookies()
  const sessionId = store.get(SESSION_COOKIE)?.value
  if (!sessionId) redirect('/admin/login')

  const session = await resolveSession(db(), sessionId)
  if (!session) redirect('/admin/login')

  return session
}
