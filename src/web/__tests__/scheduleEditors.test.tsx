import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { WEEKDAYS, type HoursOptions } from '@/form-schema'
import { LocaleProvider } from '@/i18n/context'
import { UI } from '@/i18n/dictionaries'
import { WeekHoursEditor } from '../WeekHoursEditor'

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
})
