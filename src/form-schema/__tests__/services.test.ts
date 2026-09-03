import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PROFILE_ATTRIBUTES,
  SERVICE_GROUPS,
  SERVICE_ITEMS,
  SERVICE_ATTRIBUTES,
  applicableAttributes,
  attributeApplies,
  serviceItemByKey,
  isBinaryAvailability,
  isOfferedAvailability,
  needsPass2,
  requiredAttributesFor,
  requiresPrice,
  serviceItemAnswered,
  type ServiceProfile,
} from '../services'
import { OPTION_LISTS } from '../option-lists'

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

  // Порядок закреплён потому, что по нему строятся колонки плоской выгрузки
  // (`src/export/columns.ts`): перестановка переставила бы колонки в файле, а
  // принимающая система читает их по позиции.
  //
  // `details` СЕДЬМОЙ И ОБЯЗАТЕЛЬНЫЙ, а не «ещё один при желании»: у позиций с
  // подсказкой (2.3, 2.4, 5.1–5.3, fb.3.3, fb.3.4 — «please specify the
  // capacity/drinks/hours») сам ответ пишется именно туда. Список без него
  // выкидывал бы из выгрузки то, что вопрос и просит уточнить. Само
  // соответствие списка типу `ServiceValueInput` держит компилятор
  // (`satisfies Record<keyof ServiceValueInput, true>` в services.ts), а
  // соответствие колонкам таблицы — тест в
  // `src/export/__tests__/columns.test.ts`; здесь закреплён только ПОРЯДОК и
  // то, что список не пуст.
  it('семь атрибутов в фиксированном порядке, включая details', () => {
    expect(SERVICE_ATTRIBUTES).toEqual([
      'available',
      'chargeType',
      'price',
      'currency',
      'slotMinutes',
      'bookingRequired',
      'details',
    ])
  })

  // Позиции с подсказкой — те, у которых `details` несёт единственный
  // содержательный ответ. Список подсказок проверяется ниже отдельно; здесь
  // важно, что такие позиции вообще есть: если бы их не было, аргумент за
  // `details` в выгрузке был бы теоретическим.
  it('есть позиции, чей ответ живёт только в details (подсказка «уточните»)', () => {
    const withHint = SERVICE_ITEMS.filter((i) => i.hint !== null)
    expect(withHint.length).toBeGreaterThan(0)
    expect(SERVICE_ATTRIBUTES).toContain('details')
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

  // `isBinaryAvailability` выбирает отрисовку контрола наличия (пара кнопок
  // против дропдауна, см. `ServiceAvailabilityInput`) и читает СОДЕРЖИМОЕ
  // списка — ровно два варианта, — а не его имя: список с другим именем и
  // двумя вариантами обязан вести себя как `yesNo`, иначе выбор контрола
  // снова стал бы рукописным перечнем позиций.
  it('бинарность — это «в списке ровно два варианта», не имя списка', () => {
    for (const item of SERVICE_ITEMS) {
      expect(isBinaryAvailability(item), item.key).toBe(
        OPTION_LISTS[item.availabilityList].length === 2,
      )
    }
    // Обе ветки реально населены: 8.3 (vaping, три варианта) — дропдаун,
    // всё остальное сегодня — пара.
    expect(isBinaryAvailability(SERVICE_ITEMS.find((i) => i.key === '8.3')!)).toBe(false)
    expect(isBinaryAvailability(SERVICE_ITEMS.find((i) => i.key === '2.1')!)).toBe(true)
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

/**
 * Профили — буквально, позиция за позицией, как их подтвердил пользователь.
 * Тот же приём, что у `MERGED_FIELD_GROUPS` в `steps.test.ts`: это то место,
 * которое новая позиция ОБЯЗАНА уронить громко (проверка разбиения ниже не
 * сойдётся), а перенесённая из одного профиля в другой — уронить по имени.
 * Автор решает профиль здесь сам, а не получает молча полный набор — или,
 * что хуже, молча `none`, спрятав позицию из второго прохода.
 */
const PROFILE_OF: Record<ServiceProfile, readonly string[]> = {
  none: [
    '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7',
    '2.2', '2.5', '2.6',
    '3.1', '3.2', '3.3',
    '4.1', '4.3', '4.4',
    '6.1', '6.2', '6.3', '6.4',
    '7.1', '7.3',
    '8.1', '8.2', '8.3', '8.4', '8.7',
    'fb.2.1', 'fb.2.2', 'fb.2.3', 'fb.2.5',
  ],
  charge: [
    '2.1', '2.7', '2.8', '2.9',
    '5.5',
    '7.2',
    '8.5', '8.6',
    'fb.1.1', 'fb.1.2', 'fb.1.3', 'fb.1.4', 'fb.1.5',
    'fb.2.4',
    'fb.3.1', 'fb.3.2',
  ],
  chargeDetail: ['4.2', 'fb.3.3'],
  full: ['2.3', '2.4', '5.1', '5.2', '5.3', '5.4', '5.6', '5.7'],
  detail: ['fb.3.4'],
}

describe('профили позиций', () => {
  it('распределение по профилям — ровно подтверждённое: 31 / 16 / 2 / 8 / 1', () => {
    expect(PROFILE_OF.none).toHaveLength(31)
    expect(PROFILE_OF.charge).toHaveLength(16)
    expect(PROFILE_OF.chargeDetail).toHaveLength(2)
    expect(PROFILE_OF.full).toHaveLength(8)
    expect(PROFILE_OF.detail).toHaveLength(1)

    for (const [profile, keys] of Object.entries(PROFILE_OF)) {
      for (const key of keys) {
        expect(serviceItemByKey(key)?.profile, `${key} должна быть ${profile}`).toBe(profile)
      }
    }
  })

  it('пять групп разбивают все 58 ключей ровно: без пропусков и без повторов', () => {
    const listed = Object.values(PROFILE_OF).flat()
    expect(listed).toHaveLength(58)
    expect(new Set(listed).size).toBe(listed.length)
    expect(new Set(listed)).toEqual(new Set(SERVICE_ITEMS.map((i) => i.key)))
  })

  // Каждое значение PROFILE_ATTRIBUTES — подмножество SERVICE_ATTRIBUTES без
  // `available` и в ЕГО порядке. Тип (`satisfies`) держит подмножество на
  // компиляции; порядок и «available не в профиле» — только здесь. Порядок
  // несущий: карточка, показ ревьюеру и выгрузка обходят атрибуты в одном
  // порядке именно потому, что все читают `SERVICE_ATTRIBUTES`.
  it('атрибуты каждого профиля — подмножество SERVICE_ATTRIBUTES без available, в его порядке', () => {
    for (const [profile, attributes] of Object.entries(PROFILE_ATTRIBUTES)) {
      expect(attributes, profile).not.toContain('available')
      const positions = attributes.map((a) => SERVICE_ATTRIBUTES.indexOf(a))
      expect(positions, profile).not.toContain(-1)
      expect(positions, profile).toEqual([...positions].sort((a, b) => a - b))
    }
    // Все пять профилей населены реальными позициями — иначе профиль без
    // позиций был бы мёртвой ветвью, а не правилом.
    for (const profile of Object.keys(PROFILE_ATTRIBUTES) as ServiceProfile[]) {
      expect(SERVICE_ITEMS.some((i) => i.profile === profile), profile).toBe(true)
    }
  })

  // Согласованность схемы: подсказка «If yes, please specify …» — вопрос,
  // ответ на который пишется в `details`. Профиль без `details` у позиции с
  // подсказкой оставил бы вопрос без поля для ответа — подсказка стала бы
  // текстом ни о чём, а `requiredAttributesFor` требовал бы атрибут, которого
  // карточка не рисует.
  it('у каждой позиции с подсказкой «уточните» в профиле есть details', () => {
    const hinted = SERVICE_ITEMS.filter((i) => i.hint !== null)
    expect(hinted.length).toBeGreaterThan(0)
    for (const item of hinted) {
      expect(PROFILE_ATTRIBUTES[item.profile], `${item.key} (${item.profile})`).toContain('details')
    }
  })

  it('needsPass2 — «профиль не none»: none закрывается первым проходом', () => {
    for (const item of SERVICE_ITEMS) {
      expect(needsPass2(item), item.key).toBe(item.profile !== 'none')
    }
  })
})

describe('attributeApplies / applicableAttributes', () => {
  const air = serviceItemByKey('1.1')! // none
  const wifi = serviceItemByKey('2.1')! // charge
  const massage = serviceItemByKey('5.4')! // full
  const hours = serviceItemByKey('fb.3.4')! // detail

  it('available применим всегда — и к непредложенной, и к none', () => {
    expect(attributeApplies(air, 'available', null)).toBe(true)
    expect(attributeApplies(air, 'available', 'no')).toBe(true)
    expect(attributeApplies(wifi, 'available', 'yes')).toBe(true)
  })

  it('к непредложенной позиции ни один атрибут второго прохода не применим', () => {
    for (const available of [null, undefined, '', 'no']) {
      expect(applicableAttributes(massage, available), String(available)).toEqual([])
    }
  })

  it('к предложенной — ровно атрибуты её профиля, в порядке SERVICE_ATTRIBUTES', () => {
    expect(applicableAttributes(air, 'yes')).toEqual([])
    expect(applicableAttributes(wifi, 'yes')).toEqual(['chargeType', 'price', 'currency'])
    expect(applicableAttributes(hours, 'yes')).toEqual(['details'])
    expect(applicableAttributes(massage, 'yes')).toEqual([
      'chargeType', 'price', 'currency', 'slotMinutes', 'bookingRequired', 'details',
    ])
    for (const item of SERVICE_ITEMS) {
      expect(applicableAttributes(item, 'yes'), item.key).toEqual([...PROFILE_ATTRIBUTES[item.profile]])
    }
  })

  it('слот у charge-позиции и chargeType у detail-позиции — не применимы', () => {
    expect(attributeApplies(wifi, 'slotMinutes', 'yes')).toBe(false)
    expect(attributeApplies(wifi, 'details', 'yes')).toBe(false)
    expect(attributeApplies(hours, 'chargeType', 'yes')).toBe(false)
  })
})

describe('requiredAttributesFor', () => {
  const air = serviceItemByKey('1.1')! // none
  const wifi = serviceItemByKey('2.1')! // charge, без подсказки
  const wheelchair = serviceItemByKey('4.2')! // chargeDetail, без подсказки
  const premium = serviceItemByKey('fb.3.3')! // chargeDetail, с подсказкой
  const conference = serviceItemByKey('2.3')! // full, с подсказкой
  const massage = serviceItemByKey('5.4')! // full, без подсказки
  const hours = serviceItemByKey('fb.3.4')! // detail, с подсказкой

  it('непредложенная — ничего не требуется', () => {
    expect(requiredAttributesFor(wifi, { available: 'no', chargeType: 'chargeable' })).toEqual([])
    expect(requiredAttributesFor(wifi, { available: null })).toEqual([])
  })

  it('none — ничего сверх наличия', () => {
    expect(requiredAttributesFor(air, { available: 'yes' })).toEqual([])
  })

  it('charge — chargeType; цена и валюта — только когда chargeType их требует', () => {
    expect(requiredAttributesFor(wifi, { available: 'yes', chargeType: null })).toEqual(['chargeType'])
    expect(requiredAttributesFor(wifi, { available: 'yes', chargeType: 'complimentary' })).toEqual(['chargeType'])
    expect(requiredAttributesFor(wifi, { available: 'yes', chargeType: 'chargeable' })).toEqual([
      'chargeType', 'price', 'currency',
    ])
    expect(requiredAttributesFor(wifi, { available: 'yes', chargeType: 'both' })).toEqual([
      'chargeType', 'price', 'currency',
    ])
  })

  // Решение о `details`: обязателен, когда его спрашивает профиль И у позиции
  // есть подсказка — подсказка и есть вопрос («please specify …»). Без
  // подсказки textarea «Прочее» остаётся необязательным, каким бы ни был
  // профиль. См. довод у самой функции.
  it('details обязателен ровно у позиций с подсказкой — в любом профиле, где он есть', () => {
    expect(requiredAttributesFor(hours, { available: 'yes' })).toEqual(['details'])
    expect(requiredAttributesFor(premium, { available: 'yes', chargeType: 'complimentary' })).toEqual([
      'chargeType', 'details',
    ])
    expect(requiredAttributesFor(conference, { available: 'yes', chargeType: 'complimentary' })).toEqual([
      'chargeType', 'details',
    ])
    expect(requiredAttributesFor(wheelchair, { available: 'yes', chargeType: 'complimentary' })).toEqual([
      'chargeType',
    ])
    expect(requiredAttributesFor(massage, { available: 'yes', chargeType: 'complimentary' })).toEqual([
      'chargeType',
    ])
  })

  it('требуемое — всегда подмножество применимого, у каждой позиции и любого chargeType', () => {
    for (const item of SERVICE_ITEMS) {
      for (const chargeType of [null, 'complimentary', 'chargeable', 'both']) {
        const applicable = applicableAttributes(item, 'yes')
        for (const required of requiredAttributesFor(item, { available: 'yes', chargeType })) {
          expect(applicable, `${item.key}/${chargeType}: ${required}`).toContain(required)
        }
      }
    }
  })
})

describe('serviceItemAnswered', () => {
  const wifi = serviceItemByKey('2.1')! // charge
  const air = serviceItemByKey('1.1')! // none
  const hours = serviceItemByKey('fb.3.4')! // detail, с подсказкой
  const conference = serviceItemByKey('2.3')! // full, с подсказкой
  const massage = serviceItemByKey('5.4')! // full, без подсказки

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

  it('none: «да» первого прохода закрывает позицию — chargeType не нужен', () => {
    expect(serviceItemAnswered(air, { available: 'yes', chargeType: null })).toBe(true)
  })

  it('charge с платным chargeType — нужны ещё цена и валюта', () => {
    const chargeable = { available: 'yes', chargeType: 'chargeable' }
    expect(serviceItemAnswered(wifi, chargeable)).toBe(false)
    expect(serviceItemAnswered(wifi, { ...chargeable, price: 10, currency: 'EUR' })).toBe(true)
    expect(serviceItemAnswered(wifi, { ...chargeable, price: 10, currency: '  ' })).toBe(false)
  })

  it('detail с подсказкой: предложено без details — не отвечено; с details — отвечено', () => {
    expect(serviceItemAnswered(hours, { available: 'yes', details: null })).toBe(false)
    expect(serviceItemAnswered(hours, { available: 'yes', details: '' })).toBe(false)
    expect(serviceItemAnswered(hours, { available: 'yes', details: '10:00–22:00' })).toBe(true)
  })

  it('full с подсказкой требует details; full без подсказки — нет', () => {
    const free = { available: 'yes', chargeType: 'complimentary' }
    expect(serviceItemAnswered(conference, free)).toBe(false)
    expect(serviceItemAnswered(conference, { ...free, details: '12 seats' })).toBe(true)
    expect(serviceItemAnswered(massage, free)).toBe(true)
  })
})
