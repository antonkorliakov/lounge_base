import { randomBytes, createHash } from 'node:crypto'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import type { Localized } from '@/form-schema'
import type { Db } from '@/db/types'
import { teamMembers, loginTokens, sessions } from '@/db/schema'

const LOGIN_TTL_MINUTES = 20
const SESSION_TTL_DAYS = 30

const hash = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

const minutesFromNow = (minutes: number): Date =>
  new Date(Date.now() + minutes * 60 * 1000)

const daysFromNow = (days: number): Date =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000)

export async function requestLogin(
  db: Db,
  email: string,
): Promise<{ token: string } | { error: Localized }> {
  // Почта сверяется без учёта регистра: люди пишут её как придётся.
  const rows = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(sql`lower(${teamMembers.email}) = ${email.trim().toLowerCase()}`)
    .limit(1)

  const member = rows[0]
  if (!member) {
    // Неизвестный адрес получает точно такой же по форме ответ, что и
    // ошибка валидации — просто { error }, без какого-либо признака "нет
    // такого адреса" vs "что-то другое пошло не так". Разница между
    // known/unknown должна умирать здесь: `requestLogin` — внутренний API
    // этого модуля, а обёртка для маршрута (P2 Task 6) обязана возвращать
    // наружу один и тот же нейтральный ответ независимо от ветки, иначе
    // форма входа превращается в способ перечислить состав команды.
    return {
      error: {
        en: 'This address is not on the team',
        ru: 'Этой почты нет в команде',
      },
    }
  }

  const token = randomBytes(32).toString('base64url')
  await db.insert(loginTokens).values({
    memberId: member.id,
    tokenHash: hash(token),
    expiresAt: minutesFromNow(LOGIN_TTL_MINUTES),
  })

  return { token }
}

export async function consumeLoginToken(
  db: Db,
  token: string,
): Promise<{ sessionId: string; memberId: string } | null> {
  const tokenHash = hash(token)

  // Одна атомарная транзакция: сам UPDATE — это проверка "ещё не
  // использован и не просрочен" И запись "использован" одним SQL-
  // выражением, а не SELECT, затем отдельный UPDATE. Если бы это было
  // SELECT (проверка usedAt IS NULL) и только потом UPDATE — как в
  // черновике брифа — два параллельных вызова с одной и той же ссылкой
  // (например, почтовый клиент делает prefetch и реальный клик почти
  // одновременно) оба прошли бы SELECT до того, как любой из них
  // зафиксировал usedAt, и оба получили бы свою сессию: токен стал бы
  // многоразовым. UPDATE ... WHERE usedAt IS NULL ... RETURNING не имеет
  // этого окна — постгрес берёт блокировку строки на первый UPDATE и
  // держит её до коммита; второй UPDATE ждёт эту блокировку, затем
  // перепроверяет WHERE против уже зафиксированной строки, видит
  // usedAt IS NOT NULL и не находит строк. Ровно один вызов может выиграть.
  //
  // Транзакция вокруг UPDATE+INSERT нужна не для этой гонки (её решает сам
  // UPDATE), а для all-or-nothing: без неё падение между "токен помечен
  // использованным" и "сессия создана" оставляет токен мёртвым без единой
  // выданной сессии — а токены, в отличие от fillTokens, невозможно
  // продлить (см. `access/tokens.ts`), так что это был бы permanent
  // lockout до повторного запроса на вход.
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(loginTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(loginTokens.tokenHash, tokenHash),
          gt(loginTokens.expiresAt, new Date()),
          isNull(loginTokens.usedAt),
        ),
      )
      .returning({ id: loginTokens.id, memberId: loginTokens.memberId })

    const row = updated[0]
    if (!row) return null

    const [session] = await tx
      .insert(sessions)
      .values({ memberId: row.memberId, expiresAt: daysFromNow(SESSION_TTL_DAYS) })
      .returning()

    return { sessionId: session!.id, memberId: row.memberId }
  })
}

export async function resolveSession(
  db: Db,
  sessionId: string,
): Promise<{ memberId: string; email: string } | null> {
  const rows = await db
    .select({ memberId: teamMembers.id, email: teamMembers.email })
    .from(sessions)
    .innerJoin(teamMembers, eq(sessions.memberId, teamMembers.id))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date())))
    .limit(1)

  return rows[0] ?? null
}

export async function endSession(db: Db, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId))
}
