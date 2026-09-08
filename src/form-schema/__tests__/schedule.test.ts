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
  windowsFinished,
  weekHoursComplete,
  cleaningComplete,
  applyToAll,
  applyToWeekdays,
  applyToWeekend,
  copyPreviousDay,
  switchCadence,
  WEEKDAY_WORKDAYS,
  WEEKDAY_WEEKEND,
  type HoursOptions,
  type WeekHours,
  type DayHours,
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

  // Недописанный интервал — законный черновик, но его начало уже занимает часть
  // суток: ждать, пока допишут конец, чтобы обнаружить пересечение, нельзя —
  // `from` есть всегда, и по нему пересечение проверяется независимо от `to`.
  describe('пересечение по началу недописанного интервала', () => {
    it('начало недописанного интервала внутри предыдущего завершённого — пересечение', () => {
      expect(windowsProblem([{ from: '01:00', to: '05:00' }, { from: '03:00', to: null }])).toBe('overlap')
    })

    it('пересечение по недописанному интервалу не маскирует хвост списка', () => {
      expect(
        windowsProblem([
          { from: '01:00', to: '05:00' },
          { from: '03:00', to: null },
          { from: '08:00', to: '09:00' },
        ]),
      ).toBe('overlap')
    })

    it('касание — недописанный интервал начинается ровно на конце предыдущего — не пересечение', () => {
      expect(windowsProblem([{ from: '01:00', to: '05:00' }, { from: '05:00', to: null }])).toBe(null)
    })

    it('единственный недописанный интервал по-прежнему не ошибка — отложенный конец не то же самое, что пересечение', () => {
      expect(windowsProblem([{ from: '01:00', to: null }])).toBe(null)
    })
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

describe('полнота недельной сетки', () => {
  const windows = [{ from: '01:00', to: '11:00' }]

  it('отвечены все семь дней и хотя бы один открыт — заполнено', () => {
    expect(weekHoursComplete(everyDay({ kind: 'windows', windows }), OPEN)).toBe(true)
    expect(
      weekHoursComplete({ ...everyDay({ kind: 'none' }), mon: { kind: 'allDay' } }, OPEN),
    ).toBe(true)
  })

  it('не все дни отвечены — не заполнено', () => {
    const week = everyDay({ kind: 'none' }) as Record<string, unknown>
    delete week.sun
    expect(weekHoursComplete(week, OPEN)).toBe(false)
  })

  it('вся неделя пустая — не заполнено: лаунж, закрытый всегда, это не ответ', () => {
    expect(weekHoursComplete(everyDay({ kind: 'none' }), OPEN)).toBe(false)
    expect(weekHoursComplete(everyDay({ kind: 'none' }), PEAK)).toBe(false)
  })

  it('недописанный интервал — сохраняется, но не заполнено', () => {
    const week = everyDay({ kind: 'windows', windows: [{ from: '01:00', to: null }] })
    expect(weekHoursProblem(week, OPEN)).toBe(null)
    expect(weekHoursComplete(week, OPEN)).toBe(false)
  })

  it('сломанное по форме значение не заполнено (а не бросает)', () => {
    expect(weekHoursComplete('mon 9-5', OPEN)).toBe(false)
    expect(weekHoursComplete(null, OPEN)).toBe(false)
  })
})

describe('полнота графика уборки', () => {
  it('каждая периодичность с дописанными интервалами — заполнено', () => {
    expect(cleaningComplete({ cadence: 'daily', windows: [{ from: '14:30', to: '15:00' }] })).toBe(true)
    expect(
      cleaningComplete({ cadence: 'monthly', nth: 1, weekday: 'mon', windows: [{ from: '22:00', to: '23:30' }] }),
    ).toBe(true)
    expect(
      cleaningComplete({ cadence: 'weekly', days: { ...everyDay({ kind: 'none' }), mon: { kind: 'windows', windows: [{ from: '02:00', to: '04:00' }] } } }),
    ).toBe(true)
  })

  it('еженедельная без единого дня с интервалами — не заполнено', () => {
    expect(cleaningComplete({ cadence: 'weekly', days: everyDay({ kind: 'none' }) })).toBe(false)
  })

  it('недописанный интервал — не заполнено', () => {
    expect(cleaningComplete({ cadence: 'daily', windows: [{ from: '14:30', to: null }] })).toBe(false)
  })

  it('старый текстовый ответ — не заполнено: его надо ввести заново структурой', () => {
    expect(cleaningComplete('Every day: 14:30 – 15:00')).toBe(false)
  })
})

describe('быстрые действия — чистые функции над неделей', () => {
  // Явная аннотация вместо `as const`: `WeekHours`/`DayHours` требуют
  // мутабельный `Window[]`, а `as const` сделал бы его readonly-кортежем —
  // значение то же самое, просто типизировано под форму, которую редакторы
  // реально кладут в состояние.
  const mon: DayHours = { kind: 'windows', windows: [{ from: '09:00', to: '18:00' }] }

  it('«одинаково всю неделю» раскладывает день-источник на все семь', () => {
    const out = applyToAll({ mon, sun: { kind: 'none' } }, 'mon')
    expect(Object.keys(out).sort()).toEqual([...WEEKDAYS].sort())
    for (const day of WEEKDAYS) expect(out[day], day).toEqual(mon)
  })

  it('«на будни» не трогает выходные, «на выходные» не трогает будни', () => {
    const week = applyToWeekdays({ mon, sat: { kind: 'none' } }, 'mon')
    expect(WEEKDAY_WORKDAYS.every((d) => week[d]?.kind === 'windows')).toBe(true)
    expect(week.sat).toEqual({ kind: 'none' })
    expect(week.sun).toBeUndefined()

    const weekend = applyToWeekend({ mon, sat: { kind: 'none' } }, 'mon')
    expect(WEEKDAY_WEEKEND.every((d) => weekend[d]?.kind === 'windows')).toBe(true)
    expect(weekend.tue).toBeUndefined()
  })

  it('«как в предыдущем дне» берёт соседа слева; у понедельника соседа нет', () => {
    expect(copyPreviousDay({ mon }, 'tue').tue).toEqual(mon)
    expect(copyPreviousDay({ mon }, 'mon')).toEqual({ mon })
    // Предыдущий день не отвечен — копировать нечего, неделя не меняется.
    expect(copyPreviousDay({ mon }, 'thu')).toEqual({ mon })
  })

  it('источник не мутируется — редактор кладёт результат в состояние React', () => {
    const week = { mon }
    applyToAll(week, 'mon')
    expect(Object.keys(week)).toEqual(['mon'])
  })

  it('день-источник, который не отвечен, ничего не раскладывает', () => {
    expect(applyToAll({}, 'mon')).toEqual({})
  })
})

describe('switchCadence', () => {
  const windows = [{ from: '02:00', to: '04:00' }]

  it('daily → monthly переносит интервалы и ставит первый понедельник', () => {
    const out = switchCadence({ cadence: 'daily', windows }, 'monthly')
    expect(out).toEqual({ cadence: 'monthly', nth: 1, weekday: 'mon', windows })
  })

  it('monthly → quarterly сохраняет и день, и интервалы', () => {
    const out = switchCadence({ cadence: 'monthly', nth: 'last', weekday: 'sun', windows }, 'quarterly')
    expect(out).toEqual({ cadence: 'quarterly', nth: 'last', weekday: 'sun', windows })
  })

  it('в weekly и обратно интервалы не переносятся: там они привязаны к дням', () => {
    expect(switchCadence({ cadence: 'daily', windows }, 'weekly')).toEqual({ cadence: 'weekly', days: {} })
    expect(switchCadence({ cadence: 'weekly', days: { mon: { kind: 'windows', windows } } }, 'daily')).toEqual({
      cadence: 'daily',
      windows: [],
    })
  })

  it('из пустоты (или из старого текста) — пустая форма выбранной периодичности', () => {
    expect(switchCadence(null, 'daily')).toEqual({ cadence: 'daily', windows: [] })
    expect(switchCadence(null, 'quarterly')).toEqual({
      cadence: 'quarterly', nth: 1, weekday: 'mon', windows: [],
    })
  })
})
