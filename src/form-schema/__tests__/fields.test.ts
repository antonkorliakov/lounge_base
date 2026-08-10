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
