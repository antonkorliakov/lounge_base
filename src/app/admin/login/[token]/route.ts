import { NextResponse } from 'next/server'
import { db } from '@/db/client'
import { consumeLoginToken } from '@/access/team'
import { SESSION_COOKIE, sessionCookieOptions } from '@/access/session'

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await context.params
  const consumed = await consumeLoginToken(db(), token)

  const base = process.env.APP_URL ?? 'http://localhost:3000'
  if (!consumed) return NextResponse.redirect(`${base}/admin/login`)

  const response = NextResponse.redirect(`${base}/admin`)
  // Атрибуты общие с действием парольного входа — см. `sessionCookieOptions`.
  response.cookies.set(SESSION_COOKIE, consumed.sessionId, sessionCookieOptions())
  return response
}
