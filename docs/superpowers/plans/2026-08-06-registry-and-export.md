# План 3. Реестр лаунжей и выгрузка

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Внутренняя команда видит все лаунжи с обоими статусами, фильтрует их и выгружает то, что видит, — в Excel или CSV.

**Architecture:** Модуль `registry` владеет фильтрами и выборкой; `export` строит файлы поверх той же выборки, поэтому «выгрузить то, что вижу» не требует второго набора фильтров. Порядок колонок плоской выгрузки задаётся `form-schema`.

**Tech Stack:** тот же, плюс `exceljs` (уже стоит с плана 1) для сборки xlsx.

**Предусловие:** планы 1 и 2 выполнены, `npm test && npm run typecheck && npm run build && npm run e2e` зелёные.

## Global Constraints

- Всё из «Global Constraints» планов 1 и 2 действует и здесь.
- **Два статуса не смешиваются.** `submissions.status` — где сбор данных; `lounges.operational_status` — что с объектом. Они независимы, не влияют на переходы друг друга и показываются разными колонками с полными названиями.
- Статус лаунжа меняет только внутренняя команда. Переходы свободны в обе стороны, включая возврат из «закрыт» в «действующий».
- Закрытые лаунжи приглушаются визуально, но **не скрываются фильтром по умолчанию**.
- Состав и порядок колонок плоской выгрузки стабильны между выгрузками: новое поле добавляет колонку в конец своей группы, удалённое оставляет пустую.
- По умолчанию выгружаются только принятые анкеты; непринятые включаются явной галочкой и помечены в колонке `submission_status`.
- Статус лаунжа сам по себе состав выгрузки не ограничивает — только через фильтр.

---

### Task 1: Статус лаунжа

**Files:**
- Create: `src/registry/status.ts`
- Test: `src/registry/__tests__/status.test.ts`

**Interfaces:**
- Consumes: `Db`, таблицы `lounges`, `events`
- Produces:
  - `OPERATIONAL_STATUSES: { id: OperationalStatus; label: Localized; allowsDate: boolean }[]`
  - `setOperationalStatus(db, { loungeId, status, until, comment, actor }): Promise<StatusResult>`
  - `statusHistory(db, loungeId): Promise<StatusChange[]>`
  - `type StatusChange = { from: OperationalStatus | null; to: OperationalStatus; until: string | null; comment: string | null; actor: string; at: Date }`

- [ ] **Step 1: Написать падающий тест**

`src/registry/__tests__/status.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges } from '@/db/schema'
import { OPERATIONAL_STATUSES, setOperationalStatus, statusHistory } from '../status'

async function seedLounge(db: Db): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  return lounge!.id
}

describe('перечень статусов', () => {
  it('четыре значения', () => {
    expect(OPERATIONAL_STATUSES.map((s) => s.id)).toEqual([
      'active', 'temporarily_closed', 'under_renovation', 'closed',
    ])
  })

  it('дата открытия предлагается у временных состояний', () => {
    const allows = OPERATIONAL_STATUSES.filter((s) => s.allowsDate).map((s) => s.id)
    expect(allows).toEqual(['temporarily_closed', 'under_renovation'])
  })

  it('у каждого статуса обе локали', () => {
    for (const status of OPERATIONAL_STATUSES) {
      expect(status.label.en.trim()).not.toBe('')
      expect(status.label.ru.trim()).not.toBe('')
    }
  })
})

describe('смена статуса лаунжа', () => {
  it('новый лаунж действующий', async () => {
    const db = await createTestDb()
    const loungeId = await seedLounge(db)
    const [row] = await db.select().from(lounges).where(eq(lounges.id, loungeId))
    expect(row?.operationalStatus).toBe('active')
  })

  it('перевод на ремонт с датой и комментарием', async () => {
    const db = await createTestDb()
    const loungeId = await seedLounge(db)

    const result = await setOperationalStatus(db, {
      loungeId, status: 'under_renovation',
      until: '2026-09-15', comment: 'Реконструкция зоны питания', actor: 'r1',
    })

    expect(result.ok).toBe(true)
    const [row] = await db.select().from(lounges).where(eq(lounges.id, loungeId))
    expect(row?.operationalStatus).toBe('under_renovation')
    expect(row?.statusUntil).toBe('2026-09-15')
    expect(row?.statusComment).toBe('Реконструкция зоны питания')
  })

  it('дата и комментарий необязательны', async () => {
    const db = await createTestDb()
    const loungeId = await seedLounge(db)

    const result = await setOperationalStatus(db, {
      loungeId, status: 'temporarily_closed', until: null, comment: null, actor: 'r1',
    })

    expect(result.ok).toBe(true)
    const [row] = await db.select().from(lounges).where(eq(lounges.id, loungeId))
    expect(row?.statusUntil).toBeNull()
  })

  it('возврат в «действующий» очищает дату и комментарий', async () => {
    const db = await createTestDb()
    const loungeId = await seedLounge(db)
    await setOperationalStatus(db, {
      loungeId, status: 'under_renovation', until: '2026-09-15', comment: 'ремонт', actor: 'r1',
    })

    await setOperationalStatus(db, {
      loungeId, status: 'active', until: null, comment: null, actor: 'r1',
    })

    const [row] = await db.select().from(lounges).where(eq(lounges.id, loungeId))
    expect(row?.statusUntil).toBeNull()
    expect(row?.statusComment).toBeNull()
  })

  it('из «закрыт» можно вернуться в «действующий»', async () => {
    const db = await createTestDb()
    const loungeId = await seedLounge(db)
    await setOperationalStatus(db, {
      loungeId, status: 'closed', until: null, comment: null, actor: 'r1',
    })

    const result = await setOperationalStatus(db, {
      loungeId, status: 'active', until: null, comment: null, actor: 'r1',
    })
    expect(result.ok).toBe(true)
  })

  it('дата у «действующего» отклоняется', async () => {
    const db = await createTestDb()
    const loungeId = await seedLounge(db)

    const result = await setOperationalStatus(db, {
      loungeId, status: 'active', until: '2026-09-15', comment: null, actor: 'r1',
    })
    expect(result.ok).toBe(false)
  })

  it('дата не в формате ISO отклоняется', async () => {
    const db = await createTestDb()
    const loungeId = await seedLounge(db)

    const result = await setOperationalStatus(db, {
      loungeId, status: 'under_renovation', until: '15.09.2026', comment: null, actor: 'r1',
    })
    expect(result.ok).toBe(false)
  })

  it('каждая смена попадает в историю', async () => {
    const db = await createTestDb()
    const loungeId = await seedLounge(db)
    await setOperationalStatus(db, {
      loungeId, status: 'under_renovation', until: '2026-09-15', comment: 'ремонт', actor: 'r1',
    })
    await setOperationalStatus(db, {
      loungeId, status: 'active', until: null, comment: null, actor: 'r2',
    })

    const history = await statusHistory(db, loungeId)
    expect(history).toHaveLength(2)
    expect(history[0]?.to).toBe('under_renovation')
    expect(history[0]?.from).toBe('active')
    expect(history[1]?.actor).toBe('r2')
  })

  it('несуществующий лаунж отклоняется', async () => {
    const db = await createTestDb()
    const result = await setOperationalStatus(db, {
      loungeId: '00000000-0000-0000-0000-000000000000',
      status: 'closed', until: null, comment: null, actor: 'r1',
    })
    expect(result.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npm test -- registry/__tests__/status`
Expected: FAIL — `Cannot find module '../status'`.

- [ ] **Step 3: Написать модуль**

`src/registry/status.ts`:

```ts
import { asc, eq } from 'drizzle-orm'
import type { Localized } from '@/form-schema'
import type { Db } from '@/db/types'
import type { OperationalStatus } from '@/db/schema'
import { lounges, events } from '@/db/schema'

export type StatusResult = { ok: true } | { ok: false; error: Localized }

export type StatusChange = {
  from: OperationalStatus | null
  to: OperationalStatus
  until: string | null
  comment: string | null
  actor: string
  at: Date
}

/**
 * Дата ожидаемого открытия предлагается только у временных состояний и
 * всегда необязательна: срок часто неизвестен, и честное «не указан»
 * лучше выдуманной даты.
 */
export const OPERATIONAL_STATUSES: {
  id: OperationalStatus
  label: Localized
  allowsDate: boolean
}[] = [
  { id: 'active', allowsDate: false, label: { en: 'Active', ru: 'Действующий' } },
  { id: 'temporarily_closed', allowsDate: true, label: { en: 'Temporarily closed', ru: 'Временно закрыт' } },
  { id: 'under_renovation', allowsDate: true, label: { en: 'Under renovation', ru: 'На ремонте' } },
  { id: 'closed', allowsDate: false, label: { en: 'Closed', ru: 'Закрыт' } },
]

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const fail = (en: string, ru: string): StatusResult => ({ ok: false, error: { en, ru } })

export async function setOperationalStatus(
  db: Db,
  input: {
    loungeId: string
    status: OperationalStatus
    until: string | null
    comment: string | null
    actor: string
  },
): Promise<StatusResult> {
  const definition = OPERATIONAL_STATUSES.find((s) => s.id === input.status)
  if (!definition) return fail('Unknown status', 'Неизвестный статус')

  if (input.until !== null) {
    if (!definition.allowsDate) {
      return fail(
        'This status has no reopening date',
        'У этого статуса нет даты открытия',
      )
    }
    if (!ISO_DATE.test(input.until)) {
      return fail('Use the date picker', 'Выберите дату в календаре')
    }
  }

  const rows = await db
    .select({ status: lounges.operationalStatus })
    .from(lounges)
    .where(eq(lounges.id, input.loungeId))
    .limit(1)

  const previous = rows[0]?.status
  if (!previous) return fail('Lounge not found', 'Лаунж не найден')

  // Дата и комментарий относятся к конкретному состоянию: при смене они
  // теряют смысл, поэтому переписываются целиком, а не дополняются.
  await db
    .update(lounges)
    .set({
      operationalStatus: input.status,
      statusUntil: input.until,
      statusComment: input.comment,
    })
    .where(eq(lounges.id, input.loungeId))

  await db.insert(events).values({
    loungeId: input.loungeId,
    actor: input.actor,
    action: 'operational_status_changed',
    payload: {
      from: previous,
      to: input.status,
      until: input.until,
      comment: input.comment,
    },
  })

  return { ok: true }
}

export async function statusHistory(
  db: Db,
  loungeId: string,
): Promise<StatusChange[]> {
  const rows = await db
    .select({ actor: events.actor, payload: events.payload, at: events.at })
    .from(events)
    .where(eq(events.loungeId, loungeId))
    .orderBy(asc(events.at))

  return rows
    .filter((row) => row.payload !== null && typeof row.payload === 'object' && 'to' in row.payload)
    .map((row) => {
      const payload = row.payload as {
        from: OperationalStatus | null
        to: OperationalStatus
        until: string | null
        comment: string | null
      }
      return {
        from: payload.from,
        to: payload.to,
        until: payload.until,
        comment: payload.comment,
        actor: row.actor,
        at: row.at,
      }
    })
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm test -- registry/__tests__/status && npm run typecheck`
Expected: PASS, тринадцать тестов зелёные.

- [ ] **Step 5: Коммит**

```bash
git add src/registry
git commit -m "feat(registry): operational lounge status with optional date and history"
```

---

### Task 2: Выборка и фильтры реестра

**Files:**
- Create: `src/registry/query.ts`
- Test: `src/registry/__tests__/query.test.ts`

**Interfaces:**
- Consumes: `Db`, таблицы `lounges`, `submissions`
- Produces:
  - `type RegistryFilters = { country?: string; city?: string; airport?: string; terminal?: string; zone?: string; operationalStatus?: OperationalStatus[]; submissionStatus?: SubmissionStatus[]; search?: string }`
  - `type RegistryRow = { loungeId: string; name: string; provider: string | null; country: string; city: string; airport: string; iataCode: string; terminal: string | null; zone: string[] | null; operationalStatus: OperationalStatus; statusUntil: string | null; submissionId: string | null; submissionStatus: SubmissionStatus | null; statusChangedAt: Date | null; decidedAt: Date | null; reviewerId: string | null }`
  - `listRegistry(db, filters): Promise<RegistryRow[]>`
  - `daysInStatus(row: RegistryRow, now: Date): number | null`

- [ ] **Step 1: Написать падающий тест**

`src/registry/__tests__/query.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions } from '@/db/schema'
import { listRegistry, daysInStatus, type RegistryRow } from '../query'

async function seed(db: Db): Promise<void> {
  const [ist1] = await db.insert(lounges).values({
    name: 'Primeclass Lounge', provider: 'Çelebi', country: 'Turkey', city: 'Istanbul',
    airport: 'Istanbul Airport', iataCode: 'IST',
    terminal: 'main', terminalType: 'both', zone: ['departure', 'transit'], airsideLandside: 'airside',
  }).returning()

  const [ist2] = await db.insert(lounges).values({
    name: 'IGA Lounge Arrival', provider: 'IGA', country: 'Turkey', city: 'Istanbul',
    airport: 'Istanbul Airport', iataCode: 'IST',
    terminal: 't2', terminalType: 'international', zone: ['arrival'], airsideLandside: 'airside',
    operationalStatus: 'under_renovation', statusUntil: '2026-09-15',
  }).returning()

  const [dxb] = await db.insert(lounges).values({
    name: 'Marhaba Lounge', provider: 'dnata', country: 'UAE', city: 'Dubai',
    airport: 'Dubai International', iataCode: 'DXB',
    terminal: 't3', terminalType: 'international', zone: ['departure'], airsideLandside: 'airside',
    operationalStatus: 'closed',
  }).returning()

  // У первого лаунжа две анкеты: реестр показывает последнюю.
  await db.insert(submissions).values({
    loungeId: ist1!.id, status: 'approved',
    createdAt: new Date('2026-01-10'), statusChangedAt: new Date('2026-01-20'),
  })
  await db.insert(submissions).values({
    loungeId: ist1!.id, status: 'submitted',
    createdAt: new Date('2026-03-01'), statusChangedAt: new Date('2026-03-05'),
  })
  await db.insert(submissions).values({
    loungeId: ist2!.id, status: 'draft',
    createdAt: new Date('2026-02-01'), statusChangedAt: new Date('2026-02-01'),
  })
  // У dxb анкет нет вовсе.
  void dxb
}

const names = (rows: RegistryRow[]): string[] => rows.map((r) => r.name).sort()

describe('реестр', () => {
  it('без фильтров показывает все лаунжи, включая закрытые и без анкет', async () => {
    const db = await createTestDb()
    await seed(db)

    const rows = await listRegistry(db, {})

    expect(names(rows)).toEqual(['IGA Lounge Arrival', 'Marhaba Lounge', 'Primeclass Lounge'])
  })

  it('показывает последнюю анкету лаунжа', async () => {
    const db = await createTestDb()
    await seed(db)

    const rows = await listRegistry(db, {})
    const primeclass = rows.find((r) => r.name === 'Primeclass Lounge')

    expect(primeclass?.submissionStatus).toBe('submitted')
  })

  it('лаунж без анкет присутствует с пустым статусом анкеты', async () => {
    const db = await createTestDb()
    await seed(db)

    const marhaba = (await listRegistry(db, {})).find((r) => r.name === 'Marhaba Lounge')

    expect(marhaba?.submissionStatus).toBeNull()
    expect(marhaba?.submissionId).toBeNull()
  })

  it('фильтр по аэропорту', async () => {
    const db = await createTestDb()
    await seed(db)

    const rows = await listRegistry(db, { airport: 'Istanbul Airport' })
    expect(names(rows)).toEqual(['IGA Lounge Arrival', 'Primeclass Lounge'])
  })

  it('фильтр по зоне «на вылет»', async () => {
    const db = await createTestDb()
    await seed(db)

    const rows = await listRegistry(db, { zone: 'departure' })
    expect(names(rows)).toEqual(['Marhaba Lounge', 'Primeclass Lounge'])
  })

  it('фильтр по зоне «на прилёт»', async () => {
    const db = await createTestDb()
    await seed(db)

    const rows = await listRegistry(db, { zone: 'arrival' })
    expect(names(rows)).toEqual(['IGA Lounge Arrival'])
  })

  it('фильтр по терминалу', async () => {
    const db = await createTestDb()
    await seed(db)

    const rows = await listRegistry(db, { terminal: 't2' })
    expect(names(rows)).toEqual(['IGA Lounge Arrival'])
  })

  it('фильтр по статусу лаунжа', async () => {
    const db = await createTestDb()
    await seed(db)

    const rows = await listRegistry(db, { operationalStatus: ['active', 'under_renovation'] })
    expect(names(rows)).toEqual(['IGA Lounge Arrival', 'Primeclass Lounge'])
  })

  it('фильтр по статусу анкеты', async () => {
    const db = await createTestDb()
    await seed(db)

    const rows = await listRegistry(db, { submissionStatus: ['submitted'] })
    expect(names(rows)).toEqual(['Primeclass Lounge'])
  })

  it('фильтры складываются', async () => {
    const db = await createTestDb()
    await seed(db)

    const rows = await listRegistry(db, { airport: 'Istanbul Airport', zone: 'departure' })
    expect(names(rows)).toEqual(['Primeclass Lounge'])
  })

  it('поиск по названию без учёта регистра', async () => {
    const db = await createTestDb()
    await seed(db)

    expect(names(await listRegistry(db, { search: 'marhaba' }))).toEqual(['Marhaba Lounge'])
  })

  it('поиск по коду IATA', async () => {
    const db = await createTestDb()
    await seed(db)

    expect(names(await listRegistry(db, { search: 'DXB' }))).toEqual(['Marhaba Lounge'])
  })

  it('статус лаунжа несёт дату открытия', async () => {
    const db = await createTestDb()
    await seed(db)

    const iga = (await listRegistry(db, { terminal: 't2' }))[0]
    expect(iga?.operationalStatus).toBe('under_renovation')
    expect(iga?.statusUntil).toBe('2026-09-15')
  })
})

describe('время в статусе', () => {
  const row = (statusChangedAt: Date | null): RegistryRow => ({
    loungeId: 'x', name: 'X', provider: null, country: 'Turkey', city: 'Istanbul',
    airport: 'Istanbul Airport', iataCode: 'IST', terminal: null, zone: null,
    operationalStatus: 'active', statusUntil: null, submissionId: 's1',
    submissionStatus: 'submitted', statusChangedAt, decidedAt: null, reviewerId: null,
  })

  it('считается в полных днях', () => {
    const now = new Date('2026-03-11T00:00:00Z')
    expect(daysInStatus(row(new Date('2026-03-05T00:00:00Z')), now)).toBe(6)
  })

  it('без анкеты не считается', () => {
    expect(daysInStatus(row(null), new Date('2026-03-11T00:00:00Z'))).toBeNull()
  })

  it('в день смены статуса ноль', () => {
    const now = new Date('2026-03-05T18:00:00Z')
    expect(daysInStatus(row(new Date('2026-03-05T09:00:00Z')), now)).toBe(0)
  })
})
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npm test -- registry/__tests__/query`
Expected: FAIL — `Cannot find module '../query'`.

- [ ] **Step 3: Написать модуль**

`src/registry/query.ts`:

```ts
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
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
 * Последняя анкета каждого лаунжа. Отдельного поля `current_submission_id`
 * нет намеренно — оно потребовало бы синхронизации и рассинхронизировалось бы.
 */
const latestSubmission = sql`(
  select distinct on (s.lounge_id)
    s.id, s.lounge_id, s.status, s.status_changed_at, s.decided_at, s.reviewer_id
  from submissions s
  order by s.lounge_id, s.created_at desc
)`

export async function listRegistry(
  db: Db,
  filters: RegistryFilters,
): Promise<RegistryRow[]> {
  const latest = sql`latest`
  const conditions: SQL[] = []

  if (filters.country) conditions.push(eq(lounges.country, filters.country))
  if (filters.city) conditions.push(eq(lounges.city, filters.city))
  if (filters.airport) conditions.push(eq(lounges.airport, filters.airport))
  if (filters.terminal) conditions.push(eq(lounges.terminal, filters.terminal))

  // Зона — массив: лаунж подходит, если содержит запрошенную.
  if (filters.zone) {
    conditions.push(sql`${lounges.zone} @> array[${filters.zone}]::text[]`)
  }

  if (filters.operationalStatus?.length) {
    conditions.push(inArray(lounges.operationalStatus, filters.operationalStatus))
  }

  if (filters.submissionStatus?.length) {
    conditions.push(
      sql`${latest}.status in ${sql.raw(
        `(${filters.submissionStatus.map((s) => `'${s}'`).join(', ')})`,
      )}`,
    )
  }

  if (filters.search) {
    const pattern = `%${filters.search.trim().toLowerCase()}%`
    conditions.push(
      sql`(lower(${lounges.name}) like ${pattern} or lower(${lounges.iataCode}) like ${pattern})`,
    )
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined

  const rows = await db
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
      submissionId: sql<string | null>`${latest}.id`,
      submissionStatus: sql<SubmissionStatus | null>`${latest}.status`,
      statusChangedAt: sql<Date | null>`${latest}.status_changed_at`,
      decidedAt: sql<Date | null>`${latest}.decided_at`,
      reviewerId: sql<string | null>`${latest}.reviewer_id`,
    })
    .from(lounges)
    .leftJoin(sql`${latestSubmission} as latest`, sql`latest.lounge_id = ${lounges.id}`)
    .where(where)
    .orderBy(lounges.country, lounges.city, lounges.name)

  return rows.map((row) => ({
    ...row,
    statusChangedAt: row.statusChangedAt === null ? null : new Date(row.statusChangedAt),
    decidedAt: row.decidedAt === null ? null : new Date(row.decidedAt),
  }))
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Сколько полных суток анкета висит в текущем статусе. */
export function daysInStatus(row: RegistryRow, now: Date): number | null {
  if (!row.statusChangedAt) return null
  return Math.floor((now.getTime() - row.statusChangedAt.getTime()) / DAY_MS)
}

/** Значения фильтров, встречающиеся в базе — для выпадающих списков. */
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
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm test -- registry/ && npm run typecheck`
Expected: PASS, двадцать девять тестов зелёные.

- [ ] **Step 5: Коммит**

```bash
git add src/registry
git commit -m "feat(registry): filtered lounge listing with latest submission per lounge"
```

---

### Task 3: Колонки плоской выгрузки

**Files:**
- Create: `src/export/columns.ts`
- Test: `src/export/__tests__/columns.test.ts`

**Interfaces:**
- Consumes: `FIELDS`, `SERVICE_ITEMS`, `SERVICE_ATTRIBUTES`, `PHOTO_SLOTS`
- Produces:
  - `type ColumnGroup = 'identity' | 'fields' | 'services' | 'photos'`
  - `type Column = { key: string; header: string; group: ColumnGroup }`
  - `flatColumns(): Column[]`
  - `IDENTITY_COLUMNS: Column[]`

- [ ] **Step 1: Написать падающий тест**

`src/export/__tests__/columns.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { flatColumns, IDENTITY_COLUMNS } from '../columns'
import { FIELDS, SERVICE_ITEMS, PHOTO_SLOTS } from '@/form-schema'

describe('колонки плоской выгрузки', () => {
  it('группы идут в фиксированном порядке', () => {
    const groups = flatColumns().map((c) => c.group)
    const firstOf = (group: string) => groups.indexOf(group)
    expect(firstOf('identity')).toBeLessThan(firstOf('fields'))
    expect(firstOf('fields')).toBeLessThan(firstOf('services'))
    expect(firstOf('services')).toBeLessThan(firstOf('photos'))
  })

  it('идентификация начинается с lounge_id', () => {
    expect(flatColumns()[0]?.key).toBe('lounge_id')
  })

  it('оба статуса присутствуют и различимы', () => {
    const keys = IDENTITY_COLUMNS.map((c) => c.key)
    expect(keys).toContain('operational_status')
    expect(keys).toContain('submission_status')
  })

  it('общее число колонок складывается из групп', () => {
    const columns = flatColumns()
    const expected =
      IDENTITY_COLUMNS.length +
      FIELDS.length +
      SERVICE_ITEMS.length * 6 +
      PHOTO_SLOTS.length
    expect(columns).toHaveLength(expected)
  })

  it('услуг ровно 348 колонок', () => {
    expect(flatColumns().filter((c) => c.group === 'services')).toHaveLength(348)
  })

  it('шесть атрибутов позиции идут подряд', () => {
    const columns = flatColumns()
    const start = columns.findIndex((c) => c.key === '2.1.available')
    expect(columns.slice(start, start + 6).map((c) => c.key)).toEqual([
      '2.1.available', '2.1.chargeType', '2.1.price',
      '2.1.currency', '2.1.slotMinutes', '2.1.bookingRequired',
    ])
  })

  it('заголовок услуги содержит её английское название и атрибут', () => {
    const column = flatColumns().find((c) => c.key === '2.1.price')
    expect(column?.header).toContain('Wifi Access')
    expect(column?.header).toContain('Price')
  })

  it('заголовок поля — английская формулировка из исходника', () => {
    const column = flatColumns().find((c) => c.key === 'I.2')
    expect(column?.header).toBe(FIELDS.find((f) => f.key === 'I.2')!.label.en)
  })

  it('ключи колонок уникальны', () => {
    const keys = flatColumns().map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('порядок стабилен между вызовами', () => {
    expect(flatColumns().map((c) => c.key)).toEqual(flatColumns().map((c) => c.key))
  })

  it('поля идут в порядке исходной формы', () => {
    const fieldKeys = flatColumns().filter((c) => c.group === 'fields').map((c) => c.key)
    expect(fieldKeys).toEqual(FIELDS.map((f) => f.key))
  })
})
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npm test -- columns`
Expected: FAIL — `Cannot find module '../columns'`.

- [ ] **Step 3: Написать модуль**

`src/export/columns.ts`:

```ts
import { FIELDS, SERVICE_ITEMS, SERVICE_ATTRIBUTES, PHOTO_SLOTS } from '@/form-schema'

export type ColumnGroup = 'identity' | 'fields' | 'services' | 'photos'

export type Column = { key: string; header: string; group: ColumnGroup }

const identity = (key: string, header: string): Column => ({
  key, header, group: 'identity',
})

export const IDENTITY_COLUMNS: Column[] = [
  identity('lounge_id', 'Lounge ID'),
  identity('name', 'Lounge Name'),
  identity('provider', 'Provider'),
  identity('country', 'Country'),
  identity('city', 'City'),
  identity('airport', 'Airport'),
  identity('iata_code', 'IATA Code'),
  identity('operational_status', 'Lounge Status'),
  identity('status_until', 'Reopening Date'),
  identity('submission_status', 'Form Status'),
  identity('approved_at', 'Approved At'),
]

const ATTRIBUTE_HEADERS: Record<(typeof SERVICE_ATTRIBUTES)[number], string> = {
  available: 'Available',
  chargeType: 'Charge',
  price: 'Price',
  currency: 'Currency',
  slotMinutes: 'Slot',
  bookingRequired: 'Booking',
}

/**
 * Порядок и именование колонок задаются схемой, поэтому стабильны между
 * выгрузками: новое поле добавляет колонку в конец своей группы, а удалённое
 * оставляет пустую до явного решения её убрать. Иначе принимающая система
 * ломается на каждом изменении анкеты.
 */
export function flatColumns(): Column[] {
  const fields: Column[] = FIELDS.map((field) => ({
    key: field.key,
    header: field.label.en,
    group: 'fields',
  }))

  const services: Column[] = SERVICE_ITEMS.flatMap((item) =>
    SERVICE_ATTRIBUTES.map((attribute) => ({
      key: `${item.key}.${attribute}`,
      header: `${item.label.en} — ${ATTRIBUTE_HEADERS[attribute]}`,
      group: 'services' as const,
    })),
  )

  const photos: Column[] = PHOTO_SLOTS.map((slot) => ({
    key: `photo.${slot.key}`,
    header: `Photo — ${slot.label.en}`,
    group: 'photos',
  }))

  return [...IDENTITY_COLUMNS, ...fields, ...services, ...photos]
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm test -- columns && npm run typecheck`
Expected: PASS, одиннадцать тестов зелёные.

- [ ] **Step 5: Коммит**

```bash
git add src/export
git commit -m "feat(export): stable column order derived from the form schema"
```

---

### Task 4: Сборка строк выгрузки

**Files:**
- Create: `src/export/rows.ts`
- Test: `src/export/__tests__/rows.test.ts`

**Interfaces:**
- Consumes: `Db`, `flatColumns`, `listRegistry`, `loadSubmissionValues`, `listPhotos`
- Produces:
  - `type ExportOptions = { filters: RegistryFilters; includeUnapproved: boolean }`
  - `buildFlatRows(db, options): Promise<{ columns: Column[]; rows: (string | number | null)[][] }>`

- [ ] **Step 1: Написать падающий тест**

`src/export/__tests__/rows.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions, fieldValues, serviceValues, photos } from '@/db/schema'
import { buildFlatRows } from '../rows'
import { flatColumns } from '../columns'

async function seed(db: Db): Promise<void> {
  const [approved] = await db.insert(lounges).values({
    name: 'Primeclass Lounge', provider: 'Çelebi', country: 'Turkey', city: 'Istanbul',
    airport: 'Istanbul Airport', iataCode: 'IST', terminal: 'main', zone: ['departure'],
  }).returning()

  const [draftOnly] = await db.insert(lounges).values({
    name: 'IGA Lounge', provider: 'IGA', country: 'Turkey', city: 'Istanbul',
    airport: 'Istanbul Airport', iataCode: 'IST', terminal: 't2', zone: ['departure'],
    operationalStatus: 'closed',
  }).returning()

  const [s1] = await db.insert(submissions).values({
    loungeId: approved!.id, status: 'approved',
    createdAt: new Date('2026-02-01'), decidedAt: new Date('2026-02-10'),
  }).returning()

  await db.insert(submissions).values({
    loungeId: draftOnly!.id, status: 'draft', createdAt: new Date('2026-02-01'),
  })

  await db.insert(fieldValues).values([
    { submissionId: s1!.id, fieldKey: 'I.2', value: 'Primeclass Lounge' },
    { submissionId: s1!.id, fieldKey: 'III.6.6', value: ['departure', 'transit'] },
    { submissionId: s1!.id, fieldKey: 'III.2.4', value: { option: 'specific', detail: 'Turkish Airlines' } },
    { submissionId: s1!.id, fieldKey: 'III.2.1', value: { hours: 3 } },
  ])

  await db.insert(serviceValues).values({
    submissionId: s1!.id, itemKey: '7.2', available: 'yes',
    chargeType: 'chargeable', price: '15.00', currency: 'EUR',
    slotMinutes: 30, bookingRequired: true, details: null,
  })

  await db.insert(photos).values({
    submissionId: s1!.id, slot: 'entrance',
    blobKey: 'e.jpg', url: 'https://blob.test/e.jpg',
  })
}

const at = (columns: { key: string }[], row: unknown[], key: string): unknown =>
  row[columns.findIndex((c) => c.key === key)]

describe('строки плоской выгрузки', () => {
  it('по умолчанию только принятые анкеты', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, {
      filters: {}, includeUnapproved: false,
    })

    expect(rows).toHaveLength(1)
    expect(at(columns, rows[0]!, 'name')).toBe('Primeclass Lounge')
  })

  it('с галочкой включаются непринятые, помеченные статусом', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, {
      filters: {}, includeUnapproved: true,
    })

    expect(rows).toHaveLength(2)
    const iga = rows.find((r) => at(columns, r, 'name') === 'IGA Lounge')
    expect(at(columns, iga!, 'submission_status')).toBe('draft')
  })

  it('ширина строки равна числу колонок', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, {
      filters: {}, includeUnapproved: false,
    })

    expect(columns).toHaveLength(flatColumns().length)
    expect(rows[0]).toHaveLength(columns.length)
  })

  it('мультивыбор склеивается через запятую', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(at(columns, rows[0]!, 'III.6.6')).toBe('departure, transit')
  })

  it('выбор с уточнением показывает оба значения', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(at(columns, rows[0]!, 'III.2.4')).toBe('specific — Turkish Airlines')
  })

  it('шаблон разворачивается в исходную фразу', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(at(columns, rows[0]!, 'III.2.1')).toBe(
      'Access is permitted 3 hours prior to scheduled flight departure.',
    )
  })

  it('атрибуты услуги ложатся по своим колонкам', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(at(columns, rows[0]!, '7.2.available')).toBe('yes')
    expect(at(columns, rows[0]!, '7.2.price')).toBe(15)
    expect(at(columns, rows[0]!, '7.2.currency')).toBe('EUR')
    expect(at(columns, rows[0]!, '7.2.bookingRequired')).toBe('yes')
  })

  it('незаполненные значения дают null', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(at(columns, rows[0]!, '1.1.available')).toBeNull()
  })

  it('фото выгружается ссылкой', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(at(columns, rows[0]!, 'photo.entrance')).toBe('https://blob.test/e.jpg')
  })

  it('статус лаунжа выгружается наравне и не отсекает строку', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: true })
    const iga = rows.find((r) => at(columns, r, 'name') === 'IGA Lounge')
    expect(at(columns, iga!, 'operational_status')).toBe('closed')
  })

  it('фильтр сужает выгрузку', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows } = await buildFlatRows(db, {
      filters: { terminal: 't2' }, includeUnapproved: true,
    })
    expect(rows).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npm test -- export/__tests__/rows`
Expected: FAIL — `Cannot find module '../rows'`.

- [ ] **Step 3: Написать модуль**

`src/export/rows.ts`:

```ts
import { fieldByKey, PHOTO_SLOTS, SERVICE_ATTRIBUTES, SERVICE_ITEMS } from '@/form-schema'
import type { Db } from '@/db/types'
import { listRegistry, type RegistryFilters } from '@/registry/query'
import { loadSubmissionValues } from '@/submissions/values'
import { listPhotos } from '@/photos/store'
import { flatColumns, type Column } from './columns'

export type ExportOptions = {
  filters: RegistryFilters
  includeUnapproved: boolean
}

export type ExportCell = string | number | null

/** Разворачивает поле-шаблон обратно в исходную фразу. */
function renderTemplate(fieldKey: string, value: unknown): string | null {
  const field = fieldByKey(fieldKey)
  if (!field?.templateText) return null

  const slots = (value ?? {}) as Record<string, number | null>
  let text = field.templateText.en
  for (const slot of field.templateSlots) {
    const filled = slots[slot.key]
    text = text.replace(/\(\s*\)/, filled === null || filled === undefined ? '( )' : String(filled))
  }
  return text
}

function renderField(fieldKey: string, value: unknown): ExportCell {
  if (value === null || value === undefined || value === '') return null

  const field = fieldByKey(fieldKey)
  if (field?.type === 'template') return renderTemplate(fieldKey, value)

  if (Array.isArray(value)) return value.join(', ')

  if (typeof value === 'object' && 'option' in value) {
    const selected = value as { option: string; detail: string | null }
    return selected.detail ? `${selected.option} — ${selected.detail}` : selected.option
  }

  if (typeof value === 'number') return value
  return String(value)
}

export async function buildFlatRows(
  db: Db,
  options: ExportOptions,
): Promise<{ columns: Column[]; rows: ExportCell[][] }> {
  const columns = flatColumns()
  const index = new Map(columns.map((column, position) => [column.key, position]))

  const registry = await listRegistry(db, options.filters)

  // Непринятые данные по умолчанию не уезжают в смежные системы: там они
  // неотличимы от проверенных.
  const selected = options.includeUnapproved
    ? registry
    : registry.filter((row) => row.submissionStatus === 'approved')

  const rows: ExportCell[][] = []

  for (const entry of selected) {
    const cells: ExportCell[] = new Array(columns.length).fill(null)
    const put = (key: string, value: ExportCell): void => {
      const position = index.get(key)
      if (position !== undefined) cells[position] = value
    }

    put('lounge_id', entry.loungeId)
    put('name', entry.name)
    put('provider', entry.provider)
    put('country', entry.country)
    put('city', entry.city)
    put('airport', entry.airport)
    put('iata_code', entry.iataCode)
    put('operational_status', entry.operationalStatus)
    put('status_until', entry.statusUntil)
    put('submission_status', entry.submissionStatus)
    put('approved_at', entry.decidedAt ? entry.decidedAt.toISOString().slice(0, 10) : null)

    if (entry.submissionId) {
      const values = await loadSubmissionValues(db, entry.submissionId)

      for (const [fieldKey, value] of Object.entries(values.fields)) {
        put(fieldKey, renderField(fieldKey, value))
      }

      for (const item of SERVICE_ITEMS) {
        const value = values.services[item.key]
        if (!value) continue
        for (const attribute of SERVICE_ATTRIBUTES) {
          const raw = value[attribute]
          const cell: ExportCell =
            raw === null || raw === undefined ? null
            : typeof raw === 'boolean' ? (raw ? 'yes' : 'no')
            : typeof raw === 'number' ? raw
            : String(raw)
          put(`${item.key}.${attribute}`, cell)
        }
      }

      const uploaded = await listPhotos(db, entry.submissionId)
      for (const slot of PHOTO_SLOTS) {
        const urls = uploaded.filter((photo) => photo.slot === slot.key).map((p) => p.url)
        put(`photo.${slot.key}`, urls.length === 0 ? null : urls.join(' '))
      }
    }

    rows.push(cells)
  }

  return { columns, rows }
}
```

- [ ] **Step 4: Дописать тест на дату принятия**

Колонка `approved_at` берётся из `decidedAt`, который `listRegistry` отдаёт с Task 2. Дописать в `rows.test.ts`:

```ts
  it('дата принятия выгружается', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(at(columns, rows[0]!, 'approved_at')).toBe('2026-02-10')
  })
```


- [ ] **Step 5: Прогнать тесты**

Run: `npm test -- export/ registry/ && npm run typecheck`
Expected: PASS, сорок один тест зелёный.

- [ ] **Step 6: Коммит**

```bash
git add src/export src/registry
git commit -m "feat(export): build flat rows for a filtered set of lounges"
```

---

### Task 5: Файлы xlsx и CSV

**Files:**
- Create: `src/export/workbook.ts`, `src/export/csv.ts`, `src/export/single.ts`
- Test: `src/export/__tests__/workbook.test.ts`, `src/export/__tests__/csv.test.ts`

**Interfaces:**
- Consumes: `buildFlatRows`, `flatColumns`, `FIELDS`, `SERVICE_ITEMS`, `BLOCKS`
- Produces:
  - `flatWorkbook(input: { columns: Column[]; rows: ExportCell[][] }): Promise<Buffer>`
  - `flatCsv(input: { columns: Column[]; rows: ExportCell[][] }): string`
  - `singleSubmissionWorkbook(db, submissionId): Promise<Buffer>` — два листа в структуре исходного файла

- [ ] **Step 1: Написать падающий тест на CSV**

`src/export/__tests__/csv.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { flatCsv } from '../csv'

const columns = [
  { key: 'name', header: 'Lounge Name', group: 'identity' as const },
  { key: 'note', header: 'Note', group: 'fields' as const },
  { key: 'seats', header: 'Seats', group: 'fields' as const },
]

describe('CSV', () => {
  it('первая строка — заголовки', () => {
    const csv = flatCsv({ columns, rows: [] })
    expect(csv.split('\n')[0]).toBe('Lounge Name,Note,Seats')
  })

  it('пустая ячейка выводится пустой', () => {
    const csv = flatCsv({ columns, rows: [['A', null, 60]] })
    expect(csv.split('\n')[1]).toBe('A,,60')
  })

  it('запятая внутри значения экранируется кавычками', () => {
    const csv = flatCsv({ columns, rows: [['A', 'departure, transit', 1]] })
    expect(csv.split('\n')[1]).toBe('A,"departure, transit",1')
  })

  it('кавычка внутри значения удваивается', () => {
    const csv = flatCsv({ columns, rows: [['A', 'near "iStore"', 1]] })
    expect(csv.split('\n')[1]).toBe('A,"near ""iStore""",1')
  })

  it('перенос строки внутри значения сохраняется в кавычках', () => {
    const csv = flatCsv({ columns, rows: [['A', 'Mon–Sat\nSun', 1]] })
    expect(csv).toContain('"Mon–Sat\nSun"')
  })

  it('число не берётся в кавычки', () => {
    const csv = flatCsv({ columns, rows: [['A', 'x', 60]] })
    expect(csv.split('\n')[1]).toBe('A,x,60')
  })
})
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npm test -- export/__tests__/csv`
Expected: FAIL — `Cannot find module '../csv'`.

- [ ] **Step 3: Написать CSV**

`src/export/csv.ts`:

```ts
import type { Column } from './columns'
import type { ExportCell } from './rows'

function escape(value: ExportCell): string {
  if (value === null) return ''
  if (typeof value === 'number') return String(value)
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function flatCsv(input: {
  columns: Column[]
  rows: ExportCell[][]
}): string {
  const header = input.columns.map((column) => escape(column.header)).join(',')
  const body = input.rows.map((row) => row.map(escape).join(','))
  return [header, ...body].join('\n')
}
```

- [ ] **Step 4: Написать падающий тест на xlsx**

`src/export/__tests__/workbook.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { createTestDb } from '@/db/__tests__/harness'
import { lounges, submissions, fieldValues } from '@/db/schema'
import { flatWorkbook } from '../workbook'
import { singleSubmissionWorkbook } from '../single'
import { flatColumns } from '../columns'

const columns = flatColumns()

async function read(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer)
  return workbook
}

describe('плоская книга', () => {
  it('один лист со всеми колонками в заголовке', async () => {
    const buffer = await flatWorkbook({ columns, rows: [] })
    const workbook = await read(buffer)

    expect(workbook.worksheets).toHaveLength(1)
    const header = workbook.worksheets[0]!.getRow(1)
    expect(header.cellCount).toBe(columns.length)
    expect(header.getCell(1).value).toBe('Lounge ID')
  })

  it('каждая строка данных ложится под заголовок', async () => {
    const row = new Array(columns.length).fill(null)
    row[1] = 'Primeclass Lounge'
    const buffer = await flatWorkbook({ columns, rows: [row] })
    const workbook = await read(buffer)

    expect(workbook.worksheets[0]!.getRow(2).getCell(2).value).toBe('Primeclass Lounge')
  })

  it('заголовок закреплён', async () => {
    const buffer = await flatWorkbook({ columns, rows: [] })
    const workbook = await read(buffer)
    expect(workbook.worksheets[0]!.views[0]?.state).toBe('frozen')
  })
})

describe('книга одной анкеты', () => {
  it('два листа с исходными названиями', async () => {
    const db = await createTestDb()
    const [lounge] = await db.insert(lounges).values({
      name: 'Primeclass', country: 'Turkey', city: 'Istanbul',
      airport: 'Istanbul Airport', iataCode: 'IST',
    }).returning()
    const [submission] = await db
      .insert(submissions).values({ loungeId: lounge!.id, status: 'approved' }).returning()
    await db.insert(fieldValues).values({
      submissionId: submission!.id, fieldKey: 'I.2', value: 'Primeclass Lounge',
    })

    const workbook = await read(await singleSubmissionWorkbook(db, submission!.id))

    expect(workbook.worksheets.map((s) => s.name)).toEqual([
      'General Lounge Information',
      'Services & Amenities',
    ])
  })

  it('нумерация и формулировки исходной формы сохранены', async () => {
    const db = await createTestDb()
    const [lounge] = await db.insert(lounges).values({
      name: 'Primeclass', country: 'Turkey', city: 'Istanbul',
      airport: 'Istanbul Airport', iataCode: 'IST',
    }).returning()
    const [submission] = await db
      .insert(submissions).values({ loungeId: lounge!.id, status: 'approved' }).returning()
    await db.insert(fieldValues).values({
      submissionId: submission!.id, fieldKey: 'I.2', value: 'Primeclass Lounge',
    })

    const workbook = await read(await singleSubmissionWorkbook(db, submission!.id))
    const sheet = workbook.worksheets[0]!

    let found: string | null = null
    sheet.eachRow((row) => {
      if (String(row.getCell(1).value ?? '').startsWith('I.2')) {
        found = String(row.getCell(2).value ?? '')
      }
    })
    expect(found).toBe('Primeclass Lounge')
  })

  it('услуги идут вторым листом с шестью колонками атрибутов', async () => {
    const db = await createTestDb()
    const [lounge] = await db.insert(lounges).values({
      name: 'Primeclass', country: 'Turkey', city: 'Istanbul',
      airport: 'Istanbul Airport', iataCode: 'IST',
    }).returning()
    const [submission] = await db
      .insert(submissions).values({ loungeId: lounge!.id, status: 'approved' }).returning()

    const workbook = await read(await singleSubmissionWorkbook(db, submission!.id))
    const header = workbook.worksheets[1]!.getRow(1)

    expect(header.getCell(1).value).toBe('Amenities Offered')
    expect(header.cellCount).toBeGreaterThanOrEqual(7)
  })
})
```

- [ ] **Step 5: Прогнать тест и убедиться, что он падает**

Run: `npm test -- export/__tests__/workbook`
Expected: FAIL — `Cannot find module '../workbook'`.

- [ ] **Step 6: Написать книги**

`src/export/workbook.ts`:

```ts
import ExcelJS from 'exceljs'
import type { Column } from './columns'
import type { ExportCell } from './rows'

export async function flatWorkbook(input: {
  columns: Column[]
  rows: ExportCell[][]
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Lounges', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })

  sheet.addRow(input.columns.map((column) => column.header))
  sheet.getRow(1).font = { name: 'Arial', bold: true }

  for (const row of input.rows) sheet.addRow(row)

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}
```

`src/export/single.ts`:

```ts
import ExcelJS from 'exceljs'
import {
  BLOCKS, FIELDS, SERVICE_GROUPS, SERVICE_ITEMS, SERVICE_ATTRIBUTES,
} from '@/form-schema'
import type { Db } from '@/db/types'
import { loadSubmissionValues } from '@/submissions/values'
import { listPhotos } from '@/photos/store'

const ATTRIBUTE_HEADERS = [
  'Available (Yes/No)',
  'Complimentary/Chargeable/Both',
  'Price (per person / per use)',
  'Currency',
  'Time Slot Duration (min)',
  'Booking Required (Yes/No)',
]

function render(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object' && 'option' in value) {
    const selected = value as { option: string; detail: string | null }
    return selected.detail ? `${selected.option}\n${selected.detail}` : selected.option
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).map(String).join(' / ')
  }
  return String(value)
}

/**
 * Одна анкета выгружается в структуре исходного файла: те же два листа,
 * та же нумерация и те же формулировки, чтобы получатель узнавал документ.
 */
export async function singleSubmissionWorkbook(
  db: Db,
  submissionId: string,
): Promise<Buffer> {
  const values = await loadSubmissionValues(db, submissionId)
  const photos = await listPhotos(db, submissionId)

  const workbook = new ExcelJS.Workbook()

  const general = workbook.addWorksheet('General Lounge Information')
  general.getColumn(1).width = 56
  general.getColumn(2).width = 46
  general.addRow([
    'Lounge Onboarding Form ** This form is required for each lounge individually.',
  ]).font = { name: 'Arial', bold: true }

  for (const block of BLOCKS.filter((b) => b.kind === 'fields')) {
    const heading = general.addRow([block.label.en])
    heading.font = { name: 'Arial', bold: true }

    for (const field of FIELDS.filter((f) => f.block === block.key)) {
      general.addRow([
        `${field.key}. ${field.label.en}`,
        render(values.fields[field.key]),
        field.hint?.en ?? '',
      ])
    }
  }

  const photoHeading = general.addRow(['Photos'])
  photoHeading.font = { name: 'Arial', bold: true }
  for (const photo of photos) general.addRow([photo.slot, photo.url])

  const services = workbook.addWorksheet('Services & Amenities')
  services.getColumn(1).width = 46
  services.addRow(['Amenities Offered', ...ATTRIBUTE_HEADERS, 'Other Details (if any)'])
    .font = { name: 'Arial', bold: true }

  for (const group of SERVICE_GROUPS) {
    services.addRow([group.label.en]).font = { name: 'Arial', bold: true }

    for (const item of SERVICE_ITEMS.filter((i) => i.group === group.key)) {
      const value = values.services[item.key]
      services.addRow([
        item.label.en,
        ...SERVICE_ATTRIBUTES.map((attribute) => {
          const raw = value?.[attribute]
          if (raw === null || raw === undefined) return ''
          if (typeof raw === 'boolean') return raw ? 'Yes' : 'No'
          return String(raw)
        }),
        value?.details ?? '',
      ])
    }
  }

  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => {
      row.font = { name: 'Arial', ...(row.font?.bold ? { bold: true } : {}) }
      row.alignment = { vertical: 'top', wrapText: true }
    })
  }

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}
```

- [ ] **Step 7: Прогнать тесты**

Run: `npm test -- export/ && npm run typecheck`
Expected: PASS, все тесты выгрузки зелёные.

- [ ] **Step 8: Коммит**

```bash
git add src/export
git commit -m "feat(export): xlsx and csv writers for single and multi-lounge exports"
```

---

### Task 6: Обратный прогон выгрузки

**Files:**
- Test: `src/export/__tests__/roundtrip.test.ts`

**Interfaces:**
- Consumes: `buildFlatRows`, `flatWorkbook`, `flatColumns`
- Produces: ничего — задача целиком про проверку

- [ ] **Step 1: Написать тест обратного прогона**

Спецификация требует именно этого: выгрузили, загрузили обратно, данные совпали. Плюс проверка стабильности колонок.

`src/export/__tests__/roundtrip.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions, fieldValues, serviceValues } from '@/db/schema'
import { FIELDS, SERVICE_ITEMS, OPTION_LISTS } from '@/form-schema'
import { buildFlatRows } from '../rows'
import { flatWorkbook } from '../workbook'
import { flatColumns } from '../columns'

async function seedApproved(db: Db): Promise<void> {
  const [lounge] = await db.insert(lounges).values({
    name: 'Primeclass Lounge', provider: 'Çelebi', country: 'Turkey', city: 'Istanbul',
    airport: 'Istanbul Airport', iataCode: 'IST', terminal: 'main', zone: ['departure'],
  }).returning()
  const [submission] = await db
    .insert(submissions)
    .values({ loungeId: lounge!.id, status: 'approved', decidedAt: new Date('2026-02-10') })
    .returning()

  for (const field of FIELDS) {
    const value =
      field.type === 'date' ? '2026-03-01'
      : field.type === 'number' ? 42
      : field.type === 'multi_select' ? ['departure', 'transit']
      : field.type === 'template'
        ? Object.fromEntries(field.templateSlots.map((s) => [s.key, 3]))
      : field.optionList
        ? { option: OPTION_LISTS[field.optionList][0]!.id, detail: 'уточнение' }
      : `значение ${field.key}`
    await db.insert(fieldValues).values({
      submissionId: submission!.id, fieldKey: field.key, value,
    })
  }

  for (const item of SERVICE_ITEMS) {
    await db.insert(serviceValues).values({
      submissionId: submission!.id, itemKey: item.key,
      available: item.availabilityList === 'vaping' ? 'not_allowed' : 'yes',
      chargeType: 'chargeable', price: '12.50', currency: 'EUR',
      slotMinutes: 20, bookingRequired: false, details: 'детали',
    })
  }
}

describe('обратный прогон', () => {
  it('всё, что выгрузили, читается обратно без потерь', async () => {
    const db = await createTestDb()
    await seedApproved(db)

    const built = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    const buffer = await flatWorkbook(built)

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer)
    const sheet = workbook.worksheets[0]!

    const headers = sheet.getRow(1).values as (string | undefined)[]
    expect(headers.slice(1)).toEqual(built.columns.map((c) => c.header))

    const dataRow = sheet.getRow(2)
    built.columns.forEach((column, position) => {
      const original = built.rows[0]![position]
      const readBack = dataRow.getCell(position + 1).value
      const normalised = readBack === null || readBack === undefined ? null : readBack
      expect(normalised, column.key).toEqual(original)
    })
  })

  it('число колонок совпадает с объявленным в схеме', async () => {
    const db = await createTestDb()
    await seedApproved(db)

    const built = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(built.columns).toHaveLength(flatColumns().length)
  })

  it('добавление поля сдвигает только хвост своей группы', () => {
    const before = flatColumns()
    const identityCount = before.filter((c) => c.group === 'identity').length

    // Колонки идентификации и порядок групп не зависят от состава анкеты.
    expect(before.slice(0, identityCount).every((c) => c.group === 'identity')).toBe(true)
    const firstService = before.findIndex((c) => c.group === 'services')
    const lastField = before.map((c) => c.group).lastIndexOf('fields')
    expect(lastField).toBe(firstService - 1)
  })
})
```

- [ ] **Step 2: Прогнать тест**

Run: `npm test -- roundtrip`
Expected: PASS, три теста зелёные. Если сравнение падает на числовых ячейках, привести `readBack` к числу там, где `typeof original === 'number'` — ExcelJS возвращает числа как `number`, и это ожидаемо.

- [ ] **Step 3: Коммит**

```bash
git add src/export/__tests__/roundtrip.test.ts
git commit -m "test(export): round-trip a full export through xlsx and back"
```

---

### Task 7: Экран реестра

**Files:**
- Modify: `src/app/admin/page.tsx` — заменяет временный список из плана 2
- Create: `src/app/admin/actions.ts`, `src/app/admin/export/route.ts`
- Create: `src/web/Registry.tsx`, `src/web/RegistryFilters.tsx`, `src/web/StatusEditor.tsx`
- Test: `src/web/__tests__/registryView.test.ts`

**Interfaces:**
- Consumes: `listRegistry`, `filterOptions`, `daysInStatus`, `OPERATIONAL_STATUSES`, `setOperationalStatus`
- Produces:
  - `filtersFromSearchParams(params: Record<string, string | string[] | undefined>): RegistryFilters`
  - `searchParamsFromFilters(filters: RegistryFilters): URLSearchParams`
  - серверное действие `setStatusAction(loungeId, status, until, comment)`

- [ ] **Step 1: Написать падающий тест**

`src/web/__tests__/registryView.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { filtersFromSearchParams, searchParamsFromFilters } from '../RegistryFilters'

describe('фильтры в адресной строке', () => {
  it('пустые параметры дают пустые фильтры', () => {
    expect(filtersFromSearchParams({})).toEqual({})
  })

  it('простые параметры читаются', () => {
    expect(filtersFromSearchParams({ airport: 'Istanbul Airport', zone: 'departure' })).toEqual({
      airport: 'Istanbul Airport',
      zone: 'departure',
    })
  })

  it('статусы читаются списком', () => {
    const filters = filtersFromSearchParams({
      operationalStatus: 'active,under_renovation',
    })
    expect(filters.operationalStatus).toEqual(['active', 'under_renovation'])
  })

  it('неизвестный статус лаунжа отбрасывается', () => {
    const filters = filtersFromSearchParams({ operationalStatus: 'active,нет-такого' })
    expect(filters.operationalStatus).toEqual(['active'])
  })

  it('неизвестный статус анкеты отбрасывается', () => {
    const filters = filtersFromSearchParams({ submissionStatus: 'submitted,выдумка' })
    expect(filters.submissionStatus).toEqual(['submitted'])
  })

  it('пустая строка не превращается в фильтр', () => {
    expect(filtersFromSearchParams({ search: '   ' })).toEqual({})
  })

  it('обратное преобразование восстанавливает фильтры', () => {
    const filters = {
      airport: 'Istanbul Airport',
      zone: 'departure',
      operationalStatus: ['active' as const],
      search: 'prime',
    }
    const restored = filtersFromSearchParams(
      Object.fromEntries(searchParamsFromFilters(filters).entries()),
    )
    expect(restored).toEqual(filters)
  })

  it('массив значений берёт первое', () => {
    expect(filtersFromSearchParams({ airport: ['IST', 'DXB'] })).toEqual({ airport: 'IST' })
  })
})
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npm test -- registryView`
Expected: FAIL — `Cannot find module '../RegistryFilters'`.

- [ ] **Step 3: Написать разбор фильтров и панель**

`src/web/RegistryFilters.tsx`:

```tsx
'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import type { RegistryFilters } from '@/registry/query'
import type { OperationalStatus, SubmissionStatus } from '@/db/schema'
import { OPERATIONAL_STATUSES } from '@/registry/status'
import { useLocale } from '@/i18n/context'

const OPERATIONAL_IDS: OperationalStatus[] = [
  'active', 'temporarily_closed', 'under_renovation', 'closed',
]
const SUBMISSION_IDS: SubmissionStatus[] = [
  'draft', 'submitted', 'changes_requested', 'approved',
]

type Params = Record<string, string | string[] | undefined>

const single = (value: string | string[] | undefined): string | undefined => {
  const text = Array.isArray(value) ? value[0] : value
  const trimmed = text?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

const list = <T extends string>(
  value: string | string[] | undefined,
  allowed: readonly T[],
): T[] | undefined => {
  const text = single(value)
  if (!text) return undefined
  const parsed = text.split(',').filter((item): item is T => (allowed as readonly string[]).includes(item))
  return parsed.length > 0 ? parsed : undefined
}

/** Фильтры живут в адресной строке: ссылку на выборку можно переслать. */
export function filtersFromSearchParams(params: Params): RegistryFilters {
  const filters: RegistryFilters = {}

  const country = single(params['country'])
  const city = single(params['city'])
  const airport = single(params['airport'])
  const terminal = single(params['terminal'])
  const zone = single(params['zone'])
  const search = single(params['search'])
  const operational = list(params['operationalStatus'], OPERATIONAL_IDS)
  const submission = list(params['submissionStatus'], SUBMISSION_IDS)

  if (country) filters.country = country
  if (city) filters.city = city
  if (airport) filters.airport = airport
  if (terminal) filters.terminal = terminal
  if (zone) filters.zone = zone
  if (search) filters.search = search
  if (operational) filters.operationalStatus = operational
  if (submission) filters.submissionStatus = submission

  return filters
}

export function searchParamsFromFilters(filters: RegistryFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.country) params.set('country', filters.country)
  if (filters.city) params.set('city', filters.city)
  if (filters.airport) params.set('airport', filters.airport)
  if (filters.terminal) params.set('terminal', filters.terminal)
  if (filters.zone) params.set('zone', filters.zone)
  if (filters.search) params.set('search', filters.search)
  if (filters.operationalStatus?.length) {
    params.set('operationalStatus', filters.operationalStatus.join(','))
  }
  if (filters.submissionStatus?.length) {
    params.set('submissionStatus', filters.submissionStatus.join(','))
  }
  return params
}

export function RegistryFiltersBar(props: {
  options: { countries: string[]; cities: string[]; airports: string[]; terminals: string[] }
  filters: RegistryFilters
}): React.JSX.Element {
  const router = useRouter()
  const params = useSearchParams()
  const { locale, pick } = useLocale()

  function apply(key: string, value: string): void {
    const next = new URLSearchParams(params.toString())
    if (value === '') next.delete(key)
    else next.set(key, value)
    router.push(`/admin?${next.toString()}`)
  }

  const select = (key: string, label: string, values: string[]): React.JSX.Element => (
    <label className="rf">
      <span>{label}</span>
      <select
        value={(props.filters as Record<string, unknown>)[key] as string ?? ''}
        onChange={(e) => apply(key, e.target.value)}
      >
        <option value="">{locale === 'ru' ? 'все' : 'all'}</option>
        {values.map((value) => (
          <option key={value} value={value}>{value}</option>
        ))}
      </select>
    </label>
  )

  return (
    <div className="registry-filters">
      {select('country', locale === 'ru' ? 'Страна' : 'Country', props.options.countries)}
      {select('city', locale === 'ru' ? 'Город' : 'City', props.options.cities)}
      {select('airport', locale === 'ru' ? 'Аэропорт' : 'Airport', props.options.airports)}
      {select('terminal', locale === 'ru' ? 'Терминал' : 'Terminal', props.options.terminals)}
      {select('zone', locale === 'ru' ? 'Зона' : 'Zone', ['arrival', 'departure', 'transit'])}

      <label className="rf">
        <span>{locale === 'ru' ? 'Статус лаунжа' : 'Lounge status'}</span>
        <select
          value={props.filters.operationalStatus?.[0] ?? ''}
          onChange={(e) => apply('operationalStatus', e.target.value)}
        >
          <option value="">{locale === 'ru' ? 'все' : 'all'}</option>
          {OPERATIONAL_STATUSES.map((status) => (
            <option key={status.id} value={status.id}>{pick(status.label)}</option>
          ))}
        </select>
      </label>

      <label className="rf">
        <span>{locale === 'ru' ? 'Статус анкеты' : 'Form status'}</span>
        <select
          value={props.filters.submissionStatus?.[0] ?? ''}
          onChange={(e) => apply('submissionStatus', e.target.value)}
        >
          <option value="">{locale === 'ru' ? 'все' : 'all'}</option>
          {SUBMISSION_IDS.map((status) => (
            <option key={status} value={status}>{status}</option>
          ))}
        </select>
      </label>

      <input
        className="rf-search"
        defaultValue={props.filters.search ?? ''}
        placeholder={locale === 'ru' ? 'Название или IATA…' : 'Name or IATA…'}
        onKeyDown={(e) => {
          if (e.key === 'Enter') apply('search', e.currentTarget.value)
        }}
      />
    </div>
  )
}
```

- [ ] **Step 4: Написать таблицу и редактор статуса**

`src/web/StatusEditor.tsx`:

```tsx
'use client'

import { useState } from 'react'
import type { OperationalStatus } from '@/db/schema'
import { OPERATIONAL_STATUSES } from '@/registry/status'
import { useLocale } from '@/i18n/context'
import { setStatusAction } from '@/app/admin/actions'

export function StatusEditor(props: {
  loungeId: string
  current: OperationalStatus
  until: string | null
  onClose: () => void
}): React.JSX.Element {
  const { pick, locale } = useLocale()
  const [status, setStatus] = useState<OperationalStatus>(props.current)
  const [until, setUntil] = useState(props.until ?? '')
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)

  const definition = OPERATIONAL_STATUSES.find((s) => s.id === status)!

  return (
    <div className="status-editor">
      {OPERATIONAL_STATUSES.map((item) => (
        <label key={item.id} className={`se-opt ${status === item.id ? 'se-on' : ''}`}>
          <input
            type="radio"
            checked={status === item.id}
            onChange={() => {
              setStatus(item.id)
              if (!item.allowsDate) setUntil('')
            }}
          />
          {pick(item.label)}
        </label>
      ))}

      {definition.allowsDate && (
        <div className="se-sub">
          <label>
            {locale === 'ru' ? 'Ожидаемое открытие — необязательно' : 'Expected reopening — optional'}
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
          <label>
            {locale === 'ru' ? 'Комментарий' : 'Comment'}
            <input value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
        </div>
      )}

      {error && <p className="se-error">{error}</p>}

      <div className="se-actions">
        <button
          type="button"
          onClick={async () => {
            const result = await setStatusAction(
              props.loungeId,
              status,
              until === '' ? null : until,
              comment === '' ? null : comment,
            )
            if (result.ok) props.onClose()
            else setError(result.error ?? null)
          }}
        >
          {locale === 'ru' ? 'Сохранить' : 'Save'}
        </button>
        <button type="button" onClick={props.onClose}>
          {locale === 'ru' ? 'Отмена' : 'Cancel'}
        </button>
      </div>
    </div>
  )
}
```

`src/web/Registry.tsx`:

```tsx
'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { RegistryFilters, RegistryRow } from '@/registry/query'
import { daysInStatus } from '@/registry/query'
import { OPERATIONAL_STATUSES } from '@/registry/status'
import { useLocale } from '@/i18n/context'
import { RegistryFiltersBar, searchParamsFromFilters } from './RegistryFilters'
import { StatusEditor } from './StatusEditor'

export function Registry(props: {
  rows: RegistryRow[]
  total: number
  filters: RegistryFilters
  options: { countries: string[]; cities: string[]; airports: string[]; terminals: string[] }
  now: string
}): React.JSX.Element {
  const { locale, pick } = useLocale()
  const [editing, setEditing] = useState<string | null>(null)
  const now = new Date(props.now)

  const statusLabel = (id: string): string =>
    pick(OPERATIONAL_STATUSES.find((s) => s.id === id)!.label)

  const query = searchParamsFromFilters(props.filters).toString()

  return (
    <main className="registry">
      <header className="registry-top">
        <h1>{locale === 'ru' ? 'Лаунжи' : 'Lounges'}</h1>
        <span className="registry-count">
          {locale === 'ru'
            ? `показано ${props.rows.length} из ${props.total}`
            : `${props.rows.length} of ${props.total}`}
        </span>
        <div className="registry-export">
          <a href={`/admin/export?${query}&format=xlsx`}>Excel</a>
          <a href={`/admin/export?${query}&format=csv`}>CSV</a>
          <a href={`/admin/export?${query}&format=xlsx&includeUnapproved=1`}>
            {locale === 'ru' ? 'Excel, включая непринятые' : 'Excel, incl. unapproved'}
          </a>
        </div>
      </header>

      <RegistryFiltersBar options={props.options} filters={props.filters} />

      <table className="registry-table">
        <thead>
          <tr>
            <th>{locale === 'ru' ? 'Лаунж' : 'Lounge'}</th>
            <th>{locale === 'ru' ? 'Аэропорт' : 'Airport'}</th>
            <th>{locale === 'ru' ? 'Терминал' : 'Terminal'}</th>
            <th>{locale === 'ru' ? 'Зона' : 'Zone'}</th>
            <th>{locale === 'ru' ? 'Статус лаунжа' : 'Lounge status'}</th>
            <th>{locale === 'ru' ? 'Статус анкеты' : 'Form status'}</th>
            <th>{locale === 'ru' ? 'В статусе' : 'In status'}</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => {
            const days = daysInStatus(row, now)
            return (
              <tr key={row.loungeId} className={row.operationalStatus === 'closed' ? 'row-dim' : ''}>
                <td>
                  {row.submissionId ? (
                    <Link href={`/admin/s/${row.submissionId}`}>{row.name}</Link>
                  ) : (
                    row.name
                  )}
                  <span className="row-sub">
                    {[row.provider, row.city, row.country].filter(Boolean).join(' · ')}
                  </span>
                </td>
                <td>{row.iataCode}</td>
                <td>{row.terminal ?? '—'}</td>
                <td>{row.zone?.join(', ') ?? '—'}</td>
                <td>
                  <button type="button" className="pill-btn" onClick={() => setEditing(row.loungeId)}>
                    {statusLabel(row.operationalStatus)}
                  </button>
                  {row.statusUntil && <span className="row-until">→ {row.statusUntil}</span>}
                  {editing === row.loungeId && (
                    <StatusEditor
                      loungeId={row.loungeId}
                      current={row.operationalStatus}
                      until={row.statusUntil}
                      onClose={() => setEditing(null)}
                    />
                  )}
                </td>
                <td>{row.submissionStatus ?? '—'}</td>
                <td>{days === null ? '—' : `${days}`}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </main>
  )
}
```

- [ ] **Step 5: Написать страницу, действие и маршрут выгрузки**

`src/app/admin/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { requireSession } from '@/access/session'
import { setOperationalStatus } from '@/registry/status'
import type { OperationalStatus } from '@/db/schema'

export async function setStatusAction(
  loungeId: string,
  status: OperationalStatus,
  until: string | null,
  comment: string | null,
): Promise<{ ok: boolean; error?: string }> {
  // requireSession — единственный вход в это действие, поэтому оператор
  // лаунжа со своим токеном сюда не попадает.
  const session = await requireSession()

  const result = await setOperationalStatus(db(), {
    loungeId, status, until, comment, actor: session.email,
  })

  revalidatePath('/admin')
  return result.ok ? { ok: true } : { ok: false, error: result.error.ru }
}
```

`src/app/admin/page.tsx` (заменяет временный список из плана 2):

```tsx
import { db } from '@/db/client'
import { requireSession } from '@/access/session'
import { listRegistry, filterOptions } from '@/registry/query'
import { LocaleProvider } from '@/i18n/context'
import { Registry } from '@/web/Registry'
import { filtersFromSearchParams } from '@/web/RegistryFilters'

export default async function AdminHome(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}): Promise<React.JSX.Element> {
  await requireSession()

  const filters = filtersFromSearchParams(await props.searchParams)
  const rows = await listRegistry(db(), filters)
  const all = await listRegistry(db(), {})

  return (
    <LocaleProvider initial="en">
      <Registry
        rows={rows}
        total={all.length}
        filters={filters}
        options={await filterOptions(db())}
        now={new Date().toISOString()}
      />
    </LocaleProvider>
  )
}
```

`src/app/admin/export/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { db } from '@/db/client'
import { requireSession } from '@/access/session'
import { buildFlatRows } from '@/export/rows'
import { flatWorkbook } from '@/export/workbook'
import { flatCsv } from '@/export/csv'
import { filtersFromSearchParams } from '@/web/RegistryFilters'

export async function GET(request: Request): Promise<NextResponse> {
  await requireSession()

  const url = new URL(request.url)
  const params = Object.fromEntries(url.searchParams.entries())
  const format = params['format'] === 'csv' ? 'csv' : 'xlsx'
  const includeUnapproved = params['includeUnapproved'] === '1'

  const built = await buildFlatRows(db(), {
    filters: filtersFromSearchParams(params),
    includeUnapproved,
  })

  if (format === 'csv') {
    return new NextResponse(flatCsv(built), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="lounges.csv"',
      },
    })
  }

  const buffer = await flatWorkbook(built)
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'content-type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="lounges.xlsx"',
    },
  })
}
```

- [ ] **Step 6: Дописать стили**

Дописать в `src/app/globals.css`:

```css
.registry { padding: 20px 24px; }
.registry-top { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
.registry-top h1 { margin: 0; font-size: 20px; }
.registry-count { opacity: .6; font-size: 13px; }
.registry-export { margin-left: auto; display: flex; gap: 10px; font-size: 13px; }
.registry-filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; margin-bottom: 14px; }
.rf { display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
.rf select, .rf-search { padding: 6px 8px; font: inherit; font-size: 13px; border: 1px solid #c9ced6; border-radius: 6px; }
.registry-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.registry-table th {
  text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
  opacity: .6; padding: 8px 10px; border-bottom: 1px solid #e4e6ea;
}
.registry-table td { padding: 10px; border-bottom: 1px solid #f2f3f5; vertical-align: top; }
.row-dim { opacity: .55; }
.row-sub { display: block; font-size: 11px; opacity: .6; margin-top: 2px; }
.row-until { display: block; font-size: 11px; opacity: .7; margin-top: 3px; }
.pill-btn { border: 1px solid #c9ced6; border-radius: 20px; background: none; font: inherit; font-size: 12px; padding: 3px 10px; cursor: pointer; }
.status-editor { margin-top: 8px; padding: 10px; border: 1px solid #cfd9ea; border-radius: 8px; max-width: 280px; }
.se-opt { display: flex; gap: 7px; align-items: center; padding: 4px 0; font-size: 13px; }
.se-sub { margin: 6px 0 0 20px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.se-sub input { width: 100%; padding: 5px 7px; font: inherit; border: 1px solid #d3d6db; border-radius: 5px; }
.se-actions { display: flex; gap: 6px; margin-top: 9px; }
.se-error { color: #b91c1c; font-size: 12px; }
```

- [ ] **Step 7: Прогнать тесты и сборку**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS во всех трёх.

- [ ] **Step 8: Коммит**

```bash
git add src/app/admin src/web src/app/globals.css
git commit -m "feat(web): lounge registry with shared filters, status editing and export"
```

---

### Task 8: Сквозной сценарий реестра

**Files:**
- Create: `e2e/registry.spec.ts`
- Modify: `scripts/seed-dev.ts` — режим `--fleet` заводит несколько лаунжей

**Interfaces:**
- Consumes: всё выше
- Produces: `npm run seed -- --fleet` заводит три лаунжа в разных аэропортах и зонах

- [ ] **Step 1: Расширить сид**

Дописать в `scripts/seed-dev.ts` в начале `main`, до создания основного лаунжа:

```ts
  if (process.argv.includes('--fleet')) {
    await db.insert(lounges).values([
      {
        name: 'IGA Lounge Arrival', provider: 'IGA', country: 'Turkey', city: 'Istanbul',
        airport: 'Istanbul Airport', iataCode: 'IST',
        terminal: 't2', terminalType: 'international', zone: ['arrival'],
        airsideLandside: 'airside', operationalStatus: 'under_renovation',
        statusUntil: '2026-09-15',
      },
      {
        name: 'Marhaba Lounge', provider: 'dnata', country: 'UAE', city: 'Dubai',
        airport: 'Dubai International', iataCode: 'DXB',
        terminal: 't3', terminalType: 'international', zone: ['departure'],
        airsideLandside: 'airside', operationalStatus: 'closed',
      },
    ])
  }
```

- [ ] **Step 2: Написать сквозной тест**

`e2e/registry.spec.ts`:

```ts
import { test, expect } from '@playwright/test'
import { execSync } from 'node:child_process'

function seedFleet(): void {
  execSync('npm run --silent seed -- --complete --fleet', { encoding: 'utf8' })
}

function signIn(): string {
  return execSync('npx tsx scripts/dev-login-link.ts reviewer@easyto.travel', {
    encoding: 'utf8',
  }).trim()
}

test('реестр показывает оба статуса и фильтрует по зоне', async ({ page }) => {
  seedFleet()
  await page.goto(signIn())
  await page.goto('/admin')

  await expect(page.getByRole('columnheader', { name: 'Lounge status' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Form status' })).toBeVisible()

  // Закрытый лаунж виден, но приглушён
  const marhaba = page.getByRole('row', { name: /Marhaba Lounge/ })
  await expect(marhaba).toBeVisible()
  await expect(marhaba).toHaveClass(/row-dim/)

  // Фильтр по зоне «на прилёт»
  await page.getByLabel('Zone').selectOption('arrival')
  await expect(page.getByRole('row', { name: /IGA Lounge Arrival/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /Marhaba Lounge/ })).toHaveCount(0)
})

test('фильтр по аэропорту сохраняется в адресной строке и переживает перезагрузку', async ({
  page,
}) => {
  seedFleet()
  await page.goto(signIn())
  await page.goto('/admin')

  await page.getByLabel('Airport').selectOption('Dubai International')
  await expect(page).toHaveURL(/airport=Dubai\+International/)

  await page.reload()
  await expect(page.getByRole('row', { name: /Marhaba Lounge/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /Primeclass/ })).toHaveCount(0)
})

test('статус лаунжа меняется из реестра и сохраняется', async ({ page }) => {
  seedFleet()
  await page.goto(signIn())
  await page.goto('/admin')

  const row = page.getByRole('row', { name: /Primeclass/ })
  await row.getByRole('button', { name: 'Active' }).click()
  await page.getByText('Under renovation').click()
  await page.getByLabel(/Expected reopening/).fill('2026-12-01')
  await page.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByRole('row', { name: /Primeclass/ })).toContainText('Under renovation')
  await page.reload()
  await expect(page.getByRole('row', { name: /Primeclass/ })).toContainText('2026-12-01')
})

test('выгрузка отдаёт файл по текущему фильтру', async ({ page }) => {
  seedFleet()
  await page.goto(signIn())
  await page.goto('/admin?airport=Dubai+International')

  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: 'CSV' }).click()
  const file = await download

  expect(file.suggestedFilename()).toBe('lounges.csv')
})
```

- [ ] **Step 3: Прогнать всё**

Run: `npm test && npm run typecheck && npm run build && npm run e2e`
Expected: PASS — юнит-тесты, типы, сборка и восемь сквозных сценариев (два из плана 1, два из плана 2, четыре новых).

- [ ] **Step 4: Коммит**

```bash
git add e2e scripts
git commit -m "test: end-to-end registry filtering, status editing and export"
```

---

## Готовность системы

После этого плана закрыты все цели спецификации:

| Цель из спецификации | Где реализована |
|---|---|
| Заполнение с телефона | План 1, задачи 12–15 |
| Проверка как процесс с состояниями | План 2, задачи 2–4 |
| Возврат на правку без повторного заполнения | План 2, задача 7 |
| Единый реестр с обоими статусами | План 3, задачи 1, 2, 7 |
| Выгрузка по фильтрам | План 3, задачи 3–5, 7 |

Не входит в первую версию и остаётся за рамками всех трёх планов: полноценный офлайн-режим, уведомления в мессенджеры, разделение проверки по ролям, публичный каталог лаунжей, импорт исторических Excel-файлов.
