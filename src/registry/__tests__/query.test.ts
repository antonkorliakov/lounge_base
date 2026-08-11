import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import type { SubmissionStatus } from '@/db/schema'
import { lounges, submissions } from '@/db/schema'
import {
  listRegistry, filterOptions, daysInSubmissionStatus, type RegistryRow,
} from '../query'

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

  /**
   * Фильтр по статусу анкеты смотрит на ПОСЛЕДНЮЮ анкету, а не на любую из
   * анкет лаунжа. У Primeclass есть и `approved` (январская), но реестр про
   * неё уже не знает: строка реестра — это лаунж плюс его текущее состояние
   * сбора данных. Без этой проверки соединение «по любой анкете» вместо
   * «по последней» проходило бы предыдущий тест и роняло смысл всей выборки.
   */
  it('фильтр по статусу анкеты не находит лаунж по его прежней анкете', async () => {
    const db = await createTestDb()
    await seed(db)

    expect(names(await listRegistry(db, { submissionStatus: ['approved'] }))).toEqual([])
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

  /**
   * Порядок строк — часть ответа, а не случайность: экран реестра (Task 7)
   * показывает их именно так, страна → город → название. Остальные проверки
   * здесь сравнивают отсортированные имена (`names`), то есть порядок не
   * видят вовсе; без этой проверки его можно было бы потерять незаметно.
   */
  it('строки идут по стране, городу и названию', async () => {
    const db = await createTestDb()
    await seed(db)

    expect((await listRegistry(db, {})).map((r) => r.name)).toEqual([
      'IGA Lounge Arrival', 'Primeclass Lounge', 'Marhaba Lounge',
    ])
  })

  /**
   * Значение фильтра — ДАННЫЕ, а не часть запроса. В образце плана этот фильтр
   * собирался через `sql.raw` со склейкой значений в текст SQL, а фильтры
   * приходят из адресной строки (см. Task 7): тип `SubmissionStatus[]` в
   * рантайме не значит ничего.
   *
   * Ожидание — именно отказ базы на невалидном ЗНАЧЕНИИ enum, причём с полной
   * строкой внутри сообщения: это и означает, что она доехала до Postgres
   * целиком, одним параметром, и была отвергнута как данные. Склейка в текст
   * запроса дала бы вместо этого синтаксическую ошибку. Плюс таблица на месте:
   * если бы склейка позволила выполнить второй оператор, от него осталось бы
   * видимое следствие.
   *
   * Проверяется `cause`, а не `message`: drizzle оборачивает отказ базы своим
   * «Failed query: select …», в котором про причину нет ничего.
   */
  it('значение фильтра не может подмешать SQL', async () => {
    const db = await createTestDb()
    await seed(db)
    const evil = "submitted'); drop table lounges; --" as SubmissionStatus

    const failure = await listRegistry(db, { submissionStatus: [evil] }).then(
      () => null,
      (err: unknown) => err as { cause?: { message?: string } },
    )

    expect(failure, 'запрос выполнился вместо отказа').not.toBeNull()
    const cause = String(failure?.cause?.message)
    expect(cause).toMatch(/invalid input value for enum submission_status/)
    expect(cause).toContain('drop table lounges')

    expect(await db.select({ id: lounges.id }).from(lounges)).toHaveLength(3)
  })

  /**
   * Две анкеты одного лаунжа с одинаковым `createdAt` — выбор «последней»
   * обязан быть определённым. `distinct on` без полного упорядочивания отдаёт
   * произвольную из совпавших строк, и выборка начинает мигать между
   * прогонами: реестр показывал бы то одну анкету, то другую при неизменных
   * данных. Правило дописано в модуле: при равном `createdAt` берётся строка с
   * большим `id`.
   *
   * `id` заданы явно, и МЕНЬШИЙ вставлен первым — иначе тест не отличает
   * правило от совпадения. С `defaultRandom()` (первая версия этой проверки)
   * порядок вставки и порядок id совпадают в половине случаев, и снятие
   * третьего ключа сортировки её не ронял��: проверено, 25 тестов остались
   * зелёными. Теперь физический порядок строк заведомо противоположен
   * требуемому, так что пройти её можно только настоящим упорядочиванием.
   */
  it('при одинаковом createdAt последняя анкета выбирается определённо', async () => {
    const db = await createTestDb()
    const [lounge] = await db.insert(lounges).values({
      name: 'Tie', country: 'Turkey', city: 'Istanbul',
      airport: 'Istanbul Airport', iataCode: 'IST',
    }).returning()

    const smaller = '11111111-1111-1111-1111-111111111111'
    const greater = '22222222-2222-2222-2222-222222222222'
    const sameMoment = new Date('2026-04-01T10:00:00Z')

    await db.insert(submissions).values([
      { id: smaller, loungeId: lounge!.id, status: 'draft', createdAt: sameMoment },
      { id: greater, loungeId: lounge!.id, status: 'submitted', createdAt: sameMoment },
    ])

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rows = await listRegistry(db, {})
      expect(rows).toHaveLength(1)
      expect(rows[0]?.submissionId, `прогон ${attempt + 1}`).toBe(greater)
    }
  })
})

/**
 * Значения для выпадающих списков фильтров. В плане эта функция была в образце
 * кода, но ни в одном тесте — а её ответ прямо определяет, что проверяющий
 * вообще может выбрать на экране реестра.
 */
describe('значения фильтров', () => {
  it('уникальны, отсортированы и без пустых', async () => {
    const db = await createTestDb()
    await seed(db)
    // Лаунж без терминала: `terminal` заполняется только при принятии анкеты
    // (`classifyingFieldsFrom`), так что `null` здесь — обычное состояние, а не
    // порча данных, и в списке выбора ему места нет.
    await db.insert(lounges).values({
      name: 'No Terminal', country: 'Turkey', city: 'Ankara',
      airport: 'Esenboğa', iataCode: 'ESB',
    })

    const options = await filterOptions(db)

    expect(options.countries).toEqual(['Turkey', 'UAE'])
    expect(options.cities).toEqual(['Ankara', 'Dubai', 'Istanbul'])
    expect(options.airports).toEqual(['Dubai International', 'Esenboğa', 'Istanbul Airport'])
    expect(options.terminals).toEqual(['main', 't2', 't3'])
  })

  it('на пустой базе — пустые списки, а не отказ', async () => {
    const db = await createTestDb()
    expect(await filterOptions(db)).toEqual({
      countries: [], cities: [], airports: [], terminals: [],
    })
  })
})

describe('время в статусе анкеты', () => {
  const row = (statusChangedAt: Date | null): RegistryRow => ({
    loungeId: 'x', name: 'X', provider: null, country: 'Turkey', city: 'Istanbul',
    airport: 'Istanbul Airport', iataCode: 'IST', terminal: null, zone: null,
    operationalStatus: 'active', statusUntil: null, submissionId: 's1',
    submissionStatus: 'submitted', statusChangedAt, decidedAt: null, reviewerId: null,
  })

  it('считается в полных днях', () => {
    const now = new Date('2026-03-11T00:00:00Z')
    expect(daysInSubmissionStatus(row(new Date('2026-03-05T00:00:00Z')), now)).toBe(6)
  })

  it('без анкеты не считается', () => {
    expect(daysInSubmissionStatus(row(null), new Date('2026-03-11T00:00:00Z'))).toBeNull()
  })

  it('в день смены статуса ноль', () => {
    const now = new Date('2026-03-05T18:00:00Z')
    expect(daysInSubmissionStatus(row(new Date('2026-03-05T09:00:00Z')), now)).toBe(0)
  })

  /**
   * Часы, а не только дни: `statusChangedAt` хранится с временем, и разница
   * 23 часа — это ноль полных суток. Проверка отделяет «полные сутки» от
   * «календарные дни»: у календарного сравнения этот случай дал бы 1.
   */
  it('меньше суток — ноль, даже если календарный день сменился', () => {
    expect(
      daysInSubmissionStatus(
        row(new Date('2026-03-05T23:00:00Z')),
        new Date('2026-03-06T22:00:00Z'),
      ),
    ).toBe(0)
  })
})

/** `submissions` не участвует ни в одном тесте выше как источник строк реестра
 *  напрямую — выборка идёт от `lounges`. Эта проверка держит границу: анкета
 *  без лаунжа невозможна (FK), но лаунж без анкеты — обычное дело, и он обязан
 *  быть в реестре. Явно, а не как следствие сида. */
describe('граница между лаунжем и анкетой', () => {
  it('лаунж без анкет — полноценная строка реестра', async () => {
    const db = await createTestDb()
    const [lounge] = await db.insert(lounges).values({
      name: 'Fresh', country: 'Turkey', city: 'Izmir',
      airport: 'Adnan Menderes', iataCode: 'ADB',
    }).returning()

    const rows = await listRegistry(db, {})
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      loungeId: lounge!.id,
      name: 'Fresh',
      operationalStatus: 'active',
      submissionId: null,
      submissionStatus: null,
      statusChangedAt: null,
      decidedAt: null,
      reviewerId: null,
    })
  })

  it('удаление лаунжа уносит его анкеты и его строку', async () => {
    const db = await createTestDb()
    await seed(db)
    const [gone] = await db.select({ id: lounges.id }).from(lounges).where(eq(lounges.name, 'Primeclass Lounge'))

    await db.delete(lounges).where(eq(lounges.id, gone!.id))

    expect(names(await listRegistry(db, {}))).toEqual(['IGA Lounge Arrival', 'Marhaba Lounge'])
  })
})
