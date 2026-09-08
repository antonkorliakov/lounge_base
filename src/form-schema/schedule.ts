/**
 * Правила расписаний — недельных часов (`weekHours`: III.1.1 часы работы,
 * III.1.3 пиковые часы) и графика уборки (`cleaningSchedule`: III.1.4).
 * Живут здесь, в чистой части схемы, потому что их читают трое: редакторы в
 * браузере (какие состояния и кнопки показывать, что делают быстрые
 * действия), серверная проверка в `validation.ts` (что можно сохранить и
 * что считается заполненным) и выгрузка (`export/columns.ts`, `rows.ts` —
 * ячейка на день недели). Три копии правил разошлись бы: браузер собрал бы
 * значение, которое сервер не принимает, или файл напечатал бы день, которого
 * в структуре нет.
 *
 * Ночные интервалы через полночь не поддерживаются СОЗНАТЕЛЬНО (решение
 * пользователя): «22:00–02:00» вводится как «22:00–24:00» сегодня и
 * «00:00–02:00» завтра. Поэтому конец интервала всегда больше начала, и
 * сравнение границ — обычное сравнение минут от полуночи, без ветки «а вдруг
 * это следующий день».
 */
import type { Localized } from './types'

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Weekday = (typeof WEEKDAYS)[number]

export const NTHS = [1, 2, 3, 4, 'last'] as const
export type Nth = (typeof NTHS)[number]

export const CADENCES = ['daily', 'weekly', 'monthly', 'quarterly'] as const
export type Cadence = (typeof CADENCES)[number]

/** Конец суток. `<input type="time">` такого значения не принимает, поэтому в
 *  редакторе он ставится кнопкой «до конца дня» (см. `WindowsEditor`), а здесь
 *  он законное значение `to` — иначе «работаем до полуночи» пришлось бы писать
 *  как 23:59 и терять минуту. */
export const END_OF_DAY = '24:00'

export type Window = { from: string; to: string | null }

export type DayHours =
  | { kind: 'allDay' }
  | { kind: 'none' }
  | { kind: 'windows'; windows: Window[] }

export type WeekHours = Partial<Record<Weekday, DayHours>>

export type HoursOptions = {
  /** Есть ли у дня состояние «круглосуточно». У часов работы есть, у пиковых
   *  часов и у еженедельной уборки — нет: «пик круглые сутки» и «уборка
   *  круглые сутки» это не ответы, а недоразумение. */
  allDay: boolean
  /** Подпись пустого состояния дня: «Closed» у часов работы, «No peak» у
   *  пиковых. Одно и то же состояние (`kind: 'none'`) читается по-разному в
   *  зависимости от вопроса, поэтому подпись живёт у поля, а не в структуре. */
  noneLabel: Localized
}

export type CleaningSchedule =
  | { cadence: 'daily'; windows: Window[] }
  | { cadence: 'weekly'; days: WeekHours }
  | { cadence: 'monthly' | 'quarterly'; nth: Nth; weekday: Weekday; windows: Window[] }

/** Дни еженедельной уборки — та же недельная сетка, что у часов, но без
 *  «круглосуточно» и с подписью «без уборки». */
export const CLEANING_DAY_OPTIONS: HoursOptions = {
  allDay: false,
  noneLabel: { en: 'No cleaning', ru: 'Без уборки' },
}

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/

export function isClock(value: unknown): value is string {
  if (typeof value !== 'string') return false
  return value === END_OF_DAY || CLOCK.test(value)
}

/** Минуты от полуночи: 0..1440 (1440 — только `END_OF_DAY`). Единственный
 *  способ сравнивать границы — строки сравнивать нельзя даже при нулевом
 *  паддинге, потому что '24:00' лексикографически меньше '3:00' был бы
 *  верным лишь случайно. */
export function clockMinutes(clock: string): number {
  if (clock === END_OF_DAY) return 24 * 60
  const [hours, minutes] = clock.split(':')
  return Number(hours) * 60 + Number(minutes)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type WindowsProblem = 'shape' | 'clock' | 'order' | 'overlap' | 'empty' | null

/**
 * Что не так со списком интервалов одного дня, или `null`, если всё в порядке.
 * Пустой список — `empty`: день с состоянием «по часам» и без интервалов не
 * значит ничего, для «не работаем» есть `kind: 'none'`.
 *
 * Недописанный интервал (`to: null`) формой НЕ нарушен: оператор только что
 * нажал «+ интервал», отказ на этом месте уносил бы черновик. Незаполненность
 * ловит `weekHoursComplete` (Task 3), то есть отправка, а не сохранение.
 * Порядок при этом проверяется по `from`, который есть всегда.
 */
export function windowsProblem(value: unknown): WindowsProblem {
  if (!Array.isArray(value)) return 'shape'
  if (value.length === 0) return 'empty'

  let previousEnd = -1
  let previousStart = -1
  for (const window of value) {
    if (!isPlainObject(window) || !('from' in window) || !('to' in window)) return 'shape'
    const { from, to } = window as { from: unknown; to: unknown }
    // `from` не может быть концом суток: интервал, начинающийся в 24:00, пуст.
    if (!isClock(from) || from === END_OF_DAY) return 'clock'
    if (to !== null && !isClock(to)) return 'clock'

    const start = clockMinutes(from)
    if (start <= previousStart) return 'order'
    if (to !== null) {
      const end = clockMinutes(to)
      if (end <= start) return 'order'
      if (previousEnd > start) return 'overlap'
      previousEnd = end
    }
    previousStart = start
  }
  return null
}

export type WeekHoursProblem =
  | 'shape'
  | 'day'
  | 'kind'
  | 'allDayNotAllowed'
  | Exclude<WindowsProblem, null>
  | null

/** Что не так со недельной сеткой, или `null`. Отсутствующий день — «не
 *  отвечено»: это законное состояние черновика, полноту считает
 *  `weekHoursComplete` (Task 3). */
export function weekHoursProblem(value: unknown, options: HoursOptions): WeekHoursProblem {
  if (!isPlainObject(value)) return 'shape'

  for (const [day, hours] of Object.entries(value)) {
    if (!(WEEKDAYS as readonly string[]).includes(day)) return 'day'
    if (!isPlainObject(hours)) return 'shape'
    const kind = (hours as { kind?: unknown }).kind
    if (kind === 'allDay') {
      if (!options.allDay) return 'allDayNotAllowed'
      continue
    }
    if (kind === 'none') continue
    if (kind !== 'windows') return 'kind'
    const problem = windowsProblem((hours as { windows?: unknown }).windows)
    if (problem) return problem
  }
  return null
}

export type CleaningProblem = 'cadence' | 'nth' | WeekHoursProblem

/** Что не так с графиком уборки, или `null`. */
export function cleaningProblem(value: unknown): CleaningProblem {
  if (!isPlainObject(value)) return 'shape'
  const cadence = value.cadence
  if (typeof cadence !== 'string' || !(CADENCES as readonly string[]).includes(cadence)) {
    return 'cadence'
  }

  if (cadence === 'weekly') return weekHoursProblem(value.days, CLEANING_DAY_OPTIONS)

  if (cadence === 'monthly' || cadence === 'quarterly') {
    if (!(NTHS as readonly unknown[]).includes(value.nth)) return 'nth'
    if (typeof value.weekday !== 'string' || !(WEEKDAYS as readonly string[]).includes(value.weekday)) {
      return 'day'
    }
  }
  return windowsProblem(value.windows)
}
