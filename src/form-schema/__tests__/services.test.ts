import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SERVICE_GROUPS,
  SERVICE_ITEMS,
  SERVICE_ATTRIBUTES,
  serviceItemByKey,
  isOfferedAvailability,
  requiresPrice,
  serviceItemAnswered,
} from '../services'

// Golden fixture: item key -> exact English label as read from the source
// xlsx (sheet `Services & Amenities`). Regenerate with:
//   export PATH="/opt/homebrew/bin:$PATH"
//   npx tsx scripts/extract-services.ts \
//     "/Users/antonwork/Downloads/Global Onboarding Form 1.xlsx" \
//     --fixture src/form-schema/__tests__/fixtures/source-service-labels.json
// The fixture is the source of truth for the English strings: if services.ts
// disagrees with it, the workbook wins — fix services.ts, never hand-edit
// the fixture.
const FIXTURE_PATH = join(
  process.cwd(),
  'src/form-schema/__tests__/fixtures/source-service-labels.json',
)
const sourceLabels: Record<string, string> = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))

describe('матрица услуг', () => {
  it('58 позиций: 44 услуги и 14 F&B', () => {
    expect(SERVICE_ITEMS).toHaveLength(58)
    expect(SERVICE_ITEMS.filter((i) => i.kind === 'amenity')).toHaveLength(44)
    expect(SERVICE_ITEMS.filter((i) => i.kind === 'food')).toHaveLength(14)
  })

  it('11 групп: 8 услуг и 3 питания', () => {
    expect(SERVICE_GROUPS).toHaveLength(11)
    expect(SERVICE_GROUPS.filter((g) => g.kind === 'amenity')).toHaveLength(8)
    expect(SERVICE_GROUPS.filter((g) => g.kind === 'food')).toHaveLength(3)
  })

  it('шесть атрибутов в фиксированном порядке', () => {
    expect(SERVICE_ATTRIBUTES).toEqual([
      'available',
      'chargeType',
      'price',
      'currency',
      'slotMinutes',
      'bookingRequired',
    ])
  })

  it('ключи позиций уникальны', () => {
    const keys = SERVICE_ITEMS.map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('каждая позиция принадлежит существующей группе своего вида', () => {
    const byKey = new Map(SERVICE_GROUPS.map((g) => [g.key, g]))
    for (const item of SERVICE_ITEMS) {
      const group = byKey.get(item.group)
      expect(group, item.key).toBeDefined()
      expect(group!.kind, item.key).toBe(item.kind)
    }
  })

  it('в каждой группе есть хотя бы одна позиция', () => {
    for (const group of SERVICE_GROUPS) {
      const count = SERVICE_ITEMS.filter((i) => i.group === group.key).length
      expect(count, group.key).toBeGreaterThan(0)
    }
  })

  it('у каждой позиции заполнены обе локали', () => {
    for (const item of SERVICE_ITEMS) {
      expect(item.label.en.trim(), item.key).not.toBe('')
      expect(item.label.ru.trim(), item.key).not.toBe('')
    }
  })

  it('вейпинг имеет собственный список вместо да/нет', () => {
    const vaping = SERVICE_ITEMS.find((i) => i.key === '8.3')
    expect(vaping?.availabilityList).toBe('vaping')
  })

  it('только вейпинг использует список вейпинга; всё остальное — да/нет', () => {
    for (const item of SERVICE_ITEMS) {
      if (item.key === '8.3') continue
      expect(item.availabilityList, item.key).toBe('yesNo')
    }
  })

  it('подсказка (hint) заполнена только у ожидаемых позиций и на обоих языках', () => {
    const expectedHintKeys = ['2.3', '2.4', '5.1', '5.2', '5.3', 'fb.3.3', 'fb.3.4']
    const actualHintKeys = SERVICE_ITEMS.filter((i) => i.hint !== null).map((i) => i.key)
    expect(new Set(actualHintKeys)).toEqual(new Set(expectedHintKeys))

    for (const item of SERVICE_ITEMS) {
      if (item.hint === null) continue
      expect(item.hint.en.trim(), item.key).not.toBe('')
      expect(item.hint.ru.trim(), item.key).not.toBe('')
    }
  })

  // Structural checks (counts, uniqueness) can't catch a transcription typo
  // in a label, and a reviewer with no access to the workbook has no way to
  // verify the English strings at all. The fixture closes that gap: it was
  // generated mechanically from the xlsx (see the regeneration command in
  // the file header above), so comparing SERVICE_ITEMS against it
  // independently verifies every label without anyone needing the workbook
  // open.
  it('английские подписи совпадают с исходником посимвольно (golden fixture)', () => {
    const itemKeys = SERVICE_ITEMS.map((i) => i.key)
    expect(new Set(itemKeys)).toEqual(new Set(Object.keys(sourceLabels)))

    for (const item of SERVICE_ITEMS) {
      expect(item.label.en, item.key).toBe(sourceLabels[item.key])
    }
  })
})

// These three predicates are the single source of truth `validation.ts`,
// `ServicesPass2.tsx`, `completeness.ts`, and the contract test all now call
// instead of each restating the same rule — see R1/R2 in the whole-branch
// review's second round, and Critical 1 in the first: a rule the renderer
// and the validator each hold separately is exactly the bug class this
// extraction closes.
describe('isOfferedAvailability', () => {
  const wifi = serviceItemByKey('2.1')! // yesNo
  const vaping = serviceItemByKey('8.3')! // own list

  it('null/undefined/пустая строка — не предложено', () => {
    expect(isOfferedAvailability(wifi, null)).toBe(false)
    expect(isOfferedAvailability(wifi, undefined)).toBe(false)
    expect(isOfferedAvailability(wifi, '')).toBe(false)
  })

  it('закрывающие id ("no"/"not_allowed") — не предложено', () => {
    expect(isOfferedAvailability(wifi, 'no')).toBe(false)
    expect(isOfferedAvailability(vaping, 'not_allowed')).toBe(false)
  })

  it('настоящий положительный ответ — предложено', () => {
    expect(isOfferedAvailability(wifi, 'yes')).toBe(true)
    expect(isOfferedAvailability(vaping, 'throughout')).toBe(true)
    expect(isOfferedAvailability(vaping, 'smoking_room')).toBe(true)
  })

  it('id не из списка этой позиции — не предложено (не бросает исключение)', () => {
    expect(isOfferedAvailability(wifi, 'throughout')).toBe(false)
  })
})

describe('requiresPrice', () => {
  it('chargeable и both требуют цену; complimentary и null — нет', () => {
    expect(requiresPrice('chargeable')).toBe(true)
    expect(requiresPrice('both')).toBe(true)
    expect(requiresPrice('complimentary')).toBe(false)
    expect(requiresPrice(null)).toBe(false)
    expect(requiresPrice(undefined)).toBe(false)
  })
})

describe('serviceItemAnswered', () => {
  const wifi = serviceItemByKey('2.1')!

  it('не отвечено (available отсутствует) — не отвечено', () => {
    expect(serviceItemAnswered(wifi, undefined)).toBe(false)
    expect(serviceItemAnswered(wifi, { available: null, chargeType: null })).toBe(false)
    expect(serviceItemAnswered(wifi, { available: '', chargeType: null })).toBe(false)
  })

  it('закрывающий ответ ("нет") — отвечено, chargeType не нужен', () => {
    expect(serviceItemAnswered(wifi, { available: 'no', chargeType: null })).toBe(true)
  })

  it('предложено, но без chargeType — ЕЩЁ НЕ отвечено (это и есть R1)', () => {
    expect(serviceItemAnswered(wifi, { available: 'yes', chargeType: null })).toBe(false)
  })

  it('предложено и с chargeType — отвечено', () => {
    expect(serviceItemAnswered(wifi, { available: 'yes', chargeType: 'complimentary' })).toBe(true)
  })
})
