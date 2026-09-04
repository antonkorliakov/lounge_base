import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { fieldByKey, PHONE_PLACEHOLDER, EMAIL_PLACEHOLDER } from '@/form-schema'
import { LocaleProvider } from '@/i18n/context'
import { FieldInput } from '../FieldInput'

/**
 * Контактное поле в том виде, в каком его видит оператор: тип инпута даёт
 * телефонную/почтовую клавиатуру на мобильном, плейсхолдер подсказывает
 * формат, `autocomplete` подставляет свои данные. Среда node, DOM нет —
 * рендер `renderToStaticMarkup`, как в fieldInputLocked.test.tsx; фильтр
 * символов при наборе (onChange) закреплён на чистых функциях в
 * form-schema/__tests__/contact.test.ts — здесь проверяется, что инпут их
 * ВЫЗЫВАЕТ, через сам факт нужного типа поля (ветка одна на оба атрибута).
 *
 * `inputMode`/`autoComplete` проверяются в исходном JSX-регистре, не
 * `inputmode`/`autocomplete`: у react-dom-server, установленного в этом
 * репозитории (react-dom 19.2.8), только узкий список имён —
 * `className`, `tabIndex`, `htmlFor` и несколько других — переводится в
 * атрибут другим именем; всё остальное, чего нет в этом списке, печатается
 * буква в букву тем именем, что в JSX (проверено чтением `pushAttribute` в
 * node_modules/react-dom/cjs/react-dom-server.node.production.js — нет ни
 * записи в алиасах, ни отдельного `case`). На разметку это не влияет: имена
 * HTML-атрибутов регистронезависимы при разборе, так что браузер, читая эту
 * строку, всё равно получит атрибут `inputmode`/`autocomplete`.
 */
function render(key: string, value: unknown = ''): string {
  return renderToStaticMarkup(
    <LocaleProvider initial="en">
      <FieldInput field={fieldByKey(key)!} value={value} onChange={() => {}} />
    </LocaleProvider>,
  )
}

describe('FieldInput: контактные поля', () => {
  it('телефон — type=tel, inputmode=tel, autocomplete=tel и плейсхолдер-пример', () => {
    const html = render('II.1.2')
    expect(html).toContain('type="tel"')
    expect(html).toContain('inputMode="tel"')
    expect(html).toContain('autoComplete="tel"')
    expect(html).toContain(`placeholder="${PHONE_PLACEHOLDER}"`)
  })

  it('почта — type=email, inputmode=email, autocomplete=email и плейсхолдер-пример', () => {
    const html = render('II.1.3')
    expect(html).toContain('type="email"')
    expect(html).toContain('inputMode="email"')
    expect(html).toContain('autoComplete="email"')
    expect(html).toContain(`placeholder="${EMAIL_PLACEHOLDER}"`)
  })

  it('смешанное поле II.2.2 осталось обычным текстом без плейсхолдера', () => {
    const html = render('II.2.2')
    expect(html).toContain('type="text"')
    expect(html).not.toContain('placeholder=')
  })

  it('уже сохранённое значение показывается как есть, даже если под новые правила не подходит', () => {
    // Старые ответы не переписываются; править их можно только на допустимое.
    expect(render('II.1.2', 'call reception')).toContain('value="call reception"')
  })

  it('отказ сервера рисуется под полем тем же .fix-comment, что у остальных', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider initial="en">
        <FieldInput
          field={fieldByKey('II.1.3')!}
          value="ops@lounge"
          onChange={() => {}}
          error="Enter a valid email address, e.g. name@company.com"
        />
      </LocaleProvider>,
    )
    expect(html).toContain('class="fix-comment"')
    expect(html).toContain('Enter a valid email address')
  })
})
