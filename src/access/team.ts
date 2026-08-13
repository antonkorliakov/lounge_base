import { randomBytes, createHash } from 'node:crypto'
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm'
import type { Localized } from '@/form-schema'
import type { Db, Tx } from '@/db/types'
import { teamMembers, loginTokens, sessions } from '@/db/schema'
import {
  DUMMY_STORED_HASH,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  verifyPassword,
} from './password'

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
//
// Этот срок — НЕ то же самое, что срок жизни cookie, который выставляет
// `src/app/admin/login/[token]/route.ts`. Предыдущая редакция этого
// комментария утверждала, что cookie «выражает ту же самую длительность», и
// это была ошибка: cookie пишется один раз, при входе, и никогда не
// переписывается, поэтому его `maxAge` — абсолютный потолок одного входа, а
// не скользящее окно. Отражать в нём этот TTL значило бы выкидывать
// активного проверяющего ровно через `SESSION_TTL_DAYS` дней после входа,
// сколько бы он ни работал, — прямо против обещания абзаца выше. Своя
// политика cookie и её обоснование живут при самом cookie, в
// `SESSION_COOKIE_MAX_AGE_SECONDS` (`access/session.ts`).
//
// Экспортируется (помимо `daysFromNow` внутри модуля) ради теста
// `access/__tests__/session-cookie.test.ts`: он держит НЕРАВЕНСТВО между
// этим TTL и потолком cookie — единственную настоящую связь между двумя
// политиками, — чтобы изменение TTL здесь не сделало потолок связывающим
// ограничением молча.
export const SESSION_TTL_DAYS = 7

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

    const { sessionId } = await createSession(tx, row.memberId)
    return { sessionId, memberId: row.memberId }
  })
}

/**
 * ЕДИНСТВЕННОЕ место, где создаётся строка `sessions`. Оба входа — обмен
 * magic-ссылки (`consumeLoginToken`, внутри его транзакции) и парольный
 * (`loginWithPassword`) — выдают сессию этим вызовом, поэтому TTL и всё,
 * что «сессия» значит (скользящее продление, отзыв — см. `resolveSession`,
 * `endSession` и соседей), у двух путей не могут разъехаться: второй копии
 * INSERT-а просто нет.
 *
 * `Db | Tx`: `consumeLoginToken` обязан звать это внутри своей транзакции
 * (all-or-nothing с пометкой токена использованным — см. его комментарий),
 * а парольному входу транзакция не нужна — это один INSERT без второй
 * записи, с которой ему нужно быть атомарным.
 */
async function createSession(db: Db | Tx, memberId: string): Promise<{ sessionId: string }> {
  const [session] = await db
    .insert(sessions)
    .values({ memberId, expiresAt: daysFromNow(SESSION_TTL_DAYS) })
    .returning({ id: sessions.id })

  return { sessionId: session!.id }
}

// 5 подряд неверных паролей закрывают парольный вход участника на 15 минут.
// Экспортируются ради тестов, которые закрепляют оба числа поведением, а не
// перечитыванием констант из этого же файла.
export const PASSWORD_LOCKOUT_THRESHOLD = 5
export const PASSWORD_LOCKOUT_MINUTES = 15

/**
 * Парольный вход: почта + пароль → та же сессия, что выдаёт magic-ссылка
 * (общий `createSession` выше). Возвращает `null` на ЛЮБУЮ неудачу —
 * неизвестная почта, участник без пароля, неверный пароль, действующая
 * блокировка — без различимого признака, какая именно: различие обязано
 * умереть здесь, иначе форма входа перечисляет состав команды (тот же
 * довод, что у `requestLogin`), а отдельное «вы заблокированы»
 * подтверждало бы, что адрес существует.
 *
 * Время тоже выравнено по веткам: каждая ветка неудачи, у которой нет
 * настоящего хэша, прожигает `verifyPassword` о `DUMMY_STORED_HASH` с теми
 * же параметрами scrypt — иначе «нет такого адреса» отвечал бы на всю
 * стоимость scrypt быстрее «неверного пароля», и никакой разумный пол на
 * длительность ответа (см. действие входа) этого не прикрыл бы. Остаточная
 * разница веток — один UPDATE счётчика на неверном пароле — прячется под
 * пол в действии.
 *
 * Защита от перебора — минимальная, но настоящая, и её пределы названы:
 * счётчик подряд неверных попыток НА УЧАСТНИКА с блокировкой на
 * `PASSWORD_LOCKOUT_MINUTES` после `PASSWORD_LOCKOUT_THRESHOLD` неудач.
 * Распределённый перебор по многим адресам (по одной попытке на адрес) и
 * перебор по IP это не ловит — защита от него живёт уровнем ниже
 * (rate-limit платформы), не здесь.
 *
 * Инкремент счётчика — одним UPDATE с арифметикой в SQL, а не
 * read-modify-write из JS: две параллельные неверные попытки иначе обе
 * прочитали бы 4 и обе записали бы 5 — потерянный инкремент ровно на
 * пороге. Оба CASE читают СТАРЫЕ значения строки (семантика UPDATE в
 * постгресе), поэтому «истёкшая блокировка начинает счёт заново с 1, а не
 * продолжает с порога» и «порог достигнут — закрыть» выражаются одним
 * выражением без гонки. Это не семейство lock-order-заслонов:
 * `team_members` не входит в охраняемые таблицы, и `src/access` вне
 * сканируемых корней (см. отчёт задачи) — но сама форма «атомарный UPDATE
 * вместо SELECT-потом-UPDATE» — та же, что у `consumeLoginToken`.
 */
export async function loginWithPassword(
  db: Db,
  email: string,
  password: string,
): Promise<{ sessionId: string; memberId: string } | null> {
  const rows = await db
    .select({
      id: teamMembers.id,
      passwordHash: teamMembers.passwordHash,
      failedPasswordAttempts: teamMembers.failedPasswordAttempts,
      passwordLockedUntil: teamMembers.passwordLockedUntil,
    })
    .from(teamMembers)
    .where(eq(teamMembers.email, normalizeEmail(email)))
    .limit(1)

  const member = rows[0]
  if (!member) {
    await verifyPassword(password, DUMMY_STORED_HASH)
    return null
  }

  const locked = member.passwordLockedUntil !== null && member.passwordLockedUntil > new Date()
  if (locked || member.passwordHash === null) {
    // Результат сжигаемой проверки игнорируется намеренно: у заблокированного
    // участника даже ВЕРНЫЙ пароль не открывает сессию (иначе блокировка не
    // мешала бы перебору — угадавший входит), а сравнивать с фиктивным
    // хэшем — единственный способ не выдать временем, была ли проверка.
    await verifyPassword(password, DUMMY_STORED_HASH)
    return null
  }

  const ok = await verifyPassword(password, member.passwordHash)
  if (!ok) {
    const lockoutExpired = sql`${teamMembers.passwordLockedUntil} is not null and ${teamMembers.passwordLockedUntil} <= now()`
    await db
      .update(teamMembers)
      .set({
        failedPasswordAttempts: sql`case
          when ${lockoutExpired} then 1
          else ${teamMembers.failedPasswordAttempts} + 1
        end`,
        passwordLockedUntil: sql`case
          when ${lockoutExpired} then null
          when ${teamMembers.failedPasswordAttempts} + 1 >= ${PASSWORD_LOCKOUT_THRESHOLD}
            then now() + (${PASSWORD_LOCKOUT_MINUTES} * interval '1 minute')
          else ${teamMembers.passwordLockedUntil}
        end`,
      })
      .where(eq(teamMembers.id, member.id))
    return null
  }

  // Успех гасит счётчик — иначе четыре старые неудачи держали бы участника
  // в одном шаге от блокировки неограниченно долго. Запись только когда есть
  // что гасить: обычный вход не должен писать в `team_members` вовсе.
  if (member.failedPasswordAttempts > 0 || member.passwordLockedUntil !== null) {
    await db
      .update(teamMembers)
      .set({ failedPasswordAttempts: 0, passwordLockedUntil: null })
      .where(eq(teamMembers.id, member.id))
  }

  const { sessionId } = await createSession(db, member.id)
  return { sessionId, memberId: member.id }
}

/**
 * ЕДИНСТВЕННАЯ точка записи пароля — и для смены из кабинета
 * (`/admin/password`), и для консольного `ops set-password`: одна функция
 * хэширует (`hashPassword`, `access/password.ts`) и одна проверяет правило
 * `MIN_PASSWORD_LENGTH`, так что два пути не могут разойтись ни форматом,
 * ни границей допустимого.
 *
 * Смена пароля гасит счётчик неудач и блокировку: новый пароль означает,
 * что старые неудачные попытки — о пароле, которого больше нет.
 */
export async function setMemberPassword(
  db: Db,
  memberId: string,
  password: string,
): Promise<{ ok: true } | { ok: false; error: Localized }> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: {
        en: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        ru: `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`,
      },
    }
  }

  const passwordHash = await hashPassword(password)
  await db
    .update(teamMembers)
    .set({ passwordHash, failedPasswordAttempts: 0, passwordLockedUntil: null })
    .where(eq(teamMembers.id, memberId))

  return { ok: true }
}

/**
 * `setMemberPassword` по почте, для `ops set-password`: скрипту человек
 * называет адрес, а не UUID. Неизвестная почта — честный отказ, как у
 * команды `login` там же: защита «один ответ на любой адрес» — свойство
 * ВЕБ-границы входа, а консольный скрипт, выдающий доступ, обязан говорить
 * правду тому, кто его запустил.
 */
export async function setMemberPasswordByEmail(
  db: Db,
  email: string,
  password: string,
): Promise<{ ok: true } | { ok: false; error: Localized }> {
  const rows = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(eq(teamMembers.email, normalizeEmail(email)))
    .limit(1)

  const member = rows[0]
  if (!member) {
    return {
      ok: false,
      error: {
        en: 'This address is not on the team',
        ru: 'Этой почты нет в команде',
      },
    }
  }

  return setMemberPassword(db, member.id, password)
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

/**
 * Смена пароля — каноничный момент отозвать ВСЕ ОСТАЛЬНЫЕ сессии участника
 * (человек меняет пароль в том числе потому, что подозревает утечку — чужая
 * живая сессия обесценила бы смену), но НЕ ту, из которой он это делает:
 * разлогинить его в ответ на правильное действие — наказание за
 * осторожность. Поэтому третья функция рядом с `endSession` (ровно одна) и
 * `endAllSessionsForMember` (все до единой, kill switch увольнения — тот
 * случай, где щадить текущую как раз нельзя): «все, кроме этой» — не
 * вырожденный случай ни одной из двух.
 */
export async function endOtherSessionsForMember(
  db: Db,
  memberId: string,
  keepSessionId: string,
): Promise<void> {
  await db
    .delete(sessions)
    .where(and(eq(sessions.memberId, memberId), ne(sessions.id, keepSessionId)))
}
