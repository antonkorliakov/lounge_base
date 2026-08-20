import { describe, it, expect } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { importAirports, searchAirports, type DirectoryRow } from '../directory'

/**
 * Поиск по справочнику (`searchAirports`): ярусы код→имя→город→страна,
 * префикс выше подстроки внутри яруса, появление ряда ОДИН раз на лучшем
 * ярусе, ворота двух знаков, limit+1-трюк и буквальность LIKE-спецсимволов.
 * Сеется горстка СПЕЦИАЛЬНО скроенных рядов настоящим `importAirports` —
 * тот же харнесс-довод, что в `directory.test.ts` (10 тысяч строк на тест
 * не нужны ни одному сценарию, полный файл гоняет e2e).
 */

const ROWS: DirectoryRow[] = [
  { iata: 'CDG', airport: 'Charles de Gaulle', city: 'Paris', country: 'France' },
  // Совпадает С КАЖДЫМ ярусом запроса «is»: код ISx, имя Isl…, город Isl…;
  // обязан появиться один раз — на ярусе кода.
  { iata: 'ISB', airport: 'Islamabad Intl', city: 'Islamabad', country: 'Pakistan' },
  { iata: 'IST', airport: 'Istanbul Airport', city: 'Istanbul', country: 'Turkey' },
  { iata: 'SAW', airport: 'Sabiha Gokcen', city: 'Istanbul', country: 'Turkey' },
  { iata: 'TLV', airport: 'Ben Gurion', city: 'Tel Aviv', country: 'Israel' },
  // Пара для «префикс выше подстроки» в ярусе имени: по запросу «mil»
  // Milan Malpensa — префикс, Ha-MIL-ton — подстрока; алфавит по коду
  // (HLZ < MXP) дал бы обратный порядок — тест различает ранги, не алфавит.
  { iata: 'HLZ', airport: 'Hamilton Intl', city: 'Hamilton', country: 'New Zealand' },
  { iata: 'MXP', airport: 'Milan Malpensa', city: 'Milan', country: 'Italy' },
]

async function seeded(): Promise<Db> {
  const db = await createTestDb()
  await importAirports(db, ROWS)
  return db
}

const iatas = (result: { rows: DirectoryRow[] }): string[] =>
  result.rows.map((row) => row.iata)

describe('searchAirports: ярусы и дедупликация', () => {
  it('is: код-префикс → город-префикс → город-подстрока → страна-префикс, каждый ряд один раз', async () => {
    const db = await seeded()
    // ISB и IST — ярус кода (алфавит внутри ранга); SAW — «is» лишь префикс
    // города Istanbul; CDG — подстрока города Par-IS (ниже префикса города);
    // TLV — префикс страны Israel. ISB, совпавший и именем, и городом,
    // не повторяется ниже своего лучшего яруса.
    expect(iatas(await searchAirports(db, 'is'))).toEqual(['ISB', 'IST', 'SAW', 'CDG', 'TLV'])
  })

  it('внутри яруса имени префикс стоит выше подстроки вопреки алфавиту кодов', async () => {
    const db = await seeded()
    expect(iatas(await searchAirports(db, 'mil'))).toEqual(['MXP', 'HLZ'])
  })

  it('регистр запроса безразличен', async () => {
    const db = await seeded()
    const lower = await searchAirports(db, 'is')
    expect(await searchAirports(db, 'IS')).toEqual(lower)
    expect(await searchAirports(db, 'iS')).toEqual(lower)
  })

  it('запрос обрезается: « is » ищет то же, что «is»', async () => {
    const db = await seeded()
    expect(await searchAirports(db, ' is ')).toEqual(await searchAirports(db, 'is'))
  })
})

describe('searchAirports: ворота и границы', () => {
  it('короче двух знаков — пусто без похода в базу', async () => {
    const db = await seeded()
    const empty = { rows: [], more: false }
    expect(await searchAirports(db, '')).toEqual(empty)
    expect(await searchAirports(db, 'i')).toEqual(empty)
    expect(await searchAirports(db, ' i ')).toEqual(empty)
  })

  it('limit+1: сверх лимита — усечённая страница и честное more', async () => {
    const db = await seeded()
    // По «is» совпадают пять рядов: лимит 2 режет и говорит «есть ещё»,
    // лимит 5 отдаёт всё и more не врёт.
    const cut = await searchAirports(db, 'is', 2)
    expect(iatas(cut)).toEqual(['ISB', 'IST'])
    expect(cut.more).toBe(true)

    const whole = await searchAirports(db, 'is', 5)
    expect(iatas(whole)).toEqual(['ISB', 'IST', 'SAW', 'CDG', 'TLV'])
    expect(whole.more).toBe(false)
  })

  it('кириллица — пустой ответ значением, не падение (справочник англоязычный)', async () => {
    const db = await seeded()
    expect(await searchAirports(db, 'стамбул')).toEqual({ rows: [], more: false })
  })

  it('спецсимволы LIKE буквальны: «_s» и «%%» не превращаются в шаблон', async () => {
    const db = await seeded()
    // Без экранирования «_s» совпал бы с «Is…» (любой знак + s),
    // а «%%» — со всем справочником.
    expect(await searchAirports(db, '_s')).toEqual({ rows: [], more: false })
    expect(await searchAirports(db, '%%')).toEqual({ rows: [], more: false })
  })
})
