import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LocaleProvider, useLocale } from '../context'
import { UI } from '../dictionaries'

const PICK_SAMPLE = { en: 'pick-en-sample', ru: 'pick-ru-sample' }

function ThrowsOutsideProvider(): React.JSX.Element {
  useLocale()
  return <></>
}

function Reader(): React.JSX.Element {
  const { t, pick } = useLocale()
  return (
    <>
      {t('form.next')}|{pick(PICK_SAMPLE)}
    </>
  )
}

describe('useLocale вне LocaleProvider', () => {
  it('бросает ошибку, если провайдера нет', () => {
    expect(() => renderToStaticMarkup(<ThrowsOutsideProvider />)).toThrow(
      'useLocale вне LocaleProvider',
    )
  })
})

describe('LocaleProvider резолвит t() и pick() по локали', () => {
  it('по умолчанию (без initial) отдаёт en', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <Reader />
      </LocaleProvider>,
    )
    expect(html).toContain(UI['form.next'].en)
    expect(html).toContain(PICK_SAMPLE.en)
    expect(html).not.toContain(UI['form.next'].ru)
    expect(html).not.toContain(PICK_SAMPLE.ru)
  })

  it('с initial="ru" отдаёт ru', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider initial="ru">
        <Reader />
      </LocaleProvider>,
    )
    expect(html).toContain(UI['form.next'].ru)
    expect(html).toContain(PICK_SAMPLE.ru)
    expect(html).not.toContain(UI['form.next'].en)
    expect(html).not.toContain(PICK_SAMPLE.en)
  })
})
