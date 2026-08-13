import type { Localized } from './types'
import type { OptionListId } from './option-lists'
import type { ServiceValueInput } from './validation'
import { OPTION_LISTS } from './option-lists'

/**
 * Матрица услуг и питания листа `Services & Amenities` исходного xlsx.
 * Английские подписи скопированы из колонки A дословно (см. golden fixture
 * `__tests__/fixtures/source-service-labels.json` и тест, сверяющий их
 * посимвольно). Русские переводы — наши, не из исходника.
 *
 * Нумерация позиций — собственная нумерация листа. У услуг (amenities) она
 * бесконфликтна (1.1 … 8.7), но у питания (F&B) лист использует те же самые
 * номера групп (1. Meal Types, 2. Special Meal Options, 3. Beverages), из-за
 * чего "1.1" встречается и там, и там. Чтобы ключи позиций были уникальны
 * по всей матрице, у ключей питания префикс `fb.` (`fb.1.1`).
 */

export type ServiceKind = 'amenity' | 'food'

export type ServiceGroup = {
  key: string
  kind: ServiceKind
  label: Localized
  /** Ключ блока проверки, см. Task 5. */
  block: string
}

export type ServiceItem = {
  key: string
  group: string
  kind: ServiceKind
  label: Localized
  /** Уточняющая подсказка из колонки G, если есть. */
  hint: Localized | null
  /** Список для колонки «наличие». По умолчанию да/нет. */
  availabilityList: OptionListId
}

/**
 * Атрибуты одной позиции услуг — в порядке, в котором их обходит всякий, кто
 * идёт по позиции атрибут за атрибутом (плоская выгрузка, `src/export/columns.ts`).
 *
 * СПИСОК НЕ ВЫПИСАН РУКАМИ ВТОРОЙ РАЗ. Он получается из объекта, чей тип —
 * `Record<keyof ServiceValueInput, true>`, то есть компилятор требует ровно
 * ключи сохраняемого значения позиции: пропущенный атрибут — ошибка «property
 * is missing», лишний — ошибка «excess property». Раньше список был написан
 * отдельно от `ServiceValueInput` и **терял `details`** — семь полей в типе и в
 * таблице `service_values`, шесть здесь. Пока константа никем не
 * использовалась, расхождение было безобидным; плоская выгрузка делает её
 * несущей, а `details` — это то место, куда пишется ответ на подсказку позиции
 * («If yes, please specify the capacity» у `Conference Room`, `VIP / Private
 * Meeting Room`, `Sleeping Area / Pods`; «please specify drinks» у `Premium
 * Alcohol`; «please specify hours» у `Alcohol Service Hours`). Для этих позиций
 * содержательный ответ живёт только в `details`, так что список из шести
 * молча выкинул бы из выгрузки именно то, о чём спрашивает вопрос. Та же
 * ошибка уже случалась в этой ветке дважды: `details` забыли в обнулении
 * закрытой позиции (`submissions/values.ts`) и в показе ревьюеру
 * (`web/renderValues.ts`).
 *
 * `import type` — не обычный импорт: `validation.ts` импортирует значения
 * отсюда, и обратная ссылка на ТИП стирается при компиляции, поэтому цикла
 * модулей во время выполнения не возникает.
 *
 * Проверка типом — только половина. Вторая половина — тест, сверяющий этот
 * список с настоящими колонками `service_values`
 * (`src/export/__tests__/columns.test.ts`): тип и таблица объявлены в разных
 * файлах, и добавленная в таблицу колонка сама по себе не заставит `tsc`
 * ругнуться здесь.
 */
const ATTRIBUTE_ORDER = {
  available: true,
  chargeType: true,
  price: true,
  currency: true,
  slotMinutes: true,
  bookingRequired: true,
  details: true,
} satisfies Record<keyof ServiceValueInput, true>

export type ServiceAttribute = keyof ServiceValueInput

export const SERVICE_ATTRIBUTES: readonly ServiceAttribute[] = Object.keys(
  ATTRIBUTE_ORDER,
) as (keyof typeof ATTRIBUTE_ORDER)[]

export const SERVICE_GROUPS: ServiceGroup[] = [
  { key: 'a1', kind: 'amenity', block: 'svc.a1', label: { en: 'Comfort & Environment', ru: 'Комфорт и обстановка' } },
  { key: 'a2', kind: 'amenity', block: 'svc.a2', label: { en: 'Connectivity & Business', ru: 'Связь и работа' } },
  { key: 'a3', kind: 'amenity', block: 'svc.a3', label: { en: 'Information & Announcements', ru: 'Информация и объявления' } },
  { key: 'a4', kind: 'amenity', block: 'svc.a4', label: { en: 'Special Assistance', ru: 'Особые потребности' } },
  { key: 'a5', kind: 'amenity', block: 'svc.a5', label: { en: 'Rest & Relaxation / Spa', ru: 'Отдых и спа' } },
  { key: 'a6', kind: 'amenity', block: 'svc.a6', label: { en: 'Family & Children Facilities', ru: 'Семья и дети' } },
  { key: 'a7', kind: 'amenity', block: 'svc.a7', label: { en: 'Hygiene & Sanitary', ru: 'Гигиена' } },
  { key: 'a8', kind: 'amenity', block: 'svc.a8', label: { en: 'Additional Facilities', ru: 'Дополнительно' } },
  { key: 'f1', kind: 'food', block: 'svc.f1', label: { en: 'Meal Types', ru: 'Виды питания' } },
  { key: 'f2', kind: 'food', block: 'svc.f2', label: { en: 'Special Meal Options', ru: 'Специальное питание' } },
  { key: 'f3', kind: 'food', block: 'svc.f3', label: { en: 'Beverages', ru: 'Напитки' } },
]

const amenity = (
  key: string,
  group: string,
  en: string,
  ru: string,
  extra: Partial<Pick<ServiceItem, 'hint' | 'availabilityList'>> = {},
): ServiceItem => ({
  key,
  group,
  kind: 'amenity',
  label: { en, ru },
  hint: extra.hint ?? null,
  availabilityList: extra.availabilityList ?? 'yesNo',
})

const food = (
  key: string,
  group: string,
  en: string,
  ru: string,
  hint: Localized | null = null,
): ServiceItem => ({
  key: `fb.${key}`,
  group,
  kind: 'food',
  label: { en, ru },
  hint,
  availabilityList: 'yesNo',
})

const specifyCapacity: Localized = {
  en: 'If yes, please specify the capacity',
  ru: 'Если да, укажите вместимость',
}

export const SERVICE_ITEMS: ServiceItem[] = [
  // 1. Comfort & Environment
  amenity('1.1', 'a1', 'Air Conditioning', 'Кондиционирование'),
  amenity('1.2', 'a1', 'Runway View', 'Вид на взлётную полосу'),
  amenity('1.3', 'a1', 'Grand View Area', 'Панорамная зона'),
  amenity('1.4', 'a1', 'Quiet Zone / Silent Area', 'Тихая зона'),
  amenity('1.5', 'a1', 'Television', 'Телевизор'),
  amenity('1.6', 'a1', 'Cinema / Media Room', 'Кинозал / медиакомната'),
  amenity('1.7', 'a1', 'Newspaper/Magazines', 'Газеты и журналы'),

  // 2. Connectivity & Business
  amenity('2.1', 'a2', 'Wifi Access', 'Доступ к Wi-Fi'),
  amenity('2.2', 'a2', 'Workstations / Work Area', 'Рабочие места / зона для работы'),
  amenity('2.3', 'a2', 'Conference Room', 'Конференц-зал', { hint: specifyCapacity }),
  amenity('2.4', 'a2', 'VIP / Private Meeting Room', 'VIP / приватная переговорная', { hint: specifyCapacity }),
  amenity('2.5', 'a2', 'Charging Stations', 'Зарядные станции'),
  amenity('2.6', 'a2', 'USB Ports Available', 'USB-разъёмы'),
  amenity('2.7', 'a2', 'Telephone Calls', 'Телефонные звонки'),
  amenity('2.8', 'a2', 'Fax Services', 'Факс'),
  amenity('2.9', 'a2', 'Printers & Copiers', 'Принтеры и копиры'),

  // 3. Information & Announcements
  amenity('3.1', 'a3', 'Flight information Monitor', 'Табло информации о рейсах'),
  amenity('3.2', 'a3', 'Boarding Announcements / Reminder', 'Объявления о посадке / напоминания'),
  amenity('3.3', 'a3', 'Train Boarding Reminder', 'Напоминание о посадке на поезд'),

  // 4. Special Assistance
  amenity('4.1', 'a4', 'Disabled Access', 'Доступ для людей с инвалидностью'),
  amenity('4.2', 'a4', 'Wheelchair Assistance Available', 'Помощь с инвалидной коляской'),
  amenity('4.3', 'a4', 'Disabled Shower', 'Душ для людей с инвалидностью'),
  amenity('4.4', 'a4', 'Disabled Toilet', 'Туалет для людей с инвалидностью'),

  // 5. Rest & Relaxation / Spa
  amenity('5.1', 'a5', 'Sleeping Area / Pods', 'Зона сна / капсулы', { hint: specifyCapacity }),
  amenity('5.2', 'a5', 'Private Sleep Suite / Cabin', 'Приватная спальная сьют-кабина', { hint: specifyCapacity }),
  amenity('5.3', 'a5', 'Private Resting Room', 'Приватная комната отдыха', { hint: specifyCapacity }),
  amenity('5.4', 'a5', 'Massage', 'Массаж'),
  amenity('5.5', 'a5', 'Massage Chairs', 'Массажные кресла'),
  amenity('5.6', 'a5', 'SPA Treatment', 'SPA-процедуры'),
  amenity('5.7', 'a5', 'Nail Care Treatment', 'Маникюр / уход за ногтями'),

  // 6. Family & Children Facilities
  amenity('6.1', 'a6', 'Family Room', 'Семейная комната'),
  amenity('6.2', 'a6', 'Nursing Room', 'Комната для кормления'),
  amenity('6.3', 'a6', 'Baby Changing Facilities', 'Пеленальный столик'),
  amenity('6.4', 'a6', "Children's Play Area", 'Детская игровая зона'),

  // 7. Hygiene & Sanitary
  amenity('7.1', 'a7', 'Toilets (within the Premises)', 'Туалеты (в помещении)'),
  amenity('7.2', 'a7', 'Shower Facilities', 'Душевые'),
  amenity('7.3', 'a7', 'Washing Room', 'Умывальная комната'),

  // 8. Additional Facilities
  amenity('8.1', 'a8', 'Prayer Room', 'Молитвенная комната'),
  amenity('8.2', 'a8', 'Smoking Area / Room', 'Зона / комната для курения'),
  amenity('8.3', 'a8', 'Vaping / E-Cigarette Use Policy', 'Политика использования вейпов и электронных сигарет', {
    availabilityList: 'vaping',
  }),
  amenity('8.4', 'a8', 'No Smoking Lounge', 'Лаунж без курения'),
  amenity('8.5', 'a8', 'Game Room', 'Игровая комната'),
  amenity('8.6', 'a8', 'Luggage Storage', 'Хранение багажа'),
  amenity('8.7', 'a8', 'Digital Card Accepted', 'Приём цифровых карт'),

  // F&B 1. Meal Types
  food('1.1', 'f1', 'Hot Meals', 'Горячие блюда'),
  food('1.2', 'f1', 'Cold Meals', 'Холодные блюда'),
  food('1.3', 'f1', 'Snacks', 'Снеки'),
  food('1.4', 'f1', 'A La Carte Menu', 'Меню а-ля карт'),
  food('1.5', 'f1', 'Fresh Fruits', 'Свежие фрукты'),

  // F&B 2. Special Meal Options
  food('2.1', 'f2', 'Halal Options', 'Халяльные блюда'),
  food('2.2', 'f2', 'Vegetarian Options', 'Вегетарианские блюда'),
  food('2.3', 'f2', 'Vegan Options', 'Веганские блюда'),
  food('2.4', 'f2', 'Special Dietary Meals', 'Специальное диетическое питание'),
  food('2.5', 'f2', 'Allergen Information Available', 'Информация об аллергенах'),

  // F&B 3. Beverages
  food('3.1', 'f3', 'Non-Alcoholic Beverages (Hot/Cold)', 'Безалкогольные напитки (горячие/холодные)'),
  food('3.2', 'f3', 'Alcoholic Beverages', 'Алкогольные напитки'),
  food('3.3', 'f3', 'Premium Alcohol (e.g. Champagne)', 'Премиальный алкоголь (например, шампанское)', {
    en: 'If yes, please specify drinks',
    ru: 'Если да, укажите напитки',
  }),
  food('3.4', 'f3', 'Alcohol Service Hours', 'Часы подачи алкоголя', {
    en: 'If yes, please specify hours',
    ru: 'Если да, укажите часы',
  }),
]

export function serviceItemByKey(key: string): ServiceItem | undefined {
  return SERVICE_ITEMS.find((i) => i.key === key)
}

/**
 * Availability answer ids that close a service item without offering it —
 * "no" (the `yesNo` list) and "not_allowed" (every other availability list
 * a service item currently uses, e.g. `vaping`). Kept as the one place this
 * convention is spelled out — see `isOfferedAvailability` below, the
 * predicate every consumer should call instead of restating this list.
 */
const CLOSING_AVAILABILITY_IDS = ['no', 'not_allowed']

/**
 * True when `available` means "the lounge has this" — as opposed to
 * unanswered (`null`/`''`), an id that doesn't belong to this item's own
 * `availabilityList`, or a closing "no"/"not allowed" answer. Only an
 * offered item needs the pass-2 attributes (`chargeType`, `price`, ...) —
 * see `serviceItemAnswered` and `requiresPrice` below, and
 * `ServicesPass2.tsx`'s `offeredKeys` on the render side.
 *
 * This is the single place that rule lives now. Before the whole-branch
 * review's second round, the exact same `!['no', 'not_allowed'].includes
 * (...)` check was written out separately in `validation.ts` and in
 * `ServicesPass2.tsx` — in agreement only by accident, the same shape of
 * bug as Critical 1 (a rule the renderer and the validator each held
 * separately).
 */
export function isOfferedAvailability(
  item: ServiceItem,
  available: string | null | undefined,
): boolean {
  if (available == null || available === '') return false
  const options = OPTION_LISTS[item.availabilityList]
  const chosen = options.find((o) => o.id === available)
  if (!chosen) return false
  return !CLOSING_AVAILABILITY_IDS.includes(chosen.id)
}

/**
 * True when this item's availability question is a plain either/or — and
 * therefore rendered as a Yes|No toggle pair instead of a dropdown (see
 * `ServiceAvailabilityInput`).
 *
 * A predicate of this name existed once and was deliberately deleted when the
 * dropdown unified all 58 items — it picked between a checkbox and a select,
 * and the checkbox it guarded was the two-state control that could not say
 * "no" as distinct from "nothing said" (I2). This one guards a rendering that
 * CAN say all three (neither button pressed is a visible state), so the
 * predicate is legitimate again; what stays deliberate is where it lives (the
 * schema, next to the lists it reads) and what it reads: the option list's
 * CONTENT — exactly two options — never its name. A future two-option list
 * (`allowedNotAllowed` today, anything added later) gets the toggle pair
 * automatically and with its OWN labels, instead of behaving differently
 * from `yesNo` because a UI file compared list ids.
 */
export function isBinaryAvailability(item: ServiceItem): boolean {
  return OPTION_LISTS[item.availabilityList].length === 2
}

/**
 * True for the two `chargeType` ids that require a price and currency —
 * "chargeable" and "both". `requiresPrice(chargeType)` being false covers
 * both "complimentary" and "not yet answered" (`null`) alike — this
 * predicate says nothing about whether a price is *missing*, only whether
 * one would ever be required once the rest of the answer is complete.
 */
export function requiresPrice(chargeType: string | null | undefined): boolean {
  return chargeType === 'chargeable' || chargeType === 'both'
}

/**
 * Whether a service item counts as "answered" for completeness purposes —
 * used by both `missingItems` (`src/submissions/completeness.ts`) and the
 * contract test, so the two can never quietly disagree the way
 * `validation.ts`'s old "chargeType required" save-time gate and the
 * two-pass matrix's actual save path once did (Critical/R1, whole-branch
 * review second round).
 *
 * An item is answered once its availability is set at all; if it's also
 * *offered*, its `chargeType` must be set too. An offered item with no
 * chargeType yet is a well-formed, saveable, but INCOMPLETE answer — that
 * split (shape vs. readiness) is exactly `validateServiceValue` vs.
 * `missingItems`.
 */
export function serviceItemAnswered(
  item: ServiceItem,
  value: { available: string | null; chargeType: string | null } | null | undefined,
): boolean {
  if (value == null || value.available == null || value.available === '') return false
  if (!isOfferedAvailability(item, value.available)) return true
  return value.chargeType != null && value.chargeType !== ''
}
