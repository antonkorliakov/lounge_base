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

/** Границы интервала, которые не время: «с первого рейса», «до последнего
 *  рейса». Хранятся строками рядом с часами, потому что это ответ на тот же
 *  вопрос («когда открыто»), только без цифр: у маленького аэропорта лаунж
 *  живёт по расписанию рейсов, и заставлять оператора выдумывать время — ложь
 *  в данных. Разрешены только там, где `HoursOptions.flightBounds`. */
export const FIRST_FLIGHT = 'firstFlight'
export const LAST_FLIGHT = 'lastFlight'

export type HoursOptions = {
  /** Есть ли у дня состояние «круглосуточно». У часов работы есть, у пиковых
   *  часов и у еженедельной уборки — нет: «пик круглые сутки» и «уборка
   *  круглые сутки» это не ответы, а недоразумение. */
  allDay: boolean
  /** Можно ли вместо времени поставить «первый рейс» / «последний рейс». Только
   *  у часов работы: пик «с первого рейса» и уборка «до последнего рейса» —
   *  не ответы. */
  flightBounds: boolean
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
  flightBounds: false,
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

/** Годится ли значение как НАЧАЛО интервала: время (не конец суток) или «первый рейс». */
export function isStartBound(value: unknown): boolean {
  return value === FIRST_FLIGHT || (isClock(value) && value !== END_OF_DAY)
}

/** Годится ли значение как КОНЕЦ интервала: время (включая 24:00) или «последний рейс». */
export function isEndBound(value: unknown): boolean {
  return value === LAST_FLIGHT || isClock(value)
}

export function hasMarker(window: Window): boolean {
  return window.from === FIRST_FLIGHT || window.to === LAST_FLIGHT
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
    if (!isStartBound(from)) return 'clock'
    if (to !== null && !isEndBound(to)) return 'clock'

    // Интервал с маркером не сравним по времени ни с чем — он единственный
    // в дне. Второй рядом с ним (до или после) — отказ порядка.
    const marker = from === FIRST_FLIGHT || to === LAST_FLIGHT
    if (marker && value.length > 1) return 'order'
    if (marker) return null

    const start = clockMinutes(from as string)
    if (start <= previousStart) return 'order'
    if (previousEnd > start) return 'overlap'
    if (to !== null) {
      // За этой строкой `to` не может быть `LAST_FLIGHT`: такой интервал —
      // маркерный, и ветка `if (marker) return null` выше уже вернула бы
      // раньше, чем выполнение дошло сюда.
      const end = clockMinutes(to as string)
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
 *  интервала, а у пустого списка — 09:00 как разумное начало рабочего дня.
 *  Если последний интервал ещё не закрыт (`to: null`), начинать следующий
 *  неоткуда — предложенное время совпало бы с `from` этого же интервала, и
 *  `windowsProblem` тут же отверг бы список правилом order; возвращаем
 *  `null`, и кнопка «+ интервал» остаётся выключена, пока оператор не
 *  проставит конец текущему интервалу. */
export function nextWindowStart(windows: Window[]): string | null {
  if (windows.length === 0) return '09:00'
  const last = windows[windows.length - 1]!
  // Интервал с маркером — единственный в дне (`windowsProblem`), достраивать
  // рядом с ним нечего.
  if (hasMarker(last)) return null
  if (last.to === null) return null
  if (last.to === END_OF_DAY) return null
  return last.to
}

export type NextWindowBlockedReason = 'unfinished' | 'full' | null

/**
 * Почему `nextWindowStart` вернула `null` — компаньон, а не замена: правило
 * «когда именно нельзя предложить следующий интервал» по-прежнему целиком
 * живёт в `nextWindowStart` (эта функция его не повторяет и не проверяет
 * заново — просто смотрит на тот же последний интервал и называет причину).
 * Нужен `WindowsEditor`, чтобы показать читателю, ПОЧЕМУ «+ интервал»
 * недоступна (Important 1, сквозное ревью): `nextWindowStart` одного `null`
 * для этого мало — у него две разные причины, и обе значат разное действие
 * оператора: `'unfinished'` — сперва закончить текущий интервал (проставить
 * ему конец), `'full'` — день уже занят до конца суток, добавлять некуда.
 */
export function nextWindowBlockedReason(windows: Window[]): NextWindowBlockedReason {
  if (windows.length === 0) return null
  const last = windows[windows.length - 1]!
  // Функция удаляется в Task 5 вместе с `WindowsEditor`; маркерный интервал
  // трактуется как «занято до конца» — второй причины (`'unfinished'`) у
  // него нет, `to` маркера либо задан, либо это тот же случай, что и обычного
  // недописанного интервала.
  if (hasMarker(last)) return 'full'
  if (last.to === null) return 'unfinished'
  if (last.to === END_OF_DAY) return 'full'
  return null
}

export type DayHoursProblem = 'shape' | 'kind' | 'allDayNotAllowed' | 'flightNotAllowed' | Exclude<WindowsProblem, null> | null

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
  const windows = (hours as { windows?: unknown }).windows
  const problem = windowsProblem(windows)
  if (problem) return problem
  if (!options.flightBounds && (windows as Window[]).some(hasMarker)) return 'flightNotAllowed'
  return null
}

/**
 * Может ли редактор нарисовать день с таким изъяном, или ему честнее исчезнуть
 * («не отвечено»). Это НЕ то же самое, что «можно сохранить» —
 * `weekHoursProblem`/`dayHoursProblem` уже решают это для сервера, и
 * `dayRenderable` их не заменяет, а добавляет второй, более узкий вопрос:
 * можно ли БЕЗОПАСНО прочитать `hours.kind`/`hours.windows`, чтобы нарисовать
 * кнопки и поля времени.
 *
 * `'shape'` и `'kind'` — нет: значение не разобрать (не объект, `windows` не
 * массив, элемент списка без `from`/`to`) или вид дня неизвестен, и попытка
 * всё равно отрисовать интервалы обычно кончается чтением поля не с того
 * типа. `'clock'`, `'order'`, `'overlap'`, `'empty'`, `'allDayNotAllowed'` —
 * да: день по-прежнему `{ kind, windows: Window[] }` пусть и с неверными
 * временами или недопустимым `allDay`, редактор читает его как обычно и
 * просто рисует то, что там есть, а отказ на сохранение (если он будет)
 * покажет `validateField`.
 *
 * Обычное редактирование ПРОХОДИТ через эти негодные-по-форме, но рисуемые
 * состояния постоянно: конец интервала правится раньше начала на полпути
 * ввода, соседний интервал на секунду наезжает на предыдущий — `onChange`
 * стреляет на каждое нажатие клавиши, и значение в это мгновение уже лежит
 * в состоянии React. Раньше `asWeek` держала только `null`/`'empty'`, и
 * любое из этих мимолётных состояний роняло день целиком: поля пропадали,
 * фокус терялся, кнопки состояния гасли — а следующий клик оператора сохранял
 * эту пропажу как «Сохранено».
 */
export function dayRenderable(problem: DayHoursProblem): boolean {
  return problem !== 'shape' && problem !== 'kind'
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

const UNRENDERABLE_SCHEDULE_TAGS: ReadonlySet<CleaningProblem> = new Set(['shape', 'cadence', 'nth', 'day'])

/**
 * Тот же вопрос, что `dayRenderable`, но для графика уборки целиком: можно ли
 * прочитать `cadence`/`nth`/`weekday`/`windows`/`days`, чтобы нарисовать
 * кнопки периодичности и вложенный редактор — или значению честнее считаться
 * нечитаемым (старым текстом/`null`, если он есть, иначе четыре ненажатые
 * кнопки).
 *
 * Негодно: `'shape'` (значение не объект), `'cadence'` (периодичность не одна
 * из четырёх — рисовать нажатой нечего), `'nth'`/`'day'` (у monthly/quarterly
 * порядковый номер или день недели не разобрать — `<select>` получит значение,
 * которого нет среди его `<option>`). Годно: `null`, `'empty'` (уже
 * обжитое первое состояние периодичности) и все теги одного дня —
 * `'kind'`, `'allDayNotAllowed'`, `'clock'`, `'order'`, `'overlap'` — они
 * приходят с ОДНОГО испорченного дня еженедельной уборки (`weekHoursProblem`
 * возвращает тег этого дня как есть) и не должны гасить остальные шесть дней
 * и кнопки периодичности: `WeekHoursEditor`'s `asWeek` сама разберётся с этим
 * днём через `dayRenderable`, как только доберётся до него.
 *
 * Раньше `CleaningScheduleEditor`'s `asSchedule` держала только `null`/
 * `'empty'` и на любом из этих тегов возвращала `schedule: null` — то есть
 * не только гасила один плохой день еженедельной уборки вместе со всей
 * неделей, но и роняла daily/monthly/quarterly целиком на том же
 * пересечении/недописанном интервале, на который `dayRenderable` для
 * обычных недельных часов уже отвечает «рисуй».
 */
export function scheduleRenderable(problem: CleaningProblem): boolean {
  return problem === null || !UNRENDERABLE_SCHEDULE_TAGS.has(problem)
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

const BOUND_WORD: Record<'en' | 'ru', { first: string; last: string }> = {
  en: { first: 'first flight', last: 'last flight' },
  ru: { first: 'первого рейса', last: 'последнего рейса' },
}

/** Один интервал; недописанный печатается с многоточием — читатель видит, что
 *  ответ начат и не закончен, а не что конец совпал с началом.
 *
 *  Пригодность к показу и пригодность к печати — разные вопросы: редактор
 *  нарочно продолжает показывать интервал с негодным временем (иначе день
 *  исчезал бы под курсором), а печать такого значения не имеет права выдать
 *  читателю внутреннее представление.
 *
 *  Маркер печатается словом, а не временем — «первый рейс» вместо часов,
 *  которых у оператора нет. По-русски граница с маркером требует предлогов
 *  («с первого рейса до 23:00»): голое тире перед словом читалось бы как
 *  вычитание, а не интервал. По-английски тире читается и с ними, отдельная
 *  ветка не нужна. */
function formatWindow(window: Window, locale: 'en' | 'ru'): string {
  const marker = hasMarker(window)
  const from = window.from === FIRST_FLIGHT ? BOUND_WORD[locale].first : isClock(window.from) ? window.from : UNANSWERED
  const to =
    window.to === null ? '…'
    : window.to === LAST_FLIGHT ? (locale === 'ru' && window.from === FIRST_FLIGHT ? 'последнего' : BOUND_WORD[locale].last)
    : isClock(window.to) ? window.to : UNANSWERED
  if (marker && locale === 'ru') return `с ${from} до ${to}`
  return `${from}–${to}`
}

export function formatWindows(windows: Window[], locale: 'en' | 'ru'): string {
  return windows.map((window) => formatWindow(window, locale)).join(', ')
}

export function formatDayHours(
  hours: DayHours | undefined,
  options: HoursOptions,
  locale: 'en' | 'ru',
): string {
  if (!hours) return UNANSWERED
  if (hours.kind === 'allDay') return ALL_DAY_LABEL[locale]
  if (hours.kind === 'none') return options.noneLabel[locale]
  return formatWindows(hours.windows, locale)
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

/**
 * Канонический текст недели. Деградирует ПО ДНЮ, той же мерой, что `asWeek` в
 * `WeekHoursEditor.tsx` (`dayRenderable`) — не всем текстом разом (Important
 * 2, сквозное ревью). Раньше единственной проверкой формы был
 * `weekHoursProblem(value, options) !== null` для ВСЕЙ недели, и он срабатывал
 * от одного плохого дня — `weekHoursProblem` возвращает тег первого
 * встреченного нарушения как тег недели целиком (см. её комментарий), так что
 * шесть настоящих ответов пропадали вместе с седьмым, а строкой печати
 * оказывался `String(value ?? '')` — на плоском объекте буквально
 * «[object Object]», и это доезжало до ревьюера (`renderValues`) и до файла
 * выгрузки (`export/rows.ts`, `single.ts`) как есть.
 */
export function formatWeekHours(
  value: unknown,
  options: HoursOptions,
  locale: 'en' | 'ru',
): string {
  // Старый свободный текст печатается дословно: он остаётся ответом, пока
  // оператор не введёт структуру (см. spec, «старые текстовые ответы»).
  if (isLegacyText(value)) return value
  if (!isPlainObject(value)) return ''

  const week = value as WeekHours
  const texts = Object.fromEntries(
    WEEKDAYS.map((day) => {
      const hours = week[day]
      const text = dayRenderable(dayHoursProblem(hours, options))
        ? formatDayHours(hours, options, locale)
        : UNANSWERED
      return [day, text]
    }),
  ) as Record<Weekday, string>
  return compressDays(texts, locale)
}

/**
 * Канонический текст графика уборки — та же деградация: печатается всё, что
 * можно прочитать, вместо `String(значение)` целиком. Периодичность —
 * первый и самый дешёвый в проверке кусок формы, поэтому она печатается,
 * даже если дальше (интервалы, `nth`/`weekday`, один день еженедельной сетки)
 * разобрать нечего; полностью нечитаемое значение (периодичность неизвестна
 * или значение не объект) — пустая строка, а не порченный `String`.
 */
export function formatCleaning(value: unknown, locale: 'en' | 'ru'): string {
  if (isLegacyText(value)) return value
  if (!isPlainObject(value)) return ''

  const cadenceRaw = value.cadence
  if (typeof cadenceRaw !== 'string' || !(CADENCES as readonly string[]).includes(cadenceRaw)) {
    return ''
  }
  const cadence = cadenceRaw as Cadence
  const cadenceLabel = CADENCE_LABEL[cadence][locale]

  if (cadence === 'weekly') {
    return `${cadenceLabel}: ${formatWeekHours(value.days, CLEANING_DAY_OPTIONS, locale)}`
  }

  // `dayRenderable` берёт тот же список тегов, что и день недельной сетки:
  // `windowsProblem`'s теги ('shape'|'clock'|'order'|'overlap'|'empty'|null)
  // — подмножество `DayHoursProblem`, так что 'shape' (список интервалов не
  // разобрать) остаётся непечатаемым, а мимолётные 'clock'/'order'/'overlap'
  // и законное первое 'empty' печатаются как есть (пустой список → пустой
  // текст, ветки ниже сами решают, что показать без него).
  const windowsText = dayRenderable(windowsProblem(value.windows)) ? formatWindows(value.windows as Window[], locale) : ''

  if (cadence === 'daily') {
    return windowsText ? `${cadenceLabel} ${windowsText}` : cadenceLabel
  }

  const nthOk = (NTHS as readonly unknown[]).includes(value.nth)
  const weekdayOk = typeof value.weekday === 'string' && (WEEKDAYS as readonly string[]).includes(value.weekday)
  if (!nthOk || !weekdayOk) return cadenceLabel

  const nth = NTH_LABEL[String(value.nth)]![locale]
  const day = DAY_FULL[value.weekday as Weekday][locale]
  return windowsText ? `${cadenceLabel}, ${nth} ${day} ${windowsText}` : `${cadenceLabel}, ${nth} ${day}`
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
  if (!isPlainObject(value)) return { ...empty, free: null }

  // Деградация по дню (Important 2) — та же мера, что `formatWeekHours` выше:
  // хороший день печатает свою ячейку, нерисуемый или непришедший день —
  // пустая ячейка (то же «не отвечено», которое пустая ячейка файла и так
  // значит), а не все семь ячеек `null` из-за одного плохого дня.
  const week = value as WeekHours
  const cells = Object.fromEntries(
    WEEKDAYS.map((day) => {
      const hours = week[day]
      const text =
        hours !== undefined && dayRenderable(dayHoursProblem(hours, options))
          ? formatDayHours(hours, options, 'en')
          : null
      return [day, text]
    }),
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
  if (!isPlainObject(value)) return { ...empty, cadence: null, free: null }

  const cadenceRaw = value.cadence
  if (typeof cadenceRaw !== 'string' || !(CADENCES as readonly string[]).includes(cadenceRaw)) {
    return { ...empty, cadence: null, free: null }
  }
  const cadence = cadenceRaw as Cadence

  if (cadence === 'weekly') {
    const days = weekHoursCells(value.days, CLEANING_DAY_OPTIONS)
    const { free: _free, ...perDay } = days
    return { ...perDay, cadence: CADENCE_LABEL.weekly.en, free: null }
  }

  // Та же деградация, что в `formatCleaning`: интервалы нерисуемые по форме
  // ('shape') не печатаются вовсе, но периодичность (а у monthly/quarterly —
  // и колонка дня) остаётся видна.
  // Выгрузка всегда на английском (`rows.ts` печатает `locale: 'en'`), как и
  // соседняя `weekHoursCells` выше.
  const text = dayRenderable(windowsProblem(value.windows)) ? formatWindows(value.windows as Window[], 'en') : null

  if (cadence === 'daily') {
    const cells = Object.fromEntries(WEEKDAYS.map((day) => [day, text])) as Record<Weekday, string | null>
    return { ...cells, cadence: CADENCE_LABEL.daily.en, free: null }
  }

  const nthOk = (NTHS as readonly unknown[]).includes(value.nth)
  const weekdayOk = typeof value.weekday === 'string' && (WEEKDAYS as readonly string[]).includes(value.weekday)
  if (!nthOk || !weekdayOk) return { ...empty, cadence: CADENCE_LABEL[cadence].en, free: null }

  return {
    ...empty,
    [value.weekday as Weekday]: text,
    cadence: `${CADENCE_LABEL[cadence].en}, ${NTH_LABEL[String(value.nth)]!.en}`,
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
  // Кнопки периодичности не выключаются, когда их периодичность уже выбрана
  // (оператор может нажать «Weekly», уже стоя на ней) — выбор ТОЙ ЖЕ
  // периодичности обязан ничего не менять, для всех четырёх одинаково.
  // Раньше это было true только по совпадению для daily/monthly/quarterly
  // (интервалы переживают ветку «перенос интервалов» ниже, потому что несут
  // тот же список сами себе), а `weekly` собирала новое значение с нуля
  // (`{ cadence, days: {} }`) и стирала уже заполненную сетку — рабочий
  // повторный клик выглядел как порча данных с пометкой «Сохранено».
  if (current && current.cadence === cadence) return current

  const carried = current && current.cadence !== 'weekly' ? current.windows : []

  if (cadence === 'daily') return { cadence, windows: carried }
  if (cadence === 'weekly') return { cadence, days: {} }

  const nth = current && (current.cadence === 'monthly' || current.cadence === 'quarterly') ? current.nth : 1
  const weekday =
    current && (current.cadence === 'monthly' || current.cadence === 'quarterly') ? current.weekday : 'mon'
  return { cadence, nth, weekday, windows: carried }
}

/**
 * Правила — то, как оператор ДУМАЕТ о графике: «эти дни — такой режим».
 * Хранение остаётся по дням (`WeekHours`); правила — представление, которое
 * редактор показывает и через которое пишет. Две функции ниже переводят туда и
 * обратно, и их обратимость закреплена тестами на живых графиках лаунжей.
 *
 * `Range.from === ''` — время ещё не введено: такой диапазон в неделю не
 * ложится вовсе (день остаётся неотвеченным), потому что «правило без
 * времени» — нормальное состояние черновика на полпути, а не ошибка формы.
 */
export type Range = { from: string; to: string | null }
export type RuleHours = { kind: 'allDay' } | { kind: 'windows'; ranges: Range[] }
export type HoursRule = { days: Weekday[]; hours: RuleHours }

export function emptyRule(days: Weekday[]): HoursRule {
  return { days, hours: { kind: 'windows', ranges: [{ from: '', to: null }] } }
}

export function nextDay(day: Weekday): Weekday {
  return WEEKDAYS[(WEEKDAYS.indexOf(day) + 1) % 7]!
}
export function previousDay(day: Weekday): Weekday {
  return WEEKDAYS[(WEEKDAYS.indexOf(day) + 6) % 7]!
}

/** Ночной диапазон: оба конца — времена и конец меньше начала («02:00–01:00»). */
export function isNightRange(range: Range): boolean {
  return isClock(range.from) && range.to !== null && isClock(range.to) && clockMinutes(range.to) < clockMinutes(range.from)
}

function sortWindows(windows: Window[]): Window[] {
  return [...windows].sort((a, b) => {
    const start = (w: Window): number => (isClock(w.from) ? clockMinutes(w.from) : -1)
    return start(a) - start(b)
  })
}

/**
 * Правила → семь дней. Ночной диапазон делится по суткам: `from–24:00`
 * сегодня и `00:00–to` ЗАВТРА (после воскресенья — понедельник). Именно
 * завтра: «пн 02:00–01:00» — это закрытие во вторник в час ночи, и у лаунжа,
 * закрытого по пятницам, ночь четверга честно даёт пятнице `00:00–01:00`.
 * Дни без правила закрыты (`none`); дни в правиле без введённого времени —
 * неотвечены (в неделю не попадают). Повторы дня между правилами редактор не
 * допускает; для значения, пришедшего мимо него, побеждает последнее правило.
 */
export function expandRules(rules: HoursRule[]): WeekHours {
  const own: Partial<Record<Weekday, DayHours>> = {}
  const tails: Partial<Record<Weekday, Window[]>> = {}
  const covered = new Set<Weekday>()

  for (const rule of rules) {
    for (const day of rule.days) {
      covered.add(day)
      if (rule.hours.kind === 'allDay') { own[day] = { kind: 'allDay' }; continue }
      const windows: Window[] = []
      for (const range of rule.hours.ranges) {
        if (range.from === '') continue
        if (isNightRange(range)) {
          windows.push({ from: range.from, to: END_OF_DAY })
          ;(tails[nextDay(day)] ??= []).push({ from: '00:00', to: range.to })
        } else {
          windows.push({ from: range.from, to: range.to })
        }
      }
      if (windows.length > 0) own[day] = { kind: 'windows', windows }
      else delete own[day]
    }
  }

  const week: WeekHours = {}
  for (const day of WEEKDAYS) {
    const base = own[day]
    const tail = tails[day] ?? []
    if (base?.kind === 'windows') week[day] = { kind: 'windows', windows: sortWindows([...tail, ...base.windows]) }
    else if (base) week[day] = base
    else if (tail.length > 0) week[day] = { kind: 'windows', windows: sortWindows(tail) }
    else if (!covered.has(day)) week[day] = { kind: 'none' }
    // covered, но без времени — неотвечен: ключа нет.
  }
  return week
}

/**
 * Семь дней → правила. Сначала склейка ночи: интервал `00:00–X` дня D — хвост
 * интервала `Y–24:00` предыдущего дня, если такой есть; они становятся одним
 * ночным диапазоном `Y–X` у предыдущего дня. Полный день `00:00–24:00`
 * хвостом не считается. Потом дни с одинаковым набором диапазонов
 * объединяются в правило; порядок правил — по первому дню. Закрытые и
 * неотвеченные дни правил не образуют.
 */
export function collapseWeek(week: WeekHours): HoursRule[] {
  const ranges: Partial<Record<Weekday, Range[] | 'allDay'>> = {}
  for (const day of WEEKDAYS) {
    const hours = week[day]
    if (!hours || hours.kind === 'none') continue
    if (hours.kind === 'allDay') { ranges[day] = 'allDay'; continue }
    ranges[day] = hours.windows.map((w) => ({ from: w.from, to: w.to }))
  }

  for (const day of WEEKDAYS) {
    const list = ranges[day]
    if (!Array.isArray(list)) continue
    const tailIndex = list.findIndex((r) => r.from === '00:00' && r.to !== null && isClock(r.to) && r.to !== END_OF_DAY)
    if (tailIndex < 0) continue
    const prev = ranges[previousDay(day)]
    if (!Array.isArray(prev)) continue
    const headIndex = prev.findIndex((r) => r.to === END_OF_DAY && isClock(r.from))
    if (headIndex < 0) continue
    const tail = list[tailIndex]!
    prev[headIndex] = { from: prev[headIndex]!.from, to: tail.to }
    list.splice(tailIndex, 1)
    if (list.length === 0) delete ranges[day]
  }

  const rules: HoursRule[] = []
  for (const day of WEEKDAYS) {
    const value = ranges[day]
    if (value === undefined) continue
    const key = JSON.stringify(value)
    const existing = rules.find((r) => JSON.stringify(r.hours.kind === 'allDay' ? 'allDay' : r.hours.ranges) === key)
    if (existing) { existing.days.push(day); continue }
    rules.push({ days: [day], hours: value === 'allDay' ? { kind: 'allDay' } : { kind: 'windows', ranges: value } })
  }
  return rules
}

/** Нажатие дня в правиле `index`: если день там — снять; иначе — забрать у
 *  любого другого правила и добавить сюда. День принадлежит одному правилу.
 *  Новый массив, входной не мутируется — результат кладут в состояние React. */
export function toggleDay(rules: HoursRule[], index: number, day: Weekday): HoursRule[] {
  return rules.map((rule, i) => {
    const has = rule.days.includes(day)
    if (i === index) return { ...rule, days: has ? rule.days.filter((d) => d !== day) : sortDays([...rule.days, day]) }
    return has ? { ...rule, days: rule.days.filter((d) => d !== day) } : rule
  })
}

/** «Изменить» у дня в итоге: день уходит из своего правила в новое, пустое,
 *  в конец списка — оператор правит тот день, который в итоге не сошёлся. */
export function splitDay(rules: HoursRule[], day: Weekday): HoursRule[] {
  return [...rules.map((r) => ({ ...r, days: r.days.filter((d) => d !== day) })), emptyRule([day])]
}

function sortDays(days: Weekday[]): Weekday[] {
  return [...days].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b))
}
