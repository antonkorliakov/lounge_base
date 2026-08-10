import { randomBytes, createHash } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Localized } from '@/form-schema'
import type { Db } from '@/db/types'
import { teamMembers, loginTokens, sessions } from '@/db/schema'

// Exported so anything that describes this TTL to a human — currently
// `loginMail` in `src/notify/messages.ts`, pinned by a test there — reads
// the real number instead of repeating an invented one that can drift out
// of sync with it.
export const LOGIN_TTL_MINUTES = 20

// Короткий: сессия открывает данные ВСЕХ лаунджей и любое действие
// проверяющего, а не что-то одно скоуп-ограниченное. 30 дней без права
// отзыва означали, что ушедший из команды человек или потерянный ноутбук
// сохраняли полный доступ до месяца, и снять его можно было только руками
// в базе. Семь дней с продлением активности (см. `resolveSession`) ничего
// не стоят активному проверяющему — он никогда не увидит экран входа
// посреди работы — но ограничивают экспозицию для того, кто перестал
// работать: сессия неактивного участника протухает не позже чем через
// столько же дней после последнего обращения.
const SESSION_TTL_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000
const SESSION_TTL_MS = SESSION_TTL_DAYS * DAY_MS

// Продлеваем не на каждый resolveSession, а только когда прошло больше
// половины срока действия — иначе каждый запрос активного проверяющего
// писал бы в `sessions` без необходимости. Порог в половину TTL — обычная
// практика для скользящих сессий: одно продление раз в ~3.5 дня активного
// использования вместо одного на каждый HTTP-запрос, при том же результате
// «активный пользователь никогда не видит экран входа».
const SESSION_RENEWAL_THRESHOLD_MS = SESSION_TTL_MS / 2

const hash = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

const minutesFromNow = (minutes: number): Date =>
  new Date(Date.now() + minutes * 60 * 1000)

const daysFromNow = (days: number): Date =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000)

const normalizeEmail = (email: string): string => email.trim().toLowerCase()

/**
 * The one sanctioned way to create a `teamMembers` row. Normalises
 * (trim + lowercase) the address before it's written, so `teamMembers`'s
 * existing `unique(email)` constraint — declared on the raw column, not a
 * `lower(email)` functional index — is actually effective: with every stored
 * address already lowercase, two rows differing only by case can never both
 * exist, and `requestLogin`'s lookup can match on plain equality instead of
 * `lower()`. Closing this at the write boundary (here) rather than only at
 * the read boundary matters because whatever admin path later creates team
 * members (Task 6+) must not be able to reinvent this by hand and get it
 * wrong — this is that entry point.
 */
export async function addTeamMember(
  db: Db,
  input: { email: string; name: string },
): Promise<{ id: string }> {
  const [member] = await db
    .insert(teamMembers)
    .values({ email: normalizeEmail(input.email), name: input.name })
    .returning({ id: teamMembers.id })

  return { id: member!.id }
}

export async function requestLogin(
  db: Db,
  email: string,
): Promise<{ token: string } | { error: Localized }> {
  // Люди пишут почту как придётся, поэтому вход сверяет её без учёта
  // регистра — но не через `lower()` на чтении. Хранимые адреса уже
  // нормализованы `addTeamMember`, так что здесь достаточно нормализовать
  // только введённую строку и сравнить на точное равенство: раньше `lower()`
  // на обеих сторонах делал уникальный индекс на сырой колонке бесполезным
  // (`Foo@x.com` и `foo@x.com` проходили бы как два разных участника, и
  // `.limit(1)` без `ORDER BY` выбирал произвольного из них), нормализация
  // на записи убирает саму возможность такого дубликата.
  const rows = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(eq(teamMembers.email, normalizeEmail(email)))
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

/**
 * Проверяет сессию и, если она уже прожила больше половины TTL, скользящим
 * продлением отодвигает `expiresAt` на полный TTL вперёд от текущего
 * момента — активный проверяющий никогда не видит экран входа, но сессия
 * никого, кто перестал заходить, не держит дольше `SESSION_TTL_DAYS` дней
 * с последнего обращения.
 *
 * Форма: сначала обычный SELECT (валидность — `expiresAt > now()` —
 * проверяется в SQL, как и везде в этом модуле), и только если сессия жива
 * И достаточно старая, отдельный UPDATE, тоже с `WHERE ... expiresAt > now()`
 * в качестве условия. Это НЕ единый atomic UPDATE ... RETURNING, как у
 * `consumeLoginToken`, и это осознанный выбор, а не недосмотр:
 *
 *  - `consumeLoginToken` был one-shot compare-and-swap: единственная цель
 *    того запроса — не дать токену стать многоразовым, и там нужна была
 *    ровно одна атомарная проверка-и-запись, потому что верный результат
 *    гонки — «выиграл только один звонок». Здесь же гонки того же типа нет:
 *    продление идемпотентно (два параллельных резолва одной сессии почти
 *    одновременно оба продлят её на тот же — с точностью до миллисекунд —
 *    новый `expiresAt`; не важно, сколько раз это произойдёт).
 *  - Слияние проверки и продления в один UPDATE ... RETURNING обязало бы
 *    писать на КАЖДЫЙ вызов (даже когда продление не нужно), что прямо
 *    противоречит требованию не писать на каждый запрос — throttling
 *    возможен только если решение «писать или нет» принимается до записи,
 *    а не внутри одного неизбежного UPDATE.
 *  - `resolveSession` дополнительно джойнит `teamMembers` за email; сделать
 *    это тем же выражением, что и UPDATE `sessions`, означало бы CTE или
 *    подзапрос вместо простого джойна — усложнение без выигрыша в
 *    корректности, раз гонки нет.
 *
 * Инвариант «просроченная сессия не продлевается» тем не менее сохранён
 * SQL-проверкой, а не порядком операций в JS: SELECT уже отфильтровывает
 * просроченные (наивный «продлить, потом проверить» именно так воскрешал
 * бы мёртвую сессию — здесь этот путь кода недостижим), а сам UPDATE несёт
 * собственный `expiresAt > now()` в WHERE на случай, если сессия истекла
 * ровно в промежутке между SELECT и UPDATE (окно на практике исчезающе
 * малое, но проверка в SQL, а не в JS, ничего не стоит и не полагается на
 * то, что окно останется малым).
 */
export async function resolveSession(
  db: Db,
  sessionId: string,
): Promise<{ memberId: string; email: string } | null> {
  const now = new Date()
  const rows = await db
    .select({
      memberId: teamMembers.id,
      email: teamMembers.email,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(teamMembers, eq(sessions.memberId, teamMembers.id))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now)))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  const remainingMs = row.expiresAt.getTime() - now.getTime()
  if (remainingMs < SESSION_RENEWAL_THRESHOLD_MS) {
    await db
      .update(sessions)
      .set({ expiresAt: daysFromNow(SESSION_TTL_DAYS) })
      .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date())))
  }

  return { memberId: row.memberId, email: row.email }
}

export async function endSession(db: Db, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId))
}

/**
 * Kill switch для увольнения или подозрения на компрометацию: удаляет ВСЕ
 * сессии участника одним махом, а не по одной. Отдельно от `endSession`
 * (завершает ровно одну сессию, например текущую при выходе) — это разные
 * вопросы: «выйти из этого устройства» и «отозвать весь доступ этого
 * человека», и одно не заменяет другое.
 */
export async function endAllSessionsForMember(db: Db, memberId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.memberId, memberId))
}
