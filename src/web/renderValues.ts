import {
  FIELDS, SERVICE_ITEMS, PHOTO_SLOTS,
  type ServiceValueInput, type Field, type TemplateSlot,
} from '@/form-schema'

/**
 * Одна строка экрана проверки в готовом к показу виде.
 *
 * `value` необязателен, и это не «может быть пусто», а «у этого вида строки
 * текстового значения нет вообще»: фото-слоты несут только подпись, а их
 * содержимое рисует `FieldRow` из URL-ов (`ReviewScreen`'s `photos`). Раньше
 * здесь для фото-слотов лежала строка со счётчиком снимков ("3"), которую
 * никто не мог показать — `FieldRow` игнорирует `value`, когда получил
 * `photos`, а `photos` для этих ключей передаётся всегда. Вычислять значение,
 * которое невозможно отобразить, опасно именно на пути показа: следующий
 * читатель принимает его за живой путь — так и появился исходный дефект
 * «ревьюер видит счётчик вместо снимка».
 *
 * Тип экспортируется, чтобы `ReviewScreen` импортировал его, а не объявлял
 * ту же форму у себя вторым независимым описанием — эта ветка уже несколько
 * раз чинила ровно такое расхождение (`SaveResult`, `FLAG_REASONS`).
 */
export type RenderedCell = { label: string; value?: string }

/**
 * Плоское представление одной позиции услуг для показа ревьюеру.
 *
 * Черновик этой функции показывал только `available`/`chargeType`/`price`+
 * `currency` — и тем самым прятал `details`, `slotMinutes` и
 * `bookingRequired` целиком. Это не косметика: у нескольких позиций
 * (`Conference Room`, `VIP / Private Meeting Room`, `Sleeping Area / Pods`
 * — все несут `hint: specifyCapacity`, "If yes, please specify the
 * capacity"; `Premium Alcohol` — "please specify drinks"; `Alcohol Service
 * Hours` — "please specify hours", см. `form-schema/services.ts`) сам ответ
 * на подсказку пишется именно в `details`, а не в одно из трёх показанных
 * полей. Ревьюер, глядящий только на старую тройку, увидел бы "yes ·
 * chargeable · 50 USD" и не смог бы проверить, действительно ли оператор
 * указал вместимость/напитки/часы — то есть ту самую вещь, которую вопрос
 * и просит уточнить. `slotMinutes`/`bookingRequired` — тот же случай для
 * позиций с записью на слот (массаж, спа). Все шесть атрибутов показаны
 * здесь ради этого — не ради полноты как таковой.
 */
function formatServiceValue(
  value: ServiceValueInput | undefined,
  locale: 'en' | 'ru',
): string {
  const parts = [
    value?.available ?? '—',
    value?.chargeType ?? null,
    value?.price !== null && value?.price !== undefined
      ? `${value.price} ${value.currency ?? ''}`.trim()
      : null,
    value?.slotMinutes !== null && value?.slotMinutes !== undefined
      ? `${value.slotMinutes} ${locale === 'ru' ? 'мин' : 'min'}`
      : null,
    value?.bookingRequired === true
      ? (locale === 'ru' ? 'нужна запись' : 'booking required')
      : null,
    value?.details ? value.details : null,
  ]
  return parts.filter(Boolean).join(' · ')
}

/**
 * Плоское представление значений для показа ревьюеру.
 *
 * Живёт в собственном модуле без `'use client'` — не в `ReviewScreen.tsx` —
 * потому что вызывается из `page.tsx` (серверный компонент). Раньше эта
 * функция была экспортирована прямо из `ReviewScreen.tsx`, и `'use client'`
 * в начале того файла помечает КАЖДЫЙ его экспорт клиентской ссылкой —
 * включая чистую, не-React функцию вроде этой. Рантайм-фикс-раунда:
 * `page.tsx` реально падал на `Error: Attempted to call renderValues() from
 * the server but renderValues is on the client` — не гипотетически, экран
 * проверки не открывался вообще ни для одной анкеты. Ни `tsc`, ни `next
 * build`, ни `npm test` этого не ловили: граница `'use client'` — это
 * ограничение времени выполнения RSC, а не типов, и ни один из трёх гейтов
 * не рендерит эту страницу по-настоящему (`next build` собирает динамический
 * маршрут, не выполняя его; `e2e/fill.spec.ts` вообще не заходит на
 * `/admin/...`). Обнаружено вручную запуском `next dev` и реальным заходом
 * на `/admin/s/<id>` при проверке `after()` для этого же раунда фиксов —
 * см. отчёт задачи.
 */
export function renderValues(input: {
  fields: Record<string, unknown>
  services: Record<string, ServiceValueInput>
  locale: 'en' | 'ru'
}): Record<string, RenderedCell> {
  const out: Record<string, RenderedCell> = {}

  for (const field of FIELDS) {
    const raw = input.fields[field.key]
    out[field.key] = {
      label: field.label[input.locale],
      value: formatValue(raw, field, input.locale),
    }
  }

  for (const item of SERVICE_ITEMS) {
    out[item.key] = {
      label: item.label[input.locale],
      value: formatServiceValue(input.services[item.key], input.locale),
    }
  }

  // Только подпись: сами снимки идут в `FieldRow` отдельным путём (см.
  // `RenderedCell`). Цикл нужен ради подписи — `ReviewScreen` берёт её
  // отсюда для всех 27 блоков одинаково, включая блок фото.
  for (const slot of PHOTO_SLOTS) {
    out[slot.key] = { label: slot.label[input.locale] }
  }

  return out
}

/**
 * Проверяющая версия `typeof value === 'object'`: узнаёт настоящий объект
 * (не `null`, не массив) и после вызова сужает `value` до
 * `Record<string, unknown>` без единого `as`. `formatValue` ниже раньше
 * писал `raw as { option: string; ... }` и `raw as Record<string, unknown>`
 * сразу за проверкой одного-двух свойств — тот самый класс дефекта, который
 * эта ветка уже чинила четыре раза (`toFlagReason` в `review/flags.ts`,
 * `isSelectValue` в `form-schema/validation.ts`, `optionOf`/`stringArrayOf` в
 * `review/decide.ts`): со стороны показа нет способа увидеть гарантию формы,
 * которую даёт запись (`saveFieldValue`) — а неверная форма в базе (ручная
 * правка, будущий писатель с багом) должна читаться как "непохоже на
 * известную форму", а не выдаваться `as` за неё без проверки.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type SelectLike = {
  option: string
  detail: string | null
  slots: Record<string, number | null> | null
}

/**
 * `raw['option']` — единственное свойство, что делает значение "похожим на
 * `SelectValue`" (см. `form-schema/validation.ts`'s собственный
 * `isSelectValue`, ту же проверку). Возвращает `null`, а не полу-заполненный
 * объект, если `option` не строка — вызывающий тогда падает в общую ветку
 * "просто объект" ниже, а не рисует пустую/сломанную строку, притворяясь
 * составным полем.
 */
function asSelectLike(raw: Record<string, unknown>): SelectLike | null {
  const option = raw['option']
  if (typeof option !== 'string') return null

  const detail = raw['detail']
  const slots = raw['slots']

  return {
    option,
    detail: typeof detail === 'string' ? detail : null,
    slots: isPlainObject(slots) ? asNumberOrNullRecord(slots) : null,
  }
}

/**
 * `III.3.2` (Unaccompanied Children Policy) хранит свой минимальный возраст
 * в `slots.age` как `number | null` (см. `form-schema/validation.ts`'s
 * `SelectValue.slots`/`TEMPLATE_REQUIRED_BY_OPTION`) — единственное составное
 * поле анкеты. Значение, отличное от `number`, становится `null` (то есть
 * "не показывать"), а не `String(val)` вслепую: слот, куда что-то записалось
 * не числом, читался бы как содержательный ответ, хотя это не так.
 */
function asNumberOrNullRecord(value: Record<string, unknown>): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const [key, val] of Object.entries(value)) {
    out[key] = typeof val === 'number' ? val : null
  }
  return out
}

/**
 * Один слот шаблона словами: «3 hours», «12 years old». Единица берётся из
 * схемы (`TemplateSlot.unit`, см. `form-schema/fields.ts`) — там она уже
 * есть на двух языках именно для показа человеку, и её же видит оператор
 * рядом с полем ввода (`FieldInput`'s `template` ветка).
 *
 * `null` (то есть «не отвечено», в том же смысле, что и у
 * `asNumberOrNullRecord` выше) печатается как «—», а не пропускается и не
 * превращается в `String(null)`. Печатать пропуск важно: у `III.3.3` три
 * слота, и молча выброшенный второй оставил бы ревьюеру «3 years old,
 * 13 years and older» — по этой строке невозможно понять, какой именно
 * слот оператор не заполнил, а именно это ревьюер и должен отметить.
 */
function formatSlot(slot: TemplateSlot, value: number | null, locale: 'en' | 'ru'): string {
  return `${value ?? '—'} ${slot.unit[locale]}`
}

/**
 * Значение поля `type: 'template'` — это `Record<string, number | null>` по
 * ключам `field.templateSlots`, без `option` (см. `FieldInput`'s `template`
 * ветка и `validateTemplate`). Раньше такое значение не проходило
 * `asSelectLike` (нет `option`) и падало в общую ветку «просто объект»,
 * которая печатала внутренние ключи слотов и литеральный `null`:
 * `childFrom: 2, childTo: null, adultFrom: 12`. Ревьюер видел имена
 * переменных вместо ответа, а незаполненный слот — как слово «null», то есть
 * как будто оператор что-то там написал.
 *
 * Порядок и состав — по схеме (`field.templateSlots`), а не по ключам
 * записанного объекта: так же поступает `validateTemplate`, так что показ и
 * проверка говорят об одном наборе слотов, порядок совпадает с порядком
 * пропусков в `templateText` (та самая фраза, которую заполнял оператор), и
 * посторонний ключ, попавший в базу мимо схемы, не выдаётся за ответ на
 * вопрос анкеты.
 *
 * Если не отвечен НИ ОДИН слот — обычное «—» на всю строку, как у любого
 * пустого поля: «— years old, — years old» ничего не сообщает, кроме того,
 * что поле пустое.
 */
function formatTemplate(
  field: Field,
  raw: Record<string, unknown>,
  locale: 'en' | 'ru',
): string {
  const slots = asNumberOrNullRecord(raw)
  const answered = field.templateSlots.filter((slot) => slots[slot.key] !== null)
  if (answered.length === 0) return '—'

  return field.templateSlots
    .map((slot) => formatSlot(slot, slots[slot.key] ?? null, locale))
    .join(', ')
}

/**
 * `III.3.2` (Unaccompanied Children Policy) — единственное поле анкеты, чей
 * ответ несёт составной `slots` наравне с `option`/`detail`: выбор "allowed"
 * обязан нести минимальный возраст в `slots.age`. Черновик этой функции
 * проверял только `'option' in raw` и читал `option`/`detail` — `slots` у
 * него не было в типе вообще, так что для этого единственного поля во всей
 * анкете сам возраст, то есть содержательный ответ на вопрос, тихо пропадал
 * из показа ревьюеру: он видел "allowed" и ничего больше. Ревьюер не может
 * подтвердить блок, не видя того, что подтверждает.
 *
 * `field` нужен ровно для слотов шаблона: только схема знает, какие слоты у
 * поля есть, в каком они порядке и в каких единицах измеряются. Без неё
 * значение можно было напечатать лишь внутренними ключами записи — что и
 * происходило (см. `formatTemplate`).
 */
function formatValue(raw: unknown, field: Field, locale: 'en' | 'ru'): string {
  if (raw === null || raw === undefined || raw === '') return '—'
  if (Array.isArray(raw)) return raw.join(', ')
  if (!isPlainObject(raw)) return String(raw)

  if (field.type === 'template') return formatTemplate(field, raw, locale)

  const selectLike = asSelectLike(raw)
  if (selectLike) {
    const parts = [selectLike.option]
    if (selectLike.detail) parts.push(selectLike.detail)
    if (selectLike.slots) {
      // Единицы из схемы, как и в `formatTemplate` — раньше здесь печатались
      // внутренние ключи (`age: 10`). Незаполненные слоты, наоборот,
      // пропускаются, а не показываются как «—»: у составного select-поля
      // слоты обязательны лишь при определённом варианте
      // (`TEMPLATE_REQUIRED_BY_OPTION`), поэтому у `III.3.2` с ответом
      // «not allowed» пустой возраст — это правильный ответ, а не пропуск,
      // и рисовать на него прочерк значило бы намекать ревьюеру на
      // недоделку там, где её нет.
      const slots = selectLike.slots
      const slotText = field.templateSlots
        .filter((slot) => (slots[slot.key] ?? null) !== null)
        .map((slot) => formatSlot(slot, slots[slot.key] ?? null, locale))
        .join(', ')
      if (slotText) parts.push(slotText)
    }
    return parts.join(' — ')
  }

  return Object.entries(raw)
    .map(([key, val]) => `${key}: ${String(val)}`)
    .join(', ')
}
