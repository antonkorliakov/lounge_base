import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SERVICE_ITEMS, isBinaryAvailability } from '@/form-schema'
import { LocaleProvider } from '@/i18n/context'
import { ServicesPass1 } from '../ServicesPass1'

/**
 * Pins the ONE structural rule Pass 1's row carries: which element the row is
 * follows from which control it holds, because a `<label>` forwards
 * activation to its first LABELABLE descendant and `<button>`s are labelable.
 * With the availability toggle pair inside a whole-row label, a tap on the
 * item's NAME pressed its Yes button — a wrong answer nobody typed, verified
 * in a real browser before the row was restructured (see `ServicesPass1`'s
 * comment; it is the same trap that got radios rejected in the I2 fix wave).
 *
 * The suite has no DOM to click in (`renderToStaticMarkup`, same as
 * `fixesOnly.test.tsx`), so the CONSEQUENCE — the misdirected tap — cannot be
 * asserted here; the structure that causes it can. A binary row must not be a
 * label; the non-binary row (a `<select>` is not activated by label
 * forwarding in a way that answers anything) keeps the whole-row label and
 * its finger-sized tap area. Derived per item from `isBinaryAvailability`,
 * the same schema predicate the component uses.
 */
describe('строка первого прохода: элемент строки следует за контролом', () => {
  const html = renderToStaticMarkup(
    <LocaleProvider initial="en">
      <ServicesPass1 values={{}} onChange={() => {}} />
    </LocaleProvider>,
  )

  // Row markup, one per item, in schema order — <div>/<label> both carry
  // class="pass1-row", so splitting on it walks every row regardless of tag.
  const rows = html.split(/(?=<(?:div|label) class="pass1-row">)/).slice(1)

  it('строк ровно столько, сколько позиций, и обе разновидности населены', () => {
    expect(rows.length).toBe(SERVICE_ITEMS.length)
    expect(SERVICE_ITEMS.some((i) => isBinaryAvailability(i))).toBe(true)
    expect(SERVICE_ITEMS.some((i) => !isBinaryAvailability(i))).toBe(true)
  })

  // То же экранирование, что у серверного рендера React: подписи вроде
  // «Printers & Copiers» и «Children's Play Area» в разметке приходят
  // сущностями.
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

  it('бинарная строка — <div> с парой кнопок; небинарная — <label> с <select>', () => {
    for (const [index, item] of SERVICE_ITEMS.entries()) {
      const row = rows[index]!
      expect(row, item.key).toContain(`>${esc(item.label.en)}</span>`)
      if (isBinaryAvailability(item)) {
        expect(row.startsWith('<div'), `${item.key}: строка с кнопками не должна быть label`).toBe(true)
        expect(row, item.key).toContain('aria-pressed')
        expect(row, item.key).not.toContain('<select')
      } else {
        expect(row.startsWith('<label'), `${item.key}: строка с select остаётся label`).toBe(true)
        expect(row, item.key).toContain('<select')
        expect(row, item.key).not.toContain('aria-pressed')
      }
    }
  })

  it('ни одна кнопка не оказывается внутри label (ловушка b — переадресация тапа по названию)', () => {
    // Прямая формулировка инварианта, независимая от разбиения на строки
    // выше: между открытием любого <label> и его закрытием не встречается
    // <button>. На этом экране это точный признак, потому что каждый label
    // здесь — строка позиции целиком.
    for (const chunk of html.split('<label').slice(1)) {
      const inside = chunk.slice(0, chunk.indexOf('</label>'))
      expect(inside).not.toContain('<button')
    }
  })
})
