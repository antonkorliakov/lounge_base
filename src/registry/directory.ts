import { asc, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { airportDirectory } from '@/db/schema'
import type { Db } from '@/db/types'
import { normalizeIata } from './iata'

/** Что справочник знает о коде: ровно три производные колонки паспорта. */
export type DirectoryEntry = { airport: string; city: string; country: string }

/**
 * Единственная точка чтения справочника аэропортов: нормализация кода — через
 * ТУ ЖЕ `normalizeIata`, что и всюду (свой trim/uppercase здесь был бы второй
 * записью правила). Невалидный код и код, которого в справочнике нет, дают
 * один ответ — `null`: для вызывающих оба означают «справочник не знает
 * такого кода». Различать их незачем: невалидный код `resolveIdentity`
 * останавливает своим отказом ещё до похода сюда, а для клиентской подсказки
 * (`lookupIataAction`) оба — один и тот же промах.
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
 * Строка TSV/импорта: то же, что видит поиск, плюс `prominent` — сигнал
 * ранжирования (см. searchAirports). В `DirectoryRow` его намеренно нет:
 * интерфейсу выпадающего списка признак не нужен, он работает только внутри
 * ORDER BY, и раздавать его наружу значило бы соблазнять UI на фильтрацию.
 */
export type DirectoryImportRow = DirectoryRow & { prominent: boolean }

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
 * Ярусы — от самого точного намерения к самому широкому. Мотивирующий
 * пример — «london»: главные аэропорты Лондона зовутся «Heathrow» и
 * «Gatwick» — в их ИМЕНАХ «london» нет, и ярус «имя выше города» хоронил
 * их под «London-Waterloo», «Kings Cross Rail Station» и Лондонами
 * Канады/США. Человек, набравший город ЦЕЛИКОМ, ищет аэропорты этого
 * города — поэтому точное совпадение города стоит сразу за кодом, выше
 * любых совпадений по имени:
 *
 *   0 — префикс кода IATA (только ПРЕФИКС: «is» — это «начинается с IS»,
 *       код по подстроке никто не ищет);
 *   1 — город ЦЕЛИКОМ (запрос после trim равен городу без учёта регистра) —
 *       ярус, который поднимает Heathrow/Gatwick по запросу «london»;
 *   2 — префикс имени аэропорта;
 *   3 — префикс города;
 *   4 — подстрока имени;
 *   5 — подстрока города;
 *   6 — префикс страны; 7 — подстрока страны.
 *
 * Сам матч — плоский substring ILIKE '%q%', а не словесный префикс:
 * word-boundary-шаблоны капризны, а на 10k строк честная подстрока
 * находит то же самое. Ряд, совпавший в нескольких ярусах, появляется
 * ОДИН раз на лучшем: CASE берёт первую истинную ветку, скан один.
 *
 * ВНУТРИ каждого яруса первыми стоят `prominent` строки (~600 крупных
 * аэропортов, 5-я колонка TSV), затем алфавит по коду. Признак — сигнал
 * ранжирования, НИКОГДА не фильтр: малоизвестный аэропорт остаётся
 * находимым, просто ниже крупных — по «london» четвёрка LGW/LHR/LTN/STN
 * стоит над BQH/LCY и вокзалами, но и те в выдаче. Детерминизм закреплён
 * тестами (`directory-search.test.ts`).
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

  // ILIKE без единого wildcard — это равенство без учёта регистра: экранированный
  // запрос целиком и есть шаблон «город равен запросу» для яруса 1.
  const exact = escapeLike(query)
  const prefix = `${exact}%`
  const anywhere = `%${exact}%`
  const rank = sql<number>`case
    when ${airportDirectory.iata} ilike ${prefix} then 0
    when ${airportDirectory.city} ilike ${exact} then 1
    when ${airportDirectory.airport} ilike ${prefix} then 2
    when ${airportDirectory.city} ilike ${prefix} then 3
    when ${airportDirectory.airport} ilike ${anywhere} then 4
    when ${airportDirectory.city} ilike ${anywhere} then 5
    when ${airportDirectory.country} ilike ${prefix} then 6
    else 7
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
    .orderBy(rank, desc(airportDirectory.prominent), asc(airportDirectory.iata))
    .limit(limit + 1)

  return rows.length > limit
    ? { rows: rows.slice(0, limit), more: true }
    : { rows, more: false }
}

/**
 * Разбор committed-источника истины — `src/db/reference/airports.tsv`
 * (заголовок `iata\tairport\tcity\tcountry\tprominent`, дальше по строке на
 * аэропорт; `prominent` — дословно `true`/`false`, флаг «Exist Product»
 * источника, ~600 крупных аэропортов). Падает громко на первой же негодной
 * строке (не тот заголовок, не пять колонок, код не по правилу, пустое
 * значение, признак не true/false, дубль кода) — молча пропущенная строка
 * справочника обнаружилась бы месяцами позже как «код есть в файле, а формы
 * его не видят», без всякой связи с причиной. СТАРЫЙ 4-колоночный формат
 * отвергается тем же громким заголовочным отказом: файл и код ходят парой,
 * и импорт старого файла новым кодом молча обнулил бы `prominent` у всех.
 * Коды нормализуются той же `normalizeIata`: файл в верхнем регистре уже
 * сейчас, но правило записано функцией, а не верой в файл.
 */
export function parseAirportsTsv(text: string): DirectoryImportRow[] {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== 'iata\tairport\tcity\tcountry\tprominent') {
    throw new Error(`airports.tsv: неожиданный заголовок «${lines[0] ?? ''}»`)
  }

  const rows: DirectoryImportRow[] = []
  const seen = new Set<string>()
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!
    if (line.trim() === '') continue // хвостовой перевод строки — не запись
    const cells = line.split('\t')
    if (cells.length !== 5) {
      throw new Error(`airports.tsv: строка ${i + 1} — колонок ${cells.length}, а не 5`)
    }
    const iata = normalizeIata(cells[0]!)
    const airport = cells[1]!.trim()
    const city = cells[2]!.trim()
    const country = cells[3]!.trim()
    const prominentCell = cells[4]!.trim()
    if (iata === null) {
      throw new Error(`airports.tsv: строка ${i + 1} — негодный код «${cells[0]}»`)
    }
    if (airport === '' || city === '' || country === '') {
      throw new Error(`airports.tsv: строка ${i + 1} (${iata}) — пустая колонка`)
    }
    if (prominentCell !== 'true' && prominentCell !== 'false') {
      throw new Error(
        `airports.tsv: строка ${i + 1} (${iata}) — prominent «${prominentCell}», а не true/false`,
      )
    }
    if (seen.has(iata)) {
      throw new Error(`airports.tsv: строка ${i + 1} — код ${iata} встречается повторно`)
    }
    seen.add(iata)
    rows.push({ iata, airport, city, country, prominent: prominentCell === 'true' })
  }
  return rows
}

/**
 * Сколько строк уходит одним INSERT. Ограничение — параметры протокола
 * (5 колонок × 1000 = 5000 плейсхолдеров на запрос, при лимите postgres в
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
export async function importAirports(db: Db, rows: DirectoryImportRow[]): Promise<number> {
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
            prominent: sql`excluded.prominent`,
          },
        })
    }
  })
  return rows.length
}
