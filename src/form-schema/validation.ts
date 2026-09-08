import type { Localized } from './types'
import type { Field } from './fields'
import type { ServiceItem } from './services'
import { attributeApplies, isOfferedAvailability, requiredAttributesFor } from './services'
import { OPTION_LISTS } from './option-lists'
import { EMAIL_PLACEHOLDER, PHONE_PLACEHOLDER, isValidEmail, isValidPhone } from './contact'
import {
  cleaningComplete, cleaningProblem, weekHoursComplete, weekHoursProblem,
} from './schedule'

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
// Один текст на все нарушения формы расписания, а не текст на тег: оператор в
// браузере физически не может собрать сетку с пересечением или обратным
// временем (редактор такого не даёт), так что до этого отказа доходит только
// запись мимо интерфейса — старая вкладка или скрипт. Ему нужна честная
// причина, а не разбор какого именно правила; разбор есть у тегов
// `windowsProblem`, и он проверяется тестами схемы.
const INVALID_SCHEDULE = fail(
  'Check the schedule: times must run forward and windows must not overlap',
  'Проверьте расписание: время должно идти вперёд, интервалы не должны пересекаться',
)
const INVALID_CLEANING = fail(
  'Check the cleaning schedule: pick a cadence and set the times',
  'Проверьте график уборки: выберите периодичность и укажите время',
)
// Пример в отказе — тот же плейсхолдер, что стоит в поле (`contact.ts`):
// подсказка и пример под полем не могут разойтись.
const INVALID_PHONE = fail(
  `Enter the number in international format, e.g. ${PHONE_PLACEHOLDER}`,
  `Введите номер в международном формате, например ${PHONE_PLACEHOLDER}`,
)
const INVALID_EMAIL = fail(
  `Enter a valid email address, e.g. ${EMAIL_PLACEHOLDER}`,
  `Введите адрес почты, например ${EMAIL_PLACEHOLDER}`,
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

/**
 * True when choosing `optionId` on `field` requires the clarifying `detail`
 * text — either because the option itself is `requiresDetail` in
 * `option-lists.ts`, or because this particular field overrides it via
 * `field.detailRequiredFor` (see Critical 1, whole-branch review: `III.2.4`'s
 * `airlineAccess` options are both `plain()`, yet "specific airlines" is
 * meaningless unqualified).
 *
 * The single source both `validateSelect` and `FieldInput.tsx` call —
 * before the second review round this exact expression was written out in
 * both places (plus a third time in the contract test), agreeing only by
 * accident.
 */
export function needsDetail(field: Field, optionId: string): boolean {
  const options = field.optionList ? OPTION_LISTS[field.optionList] : []
  const option = options.find((o) => o.id === optionId)
  if (!option) return false
  return option.requiresDetail || field.detailRequiredFor.includes(option.id)
}

function validateSelect(field: Field, value: unknown): ValidationResult {
  if (!isSelectValue(value)) return field.required ? REQUIRED : ok

  // A dropdown returned to its `—` placeholder emits `{ option: '' }` — a
  // deliberate un-selection, not a malformed choice. Must be treated as
  // "nothing answered" (and checked against `required`) BEFORE the
  // membership lookup below, or a non-required field could never be cleared:
  // '' never matches any real option id, so it would otherwise always fall
  // through to UNKNOWN_OPTION regardless of `required`.
  if (value.option === '') return field.required ? REQUIRED : ok

  const options = field.optionList ? OPTION_LISTS[field.optionList] : []
  const chosen = options.find((o) => o.id === value.option)
  if (!chosen) return UNKNOWN_OPTION

  if (needsDetail(field, chosen.id)) {
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

    // Четыре случая, не три: `null` — то, во что редактор обзора превращает
    // снятый ответ (`undefined` на входе становится `null`, см.
    // `review/edit.ts`), так что пустота здесь — дело `required`, ровно как
    // у `text`/`date` ниже, а не формата. Не-строка, которая при этом НЕ
    // `null` (число, булево, массив, объект — произвольный JSON клиента) —
    // это уже не пустота, а рассинхронизация формата: `EXPECTED_TEXT`, вне
    // зависимости от `required`. Непустая строка неверного формата — вопрос
    // `contact.ts`.
    case 'phone': {
      if (value === null || value === undefined) return field.required ? REQUIRED : ok
      const text = asText(value)
      if (text === null) return EXPECTED_TEXT
      if (text === '') return field.required ? REQUIRED : ok
      return isValidPhone(text) ? ok : INVALID_PHONE
    }

    case 'email': {
      if (value === null || value === undefined) return field.required ? REQUIRED : ok
      const text = asText(value)
      if (text === null) return EXPECTED_TEXT
      if (text === '') return field.required ? REQUIRED : ok
      return isValidEmail(text) ? ok : INVALID_EMAIL
    }

    // Пустота — вопрос `required`; СТРОКА — старый ответ прежней версии
    // анкеты (свободный текст), он уже лежит в базе и отказом его не
    // «исправить»: поле просто считается незаполненным (`fieldAnswered`
    // ниже), пока оператор не введёт структуру. Всё остальное судит
    // `schedule.ts`.
    case 'weekHours': {
      if (value === null || value === undefined) return field.required ? REQUIRED : ok
      if (typeof value === 'string') return ok
      const options = field.hoursOptions
      if (!options) return INVALID_SCHEDULE
      return weekHoursProblem(value, options) === null ? ok : INVALID_SCHEDULE
    }

    case 'cleaningSchedule': {
      if (value === null || value === undefined) return field.required ? REQUIRED : ok
      if (typeof value === 'string') return ok
      return cleaningProblem(value) === null ? ok : INVALID_CLEANING
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
  // Same deliberate-un-selection rule as `validateSelect`: `ServicesPass1`
  // writes `available: ''` when the operator returns a dropdown item to its
  // placeholder, and `offeredKeys()` on the client already treats `''` as
  // "not offered" (see its own doc comment). The server must agree instead
  // of refusing a value the client itself considers valid and unanswered.
  if (value.available === '') return ok

  const availability = OPTION_LISTS[item.availabilityList]
  const chosen = availability.find((o) => o.id === value.available)
  if (!chosen) return UNKNOWN_OPTION

  if (!isOfferedAvailability(item, value.available)) return ok

  // From here on this is an OFFERED item. Everything below is an
  // internal-consistency rule — "if you gave me a chargeType, and it's one
  // that needs a price, the price/currency must actually be there" — not a
  // completeness rule. Whether a chargeType must be present AT ALL is no
  // longer checked here: `ServicesPass1` only ever sets `available` (it has
  // no chargeType control), so requiring one at save time made it
  // impossible to ever save the first of the two passes through the
  // services matrix — Pass 1's answer was refused forever and survived only
  // in React state (R1, whole-branch review second round). `chargeType:
  // null` on an offered item is now a valid, well-formed, INCOMPLETE
  // answer; `serviceItemAnswered`/`missingItems` is what later requires it
  // before the questionnaire can be submitted.
  //
  // Every check is gated on the item's PROFILE (`attributeApplies`): an
  // attribute the profile excludes is not judged here at all — not even for
  // shape. A value carrying one is tolerated, not refused, because the
  // client may legitimately still hold it (a legacy row loaded into the
  // form, a card whose availability was just flipped) and the writer blanks
  // it at the boundary (`serviceRowFromInput`). Refusing it would make a
  // stale attribute nobody can see or edit block the save of the ones they
  // can.
  const applies = (attribute: keyof ServiceValueInput): boolean =>
    attributeApplies(item, attribute, value.available)

  if (applies('chargeType') && value.chargeType !== null && value.chargeType !== undefined) {
    const charge = OPTION_LISTS.chargeType.find((o) => o.id === value.chargeType)
    if (!charge) return UNKNOWN_OPTION
  }

  // Price and currency are required exactly when `requiredAttributesFor`
  // says so — the same rule completeness reads (`serviceItemAnswered`), so
  // the door and the readiness check cannot name different conditions. Of
  // everything that rule can return, only these two are enforced HERE:
  // chargeType and details being absent is incompleteness (see above), while
  // "chargeable, but no price" is a self-contradictory answer.
  const required = requiredAttributesFor(item, value)
  if (required.includes('price') && !isNonNegativeNumber(value.price)) {
    return fail('Price is required for a chargeable service', 'Для платной услуги нужна цена')
  }
  if (required.includes('currency')) {
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
    applies('slotMinutes') &&
    value.slotMinutes !== null &&
    value.slotMinutes !== undefined &&
    !isNonNegativeNumber(value.slotMinutes)
  ) {
    return NOT_A_NUMBER
  }

  return ok
}

/**
 * Дан ли на поле ОТВЕТ, годный для отправки. Для прежних типов это «значение
 * не пусто» — правило, которое годами жило в `completeness.ts` как приватный
 * `isBlank`. Расписания сломали это равенство: сетка с одним заполненным днём
 * не пуста, но и не ответ, а старый свободный текст — ответ прежней версии
 * анкеты, который надо ввести заново структурой. Правило переехало сюда,
 * рядом с `validateField`, чтобы «что можно сохранить» и «что считается
 * отвеченным» стояли в одном модуле и не расходились.
 */
export function fieldAnswered(field: Field, value: unknown): boolean {
  if (field.type === 'weekHours') {
    return field.hoursOptions ? weekHoursComplete(value, field.hoursOptions) : false
  }
  if (field.type === 'cleaningSchedule') return cleaningComplete(value)

  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length === 0 ? false : true
  return true
}
