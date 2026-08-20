import { asc, eq, ilike, or, sql } from 'drizzle-orm'
import { airportDirectory } from '@/db/schema'
import type { Db } from '@/db/types'
import { normalizeIata } from './iata'

/** Что справочник знает о коде: ровно три производные колонки паспорта. */
export type DirectoryEntry = { airport: string; city: string; country: string }

/**
 * Единственная точка чтения справочника аэропортов: нормализация кода — через
 * ТУ ЖЕ `normalizeIata`, что и всюду (свой trim/uppercase здесь был бы второй
 * записью правила). Невалидный код и код, которого в справочнике нет, дают
 * один ответ — `null`: для вызывающих оба означают «справочник не помог,
 * значения — ручные». Различать их незачем: невалидный код дальше всё равно
 * останавливает `validateIdentity` своим отказом.
 */
export async function lookupAirport(db: Db, raw: string): Promise<DirectoryEntry | null> {
  const iata = normalizeIata(raw)
  if (iata === null) return null

  const rows = await db
    .select({
      airport: airportDirectory.airport,
      city: airportDirectory.city,
      country: airportDirectory.country,
    })
    .from(airportDirectory)
    .where(eq(airportDirectory.iata, iata))
    .limit(1)

  return rows[0] ?? null
}

export type DirectoryRow = DirectoryEntry & { iata: string }

/**
 * Результат поиска: страница строк и честное «есть ещё» — вместо точного
 * счётчика, которого интерфейсу не нужно (подсказка «уточните запрос» — да/нет,
 * а COUNT(*) поверх того же скана был бы вторым запросом ради числа, которое
 * никто не показывает). `more` добывается трюком limit+1: спрашивается на
 * строку больше, чем показывается.
 */
export type AirportSearchResult = { rows: DirectoryRow[]; more: boolean }

/** Сколько строк видит выпадающий список; выбрано на глаз под панель формы. */
export const SEARCH_LIMIT = 8

/**
 * LIKE-шаблон из пользовательского ввода: `%`/`_`/`\` — операторы шаблона,
 * и без экранирования запрос «a_» совпадал бы с любым «a?» — тихая
 * подстановка вместо буквального поиска. Backslash — штатный escape LIKE
 * в postgres (ESCAPE по умолчанию), отдельной оговорки в запросе не нужно.
 */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * Поиск по справочнику для комбобокса «Найти аэропорт» (`PassportFieldsEditor`).
 *
 * Ярусы — порядок полей паспорта от самого точного к самому широкому:
 * код IATA (только ПРЕФИКС: «is» — это «начинается с IS», код по подстроке
 * никто не ищет) → имя аэропорта → город → страна. Внутри яруса префикс
 * стоит выше подстроки (CASE это даёт бесплатно — две ветки вместо одной),
 * сам матч — плоский substring ILIKE '%q%', а не словесный префикс:
 * word-boundary-шаблоны капризны, а на 10k строк честная подстрока
 * находит то же самое. Ряд, совпавший в нескольких ярусах, появляется
 * ОДИН раз на лучшем: CASE берёт первую истинную ветку, скан один.
 * Внутри ранга — алфавит по коду: детерминизм закреплён тестами
 * (`directory-search.test.ts`).
 *
 * Запрос ОДИН: тот же CASE ранжирует и сортирует поверх WHERE из тех же
 * ILIKE; индексных фокусов нет намеренно — последовательный скан 10k строк
 * измерен единицами миллисекунд (см. отчёт ветки), и это дешевле, чем
 * держать триграммные индексы честными.
 *
 * Запрос короче 2 знаков (после trim) — пустой ответ без похода в базу:
 * однобуквенный поиск вернул бы пол-справочника шумом. Кириллица и прочие
 * не-латинские запросы не ошибка — они просто ни с чем не совпадают
 * (справочник англоязычный), ответ — пустой список.
 */
export async function searchAirports(
  db: Db,
  rawQuery: string,
  limit = SEARCH_LIMIT,
): Promise<AirportSearchResult> {
  const query = rawQuery.trim()
  if (query.length < 2) return { rows: [], more: false }

  const prefix = `${escapeLike(query)}%`
  const anywhere = `%${escapeLike(query)}%`
  const rank = sql<number>`case
    when ${airportDirectory.iata} ilike ${prefix} then 0
    when ${airportDirectory.airport} ilike ${prefix} then 1
    when ${airportDirectory.airport} ilike ${anywhere} then 2
    when ${airportDirectory.city} ilike ${prefix} then 3
    when ${airportDirectory.city} ilike ${anywhere} then 4
    when ${airportDirectory.country} ilike ${prefix} then 5
    else 6
  end`

  const rows = await db
    .select({
      iata: airportDirectory.iata,
      airport: airportDirectory.airport,
      city: airportDirectory.city,
      country: airportDirectory.country,
    })
    .from(airportDirectory)
    .where(
      or(
        ilike(airportDirectory.iata, prefix),
        ilike(airportDirectory.airport, anywhere),
        ilike(airportDirectory.city, anywhere),
        ilike(airportDirectory.country, anywhere),
      ),
    )
    .orderBy(rank, asc(airportDirectory.iata))
    .limit(limit + 1)

  return rows.length > limit
    ? { rows: rows.slice(0, limit), more: true }
    : { rows, more: false }
}

/**
 * Разбор committed-источника истины — `src/db/reference/airports.tsv`
 * (заголовок `iata\tairport\tcity\tcountry`, дальше по строке на аэропорт).
 * Падает громко на первой же негодной строке (не тот заголовок, не четыре
 * колонки, код не по правилу, пустое значение, дубль кода) — молча
 * пропущенная строка справочника обнаружилась бы месяцами позже как «код
 * есть в файле, а формы его не видят», без всякой связи с причиной.
 * Коды нормализуются той же `normalizeIata`: файл в верхнем регистре уже
 * сейчас, но правило записано функцией, а не верой в файл.
 */
export function parseAirportsTsv(text: string): DirectoryRow[] {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== 'iata\tairport\tcity\tcountry') {
    throw new Error(`airports.tsv: неожиданный заголовок «${lines[0] ?? ''}»`)
  }

  const rows: DirectoryRow[] = []
  const seen = new Set<string>()
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!
    if (line.trim() === '') continue // хвостовой перевод строки — не запись
    const cells = line.split('\t')
    if (cells.length !== 4) {
      throw new Error(`airports.tsv: строка ${i + 1} — колонок ${cells.length}, а не 4`)
    }
    const iata = normalizeIata(cells[0]!)
    const airport = cells[1]!.trim()
    const city = cells[2]!.trim()
    const country = cells[3]!.trim()
    if (iata === null) {
      throw new Error(`airports.tsv: строка ${i + 1} — негодный код «${cells[0]}»`)
    }
    if (airport === '' || city === '' || country === '') {
      throw new Error(`airports.tsv: строка ${i + 1} (${iata}) — пустая колонка`)
    }
    if (seen.has(iata)) {
      throw new Error(`airports.tsv: строка ${i + 1} — код ${iata} встречается повторно`)
    }
    seen.add(iata)
    rows.push({ iata, airport, city, country })
  }
  return rows
}

/**
 * Сколько строк уходит одним INSERT. Ограничение — параметры протокола
 * (4 колонки × 1000 = 4000 плейсхолдеров на запрос, при лимите postgres в
 * 65535); тысяча держит запросы короткими, а весь файл — в ~11 запросов.
 */
const IMPORT_BATCH = 1000

/**
 * Идемпотентный импорт справочника: upsert по первичному ключу `iata`
 * (`ON CONFLICT ... DO UPDATE` на значения из `excluded`) — повторный прогон
 * того же файла не меняет ничего, прогон обновлённого файла правит ровно
 * изменившиеся строки. ОДНА транзакция на весь файл: наполовину влитый
 * справочник — состояние, в котором «код не найден» было бы ложью для
 * половины кодов, и ни один прогон не должен уметь его оставить. Строки,
 * ИСЧЕЗНУВШИЕ из файла, намеренно не удаляются: паспорт лаунжа мог быть
 * выведен из такой записи, и её удаление молча вернуло бы код в «ручные» —
 * решение об удалении из справочника, если понадобится, должно быть своим
 * явным шагом, а не побочным эффектом каждого импорта.
 *
 * Возвращает число влитых строк — то, что скрипт печатает рядом со временем.
 */
export async function importAirports(db: Db, rows: DirectoryRow[]): Promise<number> {
  await db.transaction(async (tx) => {
    for (let start = 0; start < rows.length; start += IMPORT_BATCH) {
      const batch = rows.slice(start, start + IMPORT_BATCH)
      await tx
        .insert(airportDirectory)
        .values(batch)
        .onConflictDoUpdate({
          target: airportDirectory.iata,
          set: {
            airport: sql`excluded.airport`,
            city: sql`excluded.city`,
            country: sql`excluded.country`,
          },
        })
    }
  })
  return rows.length
}
