import { END_OF_DAY, isClock } from './schedule'

/** Какую границу набирают: конец суток («24:00») законен только у «до». */
export type ClockBound = 'from' | 'to'

/**
 * Что остаётся в поле после набора или вставки. Правило одно на клавишу и на
 * буфер: цифры и не больше четырёх, двоеточие ставим сами после первых двух.
 *
 * Разделитель, который оператор набрал сам («9:»), — сигнал «часы закончены»:
 * первая группа дополняется нулём до двух знаков, дальше идут минуты. Без
 * этого набранное двоеточие пропадало бы, и следующая цифра приклеивалась к
 * часам («9:» + «0» → «90»). Лишние знаки часов срезаются слева («123:45» →
 * «23:45»): при вставке чаще лишний ведущий символ, чем лишний последний.
 *
 * Диапазон здесь не проверяется — «99:99» остаётся в поле, чтобы оператор
 * видел, что набрал; годность решает `parseClockInput`.
 */
export function sanitizeClockInput(raw: string): string {
  const groups = raw.split(/\D+/).filter((g) => g !== '')
  if (groups.length === 0) return ''
  const hoursDone = groups.length >= 2 || /\d\D/.test(raw)
  if (hoursDone) {
    // groups.length >= 1 here: the length-0 case returned above, and both
    // branches of hoursDone require at least one digit group to exist.
    const hours = groups[0]!.padStart(2, '0').slice(-2)
    const minutes = (groups[1] ?? '').slice(0, 2)
    return `${hours}:${minutes}`
  }
  const digits = groups[0]!.slice(0, 4)
  return digits.length <= 2 ? digits : `${digits.slice(0, 2)}:${digits.slice(2)}`
}

/**
 * Годится ли набранное как граница и в каком виде оно идёт в `Range`.
 * Пусто и обрезки — `null` (границы нет; `RangeEditor` пишет `''` для «с» и
 * `null` для «до», как и раньше).
 *
 * «24:00» переводится в «00:00» — представление конца суток, которое `Range`
 * уже использует (правило I1: `rangeToWindow` делает из «00:00 в "до"»
 * `END_OF_DAY`). Так оба написания дают один итог и одну подпись «до конца
 * дня», а правило «что значит конец» остаётся в `rangeToWindow`, не здесь.
 * Началом интервала конец суток быть не может — для «с» это отказ.
 */
export function parseClockInput(text: string, bound: ClockBound): string | null {
  if (text === '') return null
  if (text === END_OF_DAY) return bound === 'to' ? '00:00' : null
  return isClock(text) ? text : null
}

/**
 * Что достраивать при уходе из поля: только часы без минут («9», «09»,
 * «09:») → «09:00», и только если это часы (00–23). Всё остальное — как есть:
 * «09:3» может значить и 09:03, и 09:30, а «25» — не время; догадка здесь
 * была бы ложью в данных.
 */
export function completeClockInput(text: string): string {
  const match = /^(\d{1,2}):?$/.exec(text)
  if (!match) return text
  // match[1] is the regex's only capturing group, not optional: a
  // successful match always populates it.
  const hours = match[1]!.padStart(2, '0')
  return Number(hours) <= 23 ? `${hours}:00` : text
}
