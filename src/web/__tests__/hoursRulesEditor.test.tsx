import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FIRST_FLIGHT, LAST_FLIGHT, expandRules, type HoursOptions, type Weekday } from '@/form-schema'
import { LocaleProvider } from '@/i18n/context'
import { UI } from '@/i18n/dictionaries'
import { HoursRulesEditor } from '../HoursRulesEditor'

const OPEN: HoursOptions = { allDay: true, flightBounds: true, noneLabel: { en: 'Closed', ru: 'Закрыто' } }
const PEAK: HoursOptions = { allDay: false, flightBounds: false, noneLabel: { en: 'No peak', ru: 'Нет пика' } }
const W: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri']
const E: Weekday[] = ['sat', 'sun']
const rule = (days: Weekday[], from: string, to: string | null) => ({ days, hours: { kind: 'windows' as const, ranges: [{ from, to }] } })

/**
 * Разметка редактора правил, как её видит оператор. Среда node, DOM нет —
 * `renderToStaticMarkup`; поведение нажатий закреплено на чистых функциях
 * (`schedule.test.ts`: toggleDay, splitDay, expandRules) и сквозным
 * сценарием (`e2e/fill.spec.ts`). Здесь — что показано и чем управляется.
 */
function render(value: unknown, options: HoursOptions): string {
  return renderToStaticMarkup(
    <LocaleProvider initial="en">
      <HoursRulesEditor value={value} options={options} onChange={() => {}} idPrefix="III.1.1" />
    </LocaleProvider>,
  )
}
const pressed = (html: string) => (html.match(/aria-pressed="true"/g) ?? []).length

describe('HoursRulesEditor', () => {
  it('пустое поле открывается одним правилом на все семь дней', () => {
    const html = render(undefined, OPEN)
    expect(html.match(/class="hr-rule"/g)).toHaveLength(1)
    expect(pressed(html)).toBe(7)
    expect(html).toContain(UI['schedule.ruleN'].en.replace('{n}', '1'))
    expect(html).not.toContain('aria-label="' + UI['schedule.removeRule'].en) // единственное правило не убрать
  })

  it('два правила: дни поделены, у каждого свой крестик', () => {
    const html = render(expandRules([rule(W, '09:00', '21:00'), rule(E, '10:00', '20:00')]), OPEN)
    expect(html.match(/class="hr-rule"/g)).toHaveLength(2)
    expect(pressed(html)).toBe(7)
    expect(html.match(new RegExp(UI['schedule.removeRule'].en, 'g'))).toHaveLength(2)
    expect(html).toContain('value="09:00"')
    expect(html).toContain('value="20:00"')
  })

  it('итог на неделю — семь строк тем же текстом, что на экране проверки', () => {
    const html = render(expandRules([rule(W, '09:00', '21:00'), rule(['sat'], '10:00', '20:00')]), OPEN)
    expect(html).toContain(UI['schedule.weekSummary'].en)
    expect(html.match(/class="hr-sum-row"/g)).toHaveLength(7)
    expect(html).toContain('Closed') // воскресенье ни в одном правиле
    expect(html.match(new RegExp(UI['schedule.change'].en, 'g'))).toHaveLength(7)
  })

  it('ссылки «или первый/последний рейс» только где поле их допускает', () => {
    expect(render(undefined, OPEN)).toContain(UI['schedule.orFirstFlight'].en)
    expect(render(undefined, PEAK)).not.toContain(UI['schedule.orFirstFlight'].en)
    expect(render(undefined, PEAK)).not.toContain(UI['schedule.allDayShort'].en)
  })

  it('маркер показан словами с возвратом к времени, без поля времени', () => {
    const html = render(expandRules([rule([...W, ...E], FIRST_FLIGHT, LAST_FLIGHT)]), OPEN)
    expect(html).toContain(UI['schedule.fromFirstFlight'].en)
    expect(html).toContain(UI['schedule.toLastFlight'].en)
    expect(html).not.toContain('type="time"')
    expect(html.match(new RegExp(UI['schedule.useTime'].en, 'g'))).toHaveLength(2)
  })

  it('ночной диапазон подписан «до … следующего дня»', () => {
    const html = render(expandRules([rule([...W, ...E], '02:00', '01:00')]), OPEN)
    expect(html).toContain(UI['schedule.nextDay'].en.replace('{to}', '01:00'))
  })

  it('«добавить интервал» показана только при заполненной паре времён без маркеров', () => {
    expect(render(expandRules([rule([...W, ...E], '01:00', '11:00')]), OPEN)).toContain(UI['schedule.addRange'].en)
    expect(render(expandRules([rule([...W, ...E], '09:00', null)]), OPEN)).not.toContain(UI['schedule.addRange'].en)
    expect(render(expandRules([rule([...W, ...E], FIRST_FLIGHT, '23:00')]), OPEN)).not.toContain(UI['schedule.addRange'].en)
  })

  it('старый текстовый ответ показан с пометкой над обычным первым правилом', () => {
    const html = render('Monday – Saturday: 00:00 – 23:59', OPEN)
    expect(html).toContain('Monday – Saturday: 00:00 – 23:59')
    expect(html).toContain(UI['form.freeFormAnswer'].en)
    expect(pressed(html)).toBe(7)
  })

  it('кнопка под правилами названа задачей оператора', () => {
    expect(render(undefined, OPEN)).toContain(UI['schedule.otherHours'].en)
  })
})
