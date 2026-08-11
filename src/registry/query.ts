import {
  and, arrayContains, desc, eq, ilike, inArray, or, type SQL,
} from 'drizzle-orm'
import type { Db } from '@/db/types'
import type { OperationalStatus, SubmissionStatus } from '@/db/schema'
import { lounges, submissions } from '@/db/schema'

export type RegistryFilters = {
  country?: string
  city?: string
  airport?: string
  terminal?: string
  zone?: string
  operationalStatus?: OperationalStatus[]
  submissionStatus?: SubmissionStatus[]
  search?: string
}

export type RegistryRow = {
  loungeId: string
  name: string
  provider: string | null
  country: string
  city: string
  airport: string
  iataCode: string
  terminal: string | null
  zone: string[] | null
  operationalStatus: OperationalStatus
  statusUntil: string | null
  submissionId: string | null
  submissionStatus: SubmissionStatus | null
  statusChangedAt: Date | null
  decidedAt: Date | null
  reviewerId: string | null
}

/**
 * Какая анкета лаунжа считается «его» анкетой в строке реестра:
 *
 *  - `latest` — последняя по времени создания, независимо от статуса. Взгляд
 *    экрана реестра: где сейчас находится сбор данных по лаунжу.
 *  - `latestApproved` — последняя ПРИНЯТАЯ. Взгляд плоской выгрузки
 *    (`src/export/rows.ts`) в режиме «только принятые»: лаунж, у которого
 *    после принятия открыли новую черновую анкету, не перестал иметь
 *    проверенные данные, и выгрузка обязана продолжать отдавать именно их —
 *    взгляд `latest` потерял бы такой лаунж целиком, пока новая анкета не
 *    принята.
 *
 * Живёт здесь, а не в выгрузке, потому что «последняя» — правило этого модуля
 * (distinct on + полный порядок с tie-break по id, см. `latestSubmissionFor`),
 * и второй его экземпляр в `src/export` разъезжался бы с первым.
 */
export type SubmissionScope = 'latest' | 'latestApproved'

/**
 * Последняя анкета каждого лаунжа. Отдельного поля `current_submission_id`
 * нет намеренно — оно потребовало бы синхронизации и рассинхронизировалось бы.
 *
 * Собрано через `selectDistinctOn`, а не строкой SQL в шаблоне (как в образце
 * плана), по двум причинам, и обе — не про красоту:
 *
 *  1. Подзапрос получает ТИПЫ. Его колонки дальше видны как настоящие
 *     (`latestSubmission.status`), поэтому фильтр по статусу анкеты пишется
 *     обычным `inArray` — со связанными параметрами. В образце он собирался
 *     через `sql.raw` со склейкой значений прямо в текст запроса, а значения
 *     фильтров приходят из адресной строки (Task 7): `SubmissionStatus[]` —
 *     обещание системы типов, которое рантайм не выполняет. Это была
 *     настоящая инъекция, а не стилистическая придирка.
 *  2. Даты приходят датами. У сырого подзапроса drizzle не знает типов
 *     колонок, отдаёт строки, и образец превращал их обратно вручную
 *     (`new Date(row.statusChangedAt)`) — ещё одно место, где легко забыть
 *     поле.
 *
 * `desc(submissions.id)` третьим ключом — не косметика. `distinct on` отдаёт
 * ПЕРВУЮ строку каждой группы по указанному порядку, и при равном `createdAt`
 * (две анкеты, созданные в одну миллисекунду — сид, миграция, двойной клик)
 * порядок без третьего ключа не определён: реестр показывал бы то одну анкету,
 * то другую при неизменных данных. Правило теперь названо: при равном
 * `createdAt` берётся строка с большим `id`.
 */
function latestSubmissionFor(db: Db, scope: SubmissionScope) {
  return db
    .selectDistinctOn([submissions.loungeId], {
      id: submissions.id,
      loungeId: submissions.loungeId,
      status: submissions.status,
      statusChangedAt: submissions.statusChangedAt,
      decidedAt: submissions.decidedAt,
      reviewerId: submissions.reviewerId,
    })
    .from(submissions)
    // Сужение ДО distinct on, а не фильтром по готовой строке реестра: иначе
    // «последняя принятая» превратилась бы в «последняя, если она принята» —
    // это разные множества ровно в случае «черновик после принятия», ради
    // которого взгляд и существует (см. `SubmissionScope`).
    .where(scope === 'latestApproved' ? eq(submissions.status, 'approved') : undefined)
    .orderBy(submissions.loungeId, desc(submissions.createdAt), desc(submissions.id))
    .as('latest')
}

export async function listRegistry(
  db: Db,
  filters: RegistryFilters,
  scope: SubmissionScope = 'latest',
): Promise<RegistryRow[]> {
  const latest = latestSubmissionFor(db, scope)
  const conditions: SQL[] = []

  if (filters.country) conditions.push(eq(lounges.country, filters.country))
  if (filters.city) conditions.push(eq(lounges.city, filters.city))
  if (filters.airport) conditions.push(eq(lounges.airport, filters.airport))
  if (filters.terminal) conditions.push(eq(lounges.terminal, filters.terminal))

  // Зона — массив: лаунж подходит, если содержит запрошенную.
  if (filters.zone) conditions.push(arrayContains(lounges.zone, [filters.zone]))

  if (filters.operationalStatus?.length) {
    conditions.push(inArray(lounges.operationalStatus, filters.operationalStatus))
  }

  // Фильтр по статусу ПОСЛЕДНЕЙ анкеты, а не «по любой анкете лаунжа»: строка
  // реестра описывает текущее состояние сбора данных, и прежняя, уже
  // сменившаяся анкета к нему не относится. Условие поэтому стоит на колонке
  // подзапроса, а не на `submissions` напрямую.
  if (filters.submissionStatus?.length) {
    conditions.push(inArray(latest.status, filters.submissionStatus))
  }

  if (filters.search) {
    // `ilike`, а не `lower(...) like lower(...)`: то же самое без двух вызовов
    // функции на строку. Спецсимволы шаблона (`%`, `_`) сознательно не
    // экранируются — в строке поиска они работают как подстановочные, что для
    // поля поиска скорее полезно, чем неожиданно; на инъекцию это не влияет,
    // значение уходит связанным параметром.
    const pattern = `%${filters.search.trim()}%`
    const match = or(ilike(lounges.name, pattern), ilike(lounges.iataCode, pattern))
    if (match) conditions.push(match)
  }

  return db
    .select({
      loungeId: lounges.id,
      name: lounges.name,
      provider: lounges.provider,
      country: lounges.country,
      city: lounges.city,
      airport: lounges.airport,
      iataCode: lounges.iataCode,
      terminal: lounges.terminal,
      zone: lounges.zone,
      operationalStatus: lounges.operationalStatus,
      statusUntil: lounges.statusUntil,
      submissionId: latest.id,
      submissionStatus: latest.status,
      statusChangedAt: latest.statusChangedAt,
      decidedAt: latest.decidedAt,
      reviewerId: latest.reviewerId,
    })
    .from(lounges)
    // `leftJoin`, а не `innerJoin`: лаунж без анкет обязан быть в реестре.
    // Закрытые лаунжи и лаунжи, до которых сбор данных ещё не дошёл, — это то,
    // что реестр и должен показывать (Global Constraints плана 3), а не то, что
    // он вправе отфильтровать за проверяющего.
    .leftJoin(latest, eq(latest.loungeId, lounges.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(lounges.country, lounges.city, lounges.name)
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Сколько ПОЛНЫХ суток анкета лаунжа висит в своём текущем статусе; `null`, если
 * анкеты нет вовсе.
 *
 * Имя длиннее плановского `daysInStatus` намеренно. У строки реестра два
 * независимых статуса — `submissionStatus` (где сбор данных) и
 * `operationalStatus` (что с объектом), и первое же ограничение плана 3
 * требует их не смешивать. `daysInStatus(row)` не отвечает на вопрос «в каком
 * статусе», а на экране рядом стоят оба; у эксплуатационного статуса времени
 * смены вообще не хранится (в `lounges` есть только `status_until` и
 * `status_comment`), так что «дни в статусе» для него посчитать нечем — и
 * читателю имени это должно быть видно сразу, а не после похода в реализацию.
 *
 * Полные сутки, а не календарные дни: `statusChangedAt` хранится со временем, и
 * 23 часа — это ноль суток, даже если календарный день успел сменить��я.
 */
export function daysInSubmissionStatus(row: RegistryRow, now: Date): number | null {
  if (!row.statusChangedAt) return null
  return Math.floor((now.getTime() - row.statusChangedAt.getTime()) / DAY_MS)
}

/**
 * Значения фильтров, встречающиеся в базе — для выпадающих списков.
 *
 * Один проход по `lounges` вместо четырёх `select distinct`: списки нужны все
 * сразу и всегда вместе (их рисует один экран), так что четыре запроса — это
 * четыре обращения к базе там, где хватает одного. `null` в списки не попадает:
 * `terminal` заполняется только при принятии анкеты
 * (`classifyingFieldsFrom` в `review/decide.ts`), поэтому пустое значение — это
 * обычное состояние лаунжа, а не выбор, который проверяющему стоит предлагать.
 */
export async function filterOptions(db: Db): Promise<{
  countries: string[]
  cities: string[]
  airports: string[]
  terminals: string[]
}> {
  const rows = await db
    .select({
      country: lounges.country,
      city: lounges.city,
      airport: lounges.airport,
      terminal: lounges.terminal,
    })
    .from(lounges)

  const unique = (values: (string | null)[]): string[] =>
    [...new Set(values.filter((v): v is string => v !== null))].sort()

  return {
    countries: unique(rows.map((r) => r.country)),
    cities: unique(rows.map((r) => r.city)),
    airports: unique(rows.map((r) => r.airport)),
    terminals: unique(rows.map((r) => r.terminal)),
  }
}
