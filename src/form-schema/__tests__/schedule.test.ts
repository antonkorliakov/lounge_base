import { describe, it, expect } from 'vitest'
import {
  WEEKDAYS,
  NTHS,
  CADENCES,
  END_OF_DAY,
  isClock,
  clockMinutes,
  windowsProblem,
  weekHoursProblem,
  cleaningProblem,
  CLEANING_DAY_OPTIONS,
  type HoursOptions,
  type WeekHours,
} from '../schedule'

const OPEN: HoursOptions = { allDay: true, noneLabel: { en: 'Closed', ru: 'Закрыто' } }
const PEAK: HoursOptions = { allDay: false, noneLabel: { en: 'No peak', ru: 'Нет пика' } }

type Weekday = (typeof WEEKDAYS)[number]

/** Полная неделя одним видом — короче, чем перечислять семь ключей в каждом тесте. */
function everyDay(day: WeekHours[Weekday]): WeekHours {
  return Object.fromEntries(WEEKDAYS.map((d) => [d, day])) as WeekHours
}

describe('константы порядка', () => {
  it('дни недели — понедельник первым, семь штук', () => {
    expect(WEEKDAYS).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
  })

  it('порядковые номера дня месяца и периодичности закреплены', () => {
    expect(NTHS).toEqual([1, 2, 3, 4, 'last'])
    expect(CADENCES).toEqual(['daily', 'weekly', 'monthly', 'quarterly'])
  })
})

describe('isClock и clockMinutes', () => {
  it.each(['00:00', '09:05', '23:59', '24:00'])('принимает %s', (v) => {
    expect(isClock(v)).toBe(true)
  })

  it.each(['9:05', '24:01', '25:00', '12:60', '12', '12:5', '', ' 12:00', '12:00 ', 900, null])(
    'отклоняет %s',
    (v) => {
      expect(isClock(v)).toBe(false)
    },
  )

  it('минуты от полуночи — то, по чему сравниваются границы', () => {
    expect(clockMinutes('00:00')).toBe(0)
    expect(clockMinutes('09:05')).toBe(545)
    expect(clockMinutes(END_OF_DAY)).toBe(1440)
  })
})

describe('windowsProblem — список интервалов одного дня', () => {
  it('корректный список: непересекающиеся по возрастанию, касание разрешено', () => {
    expect(windowsProblem([{ from: '01:00', to: '11:00' }, { from: '11:00', to: '23:00' }])).toBe(null)
    expect(windowsProblem([{ from: '00:00', to: END_OF_DAY }])).toBe(null)
  })

  it('недописанный интервал — не ошибка формы (черновик сохраняется)', () => {
    expect(windowsProblem([{ from: '01:00', to: null }])).toBe(null)
  })

  it.each([
    [[], 'empty'],
    ['not an array', 'shape'],
    [[{ from: '01:00' }], 'shape'],
    [[{ from: '1:00', to: '11:00' }], 'clock'],
    [[{ from: '01:00', to: '01:00' }], 'order'],
    [[{ from: '11:00', to: '01:00' }], 'order'],
    [[{ from: END_OF_DAY, to: null }], 'clock'],
    [[{ from: '11:00', to: '12:00' }, { from: '01:00', to: '02:00' }], 'order'],
    [[{ from: '01:00', to: '12:00' }, { from: '11:00', to: '13:00' }], 'overlap'],
  ])('отклоняет %j как %s', (value, expected) => {
    expect(windowsProblem(value)).toBe(expected)
  })

  it('недописанный интервал не мешает проверить порядок остальных', () => {
    expect(windowsProblem([{ from: '05:00', to: null }, { from: '01:00', to: '02:00' }])).toBe('order')
  })
})

describe('weekHoursProblem', () => {
  it('частичная неделя корректна: незаполненный день — «не отвечено», а не ошибка', () => {
    expect(weekHoursProblem({ mon: { kind: 'allDay' } }, OPEN)).toBe(null)
    expect(weekHoursProblem({}, OPEN)).toBe(null)
  })

  it('полная неделя всех трёх видов', () => {
    expect(weekHoursProblem(everyDay({ kind: 'none' }), OPEN)).toBe(null)
    expect(
      weekHoursProblem(everyDay({ kind: 'windows', windows: [{ from: '06:00', to: '09:00' }] }), PEAK),
    ).toBe(null)
  })

  it('круглосуточно там, где поле его не разрешает — отказ', () => {
    expect(weekHoursProblem({ mon: { kind: 'allDay' } }, PEAK)).toBe('allDayNotAllowed')
  })

  it.each([
    ['not an object', 'shape'],
    [[], 'shape'],
    [{ funday: { kind: 'none' } }, 'day'],
    [{ mon: { kind: 'sometimes' } }, 'kind'],
    [{ mon: { kind: 'windows' } }, 'shape'],
    [{ mon: { kind: 'windows', windows: [] } }, 'empty'],
    [{ mon: { kind: 'windows', windows: [{ from: '11:00', to: '01:00' }] } }, 'order'],
  ])('отклоняет %j как %s', (value, expected) => {
    expect(weekHoursProblem(value, OPEN)).toBe(expected)
  })
})

describe('cleaningProblem', () => {
  it('все четыре периодичности в корректном виде', () => {
    expect(cleaningProblem({ cadence: 'daily', windows: [{ from: '14:30', to: '15:00' }] })).toBe(null)
    expect(
      cleaningProblem({ cadence: 'weekly', days: { mon: { kind: 'windows', windows: [{ from: '02:00', to: '04:00' }] } } }),
    ).toBe(null)
    expect(
      cleaningProblem({ cadence: 'monthly', nth: 1, weekday: 'mon', windows: [{ from: '22:00', to: '23:30' }] }),
    ).toBe(null)
    expect(
      cleaningProblem({ cadence: 'quarterly', nth: 'last', weekday: 'sun', windows: [{ from: '01:00', to: '05:00' }] }),
    ).toBe(null)
  })

  it('еженедельная уборка не знает «круглосуточно» — тот же запрет, что у пиковых часов', () => {
    expect(CLEANING_DAY_OPTIONS.allDay).toBe(false)
    expect(cleaningProblem({ cadence: 'weekly', days: { mon: { kind: 'allDay' } } })).toBe('allDayNotAllowed')
  })

  it.each([
    ['not an object', 'shape'],
    [{ cadence: 'yearly', windows: [] }, 'cadence'],
    [{ cadence: 'daily' }, 'shape'],
    [{ cadence: 'daily', windows: [] }, 'empty'],
    [{ cadence: 'weekly', days: 'mon' }, 'shape'],
    [{ cadence: 'monthly', nth: 5, weekday: 'mon', windows: [{ from: '01:00', to: '02:00' }] }, 'nth'],
    [{ cadence: 'monthly', nth: 1, weekday: 'funday', windows: [{ from: '01:00', to: '02:00' }] }, 'day'],
    [{ cadence: 'quarterly', nth: 1, weekday: 'mon', windows: [{ from: '02:00', to: '01:00' }] }, 'order'],
  ])('отклоняет %j как %s', (value, expected) => {
    expect(cleaningProblem(value)).toBe(expected)
  })
})
