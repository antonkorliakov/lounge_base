import { describe, it, expect } from 'vitest'
import { flatCsv } from '../csv'

const columns = [
  { key: 'name', header: 'Lounge Name', group: 'identity' as const },
  { key: 'note', header: 'Note', group: 'fields' as const },
  { key: 'seats', header: 'Seats', group: 'fields' as const },
]

/**
 * Строки файла БЕЗ решений о представлении: BOM отрезан, разделитель — CRLF.
 * Сами решения (что BOM есть, что разделитель именно CRLF) закреплены своими
 * тестами ниже; остальным тестам они не нужны, и размазывать их по каждому
 * ожиданию значило бы проверять их десять раз и нигде по существу.
 */
const lines = (csv: string): string[] => csv.replace(/^﻿/, '').split('\r\n')

describe('CSV', () => {
  it('начинается с UTF-8 BOM — иначе Excel читает Çelebi как Ã‡elebi', () => {
    const csv = flatCsv({ columns, rows: [['Çelebi', null, 1]] })
    expect(csv.startsWith('﻿')).toBe(true)
    // BOM один и стоит только в начале — не перед каждой строкой.
    expect(csv.slice(1)).not.toContain('﻿')
    expect(csv).toContain('Çelebi')
  })

  it('строки разделены CRLF (RFC 4180), а не голым LF', () => {
    const csv = flatCsv({ columns, rows: [['A', null, 1]] })
    expect(csv).toContain('\r\n')
    // Ни одного LF без CR перед ним: одинокий \n в качестве разделителя строк
    // означал бы смесь двух конвенций в одном файле.
    expect(csv.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('первая строка — заголовки', () => {
    const csv = flatCsv({ columns, rows: [] })
    expect(lines(csv)[0]).toBe('Lounge Name,Note,Seats')
  })

  it('пустая ячейка выводится пустой', () => {
    const csv = flatCsv({ columns, rows: [['A', null, 60]] })
    expect(lines(csv)[1]).toBe('A,,60')
  })

  it('запятая внутри значения экранируется кавычками', () => {
    const csv = flatCsv({ columns, rows: [['A', 'departure, transit', 1]] })
    expect(lines(csv)[1]).toBe('A,"departure, transit",1')
  })

  it('кавычка внутри значения удваивается', () => {
    const csv = flatCsv({ columns, rows: [['A', 'near "iStore"', 1]] })
    expect(lines(csv)[1]).toBe('A,"near ""iStore""",1')
  })

  it('перенос строки внутри значения сохраняется в кавычках и не рвёт строку', () => {
    const csv = flatCsv({ columns, rows: [['A', 'Mon–Sat\nSun', 1]] })
    expect(csv).toContain('"Mon–Sat\nSun"')
    // Разделителем строк файла внутренний \n не становится: строк по-прежнему
    // две — заголовок и одна запись.
    expect(lines(csv)).toHaveLength(2)
  })

  it('число не берётся в кавычки', () => {
    const csv = flatCsv({ columns, rows: [['A', 'x', 60]] })
    expect(lines(csv)[1]).toBe('A,x,60')
  })

  it('значения НЕ калечатся защитой от формул: телефон с «+» уезжает дословно', () => {
    // Решение закреплено, а не забыто: ячейку, начинающуюся с =,+,-,@, Excel
    // исполняет как формулу, и обычная защита — префикс «'». Здесь её
    // сознательно НЕТ, потому что она портит данные для заявленного
    // потребителя файла (см. csv.ts, где решение обосновано целиком):
    // международные телефоны контактов (II.*) начинаются с «+», и принимающая
    // система получила бы «'+90…» вместо номера.
    const csv = flatCsv({ columns, rows: [['A', '+90 212 463 09 45', 1]] })
    expect(lines(csv)[1]).toBe('A,+90 212 463 09 45,1')
  })

  it('и «=» в начале значения тоже уезжает дословно', () => {
    const csv = flatCsv({ columns, rows: [['A', '=SUM(A1:A9)', 1]] })
    expect(lines(csv)[1]).toBe('A,=SUM(A1:A9),1')
  })
})
