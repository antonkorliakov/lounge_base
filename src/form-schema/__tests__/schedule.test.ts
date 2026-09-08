import { describe, it, expect } from 'vitest'
import {
  WEEKDAYS,
  NTHS,
  CADENCES,
  END_OF_DAY,
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
  applyToAll,
  applyToWeekdays,
  applyToWeekend,
  copyPreviousDay,
  dayCopyable,
  switchCadence,
  formatWeekHours,
  formatCleaning,
  weekHoursCells,
  cleaningCells,
  WEEKDAY_WORKDAYS,
  WEEKDAY_WEEKEND,
  type HoursOptions,
  type WeekHours,
  type DayHours,
  type Window,
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

  describe('dayCopyable — годится ли день как источник копирования', () => {
    it('неотвеченный день — нет', () => {
      expect(dayCopyable(undefined)).toBe(false)
    })

    it('«по часам» без единого интервала — нет: нести нечего, а сервер такой день отвергает', () => {
      expect(dayCopyable({ kind: 'windows', windows: [] })).toBe(false)
    })

    it('«по часам» с недописанным интервалом — да: черновик уже несёт начатый ответ', () => {
      expect(dayCopyable({ kind: 'windows', windows: [{ from: '09:00', to: null }] })).toBe(true)
    })

    it('«не работаем» и «круглосуточно» — да, это законные ответы', () => {
      expect(dayCopyable({ kind: 'none' })).toBe(true)
      expect(dayCopyable({ kind: 'allDay' })).toBe(true)
    })
  })

  it('регресс: пустой «по часам» источник не стирает реальные ответы соседних дней', () => {
    // Воспроизведение из ревью: понедельник нажат в «по часам» и остался без
    // единого интервала (оператор удалил последний), вторник несёт настоящие
    // часы. «Одинаково всю неделю» от понедельника не должен стереть вторник.
    const week: WeekHours = {
      mon: { kind: 'windows', windows: [] },
      tue: { kind: 'windows', windows: [{ from: '09:00', to: '18:00' }] },
    }
    expect(applyToAll(week, 'mon')).toEqual(week)
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

describe('канонический текст недельных часов', () => {
  // Явная аннотация вместо `as const` — та же причина, что у `mon` выше:
  // `WeekHours`/`DayHours` требуют мутабельный `Window[]`.
  const nine: DayHours = { kind: 'windows', windows: [{ from: '09:00', to: '18:00' }] }

  it('одинаковые соседние дни сжимаются в отрезок', () => {
    const week = { ...everyDay(nine), sun: { kind: 'none' } } as WeekHours
    expect(formatWeekHours(week, OPEN, 'en')).toBe('Mon–Sat 09:00–18:00; Sun Closed')
    expect(formatWeekHours(week, OPEN, 'ru')).toBe('Пн–Сб 09:00–18:00; Вс Закрыто')
  })

  it('одиночный день не превращается в отрезок', () => {
    const week = { ...everyDay({ kind: 'allDay' }), wed: { kind: 'none' } } as WeekHours
    expect(formatWeekHours(week, OPEN, 'en')).toBe('Mon–Tue 24h; Wed Closed; Thu–Sun 24h')
  })

  it('разрывной день печатает интервалы через запятую', () => {
    const week = everyDay({ kind: 'windows', windows: [{ from: '01:00', to: '11:00' }, { from: '12:00', to: '23:00' }] })
    expect(formatWeekHours(week, OPEN, 'en')).toBe('Mon–Sun 01:00–11:00, 12:00–23:00')
  })

  it('неотвеченный день — прочерк, недописанный интервал — многоточие', () => {
    expect(formatWeekHours({ mon: nine }, OPEN, 'en')).toBe('Mon 09:00–18:00; Tue–Sun —')
    expect(
      formatWeekHours(everyDay({ kind: 'windows', windows: [{ from: '01:00', to: null }] }), OPEN, 'en'),
    ).toBe('Mon–Sun 01:00–…')
  })

  it('подпись пустого состояния берётся у поля', () => {
    expect(formatWeekHours(everyDay({ kind: 'none' }), PEAK, 'en')).toBe('Mon–Sun No peak')
    expect(formatWeekHours(everyDay({ kind: 'none' }), PEAK, 'ru')).toBe('Пн–Вс Нет пика')
  })

  it('старый текстовый ответ печатается как есть', () => {
    expect(formatWeekHours('Monday – Saturday: 00:00 – 23:59', OPEN, 'en')).toBe(
      'Monday – Saturday: 00:00 – 23:59',
    )
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
})
