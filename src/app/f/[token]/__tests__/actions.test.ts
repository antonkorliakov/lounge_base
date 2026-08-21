import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions } from '@/db/schema'
import { BLOCKS } from '@/form-schema'
import { importAirports } from '@/registry/directory'
import { createLounge, DERIVED_FIELD_KEYS, IATA_FIELD_KEY } from '@/registry/manage'
import { loadSubmissionValues } from '@/submissions/values'
import { raiseFlag, openFlags } from '@/review/flags'
import { confirmBlock } from '@/review/blocks'
import { approveSubmission } from '@/review/decide'

/**
 * Серверные ворота производных полей паспорта НА ДВЕРИ ОПЕРАТОРА —
 * `saveFieldAction` (см. `saveOperatorField` в `registry/manage.ts`). До этих
 * ворот замок I.7–I.9 был только в UI: действие достижимо по сети напрямую, и
 * держатель fill-токена мог записать любую страну поверх выведенной из
 * справочника. Здесь закрепляются обе половины контракта:
 *
 *  - прямая запись производного поля — отказ, И НИЧЕГО НЕ ЗАПИСАНО (отказы
 *    проверяются последствием, перечитыванием базы, — правило стенда
 *    `manage-actions.test.ts`);
 *  - запись кода IATA — через справочник: промах — отказ без следа, попадание
 *    — вся четвёрка I.10+I.7/8/9 одной транзакцией, и замечания по КАЖДОМУ из
 *    четырёх ключей сняты (исправленный код отвечает и на «не ту страну»).
 *
 * Стенд — тот же, что у `manage-actions.test.ts`: PGlite вместо `db()` (мок
 * `@/db/client`), НАСТОЯЩИЙ токен из `createLounge` вместо мока резолвера —
 * `resolveFillToken` работает против той же PGlite, так что путь от токена до
 * записи проверяется целиком, без подмен.
 */
const holder = vi.hoisted(() => ({ db: undefined as Db | undefined }))

vi.mock('@/db/client', () => ({
  db: (): Db => {
    if (!holder.db) throw new Error('test db not ready')
    return holder.db
  },
  createDb: (): Db => {
    if (!holder.db) throw new Error('test db not ready')
    return holder.db
  },
}))

const { saveFieldAction, searchAirportsFillAction } = await import('../actions')

const DIRECTORY = [
  { iata: 'IST', airport: 'Istanbul Airport', city: 'Istanbul', country: 'Turkey', prominent: true },
  { iata: 'ESB', airport: 'Esenboga International', city: 'Ankara', country: 'Turkey', prominent: false },
]

/** Ответы четвёрки, какими их предзаполняет `createLounge` для IST. */
const PREFILLED_IST = {
  'I.7': 'Turkey',
  'I.8': 'Istanbul',
  'I.9': 'Istanbul Airport',
  'I.10': 'IST',
}

async function seedLounge(): Promise<{ token: string; submissionId: string; loungeId: string }> {
  const created = await createLounge(holder.db!, {
    name: 'Aurora Lounge',
    provider: 'dnata',
    iataCode: 'IST',
  })
  if (!created.ok) throw new Error('seed: createLounge failed')
  return { token: created.token, submissionId: created.submissionId, loungeId: created.loungeId }
}

async function quartet(submissionId: string): Promise<Record<string, unknown>> {
  const values = await loadSubmissionValues(holder.db!, submissionId)
  return Object.fromEntries(
    [...DERIVED_FIELD_KEYS, IATA_FIELD_KEY].map((key) => [key, values.fields[key]]),
  )
}

beforeEach(async () => {
  holder.db = await createTestDb()
  await importAirports(holder.db, DIRECTORY)
})

describe('saveFieldAction: производные поля не пишутся напрямую', () => {
  it('каждый из I.7/I.8/I.9 — отказ с полным Localized, ничего не записано', async () => {
    const { token, submissionId } = await seedLounge()

    // Анти-вакуум: список производных ключей не пуст и это именно тройка.
    expect(DERIVED_FIELD_KEYS).toHaveLength(3)

    for (const key of DERIVED_FIELD_KEYS) {
      const result = await saveFieldAction(token, key, 'Atlantis')
      expect(result.ok, key).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.error.en, key).toContain('derived from the IATA code')
      expect(result.error.ru, key).toContain('выводятся из кода IATA')
    }

    // Последствие отказов: четвёрка в базе — нетронутое предзаполнение.
    expect(await quartet(submissionId)).toEqual(PREFILLED_IST)
  })

  it('отказ не снимает чужого замечания: флаг на I.7 остаётся открытым', async () => {
    const { token, submissionId } = await seedLounge()
    const flagged = await raiseFlag(holder.db!, {
      submissionId, fieldKey: 'I.7', reason: 'wrong_format', comment: 'не та страна', reviewer: 'r1',
    })
    expect(flagged.ok).toBe(true)

    const result = await saveFieldAction(token, 'I.7', 'Atlantis')
    expect(result.ok).toBe(false)

    expect(await openFlags(holder.db!, submissionId)).toHaveLength(1)
  })
})

describe('saveFieldAction: код IATA — только из справочника', () => {
  it('не-код (ISTX) — отказ правилом трёх букв, ничего не записано', async () => {
    const { token, submissionId } = await seedLounge()

    const result = await saveFieldAction(token, IATA_FIELD_KEY, 'ISTX')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.en).toContain('3 letters')

    expect(await quartet(submissionId)).toEqual(PREFILLED_IST)
  })

  it('код не из справочника (QQQ) — отказ, называющий справочник, ничего не записано', async () => {
    const { token, submissionId } = await seedLounge()

    const result = await saveFieldAction(token, IATA_FIELD_KEY, 'QQQ')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.en).toContain('QQQ')
    expect(result.error.en).toContain('directory')
    expect(result.error.ru).toContain('справочник')

    expect(await quartet(submissionId)).toEqual(PREFILLED_IST)
  })

  it('известный код: одна запись переписывает четвёрку и снимает замечания I.7 И I.10', async () => {
    const { token, submissionId } = await seedLounge()

    // Замечания на производном поле, на самом коде — И на постороннем ключе,
    // который правка кода трогать не вправе.
    for (const fieldKey of ['I.7', IATA_FIELD_KEY, 'I.2']) {
      const flagged = await raiseFlag(holder.db!, {
        submissionId, fieldKey, reason: 'wrong_format', comment: `см. ${fieldKey}`, reviewer: 'r1',
      })
      expect(flagged.ok, fieldKey).toBe(true)
    }

    // Нормализация — часть тех же ворот: регистр и края — опечатки, не другой код.
    const result = await saveFieldAction(token, IATA_FIELD_KEY, ' esb ')
    expect(result).toEqual({ ok: true })

    // Тройка СЛЕДУЕТ за кодом — значения справочника, не прежние и не клиентские.
    expect(await quartet(submissionId)).toEqual({
      'I.7': 'Turkey',
      'I.8': 'Ankara',
      'I.9': 'Esenboga International',
      'I.10': 'ESB',
    })

    // Сняты ровно замечания четвёрки; постороннее (I.2) стоит как стояло.
    const flags = await openFlags(holder.db!, submissionId)
    expect(flags.map((flag) => flag.fieldKey)).toEqual(['I.2'])
  })

  it('мёртвый токен — единый отказ ссылки, ничего не записано', async () => {
    const { submissionId } = await seedLounge()

    const result = await saveFieldAction('no-such-token', IATA_FIELD_KEY, 'ESB')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.en).toContain('invalid or has expired')

    expect(await quartet(submissionId)).toEqual(PREFILLED_IST)
  })
})

describe('searchAirportsFillAction: поиск по токену заполнения', () => {
  it('живой токен ищет по справочнику той же семантикой, что кабинет', async () => {
    const { token } = await seedLounge()
    const found = await searchAirportsFillAction(token, 'ankara')
    expect(found.rows.map((row) => row.iata)).toEqual(['ESB'])
    expect(found.more).toBe(false)
  })

  it('мёртвый токен — пустой ответ той же формы, что «ничего не найдено»', async () => {
    await seedLounge()
    expect(await searchAirportsFillAction('no-such-token', 'ankara')).toEqual({
      rows: [],
      more: false,
    })
  })
})

/**
 * Пин конструкции «принятая анкета несёт тройку справочника»: единственная
 * дверь оператора к четвёрке — ворота выше, значит к принятию ответы I.7–I.10
 * могут быть только строкой справочника, и `approveSubmission`
 * (`passportFieldsFrom`) копирует в реестр именно её. Честная оговорка про
 * СТАРЫЕ данные: ответы, записанные до ворот (или сидом через голый
 * `saveFieldValue`), могли быть любыми, и принятие скопирует их как есть —
 * они стареют по мере того, как коды правятся воротами или паспорт правится
 * кабинетом (`updateLoungePassport` — те же ворота справочника).
 */
describe('принятие после исправления кода: реестр получает строку справочника', () => {
  it('колонки лаунжа после approve равны ряду справочника ESB', async () => {
    const { token, submissionId, loungeId } = await seedLounge()

    const saved = await saveFieldAction(token, IATA_FIELD_KEY, 'ESB')
    expect(saved).toEqual({ ok: true })

    await holder.db!
      .update(submissions)
      .set({ status: 'submitted' })
      .where(eq(submissions.id, submissionId))
    for (const block of BLOCKS) {
      const confirmed = await confirmBlock(holder.db!, {
        submissionId, blockKey: block.key, reviewer: 'r1',
      })
      expect(confirmed.ok, block.key).toBe(true)
    }

    const approved = await approveSubmission(holder.db!, { submissionId, reviewer: 'r1' })
    expect(approved).toEqual({ ok: true, status: 'approved' })

    const [lounge] = await holder.db!
      .select({
        country: lounges.country,
        city: lounges.city,
        airport: lounges.airport,
        iataCode: lounges.iataCode,
      })
      .from(lounges)
      .where(eq(lounges.id, loungeId))
    expect(lounge).toEqual({
      country: 'Turkey',
      city: 'Ankara',
      airport: 'Esenboga International',
      iataCode: 'ESB',
    })
  })
})
