import { describe, it, expect } from 'vitest'
import {
  WEEKDAYS,
  NTHS,
  CADENCES,
  END_OF_DAY,
  FIRST_FLIGHT,
  LAST_FLIGHT,
  isClock,
  clockMinutes,
  windowsProblem,
  nextWindowStart,
  dayHoursProblem,
  weekHoursProblem,
  cleaningProblem,
  CLEANING_DAY_OPTIONS,
  windowsFinished,
  weekHoursComplete,
  cleaningComplete,
  dayRenderable,
  scheduleRenderable,
  switchCadence,
  formatWindows,
  formatWeekHours,
  dayTexts,
  formatCleaning,
  weekHoursCells,
  cleaningCells,
  expandRules,
  collapseWeek,
  toggleDay,
  splitDay,
  canAddRange,
  rulesFromWeek,
  weekKey,
  emptyRule,
  isNightRange,
  formatRange,
  rangeToWindow,
  windowToRange,
  type HoursOptions,
  type WeekHours,
  type DayHours,
  type Window,
  type Weekday,
  type HoursRule,
  type Range,
} from '../schedule'

const OPEN: HoursOptions = { allDay: true, flightBounds: true, noneLabel: { en: 'Closed', ru: 'Закрыто' } }
const PEAK: HoursOptions = { allDay: false, flightBounds: false, noneLabel: { en: 'No peak', ru: 'Нет пика' } }

/** Полная неделя одним видом — короче, чем перечислять семь ключей в каждом тесте. */
function everyDay(day: WeekHours[Weekday]): WeekHours {
  return Object.fromEntries(WEEKDAYS.map((d) => [d, day])) as WeekHours
}

// Общие фикстуры для `expandRules`/`collapseWeek`: будни и выходные как два
// правила, и конструктор `rule` для правила с одним диапазоном — несколько
// describe-блоков ниже делят их между собой.
const W = ['mon', 'tue', 'wed', 'thu', 'fri'] as const
const E = ['sat', 'sun'] as const
const rule = (days: readonly Weekday[], from: string, to: string | null): HoursRule =>
  ({ days: [...days], hours: { kind: 'windows', ranges: [{ from, to }] } })

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

describe('nextWindowStart — с какого времени предложить следующий интервал', () => {
  it('пустой список — 09:00, разумное начало рабочего дня', () => {
    expect(nextWindowStart([])).toBe('09:00')
  })

  it('последний интервал завершён — берём его конец', () => {
    expect(nextWindowStart([{ from: '01:00', to: '11:00' }])).toBe('11:00')
  })

  it('несколько интервалов — берём конец ПОСЛЕДНЕГО, не первого', () => {
    expect(
      nextWindowStart([
        { from: '01:00', to: '11:00' },
        { from: '12:00', to: '23:00' },
      ]),
    ).toBe('23:00')
  })

  // Пока у последнего интервала нет конца, следующему негде начаться: любое
  // предложенное время совпало бы с `from` этого же интервала (тот же
  // `from`, потому что второй интервал ещё не существует) и `windowsProblem`
  // тут же отверг бы список по правилу order. Кнопка выключена, а не
  // предлагает время, которое сделает день негодным.
  it('последний интервал недописан — начинать нечего, пока у него нет конца', () => {
    expect(nextWindowStart([{ from: '09:00', to: null }])).toBe(null)
  })

  it('последний интервал доходит до конца суток — добавлять нечего', () => {
    expect(nextWindowStart([{ from: '03:00', to: '24:00' }])).toBe(null)
  })

  // Это и есть обещание кнопки «+ интервал»: она не может предложить время,
  // которое `windowsProblem` тут же отвергнет. Проверяем как свойство на
  // ВСЕХ фикстурах выше, включая недописанный последний интервал — теперь,
  // когда `nextWindowStart` возвращает для него `null`, кнопка на этом
  // фикстуре просто не предлагает интервал (и его незачем достраивать), а
  // не предлагает время, которое `windowsProblem` тут же отверг бы. Раньше
  // этот фикстура была исключена из цикла — исключение снято.
  describe('свойство: то, что предлагает кнопка, всегда достраивает годный список', () => {
    const fixtures: Window[][] = [
      [],
      [{ from: '01:00', to: '11:00' }],
      [{ from: '01:00', to: '11:00' }, { from: '12:00', to: '23:00' }],
      [{ from: '09:00', to: null }],
    ]

    // `it.each` спредит элементы массива-фикстуры как отдельные параметры —
    // каждая фикстура сама массив, поэтому оборачиваем её в кортеж из одного
    // элемента, иначе первым аргументом придёт `undefined`.
    it.each(fixtures.map((windows) => [windows] as const))('%j + предложенный интервал остаётся годным списком (или ничего не предложено)', (windows) => {
      const start = nextWindowStart(windows)
      if (start === null) return // нечего достраивать — кнопка выключена, а не предлагает негодное время
      expect(windowsProblem([...windows, { from: start, to: null }])).toBe(null)
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

describe('dayHoursProblem', () => {
  it('корректные состояния одного дня — null', () => {
    expect(dayHoursProblem({ kind: 'allDay' }, OPEN)).toBe(null)
    expect(dayHoursProblem({ kind: 'none' }, OPEN)).toBe(null)
    expect(dayHoursProblem({ kind: 'windows', windows: [{ from: '09:00', to: '18:00' }] }, OPEN)).toBe(null)
  })

  it('круглосуточно там, где поле его не разрешает — отказ', () => {
    expect(dayHoursProblem({ kind: 'allDay' }, PEAK)).toBe('allDayNotAllowed')
  })

  it('неизвестный вид — kind', () => {
    expect(dayHoursProblem({ kind: 'sometimes' }, OPEN)).toBe('kind')
  })

  it.each([
    ['not an object', 'shape'],
    [{ kind: 'windows' }, 'shape'],
  ])('отклоняет %j как %s', (value, expected) => {
    expect(dayHoursProblem(value, OPEN)).toBe(expected)
  })

  it('пустой список интервалов — empty', () => {
    expect(dayHoursProblem({ kind: 'windows', windows: [] }, OPEN)).toBe('empty')
  })

  // weekHoursProblem теперь делегирует dayHoursProblem, но её собственный
  // контракт (ярлыки на всю неделю) не должен измениться — два прежних
  // случая до и после рефакторинга совпадают.
  it('weekHoursProblem возвращает те же ярлыки, что и раньше', () => {
    expect(weekHoursProblem({ mon: { kind: 'allDay' } }, PEAK)).toBe('allDayNotAllowed')
    expect(weekHoursProblem({ funday: { kind: 'none' } }, OPEN)).toBe('day')
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

describe('dayRenderable — можно ли нарисовать день с таким изъяном', () => {
  it.each([null, 'clock', 'order', 'overlap', 'empty', 'allDayNotAllowed'] as const)(
    'рисуемо: %s',
    (problem) => {
      expect(dayRenderable(problem)).toBe(true)
    },
  )

  it.each(['shape', 'kind'] as const)('нерисуемо: %s', (problem) => {
    expect(dayRenderable(problem)).toBe(false)
  })
})

describe('scheduleRenderable — можно ли нарисовать график с таким изъяном', () => {
  it.each([null, 'empty', 'clock', 'order', 'overlap', 'kind', 'allDayNotAllowed'] as const)(
    'рисуемо: %s',
    (problem) => {
      expect(scheduleRenderable(problem)).toBe(true)
    },
  )

  it.each(['shape', 'cadence', 'nth', 'day'] as const)('нерисуемо: %s', (problem) => {
    expect(scheduleRenderable(problem)).toBe(false)
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

  // C1: нажатие уже выбранной периодичности не должно ничего менять — ни для
  // одной из четырёх. `weekly` — самый заметный случай (кнопка не выключена,
  // и `{ cadence: 'weekly', days: {} }` проходит `cleaningProblem`, поэтому
  // повторный клик по «Weekly» стирал заполненную сетку и сохранял пустоту
  // как «Сохранено»), но правило одно на все четыре, а не частный случай для
  // weekly — «выбор той же периодичности ничего не меняет».
  describe('повторный выбор ТОЙ ЖЕ периодичности не меняет значение', () => {
    it('weekly → weekly сохраняет заполненную сетку', () => {
      const current = { cadence: 'weekly' as const, days: { mon: { kind: 'windows' as const, windows } } }
      expect(switchCadence(current, 'weekly')).toEqual(current)
    })

    it('daily → daily сохраняет интервалы', () => {
      const current = { cadence: 'daily' as const, windows }
      expect(switchCadence(current, 'daily')).toEqual(current)
    })

    it('monthly → monthly сохраняет nth/weekday/интервалы', () => {
      const current = { cadence: 'monthly' as const, nth: 'last' as const, weekday: 'fri' as const, windows }
      expect(switchCadence(current, 'monthly')).toEqual(current)
    })

    it('quarterly → quarterly сохраняет nth/weekday/интервалы', () => {
      const current = { cadence: 'quarterly' as const, nth: 2 as const, weekday: 'wed' as const, windows }
      expect(switchCadence(current, 'quarterly')).toEqual(current)
    })
  })
})

describe('канонический текст недельных часов', () => {
  it('№1: будни и выходные', () => {
    expect(formatWeekHours(expandRules([rule(W, '09:00', '21:00'), rule(E, '10:00', '20:00')]), OPEN, 'en'))
      .toBe('Mon–Fri 09:00–21:00; Sat–Sun 10:00–20:00')
  })

  it('№2: ночь печатается как её вводили, с пометкой', () => {
    const week = expandRules([rule(W, '02:00', '01:00'), rule(E, '05:00', '01:00')])
    expect(formatWeekHours(week, OPEN, 'en')).toBe('Mon–Fri 02:00–01:00 (next day); Sat–Sun 05:00–01:00 (next day)')
    expect(formatWeekHours(week, OPEN, 'ru')).toBe('Пн–Пт 02:00–01:00 (след. дня); Сб–Вс 05:00–01:00 (след. дня)')
  })

  it('№4 и №5: круглосуточно; несмежные дни через запятую, закрытый — словом поля', () => {
    expect(formatWeekHours(expandRules([{ days: [...WEEKDAYS], hours: { kind: 'allDay' } }]), OPEN, 'ru')).toBe('Пн–Вс Круглосуточно')
    expect(formatWeekHours(expandRules([rule(['mon', 'tue', 'wed', 'thu', 'sat', 'sun'], '09:00', '21:00')]), OPEN, 'en'))
      .toBe('Mon–Thu, Sat–Sun 09:00–21:00; Fri Closed')
  })

  it('№6: рейсы словами на обоих языках', () => {
    expect(formatWeekHours(expandRules([rule(WEEKDAYS, FIRST_FLIGHT, LAST_FLIGHT)]), OPEN, 'en')).toBe('Mon–Sun first flight–last flight')
    expect(formatWeekHours(expandRules([rule(WEEKDAYS, FIRST_FLIGHT, LAST_FLIGHT)]), OPEN, 'ru')).toBe('Пн–Вс с первого рейса до последнего')
    expect(formatWeekHours(expandRules([rule(W, '09:00', '21:00'), rule(E, FIRST_FLIGHT, '23:00')]), OPEN, 'ru'))
      .toBe('Пн–Пт 09:00–21:00; Сб–Вс с первого рейса до 23:00')
  })

  it('неотвеченные дни — прочерк; подпись пустого берётся у поля', () => {
    expect(formatWeekHours({ mon: { kind: 'windows', windows: [{ from: '09:00', to: '18:00' }] } }, OPEN, 'en')).toBe('Mon 09:00–18:00; Tue–Sun —')
    expect(formatWeekHours(everyDay({ kind: 'none' }), PEAK, 'en')).toBe('Mon–Sun No peak')
  })

  it('разрывной день печатает интервалы через запятую; недописанный — многоточием', () => {
    expect(formatWeekHours(everyDay({ kind: 'windows', windows: [{ from: '01:00', to: '11:00' }, { from: '12:00', to: '23:00' }] }), OPEN, 'en'))
      .toBe('Mon–Sun 01:00–11:00, 12:00–23:00')
    expect(formatWeekHours(everyDay({ kind: 'windows', windows: [{ from: '01:00', to: null }] }), OPEN, 'en')).toBe('Mon–Sun 01:00–…')
  })

  it('старый текстовый ответ печатается как есть', () => {
    expect(formatWeekHours('Monday – Saturday: 00:00 – 23:59', OPEN, 'en')).toBe('Monday – Saturday: 00:00 – 23:59')
  })

  it('dayTexts — то, что видит оператор в итоге под редактором', () => {
    const texts = dayTexts(expandRules([rule(W, '02:00', '01:00'), rule(['sat'], '10:00', '20:00')]), OPEN, 'ru')
    expect(texts.mon).toBe('02:00–01:00 (след. дня)')
    expect(texts.sat).toBe('10:00–20:00')
    expect(texts.sun).toBe('Закрыто')
  })

  // Critical review finding (Task 5): «до конца суток» печатается «24:00», а
  // не внутренним «00:00» диапазона — итог под редактором и канонический
  // текст читают его так же, как читали бы буквальный `to: END_OF_DAY`.
  it('dayTexts недели формы сида («00:00–24:00») печатает «24:00», не «00:00»', () => {
    const week = everyDay({ kind: 'windows', windows: [{ from: '00:00', to: END_OF_DAY }] })
    expect(dayTexts(week, OPEN, 'en').mon).toBe('00:00–24:00')
  })
})

describe('formatRange — конец суток печатается «24:00», не внутренним «00:00» (Critical, Task 5)', () => {
  it('часовой from, «00:00» как to — печатается «24:00», без пометки «next day»', () => {
    expect(formatRange({ from: '09:00', to: '00:00' }, 'en')).toBe('09:00–24:00')
    expect(formatRange({ from: '09:00', to: '00:00' }, 'ru')).toBe('09:00–24:00')
  })

  it('полный день 00:00–00:00 — «00:00–24:00»', () => {
    expect(formatRange({ from: '00:00', to: '00:00' }, 'en')).toBe('00:00–24:00')
  })

  it('настоящая ночь не тронута — печатается с пометкой, как раньше', () => {
    const range: Range = { from: '22:00', to: '02:00' }
    expect(formatRange(range, 'en')).toBe('22:00–02:00 (next day)')
  })
})

describe('канонический текст графика уборки', () => {
  const windows = [{ from: '02:00', to: '04:00' }]

  it('ежедневно и еженедельно', () => {
    expect(formatCleaning({ cadence: 'daily', windows }, 'en')).toBe('Daily 02:00–04:00')
    expect(formatCleaning({ cadence: 'daily', windows }, 'ru')).toBe('Ежедневно 02:00–04:00')
    const weekly = { cadence: 'weekly', days: { ...everyDay({ kind: 'none' }), mon: { kind: 'windows', windows } } }
    expect(formatCleaning(weekly, 'en')).toBe('Weekly: Mon 02:00–04:00; Tue–Sun No cleaning')
  })

  it('ежемесячно и ежеквартально с порядковым днём', () => {
    expect(
      formatCleaning({ cadence: 'monthly', nth: 1, weekday: 'mon', windows }, 'en'),
    ).toBe('Monthly, 1st Monday 02:00–04:00')
    expect(
      formatCleaning({ cadence: 'monthly', nth: 1, weekday: 'mon', windows }, 'ru'),
    ).toBe('Ежемесячно, 1-й понедельник 02:00–04:00')
    expect(
      formatCleaning({ cadence: 'quarterly', nth: 'last', weekday: 'sun', windows }, 'en'),
    ).toBe('Quarterly, last Sunday 02:00–04:00')
    expect(
      formatCleaning({ cadence: 'quarterly', nth: 'last', weekday: 'sun', windows }, 'ru'),
    ).toBe('Ежеквартально, последнее воскресенье 02:00–04:00')
  })

  it('старый текст — как есть', () => {
    expect(formatCleaning('Every day: 14:30 – 15:00', 'en')).toBe('Every day: 14:30 – 15:00')
  })

  // I2: та же деградация, что у недельных часов — печатается то, что можно
  // прочитать, а не `String(значение)` целиком.
  describe('деградация вместо порчи всего текста (I2)', () => {
    it('периодичность легко читается, интервалы — нет: печатается одна периодичность', () => {
      expect(formatCleaning({ cadence: 'daily', windows: 'not an array' }, 'en')).toBe('Daily')
    })

    it('еженедельная с одним нерисуемым днём — печатает остальные шесть, а не «object»', () => {
      const value = {
        cadence: 'weekly',
        days: { ...everyDay({ kind: 'none' }), mon: { kind: 'sometimes' } },
      }
      expect(formatCleaning(value, 'en')).not.toContain('object')
      expect(formatCleaning(value, 'en')).toBe('Weekly: Mon —; Tue–Sun No cleaning')
    })

    it('периодичность вообще не разобрать — пустая строка, а не «[object Object]»', () => {
      expect(formatCleaning({ cadence: 'yearly' }, 'en')).toBe('')
      expect(formatCleaning(42, 'en')).toBe('')
    })
  })

  // Тот же случай, что у недельных часов выше: 'clock' — рисуемый тег, но
  // граница-не-строка достижима только для значений старше этой ветки,
  // записанных скриптом или прежним клиентом, а не через редактор.
  it('негодная (не строка) граница интервала — прочерк вместо неё, а не «[object Object]»', () => {
    const badWindow = { from: {}, to: '10:00' } as unknown as Window
    const text = formatCleaning({ cadence: 'daily', windows: [badWindow] }, 'en')
    expect(text).not.toContain('object')
    expect(text).not.toContain('Object')
    expect(text).toBe('Daily —–10:00')
  })
})

describe('ячейки выгрузки', () => {
  it('недельные часы: колонка на день, старый текст в свободной колонке', () => {
    const week = { ...everyDay({ kind: 'allDay' }), sun: { kind: 'windows', windows: [{ from: '03:00', to: END_OF_DAY }] }, sat: { kind: 'none' } } as WeekHours
    const cells = weekHoursCells(week, OPEN)
    expect(cells.mon).toBe('24h')
    expect(cells.sat).toBe('Closed')
    expect(cells.sun).toBe('03:00–24:00')
    expect(cells.free).toBe(null)

    const legacy = weekHoursCells('Mon-Sun 09-18', OPEN)
    expect(legacy.free).toBe('Mon-Sun 09-18')
    expect(legacy.mon).toBe(null)
  })

  it('неотвеченный день — пустая ячейка, а не прочерк: в файле пусто это пусто', () => {
    expect(weekHoursCells({ mon: { kind: 'none' } }, OPEN).tue).toBe(null)
  })

  // Critical review finding (Task 5): ячейка читает `Window.to` напрямую, не
  // через диапазон редактора — «24:00» здесь и раньше печаталось верно,
  // фиксируем как регресс-проверку, что правка `Range` его не задела.
  it('ячейка недели формы сида («00:00–24:00») печатает «24:00» (не задета правкой Range)', () => {
    const week = everyDay({ kind: 'windows', windows: [{ from: '00:00', to: END_OF_DAY }] })
    expect(weekHoursCells(week, OPEN).mon).toBe('00:00–24:00')
  })

  it('уборка: ежедневная заполняет все семь дней', () => {
    const cells = cleaningCells({ cadence: 'daily', windows: [{ from: '14:30', to: '15:00' }] })
    expect(cells.cadence).toBe('Daily')
    for (const day of WEEKDAYS) expect(cells[day], day).toBe('14:30–15:00')
  })

  it('уборка: месячная ставит интервал в колонку своего дня', () => {
    const cells = cleaningCells({ cadence: 'monthly', nth: 1, weekday: 'mon', windows: [{ from: '22:00', to: '23:30' }] })
    expect(cells.cadence).toBe('Monthly, 1st')
    expect(cells.mon).toBe('22:00–23:30')
    expect(cells.tue).toBe(null)
  })

  it('уборка: еженедельная — по дням; квартальная называет периодичность', () => {
    const weekly = cleaningCells({ cadence: 'weekly', days: { mon: { kind: 'windows', windows: [{ from: '02:00', to: '04:00' }] }, tue: { kind: 'none' } } })
    expect(weekly.cadence).toBe('Weekly')
    expect(weekly.mon).toBe('02:00–04:00')
    expect(weekly.tue).toBe('No cleaning')
    expect(weekly.wed).toBe(null)

    expect(cleaningCells({ cadence: 'quarterly', nth: 'last', weekday: 'sun', windows: [{ from: '01:00', to: '05:00' }] }).cadence).toBe(
      'Quarterly, last',
    )
  })

  it('уборка: старый текст — в свободной колонке, остальные пусты', () => {
    const cells = cleaningCells('Every day: 14:30 – 15:00')
    expect(cells.free).toBe('Every day: 14:30 – 15:00')
    expect(cells.cadence).toBe(null)
    expect(cells.mon).toBe(null)
  })

  // I2: та же деградация по дню, что у канонического текста — `weekHoursCells`
  // раньше возвращала все семь ячеек `null`, стоило одному дню быть не по
  // форме, вместо шести настоящих значений плюс пустая ячейка у седьмого.
  it('шесть хороших дней плюс один по-настоящему нерисуемый — их ячейки целы', () => {
    const nine = { kind: 'windows' as const, windows: [{ from: '09:00', to: '18:00' }] }
    const week = { ...everyDay(nine), sun: { kind: 'sometimes' } } as unknown as WeekHours
    const cells = weekHoursCells(week, OPEN)
    expect(cells.mon).toBe('09:00–18:00')
    expect(cells.sat).toBe('09:00–18:00')
    expect(cells.sun).toBe(null)
  })

  // Тот же случай, что в «канонический текст…» выше: 'clock' — рисуемый тег,
  // но граница-не-строка достижима только для данных старше этой ветки,
  // записанных скриптом или прежним клиентом, а не через редактор.
  it('негодная (не строка) граница интервала в ячейке — прочерк вместо неё, а не «[object Object]»', () => {
    const badWindow = { from: {}, to: '10:00' } as unknown as Window
    const week = { mon: { kind: 'windows', windows: [badWindow] } } as WeekHours
    const cell = weekHoursCells(week, OPEN).mon
    expect(cell).not.toContain('object')
    expect(cell).not.toContain('Object')
    expect(cell).toBe('—–10:00')

    const cleaningCell = cleaningCells({ cadence: 'daily', windows: [badWindow] }).mon
    expect(cleaningCell).not.toContain('object')
    expect(cleaningCell).not.toContain('Object')
    expect(cleaningCell).toBe('—–10:00')
  })
})

describe('границы «первый / последний рейс»', () => {
  it('интервал с маркерами корректен по форме', () => {
    expect(windowsProblem([{ from: FIRST_FLIGHT, to: LAST_FLIGHT }])).toBe(null)
    expect(windowsProblem([{ from: FIRST_FLIGHT, to: '23:00' }])).toBe(null)
    expect(windowsProblem([{ from: '01:00', to: LAST_FLIGHT }])).toBe(null)
    expect(windowsProblem([{ from: FIRST_FLIGHT, to: null }])).toBe(null)
  })

  it('интервал с маркером — единственный в дне', () => {
    expect(windowsProblem([{ from: FIRST_FLIGHT, to: '12:00' }, { from: '13:00', to: '20:00' }])).toBe('order')
    expect(windowsProblem([{ from: '06:00', to: '12:00' }, { from: '13:00', to: LAST_FLIGHT }])).toBe('order')
  })

  it('маркер не на своей стороне — негодное время', () => {
    expect(windowsProblem([{ from: LAST_FLIGHT, to: '12:00' }])).toBe('clock')
    expect(windowsProblem([{ from: '06:00', to: FIRST_FLIGHT }])).toBe('clock')
  })

  it('маркеры разрешены только там, где поле их допускает', () => {
    const day = { kind: 'windows', windows: [{ from: FIRST_FLIGHT, to: LAST_FLIGHT }] }
    expect(dayHoursProblem(day, OPEN)).toBe(null)
    expect(dayHoursProblem(day, PEAK)).toBe('flightNotAllowed')
    expect(weekHoursProblem({ mon: day }, PEAK)).toBe('flightNotAllowed')
  })

  it('после интервала с маркером второй не предлагается', () => {
    expect(nextWindowStart([{ from: '01:00', to: LAST_FLIGHT }])).toBe(null)
    expect(nextWindowStart([{ from: FIRST_FLIGHT, to: '23:00' }])).toBe(null)
  })

  it('маркеры печатаются словами, на обоих языках', () => {
    expect(formatWindows([{ from: FIRST_FLIGHT, to: LAST_FLIGHT }], 'en')).toBe('first flight–last flight')
    expect(formatWindows([{ from: FIRST_FLIGHT, to: '23:00' }], 'en')).toBe('first flight–23:00')
    expect(formatWindows([{ from: '01:00', to: LAST_FLIGHT }], 'ru')).toBe('с 01:00 до последнего рейса')
    expect(formatWindows([{ from: FIRST_FLIGHT, to: LAST_FLIGHT }], 'ru')).toBe('с первого рейса до последнего')
    expect(formatWindows([{ from: FIRST_FLIGHT, to: '23:00' }], 'ru')).toBe('с первого рейса до 23:00')
    // Обычные времена по-русски — как раньше, тире без предлогов.
    expect(formatWindows([{ from: '09:00', to: '21:00' }], 'ru')).toBe('09:00–21:00')
  })

  it('день с маркерами считается заполненным', () => {
    const week = everyDay({ kind: 'windows', windows: [{ from: FIRST_FLIGHT, to: LAST_FLIGHT }] })
    expect(weekHoursComplete(week, OPEN)).toBe(true)
  })
})

// Critical review finding (Task 5): `<input type="time">` не может держать
// «24:00» — единственное значение `to`, которым оператор мог бы выразить
// «до конца суток», раз он набирает его сам. Правило (принято): `to: '00:00'`
// при часовом `from` значит «конец ЭТИХ суток», а не ночь через полночь — это
// касается и полного дня `00:00–00:00` (полночь-в-полночь).
describe('isNightRange — полночь как конец суток не ночь (Critical, Task 5)', () => {
  it('часовой from, to «00:00» — конец суток, не ночь', () => {
    expect(isNightRange({ from: '09:00', to: '00:00' })).toBe(false)
  })

  it('полный день 00:00–00:00 — тоже не ночь', () => {
    expect(isNightRange({ from: '00:00', to: '00:00' })).toBe(false)
  })

  it('настоящая ночь через полночь — не тронута', () => {
    expect(isNightRange({ from: '22:00', to: '02:00' })).toBe(true)
  })
})

describe('expandRules — правила ложатся в дни', () => {
  it('№1: будни и выходные', () => {
    const week = expandRules([rule(W, '09:00', '21:00'), rule(E, '10:00', '20:00')])
    expect(week.mon).toEqual({ kind: 'windows', windows: [{ from: '09:00', to: '21:00' }] })
    expect(week.sun).toEqual({ kind: 'windows', windows: [{ from: '10:00', to: '20:00' }] })
  })

  it('№2: ночной график разбивается по суткам, хвост уходит в СЛЕДУЮЩИЙ день', () => {
    const week = expandRules([rule(W, '02:00', '01:00'), rule(E, '05:00', '01:00')])
    expect(week.mon).toEqual({ kind: 'windows', windows: [{ from: '00:00', to: '01:00' }, { from: '02:00', to: END_OF_DAY }] })
    expect(week.sat).toEqual({ kind: 'windows', windows: [{ from: '00:00', to: '01:00' }, { from: '05:00', to: END_OF_DAY }] })
    // Хвост воскресенья попадает в понедельник — неделя по кругу.
    expect(week.mon!.kind === 'windows' && week.mon!.windows[0]).toEqual({ from: '00:00', to: '01:00' })
  })

  it('№3 и №4: все дни одинаково; круглосуточно', () => {
    expect(expandRules([rule(WEEKDAYS, '07:00', '22:00')]).thu).toEqual({ kind: 'windows', windows: [{ from: '07:00', to: '22:00' }] })
    expect(expandRules([{ days: [...WEEKDAYS], hours: { kind: 'allDay' } }]).sun).toEqual({ kind: 'allDay' })
  })

  it('№5: день без правила закрыт', () => {
    const week = expandRules([rule(['mon', 'tue', 'wed', 'thu', 'sat', 'sun'], '09:00', '21:00')])
    expect(week.fri).toEqual({ kind: 'none' })
  })

  it('№6: маркеры не разбиваются и ложатся как есть', () => {
    const week = expandRules([rule(WEEKDAYS, FIRST_FLIGHT, LAST_FLIGHT)])
    expect(week.wed).toEqual({ kind: 'windows', windows: [{ from: FIRST_FLIGHT, to: LAST_FLIGHT }] })
    expect(expandRules([rule(E, FIRST_FLIGHT, '23:00')]).sat).toEqual({ kind: 'windows', windows: [{ from: FIRST_FLIGHT, to: '23:00' }] })
  })

  it('день в правиле без времени остаётся НЕОТВЕЧЕННЫМ, а не закрытым', () => {
    const week = expandRules([rule(W, '09:00', '21:00'), rule(E, '', null)])
    expect(week.sat).toBeUndefined()
    expect(week.mon).toBeDefined()
  })

  it('незакрытый диапазон — незакрытый интервал (сохраняется, анкета неполна)', () => {
    const week = expandRules([rule(WEEKDAYS, '09:00', null)])
    expect(week.mon).toEqual({ kind: 'windows', windows: [{ from: '09:00', to: null }] })
    expect(weekHoursComplete(week, OPEN)).toBe(false)
  })

  it('to === from — негодная форма, которую поймает ворота', () => {
    const week = expandRules([rule(WEEKDAYS, '09:00', '09:00')])
    expect(weekHoursProblem(week, OPEN)).toBe('order')
  })

  it('хвост ночи, наехавший на свой интервал следующего дня, — пересечение', () => {
    const week = expandRules([rule(['mon'], '22:00', '03:00'), rule(['tue'], '02:00', '10:00')])
    expect(weekHoursProblem(week, OPEN)).toBe('overlap')
  })

  it('интервалы дня упорядочены после раскладки', () => {
    const week = expandRules([rule(['mon'], '22:00', '02:00'), rule(['tue'], '09:00', '18:00')])
    expect(week.tue).toEqual({ kind: 'windows', windows: [{ from: '00:00', to: '02:00' }, { from: '09:00', to: '18:00' }] })
  })

  // Critical review finding (Task 5): `to: '00:00'` — конец ЭТИХ суток, без
  // хвоста на завтра. Раньше `isNightRange` считала это ночью и `expandRules`
  // раскладывала на «09:00–24:00» сегодня плюс пустой хвост «00:00–00:00»
  // завтра, который `windowsProblem` отвергал правилом order — неделя не
  // сохранялась ровно на том единственном значении, которым оператор мог
  // выразить «до конца суток».
  describe('«00:00» как конец интервала — конец суток, без хвоста (Critical, Task 5)', () => {
    it('часовой from — один интервал до конца суток, никакого хвоста завтра', () => {
      const week = expandRules([rule(WEEKDAYS, '09:00', '00:00')])
      expect(week.mon).toEqual({ kind: 'windows', windows: [{ from: '09:00', to: END_OF_DAY }] })
      expect(week.tue).toEqual({ kind: 'windows', windows: [{ from: '09:00', to: END_OF_DAY }] })
      expect((week.tue as { kind: 'windows'; windows: Window[] }).windows).toHaveLength(1) // нет хвоста «00:00–…»
      expect(weekHoursProblem(week, OPEN)).toBe(null)
    })

    it('полный день 00:00–00:00 — целые сутки, не отказ', () => {
      const week = expandRules([rule(WEEKDAYS, '00:00', '00:00')])
      expect(week.mon).toEqual({ kind: 'windows', windows: [{ from: '00:00', to: END_OF_DAY }] })
      expect(weekHoursProblem(week, OPEN)).toBe(null)
    })

    it('обычное равенство from и to (не полночь) — отказ order по-прежнему', () => {
      const week = expandRules([rule(WEEKDAYS, '09:00', '09:00')])
      expect(weekHoursProblem(week, OPEN)).toBe('order')
    })
  })
})

describe('collapseWeek — дни собираются в правила', () => {
  const cases: [string, HoursRule[]][] = [
    ['№1', [rule(W, '09:00', '21:00'), rule(E, '10:00', '20:00')]],
    ['№2', [rule(W, '02:00', '01:00'), rule(E, '05:00', '01:00')]],
    ['№3', [rule(WEEKDAYS, '07:00', '22:00')]],
    ['№4', [{ days: [...WEEKDAYS], hours: { kind: 'allDay' } }]],
    ['№5', [rule(['mon', 'tue', 'wed', 'thu', 'sat', 'sun'], '09:00', '21:00')]],
    ['№6', [rule(WEEKDAYS, FIRST_FLIGHT, LAST_FLIGHT)]],
    ['№6 смешанно', [rule(W, '01:00', LAST_FLIGHT), rule(E, FIRST_FLIGHT, '23:00')]],
    ['разрывной день', [{ days: [...WEEKDAYS], hours: { kind: 'windows', ranges: [{ from: '01:00', to: '11:00' }, { from: '12:00', to: '23:00' }] } }]],
  ]

  it.each(cases)('%s: expand → collapse возвращает те же правила', (_name, rules) => {
    expect(collapseWeek(expandRules(rules))).toEqual(rules)
  })

  it.each(cases)('%s: collapse → expand возвращает ту же неделю', (_name, rules) => {
    const week = expandRules(rules)
    expect(expandRules(collapseWeek(week))).toEqual(week)
  })

  it('полный день 00:00–24:00 не считается хвостом предыдущего', () => {
    const week: WeekHours = { mon: { kind: 'windows', windows: [{ from: '20:00', to: END_OF_DAY }] }, tue: { kind: 'windows', windows: [{ from: '00:00', to: END_OF_DAY }] } }
    const rules = collapseWeek(week)
    // Под мутантом вторник исчезал из списка, а понедельник читался тем же —
    // проверять надо весь список, а не один день. `to: END_OF_DAY`, не
    // впитавший хвост при слиянии, становится РЕДАКТИРУЕМЫМ `to: '00:00'`
    // (Critical, Task 5) — единственное представление, которое
    // `<input type="time">` способен показать; у обоих дней здесь его и нет.
    expect(rules).toEqual([
      { days: ['mon'], hours: { kind: 'windows', ranges: [{ from: '20:00', to: '00:00' }] } },
      { days: ['tue'], hours: { kind: 'windows', ranges: [{ from: '00:00', to: '00:00' }] } },
    ])
  })

  // C1 (whole-branch fix wave): headIndex искал «хвост-донор» прошлого дня
  // тем же условием, что и текущий кандидат в хвост («заканчивается
  // END_OF_DAY, начинается часами»), но БЕЗ исключения полного дня
  // («00:00–24:00»), которое есть у соседнего поиска хвоста строкой выше.
  // Полный день ошибочно читался как ночной хвост САМ ЗА СЕБЯ: понедельник
  // «00:00–24:00» отдавал вторнику «00:00–01:00» свой собственный конец,
  // теряя часы (было бы «Mon 00:00–01:00; Tue —» вместо двух разных дней).
  it('C1: полный день «00:00–24:00» не отдаёт себя как ночной хвост следующему дню', () => {
    const week: WeekHours = {
      mon: { kind: 'windows', windows: [{ from: '00:00', to: END_OF_DAY }] },
      tue: { kind: 'windows', windows: [{ from: '00:00', to: '01:00' }] },
      wed: { kind: 'none' }, thu: { kind: 'none' }, fri: { kind: 'none' }, sat: { kind: 'none' }, sun: { kind: 'none' },
    }
    expect(expandRules(collapseWeek(week))).toEqual(week)
    expect(formatWeekHours(week, OPEN, 'en')).toBe('Mon 00:00–24:00; Tue 00:00–01:00; Wed–Sun Closed')
  })

  it('дни none и неотвеченные в правила не попадают', () => {
    expect(collapseWeek({ mon: { kind: 'none' }, tue: { kind: 'allDay' } })).toEqual([{ days: ['tue'], hours: { kind: 'allDay' } }])
    expect(collapseWeek({})).toEqual([])
  })

  // Critical review finding (Task 5) — «Read»: неделя из сида хранит
  // `X–24:00`; без этой ветки диапазон вышел бы `{ from: X, to: END_OF_DAY }`,
  // который `<input type="time">` показал бы ПУСТЫМ (браузер санитизирует
  // «24:00» до ничего), хотя итог под редактором и так печатает «24:00».
  it('окно до конца суток, не впитавшее хвост, — редактируемый диапазон «Y–00:00»', () => {
    expect(collapseWeek({ mon: { kind: 'windows', windows: [{ from: '09:00', to: END_OF_DAY }] } })).toEqual([
      { days: ['mon'], hours: { kind: 'windows', ranges: [{ from: '09:00', to: '00:00' }] } },
    ])
  })

  // Ночная фикстура №2 (пары «Y–X» через полночь) продолжает склеивать хвост
  // как раньше — правка выше касается только окон, у которых хвоста НЕ было.
  it('ночная фикстура №2 всё ещё склеивается в «02:00–01:00» (склейка хвоста не тронута)', () => {
    const week = expandRules([rule(W, '02:00', '01:00'), rule(E, '05:00', '01:00')])
    expect(collapseWeek(week)).toEqual([rule(W, '02:00', '01:00'), rule(E, '05:00', '01:00')])
  })

  // Раунд-трип на форме сида (`scripts/seed-dev.ts`): будни «00:00–24:00»,
  // выходные «03:00–24:00» — оба переживают collapse → expand без изменений.
  it('раунд-трип: неделя «до конца суток» формы сида переживает collapse → expand', () => {
    const week: WeekHours = {
      ...(Object.fromEntries(W.map((d) => [d, { kind: 'windows' as const, windows: [{ from: '00:00', to: END_OF_DAY }] }])) as WeekHours),
      ...(Object.fromEntries(E.map((d) => [d, { kind: 'windows' as const, windows: [{ from: '03:00', to: END_OF_DAY }] }])) as WeekHours),
    }
    expect(expandRules(collapseWeek(week))).toEqual(week)
  })
})

describe('toggleDay и splitDay', () => {
  it('день переходит из одного правила в другое', () => {
    const out = toggleDay([rule(WEEKDAYS, '09:00', '21:00'), rule([], '', null)], 1, 'sat')
    expect(out[0]!.days).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sun'])
    expect(out[1]!.days).toEqual(['sat'])
  })

  it('повторное нажатие снимает день с его правила', () => {
    const out = toggleDay([rule(WEEKDAYS, '09:00', '21:00')], 0, 'fri')
    expect(out[0]!.days).not.toContain('fri')
  })

  it('splitDay уносит день в новое пустое правило в конце списка', () => {
    const out = splitDay([rule(WEEKDAYS, '09:00', '21:00')], 'sat')
    expect(out).toHaveLength(2)
    expect(out[0]!.days).not.toContain('sat')
    expect(out[1]).toEqual({ days: ['sat'], hours: { kind: 'windows', ranges: [{ from: '', to: null }] } })
  })

  it('входные правила не мутируются', () => {
    const rules = [rule(WEEKDAYS, '09:00', '21:00')]
    toggleDay(rules, 0, 'fri'); splitDay(rules, 'sat')
    expect(rules[0]!.days).toHaveLength(7)
  })
})

describe('canAddRange — второй интервал правила (C1)', () => {
  it('ночной диапазон второго интервала не предлагает: следующий начинался бы уже завтра', () => {
    expect(canAddRange([{ from: '22:00', to: '06:00' }])).toBe(false)
  })

  it('обычный закрытый интервал — второй предложить можно', () => {
    expect(canAddRange([{ from: '01:00', to: '11:00' }])).toBe(true)
  })

  it('незакрытый интервал (to: null) — рано, второго ещё нет', () => {
    expect(canAddRange([{ from: '09:00', to: null }])).toBe(false)
  })

  it('интервал с маркером — единственный в дне, второго не бывает', () => {
    expect(canAddRange([{ from: FIRST_FLIGHT, to: '23:00' }])).toBe(false)
  })

  it('интервал до конца суток — день занят до конца, добавлять некуда', () => {
    expect(canAddRange([{ from: '03:00', to: '24:00' }])).toBe(false)
  })

  // Critical review finding (Task 5): `to: '00:00'` — единственная форма
  // «до конца суток», которую `<input type="time">` способен показать —
  // должна занимать день так же, как раньше это делал буквальный `'24:00'`.
  it('интервал до конца суток, введённый как «00:00» — день занят до конца, добавлять некуда', () => {
    expect(canAddRange([{ from: '09:00', to: '00:00' }])).toBe(false)
  })
})

// Fix round 2 (Task 5): `CleaningScheduleEditor` пишет `windows` из `RangeEditor`
// напрямую, без слоя `Range`/`expandRules` — оператор, набравший «00:00» как
// конец интервала уборки, получал бы буквальный `{from:X, to:'00:00'}` в
// хранении, а `windowsProblem` отверг бы его правилом `order` (конец раньше
// начала). Одно правило перевода диапазона в интервал (и обратно) для обоих
// писателей — `expandRules` и уборки — живёт здесь, а не в двух местах.
describe('rangeToWindow / windowToRange — диапазон редактора ↔ интервал хранения (Fix round 2)', () => {
  it('rangeToWindow: часовой from, to «00:00» — конец суток, в хранении 24:00', () => {
    expect(rangeToWindow({ from: '22:00', to: '00:00' })).toEqual({ from: '22:00', to: '24:00' })
  })

  it('rangeToWindow: ночной диапазон не тронут', () => {
    expect(rangeToWindow({ from: '22:00', to: '02:00' })).toEqual({ from: '22:00', to: '02:00' })
  })

  it('rangeToWindow: маркерное начало («первый рейс») — не тронут, это не часовой from', () => {
    expect(rangeToWindow({ from: FIRST_FLIGHT, to: '00:00' })).toEqual({ from: FIRST_FLIGHT, to: '00:00' })
  })

  it('windowToRange: 24:00 в хранении — «00:00» в редакторе', () => {
    expect(windowToRange({ from: '22:00', to: '24:00' })).toEqual({ from: '22:00', to: '00:00' })
  })

  it.each([
    ['конец суток', { from: '22:00', to: '00:00' }],
    ['обычный интервал', { from: '09:00', to: '18:00' }],
  ])('windowToRange(rangeToWindow(%s)) — круговой перевод без потерь', (_name, r) => {
    expect(windowToRange(rangeToWindow(r))).toEqual(r)
  })

  // Приёмочный тест: то, что раньше писал напрямую `CleaningScheduleEditor`
  // (сырой диапазон как интервал) `windowsProblem` отвергал правилом `order`;
  // диапазон, прошедший через `rangeToWindow`, тот же список принимает.
  it('приёмочный (защищает CleaningScheduleEditor): rangeToWindow делает «22:00–00:00» годным интервалом', () => {
    const raw = { from: '22:00', to: '00:00' }
    expect(windowsProblem([raw])).toBe('order')
    expect(windowsProblem([rangeToWindow(raw)])).toBe(null)
  })
})

describe('rulesFromWeek — неделя в правила, неотвеченный день не становится закрытым (C2)', () => {
  it('ни один день не отвечен — одно правило на все семь дней', () => {
    expect(rulesFromWeek({})).toEqual([emptyRule([...WEEKDAYS])])
  })

  it('один день отвечен — его правило плюс хвостовое пустое правило на остальные', () => {
    const allDay: DayHours = { kind: 'allDay' }
    const rest: Weekday[] = ['tue', 'wed', 'thu', 'fri', 'sat', 'sun']
    expect(rulesFromWeek({ mon: allDay })).toEqual([
      { days: ['mon'], hours: { kind: 'allDay' } },
      emptyRule(rest),
    ])
  })

  it('обратный переход: неотвеченный день остаётся НЕОТВЕЧЕННЫМ, а не закрытым', () => {
    const week: WeekHours = { mon: { kind: 'allDay' } }
    // Под мутантом (без хвостового emptyRule) вторник получал бы `none` —
    // ровно баг C2: несохранённый черновик выглядел бы как «закрыто».
    expect(expandRules(rulesFromWeek(week))).toEqual(week)
  })

  it('неделя отвечена целиком — то же, что collapseWeek', () => {
    const week = expandRules([rule(WEEKDAYS, '09:00', '21:00')])
    expect(rulesFromWeek(week)).toEqual(collapseWeek(week))
  })
})

describe('weekKey — сравнение недели независимо от порядка ключей jsonb (I1)', () => {
  it('одна и та же неделя с разным порядком ключей даёт один и тот же ключ', () => {
    const x: DayHours = { kind: 'allDay' }
    const y: DayHours = { kind: 'none' }
    expect(weekKey({ tue: x, mon: y })).toBe(weekKey({ mon: y, tue: x }))
  })

  it('разные часы одного дня дают разный ключ', () => {
    expect(weekKey({ mon: { kind: 'allDay' } })).not.toBe(weekKey({ mon: { kind: 'none' } }))
  })
})
