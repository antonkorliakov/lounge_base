import { describe, it, expect } from 'vitest'
import { FIELDS, BLOCKS } from '@/form-schema'
import { stepFields, BLOCK_I_IATA_FIRST } from '../FillForm'

/**
 * Порядок показа полей на шагах формы заполнения (`stepFields` — единственный
 * шов с собственным порядком, см. его комментарий в FillForm.tsx): блок I
 * рисует код IATA раньше производных от него аэропорта → города → страны,
 * все остальные блоки — в порядке `FIELDS`. Сам `FIELDS` при этом НЕ ТРОНУТ:
 * его порядок и подписи — язык исходного workbook, на нём стоят выгрузка и
 * экран проверки; посимвольно его сторожат золотые фикстуры
 * (`src/form-schema/__tests__/fields.test.ts`), а здесь закреплён именно
 * ключевой порядок — чтобы «переставили в FIELDS, а не на шве» не могло
 * пройти тихо.
 */

describe('stepFields: блок I — IATA раньше производных, только на этом шве', () => {
  it('четвёрка паспорта показывается в порядке I.10 → I.9 → I.8 → I.7, соседи не сдвигаются', () => {
    const source = FIELDS.filter((field) => field.block === 'I').map((field) => field.key)
    const display = stepFields('I').map((field) => field.key)

    // Переставлена ровно четвёрка — на её же четырёх позициях.
    const expected = [...source]
    const positions = source
      .map((key, index) => (BLOCK_I_IATA_FIRST.includes(key) ? index : -1))
      .filter((index) => index !== -1)
    BLOCK_I_IATA_FIRST.forEach((key, slot) => {
      expected[positions[slot]!] = key
    })
    expect(display).toEqual(expected)

    // И буквально, чтобы порядок читался в тесте глазами: I.6 стоит до
    // четвёрки, I.11 сразу после, четвёрка — кодом вперёд.
    const from = display.indexOf('I.10')
    expect(display.slice(from - 1, from + 5)).toEqual([
      'I.6', 'I.10', 'I.9', 'I.8', 'I.7', 'I.11',
    ])
  })

  it('состав блока I не меняется — только порядок', () => {
    const source = FIELDS.filter((field) => field.block === 'I')
    expect(new Set(stepFields('I'))).toEqual(new Set(source))
  })

  it('ИСТОЧНИК не тронут: FIELDS держит порядок исходной формы I.7 → I.10', () => {
    const keys = FIELDS.filter((field) => field.block === 'I').map((field) => field.key)
    const i7 = keys.indexOf('I.7')
    expect(keys.slice(i7, i7 + 4)).toEqual(['I.7', 'I.8', 'I.9', 'I.10'])
  })

  it('все остальные fields-блоки показываются в порядке FIELDS без перестановок', () => {
    for (const block of BLOCKS) {
      if (block.kind !== 'fields' || block.key === 'I') continue
      expect(stepFields(block.key), block.key).toEqual(
        FIELDS.filter((field) => field.block === block.key),
      )
    }
  })
})
