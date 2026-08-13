import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { db } from '@/db/client'
import { resolveSession } from './team'

export const SESSION_COOKIE = 'lounge_session'

/**
 * Абсолютный предел жизни ОДНОГО входа — не копия `SESSION_TTL_DAYS` и не
 * попытка его отразить. Это разные вещи, и вот почему.
 *
 * Cookie выставляется ровно в одном месте — `admin/login/[token]/route.ts`,
 * в момент входа — и больше НИКОГДА не переписывается: `middleware.ts`/
 * `proxy.ts` в проекте нет, а `requireSession()` работает в серверных
 * компонентах, которые выставлять cookie не могут. Значит `maxAge` здесь —
 * абсолютный потолок от момента входа. Серверная же сессия скользит:
 * `resolveSession` (`access/team.ts`) отодвигает `expiresAt` на полный TTL
 * вперёд при активности, то есть цепочка продлений не ограничена сверху
 * ничем. Никакое конечное `maxAge` не может «совпадать» с неограниченной
 * цепочкой, поэтому cookie выражает своё собственное правило: сколько
 * максимум может длиться один вход, независимо от активности.
 *
 * 90 дней (≈ квартал). Требование к числу одно: он должен быть заметно
 * больше скользящего окна, иначе активный проверяющий получит экран входа
 * посреди работы — то самое, что комментарий `SESSION_TTL_DAYS` обещает не
 * допускать. При `SESSION_TTL_DAYS = 7` серверная сессия жива, пока перерывы
 * между заходами короче недели (отпуск, болезнь, тихие две недели её уже
 * обрывают — и тогда вход всё равно нужен). 90 дней означают, что
 * непрерывно работающий проверяющий проходит вход заново примерно раз в
 * квартал — одно письмо, а не выход посреди работы. Число намеренно НЕ
 * выражено как `SESSION_TTL_DAYS * N`: это отдельная политика, а не то же
 * самое правило в других единицах; связь между ними — только неравенство,
 * и оно закреплено тестом (`__tests__/session-cookie.test.ts`), чтобы
 * будущее изменение TTL не сделало потолок связывающим ограничением молча.
 *
 * Почему более длинный cookie ничего не открывает: реальная, проверяемая на
 * КАЖДЫЙ запрос власть — серверный `expiresAt`, который проверяет
 * `resolveSession` в SQL. Значение cookie — только идентификатор сессии, не
 * подписанное утверждение о доступе: строка `sessions`, которая истекла или
 * удалена (`endSession`/`endAllSessionsForMember`), делает cookie
 * бесполезным немедленно, независимо от того, сколько браузер собирался его
 * хранить. Потолок ограничивает только длину одного входа; он не продлевает
 * доступ ни на секунду.
 */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60

/**
 * Атрибуты cookie сессии — одним объектом, потому что мест, которые его
 * ставят, теперь ДВА: маршрут обмена magic-ссылки
 * (`admin/login/[token]/route.ts`, через `response.cookies.set`) и действие
 * парольного входа (`admin/login/actions.ts`, через `cookies()` из
 * `next/headers` — действию некуда деть `NextResponse`, у него нет
 * response-объекта, а `cookies().set` в Server Function — штатный путь по
 * документации `next/dist/docs`). Оба API принимают один и тот же набор
 * опций; две инлайновые копии — это два места, где `httpOnly` или `secure`
 * можно забыть поправить вместе.
 *
 * Комментарий к `SESSION_COOKIE_MAX_AGE_SECONDS` выше говорит «cookie
 * пишется один раз, при входе» — оба места и есть входы; утверждение
 * не меняется.
 */
export function sessionCookieOptions(): {
  httpOnly: boolean
  sameSite: 'lax'
  secure: boolean
  path: string
  maxAge: number
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  }
}

export async function requireSession(): Promise<{ memberId: string; email: string }> {
  const store = await cookies()
  const sessionId = store.get(SESSION_COOKIE)?.value
  if (!sessionId) redirect('/admin/login')

  const session = await resolveSession(db(), sessionId)
  if (!session) redirect('/admin/login')

  return session
}
