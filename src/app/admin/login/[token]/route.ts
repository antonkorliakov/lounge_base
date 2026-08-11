import { NextResponse } from 'next/server'
import { db } from '@/db/client'
import { consumeLoginToken } from '@/access/team'
import { SESSION_COOKIE } from '@/access/session'

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await context.params
  const consumed = await consumeLoginToken(db(), token)

  const base = process.env.APP_URL ?? 'http://localhost:3000'
  if (!consumed) return NextResponse.redirect(`${base}/admin/login`)

  const response = NextResponse.redirect(`${base}/admin`)
  response.cookies.set(SESSION_COOKIE, consumed.sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  })
  return response
}
