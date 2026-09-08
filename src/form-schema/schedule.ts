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
 * ловит `weekHoursComplete` (Task 3), то есть отправка, а не сохранение. Но
 * `from` у недописанного интервала есть всегда, и по нему интервал наравне
 * с завершёнными проверяется и на порядок, и на пересечение с предыдущим —
 * ждать конца, чтобы заметить, что начало уже залезло в чужой интервал,
 * не нужно. Отложен только сам пропущенный `to`.
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
    if (previousEnd > start) return 'overlap'
    if (to !== null) {
      const end = clockMinutes(to)
      if (end <= start) return 'order'
      previousEnd = end
    }
    previousStart = start
  }
  return null
}

/** С какого времени начинать СЛЕДУЮЩИЙ интервал дня. Не фиксированные 09:00:
 *  у дня 01:00–11:00 такой интервал встал бы внутрь предыдущего, значение
 *  оказалось бы негодным по форме, а редактор прячет негодный день — оператор
 *  увидел бы, как день исчезает вместо новой строки. Берём конец последнего
 *  интервала (у недописанного — его начало), а у пустого списка — 09:00 как
 *  разумное начало рабочего дня. */
export function nextWindowStart(windows: Window[]): string | null {
  if (windows.length === 0) return '09:00'
  const last = windows[windows.length - 1]!
  const start = last.to ?? last.from
  if (start === END_OF_DAY) return null
  return start
}

export type DayHoursProblem = 'shape' | 'kind' | 'allDayNotAllowed' | Exclude<WindowsProblem, null> | null

/** Что не так с ОДНИМ днём, или `null`. Отдельно от недели, потому что у
 *  редактора и у ворот разные вопросы: воротам достаточно узнать, что неделя
 *  негодна, а редактору нужно показать шесть хороших дней и не выдать
 *  седьмой за пустоту. */
export function dayHoursProblem(hours: unknown, options: HoursOptions): DayHoursProblem {
  if (!isPlainObject(hours)) return 'shape'
  const kind = (hours as { kind?: unknown }).kind
  if (kind === 'allDay') return options.allDay ? null : 'allDayNotAllowed'
  if (kind === 'none') return null
  if (kind !== 'windows') return 'kind'
  return windowsProblem((hours as { windows?: unknown }).windows)
}

export type WeekHoursProblem = 'shape' | 'day' | DayHoursProblem

/** Что не так со недельной сеткой, или `null`. Отсутствующий день — «не
 *  отвечено»: это законное состояние черновика, полноту считает
 *  `weekHoursComplete` (Task 3). Правило одного дня живёт в `dayHoursProblem`
 *  — здесь только перебор ключей недели и её собственные вопросы (форма
 *  значения целиком, неизвестный день недели). */
export function weekHoursProblem(value: unknown, options: HoursOptions): WeekHoursProblem {
  if (!isPlainObject(value)) return 'shape'

  for (const [day, hours] of Object.entries(value)) {
    if (!(WEEKDAYS as readonly string[]).includes(day)) return 'day'
    const problem = dayHoursProblem(hours, options)
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

export const WEEKDAY_WORKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri']
export const WEEKDAY_WEEKEND: readonly Weekday[] = ['sat', 'sun']

/** Все интервалы дописаны (`to` задан). Незаполненность — вопрос полноты
 *  анкеты, не формы значения; см. `windowsProblem`. */
export function windowsFinished(windows: Window[]): boolean {
  return windows.every((window) => window.to !== null)
}

function dayFinished(hours: DayHours): boolean {
  return hours.kind === 'windows' ? windowsFinished(hours.windows) : true
}

function dayHasHours(hours: DayHours): boolean {
  return hours.kind === 'allDay' || (hours.kind === 'windows' && hours.windows.length > 0)
}

/**
 * Недельная сетка заполнена: значение корректно по форме, отвечены все семь
 * дней, все интервалы дописаны и хотя бы один день несёт часы. Последнее
 * условие — не придирка: у часов работы неделя из семи «закрыто» означала бы
 * лаунж, который не работает никогда, а у пиковых часов и уборки — что
 * оператор прошёл сетку, ничего не сказав.
 */
export function weekHoursComplete(value: unknown, options: HoursOptions): boolean {
  if (weekHoursProblem(value, options) !== null) return false
  const week = value as WeekHours
  const days = WEEKDAYS.map((day) => week[day])
  if (days.some((hours) => hours === undefined)) return false
  const present = days as DayHours[]
  return present.every(dayFinished) && present.some(dayHasHours)
}

/** График уборки заполнен: корректен по форме, интервалы дописаны, и есть
 *  хотя бы один интервал (у еженедельной — хотя бы один день с интервалами). */
export function cleaningComplete(value: unknown): boolean {
  if (cleaningProblem(value) !== null) return false
  const schedule = value as CleaningSchedule
  if (schedule.cadence === 'weekly') return weekHoursComplete(schedule.days, CLEANING_DAY_OPTIONS)
  return schedule.windows.length > 0 && windowsFinished(schedule.windows)
}

/** Годится ли день как ИСТОЧНИК копирования: он отвечен и несёт ответ. День в
 *  состоянии «по часам» с пустым списком интервалов не несёт ничего (и сервер
 *  такой день отвергает — `windowsProblem` → 'empty'), поэтому копировать его
 *  на другие дни значило бы стереть их ответы. Одно правило на два потребителя:
 *  `spread` ниже и выключенность кнопок в `WeekHoursEditor`. */
export function dayCopyable(hours: DayHours | undefined): boolean {
  if (!hours) return false
  return hours.kind !== 'windows' || hours.windows.length > 0
}

function spread(week: WeekHours, from: Weekday, targets: readonly Weekday[]): WeekHours {
  const source = week[from]
  // Копировать нечего — неделя возвращается как есть, а не затирается
  // пустотой: кнопка быстрого действия не должна уметь стереть введённое.
  if (!dayCopyable(source)) return week
  const out: WeekHours = { ...week }
  for (const day of targets) out[day] = source
  return out
}

/** «Одинаково всю неделю»: день-источник (в интерфейсе — понедельник) едет во
 *  все семь. Новый объект, источник не мутируется — результат кладут в
 *  состояние React, а мутация не вызвала бы перерисовку. */
export function applyToAll(week: WeekHours, from: Weekday): WeekHours {
  return spread(week, from, WEEKDAYS)
}

export function applyToWeekdays(week: WeekHours, from: Weekday): WeekHours {
  return spread(week, from, WEEKDAY_WORKDAYS)
}

export function applyToWeekend(week: WeekHours, from: Weekday): WeekHours {
  return spread(week, from, WEEKDAY_WEEKEND)
}

/** «Как в предыдущем дне»: сосед слева по `WEEKDAYS`. У понедельника соседа
 *  нет, а неотвеченный сосед копировать нечего — в обоих случаях неделя не
 *  меняется (кнопка в интерфейсе в это время выключена, но правило живёт
 *  здесь, а не в компоненте). */
export function copyPreviousDay(week: WeekHours, day: Weekday): WeekHours {
  const index = WEEKDAYS.indexOf(day)
  if (index <= 0) return week
  return spread(week, WEEKDAYS[index - 1]!, [day])
}

const DAY_SHORT: Record<Weekday, Localized> = {
  mon: { en: 'Mon', ru: 'Пн' }, tue: { en: 'Tue', ru: 'Вт' }, wed: { en: 'Wed', ru: 'Ср' },
  thu: { en: 'Thu', ru: 'Чт' }, fri: { en: 'Fri', ru: 'Пт' }, sat: { en: 'Sat', ru: 'Сб' },
  sun: { en: 'Sun', ru: 'Вс' },
}

const DAY_FULL: Record<Weekday, Localized> = {
  mon: { en: 'Monday', ru: 'понедельник' }, tue: { en: 'Tuesday', ru: 'вторник' },
  wed: { en: 'Wednesday', ru: 'среда' }, thu: { en: 'Thursday', ru: 'четверг' },
  fri: { en: 'Friday', ru: 'пятница' }, sat: { en: 'Saturday', ru: 'суббота' },
  sun: { en: 'Sunday', ru: 'воскресенье' },
}

const ALL_DAY_LABEL: Localized = { en: '24h', ru: 'Круглосуточно' }
const UNANSWERED = '—'

const CADENCE_LABEL: Record<Cadence, Localized> = {
  daily: { en: 'Daily', ru: 'Ежедневно' },
  weekly: { en: 'Weekly', ru: 'Еженедельно' },
  monthly: { en: 'Monthly', ru: 'Ежемесячно' },
  quarterly: { en: 'Quarterly', ru: 'Ежеквартально' },
}

const NTH_LABEL: Record<string, Localized> = {
  '1': { en: '1st', ru: '1-й' }, '2': { en: '2nd', ru: '2-й' }, '3': { en: '3rd', ru: '3-й' },
  '4': { en: '4th', ru: '4-й' }, last: { en: 'last', ru: 'последнее' },
}

/** Один интервал; недописанный печатается с многоточием — читатель видит, что
 *  ответ начат и не закончен, а не что конец совпал с началом. */
function formatWindow(window: Window): string {
  return `${window.from}–${window.to ?? '…'}`
}

export function formatWindows(windows: Window[]): string {
  return windows.map(formatWindow).join(', ')
}

export function formatDayHours(
  hours: DayHours | undefined,
  options: HoursOptions,
  locale: 'en' | 'ru',
): string {
  if (!hours) return UNANSWERED
  if (hours.kind === 'allDay') return ALL_DAY_LABEL[locale]
  if (hours.kind === 'none') return options.noneLabel[locale]
  return formatWindows(hours.windows)
}

/** Соседние дни с одинаковым текстом сливаются в отрезок: «Mon–Sat 09:00–18:00»
 *  вместо шести строк. Сравниваются именно ТЕКСТЫ дней, а не структуры: два дня,
 *  которые читаются одинаково, для читателя и есть одно и то же. */
function compressDays(texts: Record<Weekday, string>, locale: 'en' | 'ru'): string {
  const parts: string[] = []
  let start = 0
  for (let index = 1; index <= WEEKDAYS.length; index += 1) {
    const same = index < WEEKDAYS.length && texts[WEEKDAYS[index]!] === texts[WEEKDAYS[start]!]
    if (same) continue
    const first = DAY_SHORT[WEEKDAYS[start]!][locale]
    const last = DAY_SHORT[WEEKDAYS[index - 1]!][locale]
    const span = index - start === 1 ? first : `${first}–${last}`
    parts.push(`${span} ${texts[WEEKDAYS[start]!]}`)
    start = index
  }
  return parts.join('; ')
}

function isLegacyText(value: unknown): value is string {
  return typeof value === 'string'
}

export function formatWeekHours(
  value: unknown,
  options: HoursOptions,
  locale: 'en' | 'ru',
): string {
  // Старый свободный текст печатается дословно: он остаётся ответом, пока
  // оператор не введёт структуру (см. spec, «старые текстовые ответы»).
  if (isLegacyText(value)) return value
  if (weekHoursProblem(value, options) !== null) return String(value ?? '')

  const week = value as WeekHours
  const texts = Object.fromEntries(
    WEEKDAYS.map((day) => [day, formatDayHours(week[day], options, locale)]),
  ) as Record<Weekday, string>
  return compressDays(texts, locale)
}

export function formatCleaning(value: unknown, locale: 'en' | 'ru'): string {
  if (isLegacyText(value)) return value
  if (cleaningProblem(value) !== null) return String(value ?? '')

  const schedule = value as CleaningSchedule
  const cadence = CADENCE_LABEL[schedule.cadence][locale]

  if (schedule.cadence === 'weekly') {
    return `${cadence}: ${formatWeekHours(schedule.days, CLEANING_DAY_OPTIONS, locale)}`
  }
  if (schedule.cadence === 'daily') {
    return `${cadence} ${formatWindows(schedule.windows)}`
  }
  const nth = NTH_LABEL[String(schedule.nth)]![locale]
  const day = DAY_FULL[schedule.weekday][locale]
  return `${cadence}, ${nth} ${day} ${formatWindows(schedule.windows)}`
}

/**
 * Ячейки выгрузки для недельных часов: своя колонка на каждый день плюс
 * `free` для старого свободного текста. Ячейка дня — текст БЕЗ имени дня (имя
 * несёт заголовок колонки) и БЕЗ прочерка: пустая ячейка файла и значит «не
 * отвечено», а «—» получатель принял бы за значение. Язык — английский, как у
 * всей выгрузки (`rows.ts` печатает `locale: 'en'`).
 */
export function weekHoursCells(
  value: unknown,
  options: HoursOptions,
): Record<Weekday | 'free', string | null> {
  const empty = Object.fromEntries(WEEKDAYS.map((day) => [day, null])) as Record<Weekday, string | null>

  if (isLegacyText(value)) return { ...empty, free: value }
  if (weekHoursProblem(value, options) !== null) return { ...empty, free: null }

  const week = value as WeekHours
  const cells = Object.fromEntries(
    WEEKDAYS.map((day) => [day, week[day] ? formatDayHours(week[day], options, 'en') : null]),
  ) as Record<Weekday, string | null>
  return { ...cells, free: null }
}

/** Ячейки выгрузки графика уборки: периодичность, семь дней, свободный текст.
 *  Ежедневная заполняет все семь дней (это и значит «каждый день»), месячная и
 *  квартальная — только колонку своего дня недели, а `Cadence` при них несёт и
 *  порядковый номер («Monthly, 1st»), которому иначе негде появиться. */
export function cleaningCells(
  value: unknown,
): Record<Weekday | 'cadence' | 'free', string | null> {
  const empty = Object.fromEntries(WEEKDAYS.map((day) => [day, null])) as Record<Weekday, string | null>

  if (isLegacyText(value)) return { ...empty, cadence: null, free: value }
  if (cleaningProblem(value) !== null) return { ...empty, cadence: null, free: null }

  const schedule = value as CleaningSchedule

  if (schedule.cadence === 'weekly') {
    const days = weekHoursCells(schedule.days, CLEANING_DAY_OPTIONS)
    const { free: _free, ...perDay } = days
    return { ...perDay, cadence: CADENCE_LABEL.weekly.en, free: null }
  }

  const text = formatWindows(schedule.windows)
  if (schedule.cadence === 'daily') {
    const cells = Object.fromEntries(WEEKDAYS.map((day) => [day, text])) as Record<Weekday, string | null>
    return { ...cells, cadence: CADENCE_LABEL.daily.en, free: null }
  }

  return {
    ...empty,
    [schedule.weekday]: text,
    cadence: `${CADENCE_LABEL[schedule.cadence].en}, ${NTH_LABEL[String(schedule.nth)]!.en}`,
    free: null,
  }
}

/**
 * Смена периодичности уборки. Интервалы переносятся между `daily`, `monthly` и
 * `quarterly` — там это один список на весь график; в `weekly` они привязаны к
 * дням, поэтому при переходе в неё и из неё список начинается пустым (склеивать
 * «интервалы вообще» с «интервалами вторника» значило бы придумывать за
 * оператора). `nth`/`weekday` при переходе daily → monthly берут первый
 * понедельник как отправную точку, которую видно и легко поменять.
 */
export function switchCadence(current: CleaningSchedule | null, cadence: Cadence): CleaningSchedule {
  const carried = current && current.cadence !== 'weekly' ? current.windows : []

  if (cadence === 'daily') return { cadence, windows: carried }
  if (cadence === 'weekly') return { cadence, days: {} }

  const nth = current && (current.cadence === 'monthly' || current.cadence === 'quarterly') ? current.nth : 1
  const weekday =
    current && (current.cadence === 'monthly' || current.cadence === 'quarterly') ? current.weekday : 'mon'
  return { cadence, nth, weekday, windows: carried }
}
