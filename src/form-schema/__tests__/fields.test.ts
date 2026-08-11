import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIELDS } from '../fields'
import { OPTION_LISTS } from '../option-lists'

// Golden fixture: key -> exact English label as read from the source xlsx.
// Regenerate with:
//   export PATH="/opt/homebrew/bin:$PATH"
//   npx tsx scripts/extract-form-schema.ts \
//     "/Users/antonwork/Downloads/Global Onboarding Form 1.xlsx" \
//     --fixture src/form-schema/__tests__/fixtures/source-field-labels.json
// The fixture is the source of truth for the English strings: if fields.ts
// disagrees with it, the workbook wins — fix fields.ts, never hand-edit the
// fixture.
const FIXTURE_PATH = join(
  process.cwd(),
  'src/form-schema/__tests__/fixtures/source-field-labels.json',
)
const sourceLabels: Record<string, string> = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))

describe('плоские поля', () => {
  it('их ровно 67', () => {
    expect(FIELDS).toHaveLength(67)
  })

  it('ключи уникальны', () => {
    const keys = FIELDS.map((f) => f.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('покрыты все пять разделов в ожидаемых количествах', () => {
    const bySection = (section: string) =>
      FIELDS.filter((f) => f.section === section).length
    expect(bySection('I')).toBe(15)
    expect(bySection('II')).toBe(11)
    expect(bySection('III')).toBe(36)
    expect(bySection('IV')).toBe(4)
    expect(bySection('V')).toBe(1)
  })

  it('каждый select ссылается на существующий список', () => {
    for (const field of FIELDS) {
      const usesList =
        field.type === 'select' ||
        field.type === 'select_with_detail' ||
        field.type === 'multi_select'

      if (usesList) {
        expect(field.optionList, field.key).not.toBeNull()
        expect(OPTION_LISTS, field.key).toHaveProperty(field.optionList!)
      } else {
        expect(field.optionList, field.key).toBeNull()
      }
    }
  })

  it('у каждого template есть текст и хотя бы один слот', () => {
    for (const field of FIELDS.filter((f) => f.type === 'template')) {
      expect(field.templateText, field.key).not.toBeNull()
      expect(field.templateSlots.length, field.key).toBeGreaterThan(0)
    }
  })

  it('у каждого поля заполнены обе локали', () => {
    for (const field of FIELDS) {
      expect(field.label.en.trim(), field.key).not.toBe('')
      expect(field.label.ru.trim(), field.key).not.toBe('')
    }
  })

  it('III.6.6 — мультивыбор зоны', () => {
    const zone = FIELDS.find((f) => f.key === 'III.6.6')
    expect(zone?.type).toBe('multi_select')
  })

  it('III.2.1 — шаблон с одним числовым слотом', () => {
    const earliest = FIELDS.find((f) => f.key === 'III.2.1')
    expect(earliest?.type).toBe('template')
    expect(earliest?.templateSlots).toHaveLength(1)
  })

  // III.3.2 ("Unaccompanied Children Policy") is the questionnaire's one
  // compound field: it is a plain select (Allowed / Not allowed) over
  // optionList 'allowedNotAllowed', but the minimum age is only meaningful —
  // and only collectable — when "Allowed" is chosen, and the source encodes
  // that age as a fill-in-the-blank template ("Children from (  ) years old
  // can enter unaccompanied.") in the workbook's hint column rather than as
  // its own select option. So this field carries select-family data
  // (type/optionList) AND template data (templateText/templateSlots) at
  // once — a deliberate shape, not a data error left over from indecision
  // between 'select' and 'template'. Nothing else in the earlier tests
  // inspects templateText/templateSlots for a non-template field (the
  // "select references a list" test only checks optionList, and the
  // "template has text and a slot" test filters on type === 'template',
  // which this field never matches), so without this test a refactor could
  // silently drop the age slot — the suite would stay green while the
  // minimum-age field became uncollectable in the UI.
  it('III.3.2 — составное поле: select + шаблон с возрастным слотом', () => {
    const unaccompanied = FIELDS.find((f) => f.key === 'III.3.2')
    expect(unaccompanied).toBeDefined()
    expect(unaccompanied?.type).toBe('select')
    expect(unaccompanied?.optionList).toBe('allowedNotAllowed')
    expect(unaccompanied?.templateText).not.toBeNull()
    expect(unaccompanied?.templateText?.en.trim()).not.toBe('')
    expect(unaccompanied?.templateText?.ru.trim()).not.toBe('')
    expect(unaccompanied?.templateSlots.map((s) => s.key)).toEqual(['age'])
  })

  // Mirror image of the test above, checked over all of FIELDS rather than
  // hardcoded to III.3.2: if someone later gives a different non-template
  // field template slots (say, while modeling another "select + blank-to-
  // fill-in" question), this must fail and force an explicit decision about
  // how that field renders and is tested — exactly as III.3.2's shape was
  // decided and pinned above — instead of quietly accumulating a second,
  // untested compound field.
  it('III.3.2 — единственное не-template поле с непустыми templateSlots', () => {
    const nonTemplateFieldsWithSlots = FIELDS.filter(
      (f) => f.type !== 'template' && f.templateSlots.length > 0,
    ).map((f) => f.key)
    expect(nonTemplateFieldsWithSlots).toEqual(['III.3.2'])
  })

  // Structural checks (counts, uniqueness) can't catch a transcription typo
  // in a label, and a reviewer with no access to the workbook has no way to
  // verify the English strings at all. The fixture closes that gap: it was
  // generated mechanically from the xlsx (see the regeneration command in
  // the file header above), so comparing FIELDS against it independently
  // verifies every label without anyone needing the workbook open.
  it('английские подписи совпадают с исходником посимвольно (golden fixture)', () => {
    const fieldKeys = FIELDS.map((f) => f.key)
    expect(new Set(fieldKeys)).toEqual(new Set(Object.keys(sourceLabels)))

    for (const field of FIELDS) {
      expect(field.label.en, field.key).toBe(sourceLabels[field.key])
    }
  })
})
