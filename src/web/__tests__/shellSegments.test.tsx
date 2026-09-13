import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LocaleProvider } from '@/i18n/context'
import { UI, type Locale } from '@/i18n/dictionaries'
import { FormShell, buildSteps, stepTitle } from '../FormShell'

/**
 * Сегменты полосы хода — кнопки прыжка на шаг (см. комментарий у .shell-bar
 * в FormShell.tsx). У кнопки нет текста, вся её озвучка — aria-label, и этот
 * тест пиннит их состав на уровне данных: ровно по кнопке на КАЖДЫЙ шаг из
 * buildSteps, в порядке шагов, с именем из stepTitle — того же единственного
 * источника имён, что у заголовка шелла и списка шагов. Ожидание выводится
 * из buildSteps, а не написано константой «9», чтобы новый шаг не смог тихо
 * остаться без сегмента (и наоборот); от вакуумного прохода на пустом
 * списке защищает явная проверка непустоты.
 *
 * DOM'а в сюите нет (renderToStaticMarkup, как в servicesPass1.test.tsx),
 * так что прыжок по клику здесь не проверить — он закреплён сквозным тестом
 * в e2e/fill.spec.ts; здесь закреплена структура, которой тот прыжок
 * адресуется.
 */

// То же экранирование, что у серверного рендера React: «Access & Policies»
// в разметке приходит сущностью.
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

function renderBar(locale: Locale): string {
  const html = renderToStaticMarkup(
    <LocaleProvider initial={locale}>
      <FormShell status="" lounge={{ name: 'Primeclass Lounge', iataCode: 'IST' }} submissionStatus="draft" onSubmit={() => {}}>
        {() => null}
      </FormShell>
    </LocaleProvider>,
  )
  // Только полоса: между её классом и началом навигатора. Обрыв любой из
  // границ — сломанная разметка, пусть тест упадёт на -1 громко.
  const start = html.indexOf('class="shell-bar"')
  const end = html.indexOf('class="shell-nav"')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return html.slice(start, end)
}

describe('сегменты полосы хода', () => {
  for (const locale of ['en', 'ru'] as const) {
    it(`(${locale}) по кнопке на каждый шаг, aria-label — номер, счёт и имя шага из stepTitle`, () => {
      const steps = buildSteps()
      expect(steps.length).toBeGreaterThan(0) // защита от вакуумного прохода
      const bar = renderBar(locale)

      const labels = [...bar.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1])
      expect(labels).toEqual(
        steps.map((step, i) =>
          esc(
            UI['form.stepSegment'][locale]
              .replace('{n}', String(i + 1))
              .replace('{total}', String(steps.length))
              .replace('{title}', stepTitle(step)[locale]),
          ),
        ),
      )

      // Каждый сегмент — настоящая кнопка (не submit: полоса живёт в шелле
      // формы), и их столько же, сколько aria-label'ов, — этикеток без кнопок
      // и кнопок без этикеток нет.
      expect(bar.match(/<button type="button"/g)?.length).toBe(steps.length)

      // «Вы здесь» озвучивается ровно на одном сегменте — начальном.
      expect(bar.match(/aria-current="step"/g)?.length).toBe(1)

      // Полоса больше не aria-hidden: спрятанные интерактивные кнопки — ловушка.
      expect(bar).not.toContain('aria-hidden')
    })
  }
})

/**
 * Закреплённая шапка несёт паспорт анкеты (Anton, 2026-09-13): название,
 * код аэропорта, статус. Два статуса — два текста; без кода плашки нет.
 */
describe('шапка формы: паспорт анкеты', () => {
  const head = (lounge: { name: string; iataCode: string | null }, status: 'draft' | 'changes_requested'): string =>
    renderToStaticMarkup(
      <LocaleProvider initial="en">
        <FormShell status="Saved" lounge={lounge} submissionStatus={status} onSubmit={() => {}}>
          {() => null}
        </FormShell>
      </LocaleProvider>,
    )

  it('название, код и «Draft» у черновика', () => {
    const html = head({ name: 'Primeclass Lounge', iataCode: 'IST' }, 'draft')
    expect(html).toContain('class="shell-lounge">Primeclass Lounge<')
    expect(html).toContain('class="shell-iata">IST<')
    expect(html).toContain(`class="shell-pill">${UI['form.statusDraft'].en}<`)
    expect(html).toContain('class="shell-status">Saved<')
  })

  it('«Changes requested» — своей пилюлей; без кода аэропорта плашки нет', () => {
    const html = head({ name: 'Marhaba', iataCode: null }, 'changes_requested')
    expect(html).toContain(`class="shell-pill shell-pill-changes">${UI['form.statusChanges'].en}<`)
    expect(html).not.toContain('class="shell-iata"')
  })
})
