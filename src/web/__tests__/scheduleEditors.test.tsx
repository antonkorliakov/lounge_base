import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { WEEKDAYS, fieldByKey, type HoursOptions } from '@/form-schema'
import { LocaleProvider } from '@/i18n/context'
import { UI } from '@/i18n/dictionaries'
import { WeekHoursEditor } from '../WeekHoursEditor'
import { FieldInput } from '../FieldInput'
import { CleaningScheduleEditor } from '../CleaningScheduleEditor'
import { WindowsEditor } from '../WindowsEditor'

const OPEN: HoursOptions = { allDay: true, noneLabel: { en: 'Closed', ru: 'Закрыто' } }
const PEAK: HoursOptions = { allDay: false, noneLabel: { en: 'No peak', ru: 'Нет пика' } }

/**
 * Сетка в том виде, в каком её видит оператор. Среда node, DOM нет — рендер
 * `renderToStaticMarkup`, как в fieldInputLocked.test.tsx. Поведение нажатий
 * закреплено на чистых функциях (`schedule.test.ts`) и сквозным сценарием
 * (`e2e/fill.spec.ts`); здесь проверяется, что видно и чем управляется.
 */
function render(value: unknown, options: HoursOptions): string {
  return renderToStaticMarkup(
    <LocaleProvider initial="en">
      <WeekHoursEditor value={value} options={options} onChange={() => {}} idPrefix="III.1.1" />
    </LocaleProvider>,
  )
}

describe('WeekHoursEditor', () => {
  it('семь строк с подписями дней и кнопками состояния', () => {
    const html = render({}, OPEN)
    for (const day of WEEKDAYS) {
      expect(html, day).toContain(UI[`schedule.day.${day}`].en)
    }
    expect(html.match(/class="wh-row"/g)).toHaveLength(7)
    expect(html).toContain(UI['schedule.allDay'].en)
    expect(html).toContain('Closed')
    expect(html).toContain(UI['schedule.byHours'].en)
  })

  it('состояния берутся у поля: у пиковых часов нет «24 часа», а пустое читается «No peak»', () => {
    const html = render({}, PEAK)
    expect(html).not.toContain(UI['schedule.allDay'].en)
    expect(html).toContain('No peak')
  })

  it('выбранное состояние помечено aria-pressed — то же, чем помечены Да|Нет у услуг', () => {
    const html = render({ mon: { kind: 'none' } }, OPEN)
    expect(html).toContain('aria-pressed="true"')
  })

  it('интервалы дня показываются только у состояния «по часам»', () => {
    expect(render({ mon: { kind: 'allDay' } }, OPEN)).not.toContain('type="time"')
    const html = render({ mon: { kind: 'windows', windows: [{ from: '09:00', to: '18:00' }] } }, OPEN)
    expect(html).toContain('type="time"')
    expect(html).toContain('value="09:00"')
    expect(html).toContain('value="18:00"')
    expect(html).toContain(UI['schedule.addWindow'].en)
  })

  it('конец суток показывается кнопкой, а не значением 24:00 в поле времени', () => {
    // `<input type="time">` значения 24:00 не принимает — иначе поле осталось бы пустым.
    const html = render({ mon: { kind: 'windows', windows: [{ from: '03:00', to: '24:00' }] } }, OPEN)
    expect(html).toContain(UI['schedule.untilEndOfDay'].en)
    expect(html).not.toContain('value="24:00"')
  })

  // Кнопка предлагает время после последнего интервала, а когда день кончился
  // — не предлагает ничего. Раньше «+ interval» всегда добавляла 09:00: у
  // дня 01:00–11:00 это создавало интервал внутри предыдущего, форма
  // отказывала, и весь день пропадал из сетки.
  describe('«+ interval» предлагает время после последнего интервала', () => {
    it('день 01:00–11:00: кнопка включена', () => {
      const html = render({ mon: { kind: 'windows', windows: [{ from: '01:00', to: '11:00' }] } }, OPEN)
      const button = html.match(/<button type="button" class="wh-add"[^>]*>/)![0]
      expect(button).toContain('aria-disabled="false"')
    })

    it('день заканчивается интервалом до конца суток: кнопка недоступна — добавлять нечего', () => {
      const html = render({ mon: { kind: 'windows', windows: [{ from: '03:00', to: '24:00' }] } }, OPEN)
      const button = html.match(/<button type="button" class="wh-add"[^>]*>/)![0]
      expect(button).toContain('aria-disabled="true"')
    })

    // Последний интервал ещё не закрыт (`to: null`) — начинать следующий
    // неоткуда: любое предложенное время совпало бы с `from` этого же
    // интервала и форма отказала бы. Кнопка недоступна, а не предлагает то же
    // время второй раз.
    it('последний интервал без конца: кнопка недоступна — предыдущий ещё не закрыт', () => {
      const html = render({ mon: { kind: 'windows', windows: [{ from: '09:00', to: null }] } }, OPEN)
      const button = html.match(/<button type="button" class="wh-add"[^>]*>/)![0]
      expect(button).toContain('aria-disabled="true"')
    })
  })

  // I1: раньше недоступная «+ интервал» получала атрибут `disabled` — она
  // выпадала из таб-порядка, и ни один пользователь не мог узнать причину.
  // Теперь недоступность — `aria-disabled` (кнопка остаётся в таб-порядке и
  // кликабельна технически, но обработчик — не действие, см. WindowsEditor),
  // и рядом стоит явная причина, одна из двух.
  describe('WindowsEditor называет причину недоступности «+ интервал» (I1)', () => {
    const renderWindows = (windows: { from: string; to: string | null }[]): string =>
      renderToStaticMarkup(
        <LocaleProvider initial="en">
          <WindowsEditor windows={windows} onChange={() => {}} idPrefix="w" />
        </LocaleProvider>,
      )

    it('предыдущий интервал не закрыт — «Finish the current interval first»', () => {
      const html = renderWindows([{ from: '09:00', to: null }])
      expect(html).toContain(UI['schedule.finishPrevious'].en)
      expect(html).not.toContain(UI['schedule.dayIsFull'].en)
    })

    it('день уже занят до конца суток — «The day already runs to 24:00»', () => {
      const html = renderWindows([{ from: '03:00', to: '24:00' }])
      expect(html).toContain(UI['schedule.dayIsFull'].en)
      expect(html).not.toContain(UI['schedule.finishPrevious'].en)
    })

    it('кнопка доступна — ни одна причина не показана, и кнопка не помечена aria-disabled', () => {
      const html = renderWindows([{ from: '01:00', to: '11:00' }])
      expect(html).not.toContain(UI['schedule.finishPrevious'].en)
      expect(html).not.toContain(UI['schedule.dayIsFull'].en)
      expect(html).toContain('aria-disabled="false"')
    })

    // Не `disabled`: атрибут `disabled` убирает кнопку из таб-порядка и
    // делает причину рядом с ней недостижимой — ровно то, что было дефектом.
    it('кнопка НЕ несёт HTML-атрибут disabled ни при одной из причин', () => {
      for (const windows of [[{ from: '09:00', to: null }], [{ from: '03:00', to: '24:00' }]]) {
        const html = renderWindows(windows)
        const button = html.match(/<button type="button" class="wh-add"[^>]*>/)![0]
        expect(button).not.toContain('disabled=""')
      }
    })
  })

  it('быстрые действия на месте; «как в предыдущем дне» — не у понедельника', () => {
    const html = render({ mon: { kind: 'allDay' } }, OPEN)
    expect(html).toContain(UI['schedule.sameAllWeek'].en)
    expect(html).toContain(UI['schedule.copyToWorkdays'].en)
    expect(html).toContain(UI['schedule.copyToWeekend'].en)
    expect(html.match(new RegExp(UI['schedule.copyPrevious'].en, 'g'))).toHaveLength(6)
  })

  it('старый текстовый ответ показан над пустой сеткой с пометкой', () => {
    const html = render('Monday – Saturday: 00:00 – 23:59', OPEN)
    expect(html).toContain('Monday – Saturday: 00:00 – 23:59')
    expect(html).toContain(UI['form.freeFormAnswer'].en)
    expect(html).toContain('aria-pressed="false"')
  })

  // Выключенность — это и есть обещание «быстрое действие не может стереть»,
  // и она проверяется в разметке, потому что DOM в этом наборе нет.
  describe('быстрые действия выключены, когда понедельник не несёт ответа', () => {
    it('понедельник не отвечен — три кнопки массовых действий выключены', () => {
      const html = render({}, OPEN)
      const bulk = html.match(/<div class="wh-bulk">[\s\S]*?<\/div>/)![0]
      expect(bulk.match(/disabled=""/g)).toHaveLength(3)
    })

    it('понедельник несёт часы — кнопки массовых действий включены', () => {
      const html = render({ mon: { kind: 'allDay' } }, OPEN)
      const bulk = html.match(/<div class="wh-bulk">[\s\S]*?<\/div>/)![0]
      expect(bulk).not.toContain('disabled=""')
    })

    it('копия вторника выключена, пока понедельник не отвечен', () => {
      const html = render({}, OPEN)
      const rows = html.match(/<div class="wh-row">[\s\S]*?<\/div>\s*<\/div>/g)!
      const tueRow = rows.find((row) => row.includes(UI['schedule.day.tue'].en))!
      expect(tueRow).toContain('class="wh-copy" disabled=""')
    })

    it('понедельник «по часам» без единого интервала — кнопки массовых действий тоже выключены', () => {
      // Воспроизведение из ревью: «By hours» нажато, последний интервал
      // удалён — день формально truthy, но ничего не несёт.
      const html = render({ mon: { kind: 'windows', windows: [] } }, OPEN)
      const bulk = html.match(/<div class="wh-bulk">[\s\S]*?<\/div>/)![0]
      expect(bulk.match(/disabled=""/g)).toHaveLength(3)
    })
  })

  // C2: обычное редактирование постоянно проходит через мимолётные негодные
  // состояния (конец раньше начала, пересечение соседних интервалов) — день
  // не должен пропадать на этом, потому что `onChange` стреляет на каждое
  // нажатие клавиши и значение уже лежит в состоянии React в этот момент.
  describe('день с мимолётной негодностью (C2) остаётся на экране', () => {
    it('конец интервала раньше начала (order) — оба поля времени видны', () => {
      const html = render({ mon: { kind: 'windows', windows: [{ from: '12:00', to: '01:00' }] } }, OPEN)
      expect(html).toContain('value="12:00"')
      expect(html).toContain('value="01:00"')
    })

    it('пересекающиеся интервалы (overlap) — все четыре поля времени видны', () => {
      const html = render(
        {
          mon: {
            kind: 'windows',
            windows: [
              { from: '01:00', to: '12:00' },
              { from: '11:00', to: '13:00' },
            ],
          },
        },
        OPEN,
      )
      expect(html.match(/type="time"/g)).toHaveLength(4)
    })

    it('по-настоящему нерисуемый день (неизвестный kind) по-прежнему отбрасывается', () => {
      const html = render({ mon: { kind: 'sometimes' } }, OPEN)
      // Ни одна из трёх кнопок состояния для понедельника не нажата — день
      // вернулся к «не отвечено», как и раньше для `'shape'`/`'kind'`.
      const rows = html.match(/<div class="wh-row">[\s\S]*?<\/div>\s*<\/div>/g)!
      const monRow = rows.find((row) => row.includes(UI['schedule.day.mon'].en))!
      expect(monRow).not.toContain('aria-pressed="true"')
    })
  })

  it('испорченный понедельник не прячет вторник: у вторника видны настоящие интервалы', () => {
    // Раньше `asWeek` блокировала всю неделю, если хоть один день не проходил
    // `weekHoursProblem` — испорченный понедельник (пустой список интервалов,
    // та же форма, что и после «By hours» → «×» на последнем интервале) гасил
    // вторник вместе с собой, хотя вторник отвечен корректно. Теперь плохой
    // день отбрасывается сам по себе — вторник должен остаться на экране.
    const html = render(
      {
        mon: { kind: 'windows', windows: [] },
        tue: { kind: 'windows', windows: [{ from: '09:00', to: '18:00' }] },
      },
      OPEN,
    )
    expect(html).toContain('value="09:00"')
    expect(html).toContain('value="18:00"')
    // Понедельник с `dayHoursProblem` 'empty' теперь НЕ отбрасывается
    // `asWeek` (в отличие от других проблем) — сетка получает настоящий
    // `{ kind: 'windows', windows: [] }`, и кнопки выключает именно
    // `dayCopyable`'s ветка `windows.length > 0`. Раньше это было
    // недостижимо: `asWeek` гасила всю неделю ещё до вызова `dayCopyable`,
    // так что выключенность объяснялась `dayCopyable(undefined)`, а не тем,
    // что здесь под проверкой. Теперь эта проверка по-настоящему проверяет
    // пустой-windows ветку `dayCopyable`.
    const bulk = html.match(/<div class="wh-bulk">[\s\S]*?<\/div>/)![0]
    expect(bulk.match(/disabled=""/g)).toHaveLength(3)
  })
})

function renderCleaning(value: unknown): string {
  return renderToStaticMarkup(
    <LocaleProvider initial="en">
      <CleaningScheduleEditor value={value} onChange={() => {}} idPrefix="III.1.4" />
    </LocaleProvider>,
  )
}

describe('CleaningScheduleEditor', () => {
  it('четыре периодичности кнопками, выбранная помечена', () => {
    const html = renderCleaning({ cadence: 'daily', windows: [{ from: '02:00', to: '04:00' }] })
    for (const label of ['Daily', 'Weekly', 'Monthly', 'Quarterly']) expect(html).toContain(label)
    expect(html).toContain('aria-pressed="true"')
  })

  it('ежедневно — один список интервалов, без сетки дней', () => {
    const html = renderCleaning({ cadence: 'daily', windows: [{ from: '14:30', to: '15:00' }] })
    expect(html).toContain('value="14:30"')
    expect(html).not.toContain('class="wh-row"')
  })

  it('еженедельно — недельная сетка без «24 часа», пустое читается «No cleaning»', () => {
    const html = renderCleaning({ cadence: 'weekly', days: {} })
    expect(html.match(/class="wh-row"/g)).toHaveLength(7)
    expect(html).toContain('No cleaning')
    expect(html).not.toContain(UI['schedule.allDay'].en)
  })

  it('ежемесячно — выбор «какой по счёту» и дня недели плюс интервалы', () => {
    const html = renderCleaning({ cadence: 'monthly', nth: 1, weekday: 'mon', windows: [{ from: '22:00', to: '23:30' }] })
    expect(html).toContain(UI['schedule.nth'].en)
    expect(html).toContain(UI['schedule.weekday'].en)
    expect(html).toContain('value="22:00"')
  })

  it('старый текст показан с пометкой', () => {
    const html = renderCleaning('Every day: 14:30 – 15:00')
    expect(html).toContain('Every day: 14:30 – 15:00')
    expect(html).toContain(UI['form.freeFormAnswer'].en)
  })

  // «Пусто» — это первое состояние любой периодичности (оператор только что
  // нажал «Daily»/«Monthly»/«Quarterly» и ещё не набрал ни одного интервала),
  // а не порча. Тот же результат оставляет и снятие последнего «×» у
  // единственного интервала. Редактор обязан показать это состояние —
  // выбранную кнопку и элемент, которым можно продолжить — иначе нажатие
  // кнопки выглядит так, будто ничего не произошло.
  describe('«пусто» — законное первое состояние периодичности, не порча', () => {
    it('daily с пустым списком интервалов: кнопка «Daily» нажата, есть «+ interval»', () => {
      const html = renderCleaning({ cadence: 'daily', windows: [] })
      expect(html).toMatch(/aria-pressed="true"[^>]*>Daily</)
      expect(html).toContain(UI['schedule.addWindow'].en)
    })

    it('monthly с пустым списком интервалов: видны «какой по счёту», «день недели» и «+ interval»', () => {
      const html = renderCleaning({ cadence: 'monthly', nth: 1, weekday: 'mon', windows: [] })
      expect(html).toContain(UI['schedule.nth'].en)
      expect(html).toContain(UI['schedule.weekday'].en)
      expect(html).toContain(UI['schedule.addWindow'].en)
    })

    it('по-настоящему испорченное значение (неизвестная периодичность) — все кнопки не нажаты', () => {
      const html = renderCleaning({ cadence: 'yearly', windows: [] })
      for (const label of ['Daily', 'Weekly', 'Monthly', 'Quarterly']) expect(html).toContain(label)
      expect(html).not.toContain('aria-pressed="true"')
    })
  })

  // C2: та же мимолётная негодность, что у обычных недельных часов, не
  // должна ронять весь график уборки — ни daily/monthly/quarterly со своим
  // общим списком интервалов, ни один плохой день еженедельной сетки.
  describe('график с мимолётной негодностью (C2) остаётся на экране', () => {
    it('daily: конец раньше начала — «Daily» остаётся нажатой, поля времени видны', () => {
      const html = renderCleaning({ cadence: 'daily', windows: [{ from: '12:00', to: '01:00' }] })
      expect(html).toMatch(/aria-pressed="true"[^>]*>Daily</)
      expect(html).toContain('value="12:00"')
      expect(html).toContain('value="01:00"')
    })

    it('weekly: один плохой день не гасит кнопки периодичности и остальные дни', () => {
      const html = renderCleaning({
        cadence: 'weekly',
        days: {
          mon: { kind: 'windows', windows: [{ from: '12:00', to: '01:00' }] },
          tue: { kind: 'windows', windows: [{ from: '09:00', to: '18:00' }] },
        },
      })
      expect(html).toMatch(/aria-pressed="true"[^>]*>Weekly</)
      expect(html).toContain('value="09:00"')
      expect(html).toContain('value="18:00"')
    })

    it('по-настоящему нерисуемое значение (сломанная периодичность) по-прежнему падает к четырём ненажатым кнопкам', () => {
      const html = renderCleaning({ cadence: 'yearly', windows: [{ from: '12:00', to: '01:00' }] })
      expect(html).not.toContain('aria-pressed="true"')
    })
  })
})

describe('FieldInput отдаёт расписания своим редакторам', () => {
  const render = (key: string, value: unknown) =>
    renderToStaticMarkup(
      <LocaleProvider initial="en">
        <FieldInput field={fieldByKey(key)!} value={value} onChange={() => {}} />
      </LocaleProvider>,
    )

  it('III.1.1 — сетка с «24 часа» и «Closed»', () => {
    const html = render('III.1.1', {})
    expect(html).toContain(UI['schedule.allDay'].en)
    expect(html).toContain('Closed')
    expect(html).toContain('Lounge Operating Hours')
  })

  it('III.1.3 — та же сетка без «24 часа», пустое «No peak»', () => {
    const html = render('III.1.3', {})
    expect(html).not.toContain(UI['schedule.allDay'].en)
    expect(html).toContain('No peak')
  })

  it('III.1.4 — редактор уборки: только что выбранная «Daily» видна нажатой, с «+ interval»', () => {
    // Раньше здесь проверялась только всегда присутствующая подпись
    // «How often» — она осталась бы в разметке, даже если бы клик по
    // «Daily» не привёл ни к чему. Проверяем то, что подтверждает: кнопка
    // нажата и есть чем продолжить — управление вернулось оператору.
    const html = render('III.1.4', { cadence: 'daily', windows: [] })
    expect(html).toContain(UI['schedule.cadence'].en)
    expect(html).toMatch(/aria-pressed="true"[^>]*>Daily</)
    expect(html).toContain(UI['schedule.addWindow'].en)
  })

  it('отказ сервера рисуется тем же .fix-comment, что у остальных полей', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider initial="en">
        <FieldInput field={fieldByKey('III.1.1')!} value={{}} onChange={() => {}} error="Check the schedule" />
      </LocaleProvider>,
    )
    expect(html).toContain('class="fix-comment"')
    expect(html).toContain('Check the schedule')
  })
})
