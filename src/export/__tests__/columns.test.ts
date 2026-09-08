import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTableColumns } from 'drizzle-orm'
import { fieldValues, serviceValues } from '@/db/schema'
import { FIELDS, PHOTO_SLOTS, SERVICE_ATTRIBUTES, SERVICE_ITEMS } from '@/form-schema'
import { duplicateKeysIn, flatColumns, IDENTITY_COLUMNS, type Column } from '../columns'

/**
 * Оракулы этого файла НАМЕРЕННО не те массивы, из которых собираются колонки.
 * Тест вида `expect(columns).toHaveLength(FIELDS.length + SERVICE_ITEMS.length * 7)`
 * не падает ни от какой ошибки в модуле: обе части считаются по одному и тому
 * же источнику. Поэтому здесь:
 *
 *  - состав и ПОРЯДОК полей и позиций услуг сверяются с golden fixtures,
 *    снятыми механически с исходного xlsx (те же файлы, что у тестов
 *    `form-schema`, см. команду регенерации в их заголовке);
 *  - набор атрибутов услуги сверяется с настоящими колонками таблицы
 *    `service_values`, то есть с тем, что реально хранится;
 *  - идентификационные колонки и слоты фото закреплены списком руками — их
 *    немного, и они не выводятся ни из чего.
 *
 * Так тест падает, если колонка исчезнет, появится лишняя или порядок
 * поедет — то есть от того, из-за чего ломается принимающая сторона.
 */
const fixture = (name: string): Record<string, string> =>
  JSON.parse(
    readFileSync(join(process.cwd(), 'src/form-schema/__tests__/fixtures', name), 'utf8'),
  )

// Порядок ключей в fixture — порядок строк исходного листа (JSON.parse
// сохраняет порядок вставки, ключи вида "I.2"/"1.1" не целочисленные индексы).
const sourceFieldKeys = Object.keys(fixture('source-field-labels.json'))
const sourceFieldLabels = fixture('source-field-labels.json')
const sourceServiceKeys = Object.keys(fixture('source-service-labels.json'))
const sourceServiceLabels = fixture('source-service-labels.json')

/**
 * Атрибуты услуги по данным, а не по константе: всё, что таблица
 * `service_values` хранит про позицию, кроме её собственного ключа и метки
 * времени. Новая колонка в таблице попадёт сюда сама и уронит тесты ниже, пока
 * её не начнут выгружать, — именно так и обнаруживается «атрибут есть в базе,
 * а колонки в файле нет». Этот же тест поймал бы шестиатрибутный набор из
 * плана, потерявший `details`.
 */
// `editedBy` — служебная запись (провенанс: кто последним правил ответ,
// null — оператор), а не атрибут ответа: выгрузка везёт ОТВЕТЫ, а история
// «кто и когда» живёт в `events`. Ровно та же причина, по которой здесь
// исключён `updatedAt`. Колонка добавлена миграцией 0007 вместе с правкой
// ответов командой — и этот тест её сразу поймал, потребовав решения; это и
// есть его работа, а не ложное срабатывание.
const NON_ATTRIBUTE_COLUMNS = ['submissionId', 'itemKey', 'updatedAt', 'editedBy']
const storedAttributes = Object.keys(getTableColumns(serviceValues)).filter(
  (name) => !NON_ATTRIBUTE_COLUMNS.includes(name),
)

/**
 * Тот же оракул для `field_values` — у него не было эквивалента, и колонка,
 * добавленная в ЭТУ таблицу, не роняла бы ничего: сервисный оракул выше её не
 * видит, а группа `fields` сверяется с golden fixture, которая про хранение
 * не знает. Таблица одноатрибутная, поэтому честная форма проверки другая:
 * не «каждый атрибут имеет колонку у каждого поля» (колонка поля и ЕСТЬ его
 * единственный атрибут — сравнение вышло бы тавтологией), а «атрибут ровно
 * один, и это `value`». Новая колонка в `field_values` попадает в разность и
 * роняет тест ниже, требуя решения: либо она выгружается (и тогда группа
 * `fields` перестаёт быть «одна колонка на ключ» — правится и `columns.ts`,
 * и этот оракул), либо она служебная — и тогда её вносят в этот список с
 * причиной, как `editedBy`/`updatedAt` выше.
 */
const FIELD_NON_ATTRIBUTE_COLUMNS = ['submissionId', 'fieldKey', 'updatedAt', 'editedBy']
const storedFieldAttributes = Object.keys(getTableColumns(fieldValues)).filter(
  (name) => !FIELD_NON_ATTRIBUTE_COLUMNS.includes(name),
)

const IDENTITY_KEYS = [
  'lounge_id',
  'name',
  'provider',
  'country',
  'city',
  'airport',
  'iata_code',
  'operational_status',
  'status_until',
  'submission_status',
  'approved_at',
]

const PHOTO_SLOT_KEYS = ['entrance', 'reception', 'landmarks', 'additional']

const SUFFIX_HEADERS: Record<string, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
  cadence: 'Cadence', free: 'Free text',
}

const keysOf = (columns: Column[]): string[] => columns.map((c) => c.key)
const inGroup = (group: Column['group']): Column[] =>
  flatColumns().filter((c) => c.group === group)
const byKey = (key: string): Column | undefined => flatColumns().find((c) => c.key === key)

describe('колонки плоской выгрузки', () => {
  it('группы идут в фиксированном порядке и не перемешиваются', () => {
    // Не `indexOf` первого вхождения каждой группы, как в плане: тот тест
    // проходит и если колонки групп чередуются. Здесь свёртка в последовательные
    // отрезки — то есть каждая группа лежит одним куском.
    const runs = flatColumns()
      .map((c) => c.group)
      .filter((group, index, all) => group !== all[index - 1])
    expect(runs).toEqual(['identity', 'fields', 'services', 'photos'])
  })

  it('идентификация начинается с lounge_id', () => {
    expect(flatColumns()[0]?.key).toBe('lounge_id')
  })

  it('идентификационные колонки закреплены списком и стоят первыми', () => {
    expect(keysOf([...IDENTITY_COLUMNS])).toEqual(IDENTITY_KEYS)
    expect(keysOf(inGroup('identity'))).toEqual(IDENTITY_KEYS)
  })

  // Первое ограничение плана 3: два статуса не смешиваются. Различимы должны
  // быть и ключи, и ЗАГОЛОВКИ — в файл уезжают только заголовки (`csv.ts`,
  // `workbook.ts` пишут первой строкой `column.header`), так что «Status» и
  // «Status» рядом были бы неразличимы именно там, где на них смотрит человек.
  it('оба статуса присутствуют и различимы ключом и заголовком', () => {
    const operational = byKey('operational_status')
    const submission = byKey('submission_status')

    expect(operational?.group).toBe('identity')
    expect(submission?.group).toBe('identity')
    expect(operational?.header).not.toBe(submission?.header)
    expect(operational?.header).toContain('Operational')
    expect(submission?.header).toContain('Form')
  })

  /**
   * Расписания (`weekHours`, `cleaningSchedule`) — единственные поля, у которых
   * колонок больше одной: получателю нужна ячейка на день недели, а не строка
   * «Mon–Sat …» (решение пользователя). Суффиксы перечислены здесь ЛИТЕРАЛЬНО,
   * а не взяты из `columns.ts`: оракул, выведенный из реализации, повторил бы
   * её ошибку. Ключи расписаний тоже литеральные — те же три, что закреплены в
   * `fields.test.ts`.
   */
  const SCHEDULE_SUFFIXES: Record<string, string[]> = {
    'III.1.1': ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'free'],
    'III.1.3': ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'free'],
    'III.1.4': ['cadence', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'free'],
  }

  const expectedFieldKeys = sourceFieldKeys.flatMap((key) =>
    SCHEDULE_SUFFIXES[key] ? SCHEDULE_SUFFIXES[key]!.map((suffix) => `${key}.${suffix}`) : [key],
  )

  it('поля идут в порядке и составе исходной формы; у расписаний — колонка на день', () => {
    expect(keysOf(inGroup('fields'))).toEqual(expectedFieldKeys)
  })

  it('заголовок поля — его номер и дословная формулировка исходника, у расписания плюс день', () => {
    for (const key of sourceFieldKeys) {
      const suffixes = SCHEDULE_SUFFIXES[key]
      if (!suffixes) {
        expect(byKey(key)?.header, key).toBe(`${key} ${sourceFieldLabels[key]}`)
        continue
      }
      for (const suffix of suffixes) {
        const header = byKey(`${key}.${suffix}`)?.header
        expect(header, `${key}.${suffix}`).toBe(`${key} ${sourceFieldLabels[key]} — ${SUFFIX_HEADERS[suffix]}`)
      }
    }
  })

  it('позиции услуг идут в порядке исходного листа, по семь колонок на позицию', () => {
    const expected = sourceServiceKeys.flatMap((itemKey) =>
      SERVICE_ATTRIBUTES.map((attribute) => `${itemKey}.${attribute}`),
    )
    expect(keysOf(inGroup('services'))).toEqual(expected)
  })

  // ГЛАВНЫЙ тест на полноту: каждый хранимый атрибут выгружается, и ровно по
  // одной колонке на позицию. Он не знает про `SERVICE_ATTRIBUTES` — берёт
  // список из таблицы, поэтому падает и при потерянном атрибуте, и при
  // выдуманном.
  it('каждый хранимый атрибут service_values имеет колонку у каждой позиции', () => {
    const services = inGroup('services')
    expect(storedAttributes).toContain('details')

    for (const attribute of storedAttributes) {
      const forAttribute = services.filter((c) => c.key.endsWith(`.${attribute}`))
      expect(forAttribute, attribute).toHaveLength(sourceServiceKeys.length)
    }

    const attributesUsed = new Set(services.map((c) => c.key.split('.').at(-1)))
    expect([...attributesUsed].sort()).toEqual([...storedAttributes].sort())
    expect(services).toHaveLength(sourceServiceKeys.length * storedAttributes.length)
    expect(services).toHaveLength(406)
  })

  // Хвост оракула выше, для второй таблицы ответов: `renderField` выгружает
  // ровно `row.value`. Проверка ниже делает это равенство утверждением по
  // данным, а не молчаливой предпосылкой.
  it('field_values хранит ровно один атрибут — value; новая колонка требует решения о выгрузке', () => {
    expect(storedFieldAttributes).toEqual(['value'])
  })

  // Хвост того же оракула: одна колонка на ключ ПЕРЕСТАЛА быть правилом —
  // расписания раскладывают своё единственное `value` на день недели
  // (`scheduleColumnSuffixes`). Утверждение теперь такое: колонок больше
  // одной ровно у расписаний, у всех прочих полей — по одной.
  it('несколько колонок на поле — только у расписаний', () => {
    for (const key of sourceFieldKeys) {
      const own = keysOf(inGroup('fields')).filter((k) => k === key || k.startsWith(`${key}.`))
      expect(own.length, key).toBe(SCHEDULE_SUFFIXES[key]?.length ?? 1)
    }
  })

  it('атрибуты одной позиции идут подряд', () => {
    const keys = keysOf(flatColumns())
    for (const itemKey of sourceServiceKeys) {
      const start = keys.indexOf(`${itemKey}.${SERVICE_ATTRIBUTES[0]}`)
      expect(start, itemKey).toBeGreaterThan(-1)
      expect(keys.slice(start, start + SERVICE_ATTRIBUTES.length), itemKey).toEqual(
        SERVICE_ATTRIBUTES.map((attribute) => `${itemKey}.${attribute}`),
      )
    }
  })

  it('семь колонок Wifi Access — поимённо и в порядке', () => {
    const keys = keysOf(flatColumns())
    const start = keys.indexOf('2.1.available')
    expect(keys.slice(start, start + 7)).toEqual([
      '2.1.available',
      '2.1.chargeType',
      '2.1.price',
      '2.1.currency',
      '2.1.slotMinutes',
      '2.1.bookingRequired',
      '2.1.details',
    ])
  })

  it('заголовок услуги содержит номер, английское название и атрибут', () => {
    const column = byKey('2.1.price')
    expect(column?.header).toContain('2.1')
    expect(column?.header).toContain('Wifi Access')
    expect(column?.header).toContain('Price')
  })

  // Позиции с подсказкой «уточните вместимость/напитки/часы» отвечают именно в
  // `details`; без этой колонки выгрузка теряет сам ответ. Проверяются все
  // такие позиции, а не одна.
  it('у позиций с подсказкой есть колонка details с их названием в заголовке', () => {
    const withHint = SERVICE_ITEMS.filter((item) => item.hint !== null)
    expect(withHint.length).toBeGreaterThan(0)

    for (const item of withHint) {
      const column = byKey(`${item.key}.details`)
      expect(column, item.key).toBeDefined()
      expect(column?.header, item.key).toContain(sourceServiceLabels[item.key]!)
      expect(column?.group, item.key).toBe('services')
    }
  })

  it('фото — по одной колонке на слот, в порядке схемы', () => {
    expect(keysOf(inGroup('photos'))).toEqual(PHOTO_SLOT_KEYS.map((key) => `photo.${key}`))
    for (const slot of PHOTO_SLOTS) {
      expect(byKey(`photo.${slot.key}`)?.header, slot.key).toContain(slot.label.en)
    }
  })

  // Было 488 (11 + 67 + 58×7 + 4) до расписаний; `expectedFieldKeys` уже
  // учитывает их разворот в колонки по дню (тот же литеральный
  // `SCHEDULE_SUFFIXES`, что у теста состава `fields` выше), поэтому формула
  // остаётся суммой источников, а не вторым хардкодом числа.
  it('всего 510 колонок: 11 + 89 + 58×7 + 4', () => {
    const expected =
      IDENTITY_KEYS.length +
      expectedFieldKeys.length +
      sourceServiceKeys.length * storedAttributes.length +
      PHOTO_SLOT_KEYS.length

    expect(flatColumns()).toHaveLength(expected)
    expect(flatColumns()).toHaveLength(510)
  })

  it('ключи уникальны', () => {
    const keys = keysOf(flatColumns())
    expect(duplicateKeysIn(flatColumns())).toEqual([])
    expect(new Set(keys).size).toBe(keys.length)
  })

  // Заголовки тоже уникальны, и это не косметика: в файл уезжает только
  // строка заголовков, поэтому две одинаковые — это две колонки, которые
  // принимающая сторона не различит. Гарантирует это номер позиции/поля в
  // заголовке: подписи копируются из живого xlsx, где две одинаковые
  // формулировки в разных разделах — вопрос времени, а ключи уникальны по
  // построению.
  it('заголовки уникальны', () => {
    const headers = flatColumns().map((c) => c.header)
    expect(new Set(headers).size).toBe(headers.length)
  })

  it('у каждой колонки непустой ключ, непустой заголовок и своя группа', () => {
    for (const column of flatColumns()) {
      expect(column.key.trim(), column.key).not.toBe('')
      expect(column.header.trim(), column.key).not.toBe('')
      expect(['identity', 'fields', 'services', 'photos'], column.key).toContain(column.group)
    }
  })

  it('порядок стабилен между вызовами, и результат нельзя испортить снаружи', () => {
    const first = flatColumns()
    expect(keysOf(first)).toEqual(keysOf(flatColumns()))

    // Вызывающий получает свой массив: `rows.ts` строит по нему индекс и вправе
    // с ним работать, не ломая следующую выгрузку и `IDENTITY_COLUMNS`.
    first.length = 0
    expect(flatColumns()).toHaveLength(510)
    expect(IDENTITY_COLUMNS).toHaveLength(IDENTITY_KEYS.length)
  })

  it('число полей и позиций совпадает с form-schema (иначе разошлись схема и исходник)', () => {
    expect(FIELDS).toHaveLength(sourceFieldKeys.length)
    expect(SERVICE_ITEMS).toHaveLength(sourceServiceKeys.length)
    expect(PHOTO_SLOTS.map((s) => s.key)).toEqual(PHOTO_SLOT_KEYS)
  })
})

/**
 * Сам детектор дублей проверяется напрямую синтетическими списками: через
 * `flatColumns()` его сработавшую ветку не увидеть — сегодня дублей нет, и в
 * этом весь смысл. Тот же приём, которым в этой ветке покрыт
 * `forbiddenImportsIn` (`form-schema/__tests__/import-guard.ts`).
 */
describe('duplicateKeysIn', () => {
  const column = (key: string): Column => ({ key, header: key, group: 'fields' })

  it('чистый список — пусто', () => {
    expect(duplicateKeysIn([column('a'), column('b')])).toEqual([])
  })

  it('повторяющийся ключ назван один раз', () => {
    expect(duplicateKeysIn([column('a'), column('b'), column('a'), column('a')])).toEqual(['a'])
  })

  it('находит несколько разных дублей', () => {
    expect(
      duplicateKeysIn([column('a'), column('b'), column('a'), column('b')]).sort(),
    ).toEqual(['a', 'b'])
  })

  it('одинаковый заголовок при разных ключах дублем не считается', () => {
    const columns: Column[] = [
      { key: 'a', header: 'Same', group: 'fields' },
      { key: 'b', header: 'Same', group: 'fields' },
    ]
    expect(duplicateKeysIn(columns)).toEqual([])
  })
})
