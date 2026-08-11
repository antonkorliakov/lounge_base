import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions, fieldValues, serviceValues, photos } from '@/db/schema'
import { flatWorkbook } from '../workbook'
import { singleSubmissionWorkbook } from '../single'
import { flatColumns } from '../columns'
import fieldLabels from '@/form-schema/__tests__/fixtures/source-field-labels.json'
import serviceLabels from '@/form-schema/__tests__/fixtures/source-service-labels.json'

const columns = flatColumns()

/**
 * Без единого приведения типов. `xlsx.load` объявлен принимающим НЕ узловый
 * `Buffer`, а собственный exceljs-овский `interface Buffer extends
 * ArrayBuffer {}` (первая строка его `index.d.ts`) — образец плана закрывал
 * этот разрыв кастом `buffer as unknown as ArrayBuffer`, тем самым классом
 * приведения, который эта ветка выпалывала уже пять раз. Честный путь —
 * отдать `load` настоящий `ArrayBuffer`: `new Uint8Array(buffer)` копирует
 * байты в свежий несёженный буфер (тот же приём, с тем же обоснованием, что
 * у `createTestDb` в `db/__tests__/harness.ts`: подложка узлового `Buffer` —
 * `ArrayBufferLike`, срез её мог бы быть и `SharedArrayBuffer`), и exceljs
 * его принимает и типом, и на деле — проверено до того, как тесты на это
 * оперлись.
 */
async function read(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new Uint8Array(buffer).buffer)
  return workbook
}

/** Все непустые значения первой колонки листа — «оглавление» его строк. */
function firstColumn(sheet: ExcelJS.Worksheet): string[] {
  const out: string[] = []
  sheet.eachRow((row) => {
    const value = row.getCell(1).value
    if (value !== null && value !== undefined) out.push(String(value))
  })
  return out
}

function rowWhereFirstCellIs(sheet: ExcelJS.Worksheet, text: string): ExcelJS.Row {
  let found: ExcelJS.Row | undefined
  sheet.eachRow((row) => {
    if (String(row.getCell(1).value ?? '') === text) found = row
  })
  if (!found) throw new Error(`нет строки с «${text}» в первой колонке`)
  return found
}

describe('плоская книга', () => {
  it('один лист, и заголовок — ровно колонки выгрузки, в их порядке', async () => {
    const buffer = await flatWorkbook({ columns, rows: [] })
    const workbook = await read(buffer)

    expect(workbook.worksheets).toHaveLength(1)
    const header = workbook.worksheets[0]!.getRow(1)
    expect(header.cellCount).toBe(columns.length)
    // Весь ряд, не первая ячейка: сдвиг любой колонки — та же поломка для
    // принимающей системы, что и пропавшая.
    const headers = columns.map((_, i) => String(header.getCell(i + 1).value))
    expect(headers).toEqual(columns.map((c) => c.header))
  })

  it('каждая строка данных ложится под заголовок', async () => {
    const row: (string | number | null)[] = new Array(columns.length).fill(null)
    row[1] = 'Primeclass Lounge'
    const buffer = await flatWorkbook({ columns, rows: [row] })
    const workbook = await read(buffer)

    expect(workbook.worksheets[0]!.getRow(2).getCell(2).value).toBe('Primeclass Lounge')
  })

  it('null — пустая ячейка, а не строка "null"; число остаётся числом', async () => {
    const row: (string | number | null)[] = new Array(columns.length).fill(null)
    row[0] = 'id-1'
    row[2] = 60
    const buffer = await flatWorkbook({ columns, rows: [row] })
    const sheet = (await read(buffer)).worksheets[0]!

    expect(sheet.getRow(2).getCell(2).value).toBeNull()
    expect(sheet.getRow(2).getCell(3).value).toBe(60)
    sheet.getRow(2).eachCell((cell) => {
      expect(cell.value).not.toBe('null')
    })
  })

  it('заголовок закреплён', async () => {
    const buffer = await flatWorkbook({ columns, rows: [] })
    const workbook = await read(buffer)
    expect(workbook.worksheets[0]!.views[0]?.state).toBe('frozen')
  })
})

async function seedSubmission(db: Db): Promise<string> {
  const [lounge] = await db.insert(lounges).values({
    name: 'Primeclass', provider: 'Çelebi', country: 'Turkey', city: 'Istanbul',
    airport: 'Istanbul Airport', iataCode: 'IST',
  }).returning()
  const [submission] = await db
    .insert(submissions).values({ loungeId: lounge!.id, status: 'approved' }).returning()

  await db.insert(fieldValues).values([
    { submissionId: submission!.id, fieldKey: 'I.2', value: 'Primeclass Lounge' },
    // Единственное составное поле анкеты: `slots.age` — содержательный ответ,
    // который до общего форматтера терялся уже в ТРЁХ независимых показах.
    {
      submissionId: submission!.id,
      fieldKey: 'III.3.2',
      value: { option: 'allowed', detail: null, slots: { age: 10 } },
    },
  ])

  await db.insert(serviceValues).values({
    submissionId: submission!.id, itemKey: '7.2', available: 'yes',
    chargeType: 'chargeable', price: '15.00', currency: 'EUR',
    slotMinutes: 30,
    // `false`, а не `true`: ячейка обязана сказать «no», а не опустеть — и
    // при сдвиге колонок именно непустое «no» уедет под чужой заголовок.
    bookingRequired: false,
    // Седьмой атрибут, который образец плана печатал ДВАЖДЫ (в своей колонке
    // из SERVICE_ATTRIBUTES и ещё раз довеском) под восемью заголовками.
    details: 'Towels and amenities provided',
  })

  await db.insert(photos).values([
    { submissionId: submission!.id, slot: 'entrance', blobKey: 'e.jpg', url: 'https://blob.test/e.jpg' },
    { submissionId: submission!.id, slot: 'additional', blobKey: 'a.jpg', url: 'https://blob.test/a.jpg', caption: 'Bar area' },
  ])

  return submission!.id
}

describe('книга одной анкеты', () => {
  it('два листа с исходными названиями', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db)

    const workbook = await read(await singleSubmissionWorkbook(db, submissionId))

    expect(workbook.worksheets.map((s) => s.name)).toEqual([
      'General Lounge Information',
      'Services & Amenities',
    ])
  })

  it('несуществующая анкета — громкий отказ, а не пустая книга', async () => {
    const db = await createTestDb()
    await expect(singleSubmissionWorkbook(db, randomUUID())).rejects.toThrow(/анкет/)
  })

  it('нумерация и формулировки исходной формы сохранены — ВСЕ, по golden fixture', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db)

    const workbook = await read(await singleSubmissionWorkbook(db, submissionId))
    const labels = firstColumn(workbook.worksheets[0]!)

    // Оракул — fixture, снятый с исходного xlsx, а не массив FIELDS: тест
    // «I.2 на месте» из плана прошёл бы и с листом из одного вопроса.
    for (const [key, label] of Object.entries(fieldLabels)) {
      expect(labels, key).toContain(`${key}. ${label}`)
    }
  })

  it('значение ложится в свою строку, составное — через общий форматтер', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db)

    const sheet = (await read(await singleSubmissionWorkbook(db, submissionId))).worksheets[0]!

    const name = rowWhereFirstCellIs(sheet, `I.2. ${fieldLabels['I.2']}`)
    expect(name.getCell(2).value).toBe('Primeclass Lounge')

    // `slots.age` не выпадает: тот же `formatFieldValue`, что у экрана
    // проверки и плоской выгрузки, — не четвёртый рукописный показ.
    const children = rowWhereFirstCellIs(sheet, `III.3.2. ${fieldLabels['III.3.2']}`)
    expect(children.getCell(2).value).toBe('allowed — 10 years old')
  })

  it('лист услуг: все формулировки исходной матрицы на месте', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db)

    const workbook = await read(await singleSubmissionWorkbook(db, submissionId))
    const labels = firstColumn(workbook.worksheets[1]!)

    for (const label of Object.values(serviceLabels)) {
      expect(labels).toContain(label)
    }
  })

  it('лист услуг: ровно 8 колонок, и каждое значение под СВОИМ заголовком', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db)

    const workbook = await read(await singleSubmissionWorkbook(db, submissionId))
    const sheet = workbook.worksheets[1]!
    const header = sheet.getRow(1)

    // Точное равенство, не `>= 7` из плана: подпись + семь атрибутов
    // (`SERVICE_ATTRIBUTES` несёт `details` с Task 3). Образец плана писал
    // 9 ячеек под 8 заголовками — details дважды, всё после bookingRequired
    // со сдвигом — и его `toBeGreaterThanOrEqual(7)` этого не видел.
    expect(header.getCell(1).value).toBe('Amenities Offered')
    expect(header.cellCount).toBe(8)

    // Выравнивание проверяется ПО ЗАГОЛОВКУ, а не по номеру колонки: колонка
    // ищется по своему заголовку, значение обязано лежать именно в ней.
    const columnOf = (title: string): number => {
      for (let i = 1; i <= header.cellCount; i++) {
        if (header.getCell(i).value === title) return i
      }
      throw new Error(`нет заголовка «${title}» на листе услуг`)
    }

    const shower = rowWhereFirstCellIs(sheet, 'Shower Facilities')
    expect(shower.getCell(columnOf('Booking Required (Yes/No)')).value).toBe('no')
    expect(shower.getCell(columnOf('Other Details (if any)')).value).toBe(
      'Towels and amenities provided',
    )
    // Последняя ячейка строки — details, девятой ячейки-довеска нет.
    expect(shower.cellCount).toBe(8)
  })

  it('фото подписаны формулировкой формы, а не внутренним ключом слота', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db)

    const sheet = (await read(await singleSubmissionWorkbook(db, submissionId))).worksheets[0]!
    const labels = firstColumn(sheet)

    const entrance = rowWhereFirstCellIs(sheet, 'Entrance')
    expect(entrance.getCell(2).value).toBe('https://blob.test/e.jpg')

    const additional = rowWhereFirstCellIs(sheet, 'Additional Photos')
    expect(additional.getCell(2).value).toBe('https://blob.test/a.jpg')
    expect(additional.getCell(3).value).toBe('Bar area')

    // Сырые ключи слотов — внутренний язык базы, в документе их нет.
    expect(labels).not.toContain('entrance')
    expect(labels).not.toContain('additional')
  })
})
