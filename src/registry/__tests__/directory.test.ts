import { describe, it, expect } from 'vitest'
import { asc } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { airportDirectory } from '@/db/schema'
import { normalizeIata } from '../iata'
import {
  lookupAirport,
  parseAirportsTsv,
  importAirports,
  type DirectoryRow,
} from '../directory'

/**
 * Справочник аэропортов: разбор TSV, идемпотентный импорт и единственная
 * точка чтения (`lookupAirport`). Юнит-харнесс (PGlite) поднимает таблицу
 * миграцией, но НЕ наполняет её: 10 тысяч строк на каждый тест — цена,
 * которой ни один тест здесь не стоит. Каждый тест сеет ровно те строки,
 * что ему нужны, — через НАСТОЯЩИЙ `importAirports`, тем же путём, каким
 * строки появляются в живой базе (`npm run db:import-airports`). Полный
 * файл гоняет сам скрипт перед e2e (см. `e2e/directory.spec.ts`).
 */

const HEADER = 'iata\tairport\tcity\tcountry'

const ROWS: DirectoryRow[] = [
  { iata: 'IST', airport: 'Istanbul Airport', city: 'Istanbul', country: 'Turkey' },
  { iata: 'ESB', airport: 'Esenboga International', city: 'Ankara', country: 'Turkey' },
  { iata: 'DXB', airport: 'Dubai', city: 'Dubai', country: 'United Arab Emirates' },
]

async function allRows(db: Db) {
  return db.select().from(airportDirectory).orderBy(asc(airportDirectory.iata))
}

describe('parseAirportsTsv', () => {
  it('разбирает заголовок и строки, нормализуя код', () => {
    const text = `${HEADER}\nist\tIstanbul Airport\tIstanbul\tTurkey\nESB\tEsenboga International\tAnkara\tTurkey\n`
    expect(parseAirportsTsv(text)).toEqual([
      { iata: 'IST', airport: 'Istanbul Airport', city: 'Istanbul', country: 'Turkey' },
      { iata: 'ESB', airport: 'Esenboga International', city: 'Ankara', country: 'Turkey' },
    ])
  })

  it.each([
    ['чужой заголовок', 'code\tname\tcity\tcountry\nIST\ta\tb\tc'],
    ['не четыре колонки', `${HEADER}\nIST\tIstanbul Airport\tIstanbul`],
    ['негодный код', `${HEADER}\nISTX\ta\tb\tc`],
    ['пустая колонка', `${HEADER}\nIST\t\tIstanbul\tTurkey`],
    ['дубль кода', `${HEADER}\nIST\ta\tb\tc\nist\td\te\tf`],
  ])('громко падает: %s', (_label, text) => {
    expect(() => parseAirportsTsv(text)).toThrow()
  })
})

describe('importAirports: идемпотентный upsert', () => {
  it('повторный прогон тех же строк не меняет ничего', async () => {
    const db = await createTestDb()
    expect(await importAirports(db, ROWS)).toBe(3)
    const first = await allRows(db)

    expect(await importAirports(db, ROWS)).toBe(3)
    expect(await allRows(db)).toEqual(first)
    expect(first).toHaveLength(3)
  })

  it('прогон обновлённого файла правит изменившуюся строку и не трогает исчезнувшие', async () => {
    const db = await createTestDb()
    await importAirports(db, ROWS)

    // ESB переименован, DXB из файла исчез, SAW появился.
    await importAirports(db, [
      { iata: 'ESB', airport: 'Esenboga', city: 'Ankara', country: 'Turkey' },
      { iata: 'SAW', airport: 'Sabiha Gokcen', city: 'Istanbul', country: 'Turkey' },
    ])

    const rows = await allRows(db)
    expect(rows.map((row) => row.iata)).toEqual(['DXB', 'ESB', 'IST', 'SAW'])
    expect(rows.find((row) => row.iata === 'ESB')?.airport).toBe('Esenboga')
    // Исчезнувшая строка осталась: удаление из справочника — явный шаг,
    // не побочный эффект импорта (см. комментарий importAirports).
    expect(rows.find((row) => row.iata === 'DXB')?.city).toBe('Dubai')
  })
})

describe('lookupAirport: нормализация через единственный normalizeIata', () => {
  it('находит код в любом регистре и с пробелами', async () => {
    const db = await createTestDb()
    await importAirports(db, ROWS)

    const entry = { airport: 'Istanbul Airport', city: 'Istanbul', country: 'Turkey' }
    expect(await lookupAirport(db, 'IST')).toEqual(entry)
    expect(await lookupAirport(db, ' ist ')).toEqual(entry)
    // Дословно то, что вернул бы normalizeIata, — правило одно.
    expect(normalizeIata(' ist ')).toBe('IST')
  })

  it('неизвестный и невалидный коды — null значением, не падение', async () => {
    const db = await createTestDb()
    await importAirports(db, ROWS)

    expect(await lookupAirport(db, 'QQQ')).toBeNull()
    expect(await lookupAirport(db, 'ISTX')).toBeNull()
    expect(await lookupAirport(db, '')).toBeNull()
  })
})
