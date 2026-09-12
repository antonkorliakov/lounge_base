import { describe, it, expect } from 'vitest'
import { sanitizeClockInput, parseClockInput, completeClockInput } from '../clockInput'

/**
 * Одно правило — одно место: фильтр набора, «годится ли как граница» и
 * достраивание на blur читают только эти функции; `ClockInput` их вызывает,
 * а сам ничего про формат не знает. Ниже — таблицы допустимого и
 * недопустимого. Сервер здесь не при чём: он и так пускает только `isClock`.
 */
describe('sanitizeClockInput — что остаётся в поле при наборе', () => {
  it('набор по одной цифре: двоеточие встаёт само после второй', () => {
    expect(sanitizeClockInput('0')).toBe('0')
    expect(sanitizeClockInput('09')).toBe('09')
    expect(sanitizeClockInput('093')).toBe('09:3')
    expect(sanitizeClockInput('0930')).toBe('09:30')
  })

  it('больше четырёх цифр не бывает', () => {
    expect(sanitizeClockInput('093015')).toBe('09:30')
  })

  it('набранный оператором разделитель не пропадает: «9:» → «09:», а следующая цифра идёт в минуты', () => {
    expect(sanitizeClockInput('9:')).toBe('09:')
    expect(sanitizeClockInput('9:0')).toBe('09:0')
    expect(sanitizeClockInput('09:')).toBe('09:')
  })

  it('стирание минут оставляет часы без хвоста', () => {
    // «09:3» → backspace → браузер отдаёт «09:» → мы оставляем «09:»;
    // ещё backspace → «09» → «09». Двоеточие не возвращается насильно.
    expect(sanitizeClockInput('09')).toBe('09')
  })
})

describe('sanitizeClockInput — что остаётся после вставки', () => {
  it.each([
    ['9:00', '09:00'],
    ['9.00', '09:00'],
    ['9 00', '09:00'],
    ['09:00', '09:00'],
    ['0900', '09:00'],
    ['9:3', '09:3'],
    ['123:45', '23:45'],
    [' 21:00 ', '21:00'],
  ])('%s → %s', (raw, expected) => {
    expect(sanitizeClockInput(raw)).toBe(expected)
  })

  it('без единой цифры — пусто', () => {
    expect(sanitizeClockInput('abc')).toBe('')
    expect(sanitizeClockInput('')).toBe('')
    expect(sanitizeClockInput(':')).toBe('')
  })

  it('диапазон не проверяет: «99:99» остаётся в поле (подсветит parse)', () => {
    expect(sanitizeClockInput('99:99')).toBe('99:99')
  })
})

describe('parseClockInput — годится ли набранное как граница', () => {
  it('полное время часов 00–23 проходит в обоих полях как есть', () => {
    expect(parseClockInput('09:30', 'from')).toBe('09:30')
    expect(parseClockInput('09:30', 'to')).toBe('09:30')
    expect(parseClockInput('00:00', 'from')).toBe('00:00')
    expect(parseClockInput('00:00', 'to')).toBe('00:00')
    expect(parseClockInput('23:59', 'to')).toBe('23:59')
  })

  it('пусто — null', () => {
    expect(parseClockInput('', 'from')).toBeNull()
    expect(parseClockInput('', 'to')).toBeNull()
  })

  it.each(['9', '09', '09:', '09:3', '25:00', '09:60', '99:99', 'ab'])('обрезок или мусор «%s» — null', (text) => {
    expect(parseClockInput(text, 'from')).toBeNull()
    expect(parseClockInput(text, 'to')).toBeNull()
  })

  // Конец суток: в `Range` он живёт как «00:00 в поле "до"» (правило I1,
  // `rangeToWindow`), а не как буквальное `END_OF_DAY`. Набранное «24:00»
  // переводится в то же представление — итог и подпись «до конца дня»
  // одинаковы для обоих написаний. Началом интервала конец суток быть не может.
  it('«24:00» в «до» — это «00:00»; в «с» — отказ', () => {
    expect(parseClockInput('24:00', 'to')).toBe('00:00')
    expect(parseClockInput('24:00', 'from')).toBeNull()
  })

  it('«24:30» — не конец суток и не время', () => {
    expect(parseClockInput('24:30', 'to')).toBeNull()
  })
})

describe('completeClockInput — что достраивается на blur', () => {
  it.each([
    ['9', '09:00'],
    ['09', '09:00'],
    ['09:', '09:00'],
    ['0', '00:00'],
  ])('«%s» → «%s»', (text, expected) => {
    expect(completeClockInput(text)).toBe(expected)
  })

  it.each(['', '09:3', '09:30', '25', '99:99', '24:00'])('«%s» остаётся как есть', (text) => {
    expect(completeClockInput(text)).toBe(text)
  })
})
