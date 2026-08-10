import { describe, it, expect } from 'vitest'
import { validateField, validateServiceValue } from '../validation'
import { fieldByKey, serviceItemByKey } from '../index'

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
