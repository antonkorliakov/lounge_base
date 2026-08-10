import { describe, it, expect } from 'vitest'
import { validateField, validateServiceValue } from '../validation'
import { fieldByKey, serviceItemByKey } from '../index'
import type { Field } from '../index'

const field = (key: string) => {
  const found = fieldByKey(key)
  if (!found) throw new Error(`нет поля ${key}`)
  return found
}

const item = (key: string) => {
  const found = serviceItemByKey(key)
  if (!found) throw new Error(`нет позиции ${key}`)
  return found
}

// FIELDS has no non-required select / number / multi_select field to exercise
// the "not required + empty" branch against real data (every field of those
// three types in the questionnaire happens to be required). These minimal
// fakes exist only to reach that branch; they are never written back to
// fields.ts.
const fakeField = (over: Partial<Field>): Field => ({
  key: 'fake.field',
  section: 'III',
  block: 'III.1',
  type: 'text',
  label: { en: 'Fake field', ru: 'Тестовое поле' },
  hint: null,
  example: null,
  required: false,
  optionList: null,
  templateText: null,
  templateSlots: [],
  detailRequiredFor: [],
  ...over,
})

const serviceValue = (over: Partial<Parameters<typeof validateServiceValue>[1]>) => ({
  available: 'yes',
  chargeType: 'complimentary',
  price: null,
  currency: null,
  slotMinutes: null,
  bookingRequired: false,
  details: null,
  ...over,
})

describe('валидация полей', () => {
  it('обязательное поле не пустое', () => {
    expect(validateField(field('I.2'), '').ok).toBe(false)
    expect(validateField(field('I.2'), 'Primeclass Lounge').ok).toBe(true)
  })

  it('select принимает только известный вариант', () => {
    const f = field('III.5.2')
    expect(validateField(f, { option: 'ground', detail: null }).ok).toBe(true)
    expect(validateField(f, { option: 'basement', detail: null }).ok).toBe(false)
  })

  it('вариант со Specify требует уточнения', () => {
    const f = field('III.6.2')
    expect(validateField(f, { option: 'other', detail: null }).ok).toBe(false)
    expect(validateField(f, { option: 'other', detail: 'Pier C' }).ok).toBe(true)
    expect(validateField(f, { option: 't3', detail: null }).ok).toBe(true)
  })

  it('список авиакомпаний обязателен при выборе specific', () => {
    const f = field('III.2.4')
    expect(validateField(f, { option: 'specific', detail: null }).ok).toBe(false)
    expect(
      validateField(f, { option: 'specific', detail: 'Turkish Airlines' }).ok,
    ).toBe(true)
    expect(validateField(f, { option: 'all', detail: null }).ok).toBe(true)
  })

  it('составное III.3.2 требует возраст при «allowed»', () => {
    const f = field('III.3.2')
    expect(validateField(f, { option: 'allowed', detail: null, slots: { age: null } }).ok).toBe(false)
    expect(validateField(f, { option: 'allowed', detail: null, slots: { age: 10 } }).ok).toBe(true)
  })

  it('составное III.3.2 не требует возраст при «not_allowed»', () => {
    const f = field('III.3.2')
    expect(
      validateField(f, { option: 'not_allowed', detail: null, slots: { age: null } }).ok,
    ).toBe(true)
  })

  it('мультивыбор требует хотя бы одного значения', () => {
    const f = field('III.6.6')
    expect(validateField(f, []).ok).toBe(false)
    expect(validateField(f, ['departure', 'transit']).ok).toBe(true)
  })

  it('шаблон требует заполнения всех слотов', () => {
    const f = field('III.2.1')
    expect(validateField(f, { hours: null }).ok).toBe(false)
    expect(validateField(f, { hours: 3 }).ok).toBe(true)
  })

  it('шаблон не принимает отрицательные числа', () => {
    expect(validateField(field('III.2.1'), { hours: -1 }).ok).toBe(false)
  })

  it('поле-дата принимает ISO-строку', () => {
    expect(validateField(field('I.1'), '2026-03-01').ok).toBe(true)
    expect(validateField(field('I.1'), '01.03.2026').ok).toBe(false)
  })
})

describe('валидация позиции услуг', () => {
  it('недоступная услуга не требует остальных атрибутов', () => {
    const value = serviceValue({ available: 'no', chargeType: null })
    expect(validateServiceValue(item('2.1'), value).ok).toBe(true)
  })

  it('доступная услуга требует указания платности', () => {
    const value = serviceValue({ chargeType: null })
    expect(validateServiceValue(item('2.1'), value).ok).toBe(false)
  })

  it('платная услуга требует цену и валюту', () => {
    const withoutPrice = serviceValue({ chargeType: 'chargeable' })
    expect(validateServiceValue(item('7.2'), withoutPrice).ok).toBe(false)

    const complete = serviceValue({
      chargeType: 'chargeable',
      price: 15,
      currency: 'EUR',
    })
    expect(validateServiceValue(item('7.2'), complete).ok).toBe(true)
  })

  it('вариант «И то и другое» тоже требует цену', () => {
    const value = serviceValue({ chargeType: 'both' })
    expect(validateServiceValue(item('7.2'), value).ok).toBe(false)
  })

  it('вейпинг принимает значения своего списка', () => {
    const ok = serviceValue({ available: 'smoking_room' })
    expect(validateServiceValue(item('8.3'), ok).ok).toBe(true)

    const bad = serviceValue({ available: 'yes' })
    expect(validateServiceValue(item('8.3'), bad).ok).toBe(false)
  })
})

// Fix round 1: the brief's own transcribed code threw instead of failing on
// several kinds of malformed client JSON, and let two forms of bad data
// (whitespace-as-zero, unknown/duplicate multi-select ids) through as valid.
// Every case below asserts the function RETURNS { ok: false }, not that it
// merely doesn't throw — a test that only wrapped the call in
// `expect(() => …).not.toThrow()` would pass even if validation silently
// approved garbage.
describe('устойчивость к некорректным данным (fix round 1)', () => {
  it('нестроковый detail не бросает исключение, а проваливает валидацию', () => {
    // III.6.2, option 'other' has requiresDetail: true, so detail is
    // actually read — this is exactly the path that used to call
    // `value.detail.trim()` on a number and throw.
    const f = field('III.6.2')
    let result: ReturnType<typeof validateField> | undefined
    expect(() => {
      result = validateField(f, { option: 'other', detail: 42 })
    }).not.toThrow()
    expect(result?.ok).toBe(false)
  })

  it('нестроковая currency не бросает исключение, а проваливает валидацию', () => {
    let result: ReturnType<typeof validateServiceValue> | undefined
    expect(() => {
      result = validateServiceValue(
        item('7.2'),
        serviceValue({ chargeType: 'chargeable', price: 15, currency: 42 as unknown as string }),
      )
    }).not.toThrow()
    expect(result?.ok).toBe(false)
  })

  it('обязательное числовое поле не принимает значения без реального number', () => {
    const f = field('I.14') // Tax Chargeable (%) — required, type 'number'
    const badValues: unknown[] = [true, [5], '3', '   ', NaN, Infinity]
    for (const bad of badValues) {
      expect(validateField(f, bad).ok, JSON.stringify(bad)).toBe(false)
    }
    // A real, valid number still passes — the tightened rule isn't just
    // rejecting everything.
    expect(validateField(f, 18).ok).toBe(true)
  })

  it('обязательное текстовое поле не принимает строку из одних пробелов', () => {
    expect(validateField(field('I.2'), '   ').ok).toBe(false)
  })

  it('мультивыбор отвергает значение не из своего списка', () => {
    const f = field('III.6.6') // optionList 'zone': arrival/departure/transit
    expect(validateField(f, ['nonsense']).ok).toBe(false)
    expect(validateField(f, ['departure', 'also-fake']).ok).toBe(false)
  })

  it('мультивыбор отвергает повторяющиеся значения', () => {
    const f = field('III.6.6')
    expect(validateField(f, ['departure', 'departure']).ok).toBe(false)
  })

  it('некорректное значение обязательного select отвергается, а не проходит как валидное', () => {
    const f = field('III.5.2') // Floor — required, type 'select'
    let r1: ReturnType<typeof validateField> | undefined
    let r2: ReturnType<typeof validateField> | undefined
    let r3: ReturnType<typeof validateField> | undefined
    expect(() => {
      r1 = validateField(f, 'ground') // bare string, not a SelectValue
      r2 = validateField(f, null)
      r3 = validateField(f, [])
    }).not.toThrow()
    expect(r1?.ok).toBe(false)
    expect(r2?.ok).toBe(false)
    expect(r3?.ok).toBe(false)
  })

  it('необязательный select с пустым значением валиден', () => {
    const f = fakeField({ type: 'select', optionList: 'yesNo', required: false })
    expect(validateField(f, null).ok).toBe(true)
    expect(validateField(f, undefined).ok).toBe(true)
  })

  it('необязательное числовое поле с пустым значением валидно', () => {
    const f = fakeField({ type: 'number', required: false })
    expect(validateField(f, null).ok).toBe(true)
    expect(validateField(f, '').ok).toBe(true)
    expect(validateField(f, undefined).ok).toBe(true)
  })

  it('необязательный мультивыбор с пустым значением валиден', () => {
    const f = fakeField({ type: 'multi_select', optionList: 'zone', required: false })
    expect(validateField(f, []).ok).toBe(true)
    expect(validateField(f, undefined).ok).toBe(true)
  })
})
