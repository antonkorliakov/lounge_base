import { describe, it, expect } from 'vitest'
import {
  PHONE_PLACEHOLDER,
  EMAIL_PLACEHOLDER,
  sanitizePhoneInput,
  sanitizeEmailInput,
  isValidPhone,
  isValidEmail,
} from '../contact'

/**
 * Одно правило — одно место: и фильтр ввода в браузере, и серверная проверка
 * читают эти функции. Тесты ниже — таблицы допустимого и недопустимого; текст
 * подсказки под полем сам по себе здесь не проверяется — он в validation.test.
 */
describe('sanitizePhoneInput — что остаётся в поле при наборе и вставке', () => {
  it('пропускает + первым символом, цифры, пробелы, скобки и дефис', () => {
    expect(sanitizePhoneInput('+90 (212) 000-00-00')).toBe('+90 (212) 000-00-00')
  })

  it('буквы и прочие символы исчезают, порядок остальных не меняется', () => {
    expect(sanitizePhoneInput('ab+12 c3#4')).toBe('+12 34')
  })

  it('+ не в начале вырезается, в начале — остаётся', () => {
    expect(sanitizePhoneInput('12+34')).toBe('1234')
    expect(sanitizePhoneInput('++90')).toBe('+90')
  })

  it('пробелы перед номером не мешают + встать первым', () => {
    // Вставка « +90 …» из буфера: без этого правила пробел занял бы первое
    // место, и + пропал бы.
    expect(sanitizePhoneInput('  +90 212')).toBe('+90 212')
  })

  it('пустая строка остаётся пустой', () => {
    expect(sanitizePhoneInput('')).toBe('')
  })

  it('плейсхолдер сам проходит фильтр без изменений', () => {
    expect(sanitizePhoneInput(PHONE_PLACEHOLDER)).toBe(PHONE_PLACEHOLDER)
  })
})

describe('isValidPhone — серверное правило', () => {
  it.each([
    '+90 212 000 00 00',
    '+902120000000',
    '(0212) 000-00-00',
    '123456',
    '+123456789012345',
  ])('принимает %s', (text) => {
    expect(isValidPhone(text)).toBe(true)
  })

  it.each([
    ['12345', 'меньше 6 цифр'],
    ['+1234567890123456', 'больше 15 цифр'],
    ['12+34567', '+ не в начале'],
    ['+90 212 ABC', 'буквы'],
    ['+', 'один плюс'],
    ['', 'пусто — пустоту решает required, не формат'],
  ])('отклоняет %s (%s)', (text) => {
    expect(isValidPhone(text)).toBe(false)
  })

  it('плейсхолдер — допустимый номер', () => {
    expect(isValidPhone(PHONE_PLACEHOLDER)).toBe(true)
  })
})

describe('sanitizeEmailInput — при наборе исчезают только пробельные символы', () => {
  it('вырезает пробелы, табы и переносы, остальное не трогает', () => {
    expect(sanitizeEmailInput(' Na me@Comp any.com\n')).toBe('Name@Company.com')
  })

  it('регистр не меняется', () => {
    expect(sanitizeEmailInput('John.Doe@Example.COM')).toBe('John.Doe@Example.COM')
  })
})

describe('isValidEmail — серверное правило', () => {
  it.each(['name@company.com', 'first.last+tag@sub.domain.co', EMAIL_PLACEHOLDER])(
    'принимает %s',
    (text) => {
      expect(isValidEmail(text)).toBe(true)
    },
  )

  it.each([
    ['name@company', 'домен без точки'],
    ['name.company.com', 'нет @'],
    ['na me@company.com', 'пробел'],
    ['name@@company.com', 'две @'],
    ['@company.com', 'пусто до @'],
    ['', 'пусто'],
  ])('отклоняет %s (%s)', (text) => {
    expect(isValidEmail(text)).toBe(false)
  })
})
