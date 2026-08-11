import { NextResponse } from 'next/server'
import { db } from '@/db/client'
import { consumeLoginToken, SESSION_TTL_DAYS } from '@/access/team'
import { SESSION_COOKIE } from '@/access/session'

// Читает тот же `SESSION_TTL_DAYS`, что `resolveSession` (`access/team.ts`)
// использует для реального, проверяемого на сервере срока действия сессии —
// раньше здесь был отдельный захардкоженный `30 * 24 * 60 * 60`, который
// говорил читателю этого файла, что сессия живёт 30 дней, хотя на самом деле
// (см. `team.ts`'s собственный комментарий) она живёт 7 со скользящим
// продлением. Расхождение не было угрозой безопасности — `resolveSession`
// всё равно проверяет реальный `expiresAt` на каждый запрос, так что более
// длинный cookie ничего лишнего не открывает, — но читатель одного этого
// файла получал неверную модель того, сколько сессия живёт. Один и тот же
// constant на обеих сторонах делает расхождение невозможным, а не просто
// маловероятным.
const SESSION_COOKIE_MAX_AGE_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60

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
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  })
  return response
}
