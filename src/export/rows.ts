import {
  fieldByKey, formatFieldValue, PHOTO_SLOTS, SERVICE_ATTRIBUTES, SERVICE_ITEMS,
} from '@/form-schema'
import type { Db } from '@/db/types'
import { listRegistry, type RegistryFilters } from '@/registry/query'
import { loadSubmissionValues } from '@/submissions/values'
import { listPhotos } from '@/photos/store'
import { flatColumns, type Column } from './columns'

export type ExportOptions = {
  filters: RegistryFilters
  includeUnapproved: boolean
}

export type ExportCell = string | number | null

/**
 * Значение одного поля анкеты в ячейку файла.
 *
 * Само форматирование — общий `formatFieldValue` из `@/form-schema`
 * (`render.ts`), тот же, каким значения показывает экран проверки: это
 * ТРЕТИЙ потребитель этих значений, и два предыдущих независимых показа оба
 * успели молча потерять `slots.age` поля `III.3.2` — историю целиком
 * рассказывает сам модуль. Решения ЭТОГО потребителя, переданные параметрами:
 * «ответа нет» — `null` (пустая ячейка, а не прочерк экрана), шаблонное поле
 * разворачивается в исходную фразу формы (`template: 'phrase'`) — ячейка
 * файла живёт без контекста экрана и должна читаться сама по себе; язык
 * файла английский, как и заголовки (`columns.ts`).
 *
 * Числовой ответ остаётся числом, а не `String(raw)`: xlsx и CSV различают
 * числовые ячейки, и принимающая сторона иначе сортирует «10» перед «9».
 *
 * Ключ мимо схемы (`fieldByKey` не нашёл) — `null`: `saveFieldValue` такое
 * не пишет, но выгрузка читает базу, а не обещания писателя; колонки для
 * такого ключа всё равно нет, и `put` ниже его молча уронил бы — здесь это
 * решение принято явно, а не по совпадению устройства `put`.
 */
function renderField(fieldKey: string, value: unknown): ExportCell {
  const field = fieldByKey(fieldKey)
  if (!field) return null
  if (typeof value === 'number') return value
  return formatFieldValue(field, value, { locale: 'en', template: 'phrase' })
}

/**
 * Строки плоской выгрузки для набора лаунжей под фильтрами реестра.
 *
 * СЕМАНТИКА СТРОКИ: одна анкета лаунжа ЦЕЛИКОМ. Значения полей,
 * `submission_status` и `approved_at` берутся из одной и той же анкеты и не
 * смешиваются — `approved_at` значит «день, когда были приняты ИМЕННО ЭТИ
 * значения», а не «когда лаунж что-нибудь проходил проверку».
 *
 *  - `includeUnapproved: false` (умолчание): последняя ПРИНЯТАЯ анкета
 *    каждого лаунжа (`listRegistry(..., 'latestApproved')`). Лаунж, у
 *    которого после принятия открыли новый черновик, продолжает уезжать со
 *    своими проверенными данными — образец плана здесь терял его целиком,
 *    потому что фильтровал по статусу ПОСЛЕДНЕЙ анкеты. Непринятые данные по
 *    умолчанию не уезжают в смежные системы: там они неотличимы от
 *    проверенных. Фильтр «только принятые» — это существующий SQL-фильтр
 *    `submissionStatus` реестра (он же отсекает лаунжи, у которых принятой
 *    анкеты нет вовсе), а не второй экземпляр правила на JS; пользовательский
 *    `filters.submissionStatus` при этом перекрывается сознательно — без
 *    галочки статусом выгрузки управляет галочка, и любой другой статусный
 *    фильтр мог бы только молча выкинуть строки из «только принятых».
 *  - `includeUnapproved: true`: реестр как есть — последняя анкета каждого
 *    лаунжа, помеченная своим `submission_status`; лаунж вовсе без анкет
 *    уезжает паспортом с пустыми ячейками анкеты, как и в реестре.
 *
 * ЗАПРОСЫ: `loadSubmissionValues` + `listPhotos` на каждый лаунж — 2N+1.
 * Осознанно: выгрузка — редкое ручное действие проверяющего над реестром в
 * сотни строк (один аэропортовый оператор), а не горячий путь; страница
 * анкеты делает те же два вызова на каждый показ. Батч-вариант потребовал бы
 * второй экземпляр маппинга строк БД в значения (`price: Number(...)` и
 * прочее из `loadSubmissionValues`) — ровно класс «одно правило в N местах».
 * Если реестр вырастет на порядки, правильный ход — вынести маппинг из
 * `loadSubmissionValues` и читать тремя `inArray`-запросами, не третий копир.
 */
export async function buildFlatRows(
  db: Db,
  options: ExportOptions,
): Promise<{ columns: Column[]; rows: ExportCell[][] }> {
  const columns = flatColumns()
  const index = new Map(columns.map((column, position) => [column.key, position]))

  const registry = options.includeUnapproved
    ? await listRegistry(db, options.filters)
    : await listRegistry(
        db,
        { ...options.filters, submissionStatus: ['approved'] },
        'latestApproved',
      )

  const rows: ExportCell[][] = []

  for (const entry of registry) {
    const cells: ExportCell[] = new Array<ExportCell>(columns.length).fill(null)
    const put = (key: string, value: ExportCell): void => {
      const position = index.get(key)
      if (position !== undefined) cells[position] = value
    }

    put('lounge_id', entry.loungeId)
    put('name', entry.name)
    put('provider', entry.provider)
    put('country', entry.country)
    put('city', entry.city)
    put('airport', entry.airport)
    put('iata_code', entry.iataCode)
    put('operational_status', entry.operationalStatus)
    // Уже строка YYYY-MM-DD: `date`-колонку drizzle отдаёт строкой
    // (`RegistryRow.statusUntil: string | null`), Date-объекта здесь нет.
    put('status_until', entry.statusUntil)
    put('submission_status', entry.submissionStatus)
    // `decidedAt` пишет только ветка approve (`review/decide.ts`), так что у
    // непринятой анкеты он пуст сам по себе; день — по UTC, как и хранится.
    put('approved_at', entry.decidedAt ? entry.decidedAt.toISOString().slice(0, 10) : null)

    if (entry.submissionId) {
      const values = await loadSubmissionValues(db, entry.submissionId)

      for (const [fieldKey, value] of Object.entries(values.fields)) {
        put(fieldKey, renderField(fieldKey, value))
      }

      for (const item of SERVICE_ITEMS) {
        const value = values.services[item.key]
        if (!value) continue
        for (const attribute of SERVICE_ATTRIBUTES) {
          const raw = value[attribute]
          const cell: ExportCell =
            raw === null || raw === undefined ? null
            : typeof raw === 'boolean' ? (raw ? 'yes' : 'no')
            : typeof raw === 'number' ? raw
            : String(raw)
          put(`${item.key}.${attribute}`, cell)
        }
      }

      const uploaded = await listPhotos(db, entry.submissionId)
      for (const slot of PHOTO_SLOTS) {
        const urls = uploaded.filter((photo) => photo.slot === slot.key).map((p) => p.url)
        // Несколько URL в одной ячейке бывает только у накопительного слота
        // `additional` (именованные слоты держат один снимок — replace-правило
        // `attachPhoto`). РАЗДЕЛИТЕЛЬ — ОДИН ПРОБЕЛ, решение названо: внутри
        // URL пробел невозможен (был бы %20), так что склейка обратима, а
        // ячейка остаётся однострочной — перенос строки внутри значения
        // пережил бы наш CSV (Task 5 экранирует), но не всякий парсер
        // принимающей стороны.
        put(`photo.${slot.key}`, urls.length === 0 ? null : urls.join(' '))
      }
    }

    rows.push(cells)
  }

  return { columns, rows }
}
