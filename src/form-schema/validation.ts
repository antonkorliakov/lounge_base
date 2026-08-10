import type { Localized } from './types'
import type { Field } from './fields'
import type { ServiceItem } from './services'
import { OPTION_LISTS } from './option-lists'

export type ValidationResult = { ok: true } | { ok: false; error: Localized }

export type SelectValue = {
  option: string
  detail: string | null
  /** Только у составных полей — см. TEMPLATE_REQUIRED_BY_OPTION. */
  slots?: Record<string, number | null>
}
export type TemplateValue = Record<string, number | null>

export type ServiceValueInput = {
  available: string | null
  chargeType: string | null
  price: number | null
  currency: string | null
  slotMinutes: number | null
  bookingRequired: boolean | null
  details: string | null
}

const ok: ValidationResult = { ok: true }
const fail = (en: string, ru: string): ValidationResult => ({
  ok: false,
  error: { en, ru },
})

const REQUIRED = fail('This field is required', 'Поле обязательно')
const UNKNOWN_OPTION = fail('Unknown option', 'Неизвестный вариант')
const DETAIL_REQUIRED = fail(
  'Please specify the details',
  'Уточните, пожалуйста',
)

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Поля, где конкретный вариант обязывает заполнить уточнение. */
const DETAIL_REQUIRED_BY_OPTION: Record<string, string[]> = {
  'III.2.4': ['specific'],
}

/**
 * Составные поля: выбранный вариант обязывает заполнить слоты шаблона.
 * `III.3.2` — единственное такое поле в анкете: возраст нужен, только если
 * детей без сопровождения вообще пускают.
 */
const TEMPLATE_REQUIRED_BY_OPTION: Record<string, string[]> = {
  'III.3.2': ['allowed'],
}

function isSelectValue(value: unknown): value is SelectValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    'option' in value &&
    typeof (value as SelectValue).option === 'string'
  )
}

function validateSelect(field: Field, value: unknown): ValidationResult {
  if (!isSelectValue(value)) return field.required ? REQUIRED : ok

  const options = field.optionList ? OPTION_LISTS[field.optionList] : []
  const chosen = options.find((o) => o.id === value.option)
  if (!chosen) return UNKNOWN_OPTION

  const detail = value.detail?.trim() ?? ''
  const byOption = DETAIL_REQUIRED_BY_OPTION[field.key] ?? []
  const needsDetail = chosen.requiresDetail || byOption.includes(chosen.id)
  if (needsDetail && detail === '') return DETAIL_REQUIRED

  // Составное поле: выбранный вариант может требовать слоты шаблона.
  const slotsRequiredFor = TEMPLATE_REQUIRED_BY_OPTION[field.key] ?? []
  if (slotsRequiredFor.includes(chosen.id)) {
    const slots = value.slots ?? {}
    for (const slot of field.templateSlots) {
      const filled = slots[slot.key]
      if (filled === null || filled === undefined) return REQUIRED
      if (!Number.isFinite(filled) || filled < 0) {
        return fail('Enter a non-negative number', 'Введите неотрицательное число')
      }
    }
  }

  return ok
}

function validateTemplate(field: Field, value: unknown): ValidationResult {
  const slots = field.templateSlots
  const record = (value ?? {}) as TemplateValue

  for (const slot of slots) {
    const filled = record[slot.key]
    if (filled === null || filled === undefined) {
      return field.required ? REQUIRED : ok
    }
    if (!Number.isFinite(filled) || filled < 0) {
      return fail('Enter a non-negative number', 'Введите неотрицательное число')
    }
  }
  return ok
}

export function validateField(field: Field, value: unknown): ValidationResult {
  switch (field.type) {
    case 'select':
    case 'select_with_detail':
      return validateSelect(field, value)

    case 'multi_select': {
      const list = Array.isArray(value) ? value : []
      return field.required && list.length === 0 ? REQUIRED : ok
    }

    case 'template':
      return validateTemplate(field, value)

    case 'number': {
      if (value === null || value === undefined || value === '') {
        return field.required ? REQUIRED : ok
      }
      const parsed = Number(value)
      return Number.isFinite(parsed) && parsed >= 0
        ? ok
        : fail('Enter a non-negative number', 'Введите неотрицательное число')
    }

    case 'date': {
      const text = typeof value === 'string' ? value.trim() : ''
      if (text === '') return field.required ? REQUIRED : ok
      return ISO_DATE.test(text)
        ? ok
        : fail('Use the date picker', 'Выберите дату в календаре')
    }

    default: {
      const text = typeof value === 'string' ? value.trim() : ''
      return field.required && text === '' ? REQUIRED : ok
    }
  }
}

export function validateServiceValue(
  item: ServiceItem,
  value: ServiceValueInput,
): ValidationResult {
  const availability = OPTION_LISTS[item.availabilityList]
  const chosen = availability.find((o) => o.id === value.available)
  if (!chosen) return UNKNOWN_OPTION

  /** «Нет» и «не разрешено» закрывают позицию: остальные атрибуты не нужны. */
  const isOffered = !['no', 'not_allowed'].includes(chosen.id)
  if (!isOffered) return ok

  const charge = OPTION_LISTS.chargeType.find((o) => o.id === value.chargeType)
  if (!charge) {
    return fail(
      'Specify whether the service is complimentary or chargeable',
      'Укажите, бесплатная услуга или платная',
    )
  }

  if (charge.id === 'chargeable' || charge.id === 'both') {
    if (value.price === null || !Number.isFinite(value.price) || value.price < 0) {
      return fail('Price is required for a chargeable service', 'Для платной услуги нужна цена')
    }
    if (!value.currency || value.currency.trim() === '') {
      return fail('Specify the currency', 'Укажите валюту')
    }
  }

  if (
    value.slotMinutes !== null &&
    (!Number.isFinite(value.slotMinutes) || value.slotMinutes < 0)
  ) {
    return fail('Enter a non-negative number', 'Введите неотрицательное число')
  }

  return ok
}
