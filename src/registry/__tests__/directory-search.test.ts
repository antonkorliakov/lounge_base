import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import {
  importAirports,
  parseAirportsTsv,
  searchAirports,
  type DirectoryImportRow,
  type DirectoryRow,
} from '../directory'

/**
 * Поиск по справочнику (`searchAirports`): ярусы код → город-целиком → имя →
 * город → страна, prominent-строки первыми ВНУТРИ каждого яруса, появление
 * ряда ОДИН раз на лучшем ярусе, ворота двух знаков, limit+1-трюк и
 * буквальность LIKE-спецсимволов. Сеется горстка СПЕЦИАЛЬНО скроенных рядов
 * настоящим `importAirports` — тот же харнесс-довод, что в
 * `directory.test.ts`. Плюс блок на ПОЛНОМ реальном TSV: пользовательский
 * сценарий «london» (Хитроу и Гатвик обязаны быть в восьмёрке) слишком
 * важен, чтобы доверять его только скроенным рядам, — он и есть причина
 * нынешних ярусов.
 */

const ROWS: DirectoryImportRow[] = [
  { iata: 'CDG', airport: 'Charles de Gaulle', city: 'Paris', country: 'France', prominent: false },
  // Совпадает С КАЖДЫМ ярусом запроса «is»: код ISx, имя Isl…, город Isl…;
  // обязан появиться один раз — на ярусе кода.
  { iata: 'ISB', airport: 'Islamabad Intl', city: 'Islamabad', country: 'Pakistan', prominent: false },
  { iata: 'IST', airport: 'Istanbul Airport', city: 'Istanbul', country: 'Turkey', prominent: false },
  { iata: 'SAW', airport: 'Sabiha Gokcen', city: 'Istanbul', country: 'Turkey', prominent: false },
  { iata: 'TLV', airport: 'Ben Gurion', city: 'Tel Aviv', country: 'Israel', prominent: false },
  // Пара для «префикс выше подстроки» в ярусе имени: по запросу «mil»
  // Milan Malpensa — префикс, Ha-MIL-ton — подстрока; алфавит по коду
  // (HLZ < MXP) дал бы обратный порядок — тест различает ранги, не алфавит.
  { iata: 'HLZ', airport: 'Hamilton Intl', city: 'Hamilton', country: 'New Zealand', prominent: false },
  { iata: 'MXP', airport: 'Milan Malpensa', city: 'Milan', country: 'Italy', prominent: false },
]

// Мини-Лондон — история, ради которой появились ярус «город целиком» и
// prominent (см. searchAirports): главные аэропорты города НЕ носят его имя.
const LONDON_ROWS: DirectoryImportRow[] = [
  // Крупные аэропорты Лондона: «london» есть только в ГОРОДЕ.
  { iata: 'LGW', airport: 'Gatwick', city: 'London', country: 'United Kingdom', prominent: true },
  { iata: 'LHR', airport: 'Heathrow', city: 'London', country: 'United Kingdom', prominent: true },
  // Тот же точный город, НЕ prominent, код алфавитно ПЕРВЫЙ из пятёрки:
  // только prominent-сортировка ставит LGW/LHR выше него.
  { iata: 'BQH', airport: 'Biggin Hill', city: 'London', country: 'United Kingdom', prominent: false },
  // Вокзал: имя НАЧИНАЕТСЯ с «london» И город точный — лучший ярус городской,
  // ряд появляется один раз, ниже prominent-соседей по ярусу.
  { iata: 'QQW', airport: 'London-Waterloo', city: 'London', country: 'United Kingdom', prominent: false },
  // Имя-префикс при ЧУЖОМ городе: прежние ярусы ставили такие ряды выше
  // Хитроу — теперь он ниже всего точного города.
  { iata: 'AAX', airport: 'London Ashford', city: 'Lydd', country: 'United Kingdom', prominent: false },
]

async function seeded(rows: DirectoryImportRow[] = ROWS): Promise<Db> {
  const db = await createTestDb()
  await importAirports(db, rows)
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

  it('город целиком бьёт имя-префикс, prominent бьёт алфавит, никто не отфильтрован', async () => {
    const db = await seeded(LONDON_ROWS)
    // «london» = город целиком: prominent LGW/LHR первыми (BQH алфавитно
    // раньше — его обходит только признак), затем BQH и QQW (вокзал совпал
    // и именем — но показан один раз, на городском ярусе), и лишь потом
    // AAX — имя-префикс при чужом городе, алфавитно первый из всех.
    // Ни одна не-prominent строка не исчезла: признак — сортировка, не фильтр.
    expect(iatas(await searchAirports(db, 'london'))).toEqual([
      'LGW', 'LHR', 'BQH', 'QQW', 'AAX',
    ])
  })

  it('город целиком — это trim-равенство, а не подстрока: «lond» уходит в ярус префикса', async () => {
    const db = await seeded(LONDON_ROWS)
    // Неполный город: точного яруса нет — AAX и QQW всплывают именем-префиксом
    // выше городских совпадений; полный (« london » с пробелами — trim) —
    // тот же порядок, что «london».
    expect(iatas(await searchAirports(db, 'lond'))).toEqual([
      'AAX', 'QQW', 'LGW', 'LHR', 'BQH',
    ])
    expect(await searchAirports(db, ' london ')).toEqual(await searchAirports(db, 'london'))
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

describe('searchAirports: полный реальный TSV — пользовательские сценарии', () => {
  // Один импорт 10k строк на весь блок: тесты ниже только читают.
  let db: Db
  beforeAll(async () => {
    db = await createTestDb()
    await importAirports(
      db,
      parseAirportsTsv(readFileSync(resolve(process.cwd(), 'src/db/reference/airports.tsv'), 'utf8')),
    )
  })

  it('london: Хитроу и Гатвик — В ВОСЬМЁРКЕ, четвёрка крупных над вокзалами и тёзками', async () => {
    // Жалоба пользователя, с которой всё началось: раньше восьмёрку съедали
    // имя-совпадения (вокзалы, Лондоны Канады/США), а Heathrow/Gatwick не
    // показывались вовсе. Теперь ярус «город целиком»: prominent-четвёрка
    // LGW/LHR/LTN/STN по алфавиту, затем не-prominent тёзки города —
    // BQH, LCY, LOZ (Corbin-london, США), QQK (вокзал Kings Cross).
    // Совпадений 23 — more честно говорит «уточните».
    const result = await searchAirports(db, 'london')
    expect(iatas(result)).toEqual(['LGW', 'LHR', 'LTN', 'STN', 'BQH', 'LCY', 'LOZ', 'QQK'])
    expect(result.more).toBe(true)
  })

  it('istan: IST и SAW по-прежнему первые, prominent поднимает Ташкент в ярусе стран', async () => {
    // IST — имя-префикс (Istanbul Airport, ярус 2), SAW — префикс города
    // (ярус 3), FNU — подстрока города Or-ISTAN-o (ярус 5); дальше страны
    // на *istan (ярус 7), где prominent TAS (Ташкент) обходит алфавит.
    const result = await searchAirports(db, 'istan')
    expect(iatas(result)).toEqual(['IST', 'SAW', 'FNU', 'TAS', 'AAW', 'AFS', 'ASB', 'ATG'])
    expect(result.more).toBe(true)
  })

  it('точный код IATA — ярусом 0 впереди всего, как и раньше', async () => {
    // «lhr» — префикс кода: LHR первым, никакая городская магия не мешает.
    const byCode = await searchAirports(db, 'lhr')
    expect(iatas(byCode)[0]).toBe('LHR')
    const bySaw = await searchAirports(db, 'saw')
    expect(iatas(bySaw)[0]).toBe('SAW')
  })
})
