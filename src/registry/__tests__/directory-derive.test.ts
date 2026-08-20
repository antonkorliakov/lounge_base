import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges } from '@/db/schema'
import { loadSubmissionValues } from '@/submissions/values'
import { importAirports } from '../directory'
import {
  createLounge,
  updateLoungePassport,
  lockedIdentityKeys,
  type IdentityColumns,
} from '../manage'

/**
 * Серверные ворота справочника: аэропорт/город/страна ВЫВОДЯТСЯ из кода IATA,
 * когда справочник код знает, — что бы ни прислал клиент (`resolveIdentity` в
 * `manage.ts`). Обе половины матрицы, на обоих писателях паспорта:
 *
 *  - код ИЗВЕСТЕН → в колонках значения СПРАВОЧНИКА, присланное клиентом
 *    (мусор, пустота — неважно) не переживает запись;
 *  - кода НЕТ → ручные значения проходят прежнюю валидацию и сохраняются
 *    как есть: справочник — не истина в последней инстанции.
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
  iataCode: 'IST',
  provider: 'dnata',
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

describe('createLounge: справочник — ворота, клиент — подсказка', () => {
  it('известный код: в колонках значения справочника, даже если клиент прислал мусор', async () => {
    const db = await seededDb()
    const created = await createLounge(db, {
      ...INPUT,
      iataCode: ' ist ', // нормализация — часть тех же ворот
      city: 'garbage-city',
      country: 'garbage-country',
      airport: 'garbage-airport',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('unreachable')

    expect(await loungeRow(db, created.loungeId)).toEqual({ ...INPUT, iataCode: 'IST' })

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

  it('известный код: производные поля можно вовсе не заполнять', async () => {
    // Ровно сценарий «Add lounge»: админ набрал имя и код, три производных
    // поля форма показала выведенными и read-only — клиент их не шлёт.
    const db = await seededDb()
    const created = await createLounge(db, {
      name: 'Aurora Lounge',
      iataCode: 'ESB',
      provider: null,
      country: '',
      city: '',
      airport: '',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('unreachable')

    expect(await loungeRow(db, created.loungeId)).toEqual({
      name: 'Aurora Lounge',
      provider: null,
      country: 'Turkey',
      city: 'Ankara',
      airport: 'Esenboga International',
      iataCode: 'ESB',
    })
  })

  it('неизвестный код: ручные значения сохраняются как есть, пустые — прежний отказ', async () => {
    const db = await seededDb()
    const manual = await createLounge(db, {
      ...INPUT,
      iataCode: 'QQQ',
      city: 'Private City',
      country: 'Nowheria',
      airport: 'Private Terminal',
    })
    expect(manual.ok).toBe(true)
    if (!manual.ok) throw new Error('unreachable')
    expect(await loungeRow(db, manual.loungeId)).toEqual({
      ...INPUT,
      iataCode: 'QQQ',
      city: 'Private City',
      country: 'Nowheria',
      airport: 'Private Terminal',
    })

    // Без справочника пустой город остаётся пустым городом — отказ.
    const refused = await createLounge(db, { ...INPUT, iataCode: 'QQQ', city: '' })
    expect(refused.ok).toBe(false)
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
      // Клиентский «город» при известном коде не значит ничего.
      city: 'garbage-city',
      airport: 'garbage-airport',
    })
    expect(result).toEqual({ ok: true })

    expect(await loungeRow(db, created.loungeId)).toEqual({
      ...INPUT,
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

  it('неизвестный код: ручные значения переживают правку (directory miss)', async () => {
    const db = await seededDb()
    const created = await createLounge(db, INPUT)
    if (!created.ok) throw new Error('seed failed')

    const result = await updateLoungePassport(db, {
      ...INPUT,
      loungeId: created.loungeId,
      actor: 'r1',
      iataCode: 'QQQ',
      city: 'Private City',
      airport: 'Private Terminal',
    })
    expect(result).toEqual({ ok: true })

    expect(await loungeRow(db, created.loungeId)).toEqual({
      ...INPUT,
      iataCode: 'QQQ',
      city: 'Private City',
      airport: 'Private Terminal',
    })
  })
})
