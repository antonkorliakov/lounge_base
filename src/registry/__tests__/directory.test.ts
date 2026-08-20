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
  type DirectoryImportRow,
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

const HEADER = 'iata\tairport\tcity\tcountry\tprominent'

const ROWS: DirectoryImportRow[] = [
  { iata: 'IST', airport: 'Istanbul Airport', city: 'Istanbul', country: 'Turkey', prominent: true },
  { iata: 'ESB', airport: 'Esenboga International', city: 'Ankara', country: 'Turkey', prominent: false },
  { iata: 'DXB', airport: 'Dubai', city: 'Dubai', country: 'United Arab Emirates', prominent: true },
]

async function allRows(db: Db) {
  return db.select().from(airportDirectory).orderBy(asc(airportDirectory.iata))
}

describe('parseAirportsTsv', () => {
  it('разбирает заголовок и строки, нормализуя код и признак', () => {
    const text = `${HEADER}\nist\tIstanbul Airport\tIstanbul\tTurkey\ttrue\nESB\tEsenboga International\tAnkara\tTurkey\tfalse\n`
    expect(parseAirportsTsv(text)).toEqual([
      { iata: 'IST', airport: 'Istanbul Airport', city: 'Istanbul', country: 'Turkey', prominent: true },
      { iata: 'ESB', airport: 'Esenboga International', city: 'Ankara', country: 'Turkey', prominent: false },
    ])
  })

  it.each([
    ['чужой заголовок', 'code\tname\tcity\tcountry\tprominent\nIST\ta\tb\tc\ttrue'],
    // Старый 4-колоночный формат — тоже чужой заголовок: файл и код ходят
    // парой, импорт старого файла молча обнулил бы prominent у всех строк.
    ['старый 4-колоночный формат', 'iata\tairport\tcity\tcountry\nIST\ta\tb\tc'],
    ['не пять колонок в строке', `${HEADER}\nIST\tIstanbul Airport\tIstanbul\tTurkey`],
    ['негодный код', `${HEADER}\nISTX\ta\tb\tc\ttrue`],
    ['пустая колонка', `${HEADER}\nIST\t\tIstanbul\tTurkey\ttrue`],
    ['prominent не true/false', `${HEADER}\nIST\ta\tb\tc\tyes`],
    ['prominent пуст', `${HEADER}\nIST\ta\tb\tc\t`],
    ['дубль кода', `${HEADER}\nIST\ta\tb\tc\ttrue\nist\td\te\tf\tfalse`],
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

    // ESB переименован и стал prominent, DXB из файла исчез, SAW появился.
    await importAirports(db, [
      { iata: 'ESB', airport: 'Esenboga', city: 'Ankara', country: 'Turkey', prominent: true },
      { iata: 'SAW', airport: 'Sabiha Gokcen', city: 'Istanbul', country: 'Turkey', prominent: true },
    ])

    const rows = await allRows(db)
    expect(rows.map((row) => row.iata)).toEqual(['DXB', 'ESB', 'IST', 'SAW'])
    expect(rows.find((row) => row.iata === 'ESB')?.airport).toBe('Esenboga')
    // Upsert правит и признак: false из первого импорта не переживает второй.
    expect(rows.find((row) => row.iata === 'ESB')?.prominent).toBe(true)
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
