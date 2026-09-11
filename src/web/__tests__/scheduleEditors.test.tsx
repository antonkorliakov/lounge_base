import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { fieldByKey } from '@/form-schema'
import { LocaleProvider } from '@/i18n/context'
import { UI } from '@/i18n/dictionaries'
import { FieldInput } from '../FieldInput'
import { CleaningScheduleEditor } from '../CleaningScheduleEditor'

/**
 * Расписания в том виде, в каком их видит оператор. Среда node, DOM нет —
 * рендер `renderToStaticMarkup`, как в fieldInputLocked.test.tsx. Часы работы
 * и пиковые часы (недельная сетка правилами) закреплены отдельно, в
 * `hoursRulesEditor.test.tsx`; здесь — график уборки (`CleaningScheduleEditor`,
 * который еженедельную ветку отдаёт тому же редактору правил) и то, что
 * `FieldInput` вообще подключает нужный редактор к нужному полю. Поведение
 * нажатий закреплено на чистых функциях (`schedule.test.ts`) и сквозным
 * сценарием (`e2e/fill.spec.ts`).
 */
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
    // Ни `hr-rule` (правила недели), ни `hr-sum` (итог на неделю) — daily не
    // задействует редактор недели вовсе, только список интервалов.
    expect(html).not.toContain('class="hr-rule"')
    expect(html).not.toContain('class="hr-sum"')
  })

  // Еженедельная уборка идёт через тот же редактор правил, что часы работы
  // (`HoursRulesEditor`) — не через сетку по дням, у которой не было своего
  // текста для «пусто»: 24-часовой чип и «или первый рейс» здесь не рисуются
  // вовсе, они гасятся самими `options` (`CLEANING_DAY_OPTIONS.allDay` и
  // `.flightBounds` — оба false), не текущим значением. Шесть дней с
  // одинаковыми часами схлопываются в одно правило (`collapseWeek`, закреплено
  // в `schedule.test.ts`), а седьмой явно закрыт и ни в одно правило не
  // попадает — «No cleaning» в итоге на неделю читает это как `noneLabel`,
  // ровно тот текст, который у часов работы читался бы «Closed».
  it('еженедельно — редактор правил без «24 часа», закрытый день читается «No cleaning»', () => {
    const week = { kind: 'windows' as const, windows: [{ from: '09:00', to: '18:00' }] }
    const html = renderCleaning({
      cadence: 'weekly',
      days: { mon: week, tue: week, wed: week, thu: week, fri: week, sat: week, sun: { kind: 'none' as const } },
    })
    expect(html.match(/class="hr-rule"/g)).toHaveLength(1)
    expect(html).not.toContain(UI['schedule.allDayShort'].en)
    expect(html).not.toContain(UI['schedule.orFirstFlight'].en)
    expect(html).toContain('No cleaning')
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

  // Несколько окон daily/monthly/quarterly — свой «×» у каждого, ЕСЛИ окон
  // больше одного: единственное окно снять нечем заменить, кроме как сменить
  // периодичность целиком, так что у него «×» нет вовсе (тот же довод, что у
  // единственного правила в `HoursRulesEditor` — см. её тест «единственное
  // правило не убрать»).
  it('daily: два интервала — два «×», один интервал — ни одного', () => {
    const two = renderCleaning({
      cadence: 'daily',
      windows: [{ from: '02:00', to: '04:00' }, { from: '05:00', to: '06:00' }],
    })
    expect(two.match(/class="hr-x"/g)).toHaveLength(2)

    const one = renderCleaning({ cadence: 'daily', windows: [{ from: '02:00', to: '04:00' }] })
    expect(one).not.toContain('class="hr-x"')
  })

  // «Пусто» — это первое состояние любой периодичности (оператор только что
  // нажал «Daily»/«Monthly»/«Quarterly» и ещё не набрал ни одного интервала),
  // а не порча. Тот же результат оставляет и снятие последнего «×» у
  // единственного интервала. Редактор обязан показать это состояние —
  // выбранную кнопку и элемент, которым можно продолжить — иначе нажатие
  // кнопки выглядит так, будто ничего не произошло.
  describe('«пусто» — законное первое состояние периодичности, не порча', () => {
    it('daily с пустым списком интервалов: кнопка «Daily» нажата, есть «Add an interval»', () => {
      const html = renderCleaning({ cadence: 'daily', windows: [] })
      expect(html).toMatch(/aria-pressed="true"[^>]*>Daily</)
      expect(html).toContain(UI['schedule.addRange'].en)
    })

    it('monthly с пустым списком интервалов: видны «какой по счёту», «день недели» и «Add an interval»', () => {
      const html = renderCleaning({ cadence: 'monthly', nth: 1, weekday: 'mon', windows: [] })
      expect(html).toContain(UI['schedule.nth'].en)
      expect(html).toContain(UI['schedule.weekday'].en)
      expect(html).toContain(UI['schedule.addRange'].en)
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

  // Оба поля идут через один и тот же `HoursRulesEditor` — разница между
  // ними только в `hoursOptions` (`allDay`/`flightBounds`), которую сама
  // сетка правил уже закрепляет в `hoursRulesEditor.test.tsx`. Здесь — что
  // `FieldInput` подключает именно её (не сетку по дням, которой больше нет).
  it('III.1.1 — hr-rule с «24h» и «или первый рейс»', () => {
    const html = render('III.1.1', {})
    expect(html.match(/class="hr-rule"/g)).toHaveLength(1)
    expect(html).toContain(UI['schedule.allDayShort'].en)
    expect(html).toContain(UI['schedule.orFirstFlight'].en)
    expect(html).toContain('Lounge Operating Hours')
  })

  it('III.1.3 — тот же hr-rule, без «24h» и без «или первый рейс»', () => {
    const html = render('III.1.3', {})
    expect(html.match(/class="hr-rule"/g)).toHaveLength(1)
    expect(html).not.toContain(UI['schedule.allDayShort'].en)
    expect(html).not.toContain(UI['schedule.orFirstFlight'].en)
  })

  it('III.1.4 — редактор уборки: только что выбранная «Daily» видна нажатой, с «Add an interval»', () => {
    // Раньше здесь проверялась только всегда присутствующая подпись
    // «How often» — она осталась бы в разметке, даже если бы клик по
    // «Daily» не привёл ни к чему. Проверяем то, что подтверждает: кнопка
    // нажата и есть чем продолжить — управление вернулось оператору.
    const html = render('III.1.4', { cadence: 'daily', windows: [] })
    expect(html).toContain(UI['schedule.cadence'].en)
    expect(html).toMatch(/aria-pressed="true"[^>]*>Daily</)
    expect(html).toContain(UI['schedule.addRange'].en)
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
