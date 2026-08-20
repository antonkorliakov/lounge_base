import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions, fillTokens, events } from '@/db/schema'
import { loadSubmissionValues } from '@/submissions/values'
import { importAirports } from '../directory'
import {
  createLounge,
  updateLoungePassport,
  lockedIdentityKeys,
  type IdentityColumns,
} from '../manage'

/**
 * Серверные ворота справочника: аэропорт/город/страна ВЫВОДЯТСЯ из кода IATA
 * и ТОЛЬКО из него (`resolveIdentity` в `manage.ts`) — контракт действий
 * (`CreateLoungeInput`) этих полей больше не принимает вовсе. Обе половины
 * матрицы, на обоих писателях паспорта:
 *
 *  - код ИЗВЕСТЕН → в колонках значения СПРАВОЧНИКА;
 *  - кода НЕТ → ОТКАЗ, и ничего не записано. Прежний ручной путь («значения
 *    клиента сохраняются как есть») удалён осознанно — этот файл раньше
 *    закреплял его, теперь закрепляет отказ: лаунж можно завести только для
 *    аэропорта из справочника, лекарство — обновить справочник.
 *
 * Стенд сеет справочник настоящим `importAirports` (двух строк достаточно —
 * харнесс PGlite не обязан глотать 10 тысяч строк на тест, см.
 * `directory.test.ts`).
 */

const DIRECTORY = [
  { iata: 'IST', airport: 'Istanbul Airport', city: 'Istanbul', country: 'Turkey', prominent: true },
  { iata: 'ESB', airport: 'Esenboga International', city: 'Ankara', country: 'Turkey', prominent: false },
]

const INPUT = {
  name: 'Aurora Lounge',
  provider: 'dnata',
  iataCode: 'IST',
}

/** Паспорт IST, каким его выводит справочник, — ожидание, не вход. */
const DERIVED_IST = {
  ...INPUT,
  country: 'Turkey',
  city: 'Istanbul',
  airport: 'Istanbul Airport',
}

async function seededDb(): Promise<Db> {
  const db = await createTestDb()
  await importAirports(db, DIRECTORY)
  return db
}

async function loungeRow(db: Db, loungeId: string): Promise<IdentityColumns> {
  const [row] = await db
    .select({
      name: lounges.name,
      provider: lounges.provider,
      country: lounges.country,
      city: lounges.city,
      airport: lounges.airport,
      iataCode: lounges.iataCode,
    })
    .from(lounges)
    .where(eq(lounges.id, loungeId))
  expect(row).toBeDefined()
  return row!
}

describe('createLounge: справочник — единственный источник тройки', () => {
  it('известный код: колонки — значения справочника, предзаполнение под замком', async () => {
    const db = await seededDb()
    const created = await createLounge(db, {
      ...INPUT,
      iataCode: ' ist ', // нормализация — часть тех же ворот
    })
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('unreachable')

    expect(await loungeRow(db, created.loungeId)).toEqual({ ...DERIVED_IST, iataCode: 'IST' })

    // И предзаполнение анкеты видит уже выведенные значения — с замками:
    // ответ дословно равен колонке (правило lockedIdentityKeys, не флаг).
    const answers = (await loadSubmissionValues(db, created.submissionId)).fields
    expect(answers['I.7']).toBe('Turkey')
    expect(answers['I.8']).toBe('Istanbul')
    expect(answers['I.9']).toBe('Istanbul Airport')
    expect(answers['I.10']).toBe('IST')
    const locked = lockedIdentityKeys(await loungeRow(db, created.loungeId), answers)
    expect(locked).toEqual(expect.arrayContaining(['I.7', 'I.8', 'I.9', 'I.10']))
  })

  it('неизвестный код: отказ, называющий справочник, и НИ ОДНОЙ записи', async () => {
    // Прежний пин («ручные значения сохраняются как есть») ИНВЕРТИРОВАН
    // намеренно: ручного пути больше нет. Отказ проверяется последствием —
    // ни лаунжа, ни анкеты, ни токена, ни события.
    const db = await seededDb()
    const refused = await createLounge(db, { ...INPUT, iataCode: 'QQQ' })

    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('unreachable')
    expect(refused.error.en).toContain('QQQ')
    expect(refused.error.en).toContain('directory')
    expect(refused.error.ru).toContain('справочник')

    expect(await db.select().from(lounges)).toEqual([])
    expect(await db.select().from(submissions)).toEqual([])
    expect(await db.select().from(fillTokens)).toEqual([])
    expect(await db.select().from(events)).toEqual([])
  })

  it('пустой справочник: даже настоящий код — отказ (ворота, не подсказка)', async () => {
    const db = await createTestDb() // без importAirports
    const refused = await createLounge(db, INPUT)
    expect(refused.ok).toBe(false)
    expect(await db.select().from(lounges)).toEqual([])
  })
})

describe('updateLoungePassport: та же матрица', () => {
  it('известный код: колонки — из справочника, непочатые ответы следуют', async () => {
    const db = await seededDb()
    const created = await createLounge(db, INPUT)
    if (!created.ok) throw new Error('seed failed')

    const result = await updateLoungePassport(db, {
      ...INPUT,
      loungeId: created.loungeId,
      actor: 'r1',
      iataCode: 'esb',
    })
    expect(result).toEqual({ ok: true })

    expect(await loungeRow(db, created.loungeId)).toEqual({
      ...DERIVED_IST,
      iataCode: 'ESB',
      city: 'Ankara',
      airport: 'Esenboga International',
    })

    // Непочатое предзаполнение последовало за ВЫВЕДЕННЫМИ значениями —
    // синхронизация ниже по течению не менялась, колонки есть колонки.
    const answers = (await loadSubmissionValues(db, created.submissionId)).fields
    expect(answers['I.8']).toBe('Ankara')
    expect(answers['I.9']).toBe('Esenboga International')
    expect(answers['I.10']).toBe('ESB')
  })

  it('неизвестный код: отказ, колонки целы, события нет', async () => {
    // Вторая половина инверсии miss-пути: правка на код вне справочника
    // больше не «ручные значения переживают», а отказ без следа в базе.
    const db = await seededDb()
    const created = await createLounge(db, INPUT)
    if (!created.ok) throw new Error('seed failed')
    const before = await loungeRow(db, created.loungeId)

    const refused = await updateLoungePassport(db, {
      ...INPUT,
      loungeId: created.loungeId,
      actor: 'r1',
      iataCode: 'QQQ',
    })
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('unreachable')
    expect(refused.error.ru).toContain('справочник')

    expect(await loungeRow(db, created.loungeId)).toEqual(before)
    expect(
      await db.select().from(events).where(eq(events.action, 'passport_edited')),
    ).toEqual([])
  })
})
