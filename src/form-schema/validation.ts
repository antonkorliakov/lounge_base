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
const NOT_A_NUMBER = fail(
  'Enter a non-negative number',
  'Введите неотрицательное число',
)
/**
 * Reserved for a value that is expected to be text (a select's clarifying
 * `detail`, a service's `currency`) but arrives as some other JSON type
 * (number, boolean, array, object). All of this module's inputs are treated
 * as arbitrary client JSON, never as pre-validated `SelectValue`/
 * `ServiceValueInput` shapes — so a `.trim()` on the wrong type must fail,
 * never throw.
 */
const EXPECTED_TEXT = fail('Expected text', 'Ожидается текст')
const DUPLICATE_OPTION = fail(
  'Remove duplicate selections',
  'Уберите повторяющиеся варианты',
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

/**
 * Trimmed string for a string input; `null` for anything else. Never
 * throws — the sole guard between arbitrary client JSON and `.trim()`.
 */
function asText(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null
}

/** True for the three ways a value can mean "nothing answered yet". */
function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === ''
}

/**
 * The one non-negative-number rule shared by the plain `number` field, every
 * template slot, and the `III.3.2` compound slot. No coercion: `'3'`,
 * `true`, `[5]`, `NaN` and `Infinity` all fail — only an actual finite,
 * non-negative `number` passes.
 */
function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
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

  const byOption = DETAIL_REQUIRED_BY_OPTION[field.key] ?? []
  const needsDetail = chosen.requiresDetail || byOption.includes(chosen.id)

  if (needsDetail) {
    if (value.detail === null || value.detail === undefined) return DETAIL_REQUIRED
    const detail = asText(value.detail)
    if (detail === null) return EXPECTED_TEXT
    if (detail === '') return DETAIL_REQUIRED
  }

  // Составное поле: выбранный вариант может требовать слоты шаблона.
  const slotsRequiredFor = TEMPLATE_REQUIRED_BY_OPTION[field.key] ?? []
  if (slotsRequiredFor.includes(chosen.id)) {
    const slots = value.slots ?? {}
    for (const slot of field.templateSlots) {
      const filled = slots[slot.key]
      if (isEmpty(filled)) return REQUIRED
      if (!isNonNegativeNumber(filled)) return NOT_A_NUMBER
    }
  }

  return ok
}

function validateTemplate(field: Field, value: unknown): ValidationResult {
  const slots = field.templateSlots
  const record = (value ?? {}) as TemplateValue

  for (const slot of slots) {
    const filled = record[slot.key]
    if (isEmpty(filled)) {
      return field.required ? REQUIRED : ok
    }
    if (!isNonNegativeNumber(filled)) {
      return NOT_A_NUMBER
    }
  }
  return ok
}

/**
 * Every element must be a string that names one of the field's own option
 * ids, and no id may repeat — the same zone selected twice is malformed
 * input, not a legitimate double vote.
 */
function validateMultiSelect(field: Field, value: unknown): ValidationResult {
  const list = Array.isArray(value) ? value : null
  if (list === null || list.length === 0) {
    return field.required ? REQUIRED : ok
  }

  const options = field.optionList ? OPTION_LISTS[field.optionList] : []
  const seen = new Set<string>()
  for (const entry of list) {
    if (typeof entry !== 'string' || !options.some((o) => o.id === entry)) {
      return UNKNOWN_OPTION
    }
    if (seen.has(entry)) return DUPLICATE_OPTION
    seen.add(entry)
  }
  return ok
}

/**
 * Compile-time exhaustiveness guard: if `FieldType` ever grows a member
 * without a matching `case` in `validateField`, `field.type` stops
 * narrowing to `never` here and `tsc` fails the build — instead of the new
 * type silently falling through to the plain-text branch at runtime.
 */
function assertNeverFieldType(type: never): never {
  throw new Error(`Unhandled field type: ${JSON.stringify(type)}`)
}

export function validateField(field: Field, value: unknown): ValidationResult {
  switch (field.type) {
    case 'select':
    case 'select_with_detail':
      return validateSelect(field, value)

    case 'multi_select':
      return validateMultiSelect(field, value)

    case 'template':
      return validateTemplate(field, value)

    case 'number': {
      if (isEmpty(value)) return field.required ? REQUIRED : ok
      return isNonNegativeNumber(value) ? ok : NOT_A_NUMBER
    }

    case 'date': {
      const text = asText(value) ?? ''
      if (text === '') return field.required ? REQUIRED : ok
      return ISO_DATE.test(text)
        ? ok
        : fail('Use the date picker', 'Выберите дату в календаре')
    }

    case 'text':
    case 'textarea': {
      const text = asText(value) ?? ''
      return field.required && text === '' ? REQUIRED : ok
    }

    default:
      return assertNeverFieldType(field.type)
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
    if (!isNonNegativeNumber(value.price)) {
      return fail('Price is required for a chargeable service', 'Для платной услуги нужна цена')
    }

    if (value.currency === null || value.currency === undefined) {
      return fail('Specify the currency', 'Укажите валюту')
    }
    const currency = asText(value.currency)
    if (currency === null) return EXPECTED_TEXT
    if (currency === '') {
      return fail('Specify the currency', 'Укажите валюту')
    }
  }

  if (
    value.slotMinutes !== null &&
    value.slotMinutes !== undefined &&
    !isNonNegativeNumber(value.slotMinutes)
  ) {
    return NOT_A_NUMBER
  }

  return ok
}
