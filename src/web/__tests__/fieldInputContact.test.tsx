import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { fieldByKey, PHONE_PLACEHOLDER, EMAIL_PLACEHOLDER } from '@/form-schema'
import { LocaleProvider } from '@/i18n/context'
import { FieldInput } from '../FieldInput'

/**
 * Контактное поле в том виде, в каком его видит оператор: тип инпута даёт
 * телефонную/почтовую клавиатуру на мобильном, плейсхолдер подсказывает
 * формат, `autocomplete` подставляет свои данные. Среда node, DOM нет —
 * рендер `renderToStaticMarkup`, как в fieldInputLocked.test.tsx.
 *
 * ЧЕГО ЭТОТ ФАЙЛ НЕ ДОКАЗЫВАЕТ. Атрибуты (`type`/`inputMode`/`autoComplete`/
 * `placeholder`) — это разметка, не поведение: из них не следует, что onChange
 * действительно вызывает фильтр символов. Семантика самого фильтра (что
 * остаётся в поле при наборе и вставке) закреплена на чистых функциях в
 * `src/form-schema/__tests__/contact.test.ts`; то, что `FieldInput` реально
 * подключает `sanitizePhoneInput`/`sanitizeEmailInput` к вводу, закреплено
 * только сквозным сценарием в `e2e/fill.spec.ts` (contact-fields) — у этого
 * набора нет DOM, событие `onChange` здесь никогда не срабатывает.
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
function render(key: string, value: unknown = '', noAutofill?: boolean): string {
  return renderToStaticMarkup(
    <LocaleProvider initial="en">
      <FieldInput
        field={fieldByKey(key)!}
        value={value}
        onChange={() => {}}
        noAutofill={noAutofill}
      />
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

  it('noAutofill гасит автозаполнение браузера — почта II.1.3 без autoComplete=email', () => {
    // II.1.3 — как раз адрес, на который сервер шлёт уведомления: если
    // браузер вместо этого предложит адрес ПРОВЕРЯЮЩЕГО, письма уедут не
    // туда. `noAutofill` — переключатель именно на этот случай (см.
    // `FieldRow.tsx`, редактор команды).
    const html = render('II.1.3', '', true)
    expect(html).toContain('autoComplete="off"')
    expect(html).not.toContain('autoComplete="email"')
  })

  it('без noAutofill почта по-прежнему получает autoComplete=email — операторский экран не регрессирует', () => {
    const html = render('II.1.3', '', false)
    expect(html).toContain('autoComplete="email"')
  })

  it('число, записанное в контактное поле до появления его типа, показывается как строка, не пустотой', () => {
    // Зеркалит ветку `default` (см. finding 6): значение может быть числом,
    // если поле раньше писалось до появления branch'а phone/email — старый
    // JSON-ответ не переписывается назад.
    expect(render('II.1.2', 90212)).toContain('value="90212"')
  })
})

/**
 * `FieldRow` — редактор ОТВЕТА КОМАНДЫ поверх чужого поля, а не своего:
 * открывается кликом по карандашу и живёт в собственном `useState`
 * (`editOpen`), так что без DOM его нельзя раскрыть и получить в разметке
 * настоящий `<FieldInput>` контактной ветки — `renderToStaticMarkup` не
 * исполняет обработчики. Пин по исходнику — тем же приёмом, что
 * `src/review/__tests__/decide.test.ts` ("копия паспорта делит ОДИН UPDATE")
 * и `src/review/__tests__/flags.test.ts`: находим именно тот `<FieldInput`,
 * которым `FieldRow` рендерит `kind === 'field'`, и проверяем, что он несёт
 * `noAutofill` — так регресс (кто-то уберёт проп при рефакторинге экрана)
 * ловится без сборки jsdom-сценария ради одного атрибута.
 */
describe('FieldRow: правка команды передаёт FieldInput noAutofill', () => {
  it('редактор поля (`kind === \'field\'`) монтирует FieldInput с noAutofill', () => {
    const source = readFileSync(join(process.cwd(), 'src/web/FieldRow.tsx'), 'utf8')
    const fieldEditorMatch = source.match(
      /props\.edit\.kind === 'field' && \(\s*<FieldInput[\s\S]*?\/>\s*\)/,
    )
    expect(fieldEditorMatch, 'редактор поля не найден в FieldRow.tsx — проверь разметку').not.toBeNull()
    expect(fieldEditorMatch![0]).toContain('noAutofill')
  })
})
