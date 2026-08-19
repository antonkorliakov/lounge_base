import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { fieldByKey } from '@/form-schema'
import { LocaleProvider } from '@/i18n/context'
import { UI } from '@/i18n/dictionaries'
import { FieldInput } from '../FieldInput'

/**
 * Замкнутое (предзаполненное командой) поле блока I в основном проходе:
 * `FieldInput` с `locked` обязан показать значение БЕЗ возможности его
 * менять — readonly-инпут с микроподписью, — а без `locked` тот же ключ
 * остаётся обычным редактируемым полем. Вторая половина — контракт экрана
 * правок: `FixesOnly` проп не передаёт вовсе (см. fixesOnly.test.tsx, где
 * это закреплено на НАСТОЯЩЕМ рендере экрана правок), так что отмеченный
 * ревьюером ответ правится всегда.
 *
 * Рендер настоящий (`renderToStaticMarkup`, как у fixesOnly.test.tsx —
 * среда node, DOM нет), утверждения — по разметке, которую видит оператор.
 */
function render(key: string, value: unknown, locked: boolean): string {
  return renderToStaticMarkup(
    <LocaleProvider initial="en">
      <FieldInput
        field={fieldByKey(key)!}
        value={value}
        onChange={() => {}}
        locked={locked}
      />
    </LocaleProvider>,
  )
}

describe('FieldInput под замком', () => {
  it('значение видно, инпут readonly, микроподпись на месте', () => {
    const html = render('I.10', 'IST', true)
    expect(html).toMatch(/readonly/i)
    expect(html).toContain('value="IST"')
    expect(html).toContain('field-locked')
    expect(html).toContain(UI['form.prefilled'].en)
    // Label остаётся настоящим label поля — скринридер читает то же имя.
    expect(html).toContain(fieldByKey('I.10')!.label.en)
  })

  it('без locked то же поле — обычный редактируемый инпут', () => {
    const html = render('I.10', 'IST', false)
    expect(html).not.toMatch(/readonly/i)
    expect(html).not.toContain(UI['form.prefilled'].en)
    expect(html).toContain('value="IST"')
  })
})
