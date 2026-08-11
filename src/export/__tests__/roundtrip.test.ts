import { beforeAll, describe, it, expect } from 'vitest'
import type ExcelJS from 'exceljs'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions } from '@/db/schema'
import {
  FIELDS,
  OPTION_LISTS,
  PHOTO_SLOTS,
  SERVICE_ATTRIBUTES,
  SERVICE_ITEMS,
  isOfferedAvailability,
  needsDetail,
  type Field,
  type SelectValue,
  type ServiceItem,
  type ServiceValueInput,
} from '@/form-schema'
import { saveFieldValue, saveServiceValue } from '@/submissions/values'
import { attachPhoto } from '@/photos/store'
import { buildFlatRows } from '../rows'
import { flatColumns } from '../columns'
import { flatWorkbook } from '../workbook'
import { read } from './readWorkbook'

/**
 * Обратный прогон: анкета, заполненная ЦЕЛИКОМ, выгружается в xlsx, файл
 * читается обратно, и введённое находится в ячейках.
 *
 * КАКОЕ ИМЕННО УТВЕРЖДЕНИЕ ЗДЕСЬ ДОКАЗЫВАЕТСЯ — «что оператор может ввести,
 * то и возвращается», а не «что лежит в базе, то и возвращается». Значения
 * идут через `saveFieldValue`/`saveServiceValue`/`attachPhoto` — те же
 * функции, что вызывает форма (приём `fillComplete` из `scripts/seed-dev.ts`)
 * — а не через голый `db.insert`, как в образце плана. Разница не в
 * чистоплюйстве: голый сид образца писал состояния, которых приложение НЕ
 * ПРОИЗВОДИТ и произвести не может —
 *
 *  - `III.3.2` с `{option: 'allowed'}` и БЕЗ `slots.age`:
 *    `TEMPLATE_REQUIRED_BY_OPTION` требует возраст при «allowed», так что
 *    `saveFieldValue` такое ОТКАЗЫВАЕТ — а заодно единственное составное
 *    значение анкеты (то самое, что трижды терялось в показах) в прогоне
 *    образца вовсе не участвовало;
 *  - платные атрибуты (`price: '12.50'` СТРОКОЙ, `chargeType`, `details`)
 *    при закрывающем `not_allowed` у вейпинга: `saveServiceValue` цену-строку
 *    отказывает (`isNonNegativeNumber`), а атрибуты непредлагаемой позиции
 *    ОБНУЛЯЕТ — образец «проверял» хранение мусора, недостижимого через
 *    приложение.
 *
 * Прогон через настоящие писатели заодно держит сид честным без второго
 * экземпляра правил: значение, переставшее проходить валидацию, роняет сид
 * с именем поля, а не тихо оставляет дырку.
 *
 * Один раз на файл (`beforeAll`), а не на тест: сид — 125+ настоящих
 * транзакций записи, а все тесты ниже только ЧИТАЮТ построенную книгу.
 *
 * Смена статуса на `approved` — единственная прямая запись: механика
 * переходов (полнота, подтверждения блоков) — территория `review`/
 * `submissions` со своими тестами и к форме значений отношения не имеет.
 *
 * ПРОТИВ ТАВТОЛОГИИ. Сравнение ячейки с `built.rows[0]` доказывает только
 * слой xlsx: потеряй `buildFlatRows` возраст — обе стороны согласно потеряли
 * бы его вместе (ровно так молчали оба показа-предшественника). Поэтому
 * ожидаемые значения содержательных тестов ниже написаны ОТ СИДА литералами,
 * а колонка ищется ПО ЗАГОЛОВКУ в самом файле, не по позиции из `built`.
 *
 * Чего здесь нет из образца плана: «число колонок совпадает со схемой» и
 * «группы не перемешиваются» уже закреплены сильнее в `columns.test.ts`
 * (свёртка групп в отрезки, состав против golden fixtures) и в
 * `rows.test.ts` (ширина каждой строки) — их копия слабее и была бы шумом.
 */

/** Ответ, который оператор мог бы ввести в поле, — заведомо проходящий
 *  валидацию и различимый по ключу поля, чтобы уехавшая в чужую колонку
 *  ячейка не совпала со «своим» значением случайно. */
function enteredFieldValue(field: Field, position: number): unknown {
  switch (field.type) {
    case 'text':
    case 'textarea':
      return `Answer ${field.key}`

    case 'date':
      return '2026-03-01'

    // Своё число каждому числовому полю — совпадение двух ячеек не спишешь
    // на одинаковый сид.
    case 'number':
      return 100 + position

    case 'template': {
      const slots: Record<string, number> = {}
      field.templateSlots.forEach((slot, index) => {
        slots[slot.key] = 3 + index
      })
      return slots
    }

    case 'multi_select': {
      const options = field.optionList ? OPTION_LISTS[field.optionList] : []
      return options.map((option) => option.id)
    }

    case 'select':
    case 'select_with_detail': {
      const options = field.optionList ? OPTION_LISTS[field.optionList] : []
      const first = options[0]
      if (!first) throw new Error(`у поля ${field.key} нет списка вариантов`)

      const value: SelectValue = {
        option: first.id,
        // Уточнение — только там, где выбранный вариант его ТРЕБУЕТ (то же
        // `needsDetail`, что у валидатора и `FieldInput`): лишний detail
        // валидатор стерпел бы, но форма его для plain-варианта не собирает,
        // а утверждение теста — про вводимое, не про терпимое.
        detail: needsDetail(field, first.id) ? `Detail ${field.key}` : null,
      }

      // III.3.2 — единственное составное поле: первый вариант его списка
      // («allowed») обязывает заполнить slots.age. Именно это значение
      // образец плана не мог даже записать.
      if (field.templateSlots.length > 0) {
        const slots: Record<string, number> = {}
        for (const slot of field.templateSlots) slots[slot.key] = 10
        value.slots = slots
      }

      return value
    }
  }
}

/** Предлагаемая позиция со всеми семью атрибутами: только у предлагаемой
 *  они переживают запись (`saveServiceValue` обнуляет атрибуты закрытой), и
 *  только заполненные все семь дают прогону что терять. Первый НЕ
 *  закрывающий вариант списка — «yes» у yesNo, «throughout» у vaping. */
function enteredServiceValue(item: ServiceItem): ServiceValueInput {
  const offered = OPTION_LISTS[item.availabilityList].find((option) =>
    isOfferedAvailability(item, option.id),
  )
  if (!offered) throw new Error(`у позиции ${item.key} нет предлагающего варианта`)

  return {
    available: offered.id,
    chargeType: 'chargeable',
    price: 12.5,
    currency: 'EUR',
    slotMinutes: 20,
    // `false`, а не `true`: ячейка обязана нести «no», а не опустеть.
    bookingRequired: false,
    details: `Details ${item.key}`,
  }
}

async function seedEntered(db: Db): Promise<void> {
  const [lounge] = await db.insert(lounges).values({
    name: 'Primeclass Lounge', provider: 'Çelebi', country: 'Turkey', city: 'Istanbul',
    airport: 'Istanbul Airport', iataCode: 'IST',
  }).returning()
  const [submission] = await db
    .insert(submissions)
    .values({ loungeId: lounge!.id, status: 'draft' })
    .returning()
  const submissionId = submission!.id

  for (const [position, field] of FIELDS.entries()) {
    const result = await saveFieldValue(db, {
      submissionId,
      fieldKey: field.key,
      value: enteredFieldValue(field, position),
    })
    if (!result.ok) {
      throw new Error(`сид: поле ${field.key} отклонено — ${result.error.en}`)
    }
  }

  for (const item of SERVICE_ITEMS) {
    const result = await saveServiceValue(db, {
      submissionId,
      itemKey: item.key,
      value: enteredServiceValue(item),
    })
    if (!result.ok) {
      throw new Error(`сид: позиция ${item.key} отклонена — ${result.error.en}`)
    }
  }

  // Каждый именованный слот по снимку, накопительный — двумя: несколько URL
  // в одной ячейке бывают только у него, и разделитель — часть прогона.
  for (const slot of PHOTO_SLOTS.filter((s) => !s.extra)) {
    const result = await attachPhoto(db, {
      submissionId, slot: slot.key,
      blobKey: `${slot.key}.jpg`, url: `https://blob.test/${slot.key}.jpg`, caption: null,
    })
    if (!result.ok) throw new Error(`сид: фото ${slot.key} отклонено — ${result.error.en}`)
  }
  const extra = PHOTO_SLOTS.find((s) => s.extra)!
  for (const n of [1, 2]) {
    const result = await attachPhoto(db, {
      submissionId, slot: extra.key,
      blobKey: `a${n}.jpg`, url: `https://blob.test/a${n}.jpg`, caption: null,
    })
    if (!result.ok) throw new Error(`сид: фото ${extra.key} отклонено — ${result.error.en}`)
  }

  await db
    .update(submissions)
    .set({ status: 'approved', decidedAt: new Date('2026-02-10') })
    .where(eq(submissions.id, submissionId))
}

let built: Awaited<ReturnType<typeof buildFlatRows>>
let sheet: ExcelJS.Worksheet

beforeAll(async () => {
  const db = await createTestDb()
  await seedEntered(db)
  built = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
  sheet = (await read(await flatWorkbook(built))).worksheets[0]!
})

/** Значение ячейки под заголовком колонки `key` — заголовок ищется В САМОМ
 *  ФАЙЛЕ, а позиция не берётся из `built`: ожидания содержательных тестов
 *  привязаны к сиду и файлу, третьего участника у сравнения нет. Сам текст
 *  заголовка — из схемы (`flatColumns`), чьё дословное соответствие
 *  исходнику закреплено golden fixtures в `columns.test.ts`. */
function cellUnder(key: string): ExcelJS.CellValue {
  const column = flatColumns().find((c) => c.key === key)
  if (!column) throw new Error(`в схеме выгрузки нет колонки ${key}`)

  const headerRow = sheet.getRow(1)
  for (let position = 1; position <= headerRow.cellCount; position++) {
    if (headerRow.getCell(position).value === column.header) {
      return sheet.getRow(2).getCell(position).value ?? null
    }
  }
  throw new Error(`в файле нет заголовка «${column.header}»`)
}

describe('обратный прогон: слой xlsx', () => {
  it('одна строка данных под заголовком из всех колонок в их порядке', () => {
    expect(built.rows).toHaveLength(1)
    const headerRow = sheet.getRow(1)
    expect(headerRow.cellCount).toBe(built.columns.length)
    const headers = built.columns.map((_, i) => String(headerRow.getCell(i + 1).value))
    expect(headers).toEqual(built.columns.map((c) => c.header))
  })

  // Обе стороны этого сравнения происходят из `buildFlatRows`, поэтому оно
  // доказывает ТОЛЬКО, что запись и чтение xlsx не искажают ячейку (число
  // остаётся числом, null — пустотой, перенос строки внутри значения
  // выживает). Потерю данных ДО файла оно не видит по построению — для
  // этого следующий describe, привязанный к сиду.
  //
  // Нормализация чисел, которую предсказывал шаг 2 плана, по замеру не
  // нужна: exceljs возвращает и 60, и 12.5 типом `number`, а пустую ячейку —
  // `null`, не `undefined`, даже в хвосте строки. `?? null` ниже закрывает
  // только undefined-ветку типа `CellValue` у ВОВСЕ отсутствующей ячейки —
  // чтобы недостача читалась как пустота и падала, а не проскакивала.
  it('каждая из 488 ячеек читается обратно тем же значением того же типа', () => {
    const dataRow = sheet.getRow(2)
    built.columns.forEach((column, position) => {
      const readBack = dataRow.getCell(position + 1).value ?? null
      expect(readBack, column.key).toStrictEqual(built.rows[0]![position])
    })
  })
})

describe('обратный прогон: введённое возвращается (ожидания — от сида)', () => {
  it('каждый введённый ответ доехал до файла непустым', () => {
    for (const field of FIELDS) {
      expect(cellUnder(field.key), field.key).not.toBeNull()
    }
    for (const item of SERVICE_ITEMS) {
      for (const attribute of SERVICE_ATTRIBUTES) {
        expect(cellUnder(`${item.key}.${attribute}`), `${item.key}.${attribute}`).not.toBeNull()
      }
    }
    for (const slot of PHOTO_SLOTS) {
      expect(cellUnder(`photo.${slot.key}`), slot.key).not.toBeNull()
    }
  })

  it('возраст III.3.2 в файле — введённый ответ целиком, не только вариант', () => {
    expect(cellUnder('III.3.2')).toBe('allowed — 10 years old')
  })

  it('шаблон возвращает введённое число в исходной фразе', () => {
    expect(cellUnder('III.2.1')).toBe(
      'Access is permitted 3 hours prior to scheduled flight departure.',
    )
  })

  it('мультивыбор возвращается целиком, а не первым значением', () => {
    expect(cellUnder('III.6.6')).toBe('arrival, departure, transit')
  })

  it('обязательное уточнение возвращается рядом с вариантом', () => {
    expect(cellUnder('III.2.4')).toBe('specific — Detail III.2.4')
  })

  it('введённые числа приходят числами: ответ поля и цена услуги', () => {
    // Та же формула, что в сиде, — разойдясь с ним, тест падает, а не молчит.
    expect(cellUnder('III.2.2')).toBe(100 + FIELDS.findIndex((f) => f.key === 'III.2.2'))
    expect(cellUnder('7.2.price')).toBe(12.5)
  })

  it('details — сам ответ позиции с подсказкой — возвращается', () => {
    expect(cellUnder('5.1.details')).toBe('Details 5.1')
    // Позиция с собственным списком наличия: её «предлагается» — не «yes».
    expect(cellUnder('8.3.available')).toBe('throughout')
    expect(cellUnder('7.2.bookingRequired')).toBe('no')
  })

  it('накопительный слот фото возвращает обе ссылки', () => {
    expect(cellUnder('photo.additional')).toBe(
      'https://blob.test/a1.jpg https://blob.test/a2.jpg',
    )
  })

  it('день принятия — тот, которым анкету приняли', () => {
    expect(cellUnder('approved_at')).toBe('2026-02-10')
  })
})
