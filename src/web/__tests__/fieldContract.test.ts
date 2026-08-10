import { describe, it, expect } from 'vitest'
import {
  FIELDS,
  OPTION_LISTS,
  validateField,
  validateServiceValue,
  fieldByKey,
  serviceItemByKey,
  type Field,
  type SelectValue,
} from '@/form-schema'
import { numberFieldValue } from '../FieldInput'

/**
 * The whole-branch review's central finding: every task-scoped review looked
 * at either the schema/validator or the renderer, never both — so nothing
 * ever asked "can `FieldInput` actually PRODUCE a value that `validateField`
 * will accept?" `validation.test.ts` pins the validator's own rules (e.g.
 * "III.2.4 requires a detail for 'specific'") entirely from the validator's
 * side, with hand-built `SelectValue`s that assume a detail box exists to
 * type into. This file starts from the other side instead: for every real
 * field and every one of its option list's options, build the BEST value
 * the UI's own controls could ever emit, and check the schema actually
 * accepts it. It needs no DOM — every value here is exactly what a
 * `onChange` handler in `FieldInput.tsx` constructs, computed the same way,
 * never rendered.
 *
 * This is the test that would have caught Critical 1 before it shipped:
 * `III.2.4`'s `airlineAccess` options are both `plain()` (`requiresDetail:
 * false`), so before this fix `FieldInput` never rendered a detail box for
 * either — meaning `{ option: 'specific', detail: null }` was the BEST value
 * the UI could ever produce for that option, and the validator refused it
 * forever. 155 other passing tests never noticed because none of them asked
 * this particular question.
 */
describe('контракт FieldInput ↔ validateField', () => {
  function fakeField(over: Partial<Field>): Field {
    return {
      key: 'fake.field',
      section: 'III',
      block: 'III.1',
      type: 'select',
      label: { en: 'Fake field', ru: 'Тестовое поле' },
      hint: null,
      example: null,
      required: false,
      optionList: null,
      templateText: null,
      templateSlots: [],
      detailRequiredFor: [],
      ...over,
    }
  }

  describe('select-family: каждый вариант каждого поля', () => {
    const selectFields = FIELDS.filter(
      (f) => f.type === 'select' || f.type === 'select_with_detail',
    )

    it('в анкете действительно есть select-поля (иначе тест ничего не проверяет)', () => {
      expect(selectFields.length).toBeGreaterThan(0)
    })

    it('для каждого варианта существует значение, которое реально может отправить FieldInput и которое проходит валидацию', () => {
      for (const field of selectFields) {
        const options = field.optionList ? OPTION_LISTS[field.optionList] : []
        for (const option of options) {
          // Exactly the condition `FieldInput.tsx` uses to decide whether it
          // renders a detail `<textarea>` at all: `option.requiresDetail`
          // (the list's own flag) OR `field.detailRequiredFor` (this
          // field's own override — see Critical 1). If neither is true, the
          // UI never offers a way to type a detail, so `detail` can only
          // ever be `null` for this option — that must still be enough.
          const needsDetail =
            option.requiresDetail || field.detailRequiredFor.includes(option.id)

          const value: SelectValue = {
            option: option.id,
            detail: needsDetail ? 'operator-entered detail' : null,
          }
          // The compound-slot UI (`field-compound`) renders unconditionally
          // whenever the field has template slots, regardless of which
          // option is chosen — see `FieldInput.tsx`'s `select_with_detail`
          // case — so a value with every slot filled is always something
          // the UI can produce, for any option.
          if (field.templateSlots.length > 0) {
            value.slots = Object.fromEntries(field.templateSlots.map((s) => [s.key, 1]))
          }

          const result = validateField(field, value)
          expect(result.ok, `${field.key} / option "${option.id}"`).toBe(true)
        }
      }
    })
  })

  describe('очистка select-поля (I3)', () => {
    it('обязательное select-поле, возвращённое к «—», отказывает как «обязательно», а не как «неизвестный вариант»', () => {
      const selectFields = FIELDS.filter(
        (f) => f.type === 'select' || f.type === 'select_with_detail',
      )
      for (const field of selectFields) {
        // Every real select field in the questionnaire is required — this
        // loop exercises them all rather than picking one, because the bug
        // was in `validateSelect` itself, not in any one field's data.
        expect(field.required, field.key).toBe(true)

        const result = validateField(field, { option: '', detail: null })
        expect(result.ok, field.key).toBe(false)
        // The distinguishing signal: before the fix this was `UNKNOWN_OPTION`
        // ("Unknown option"), not `REQUIRED` — both are `ok: false`, but only
        // one is the truth about what happened (the operator answered
        // nothing, not something unrecognised).
        if (!result.ok) {
          expect(result.error.en, field.key).toBe('This field is required')
        }
      }
    })

    it('необязательное select-поле, возвращённое к «—», валидно (в анкете таких полей нет — синтетическая фикстура)', () => {
      const fake = fakeField({ type: 'select', optionList: 'yesNo', required: false })
      const result = validateField(fake, { option: '', detail: null })
      expect(result.ok).toBe(true)
    })
  })

  describe('очистка позиции услуг до «—» (I3, серверная сторона)', () => {
    const cleared = {
      available: '',
      chargeType: null,
      price: null,
      currency: null,
      slotMinutes: null,
      bookingRequired: null,
      details: null,
    }

    it('бинарная позиция (yesNo), снятая обратно до «—», проходит валидацию', () => {
      const item = serviceItemByKey('2.1') // Wifi Access
      if (!item) throw new Error('нет позиции 2.1')
      expect(validateServiceValue(item, cleared).ok).toBe(true)
    })

    it('позиция со своим списком (vaping), снятая обратно до «—», проходит валидацию', () => {
      const item = serviceItemByKey('8.3') // Vaping policy — own list
      if (!item) throw new Error('нет позиции 8.3')
      expect(validateServiceValue(item, cleared).ok).toBe(true)
    })
  })

  describe('очистка числового поля не должна тихо становиться 0 (I4)', () => {
    const numberFields = FIELDS.filter((f) => f.type === 'number')

    it('в анкете действительно есть числовые поля (иначе тест ничего не проверяет)', () => {
      expect(numberFields.length).toBeGreaterThan(0)
    })

    it('документирует ловушку: Number(\'\") приводит пустую строку к 0, который проходит как настоящий ответ', () => {
      expect(Number('')).toBe(0)
      const field = fieldByKey('I.14') // Tax Chargeable (%) — required
      if (!field) throw new Error('нет поля I.14')
      // `0` genuinely is a valid non-negative number, so `validateField`
      // has no way to tell "the operator answered zero" apart from "the
      // box got emptied" once it's already a bare `0` — that distinction
      // has to be made before the value ever reaches `validateField`, which
      // is exactly what `numberFieldValue` does.
      expect(validateField(field, 0).ok).toBe(true)
    })

    it('numberFieldValue возвращает null на пустой строке, а не 0', () => {
      expect(numberFieldValue('')).toBeNull()
      expect(numberFieldValue('250')).toBe(250)
    })

    it('очищенный (через numberFieldValue) обязательный числовой ввод отклоняется как «обязательно», а не принимается как 0', () => {
      for (const field of numberFields) {
        expect(field.required, field.key).toBe(true)
        const emptied = numberFieldValue('')
        expect(emptied, field.key).toBeNull()
        const result = validateField(field, emptied)
        expect(result.ok, field.key).toBe(false)
      }
    })
  })

  describe('очистка остальных типов полей (для полноты контракта)', () => {
    it('multi_select, доведённый до пустого массива', () => {
      for (const field of FIELDS.filter((f) => f.type === 'multi_select')) {
        const result = validateField(field, [])
        expect(result.ok, field.key).toBe(!field.required)
      }
    })

    it('text/textarea, очищенные до пустой строки', () => {
      for (const field of FIELDS.filter((f) => f.type === 'text' || f.type === 'textarea')) {
        const result = validateField(field, '')
        expect(result.ok, field.key).toBe(!field.required)
      }
    })

    it('date, очищенное до пустой строки', () => {
      for (const field of FIELDS.filter((f) => f.type === 'date')) {
        const result = validateField(field, '')
        expect(result.ok, field.key).toBe(!field.required)
      }
    })

    it('template, каждый слот очищен через numberFieldValue', () => {
      for (const field of FIELDS.filter((f) => f.type === 'template')) {
        const slots = Object.fromEntries(
          field.templateSlots.map((slot) => [slot.key, numberFieldValue('')]),
        )
        const result = validateField(field, slots)
        expect(result.ok, field.key).toBe(!field.required)
      }
    })
  })
})
