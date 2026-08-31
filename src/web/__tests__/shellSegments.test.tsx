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
      <FormShell status="" onSubmit={() => {}}>
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
