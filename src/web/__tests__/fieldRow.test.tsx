import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LocaleProvider } from '@/i18n/context'
import { UI } from '@/i18n/dictionaries'
import { FieldRow } from '../FieldRow'

/**
 * Строка экрана проверки в изоляции — среда node, DOM нет, тот же приём, что
 * у `scheduleEditors.test.tsx`. Минимальный набор пропов: строка без
 * замечания, без права отмечать и без карандаша, чтобы проверить только
 * значок «ответ в свободной форме» (Important 3, сквозное ревью), не задевая
 * остальную разметку строки.
 */
function render(props: { value: string; freeFormAnswer?: boolean; editedByTeam?: boolean }): string {
  return renderToStaticMarkup(
    <LocaleProvider initial="en">
      <FieldRow
        label="Lounge Operating Hours"
        value={props.value}
        flag={null}
        canFlag={false}
        onRaise={() => {}}
        onResolve={() => {}}
        freeFormAnswer={props.freeFormAnswer}
        editedByTeam={props.editedByTeam}
      />
    </LocaleProvider>,
  )
}

describe('FieldRow — значок «ответ в свободной форме» (I3)', () => {
  it('freeFormAnswer=true — значок виден рядом со значением', () => {
    const html = render({ value: 'Mon-Fri 9-18', freeFormAnswer: true })
    expect(html).toContain(UI['review.freeFormAnswer'].en)
    expect(html).toContain('Mon-Fri 9-18')
  })

  it('freeFormAnswer не задан — значка нет', () => {
    const html = render({ value: 'Mon–Sun 09:00–18:00' })
    expect(html).not.toContain(UI['review.freeFormAnswer'].en)
  })

  it('freeFormAnswer и editedByTeam — оба значка видны одновременно, не гасят друг друга', () => {
    const html = render({ value: 'Mon-Fri 9-18', freeFormAnswer: true, editedByTeam: true })
    expect(html).toContain(UI['review.freeFormAnswer'].en)
    expect(html).toContain(UI['answer.teamEdited'].en)
  })
})
