import type { Field, TemplateSlot } from './fields'

/**
 * Текстовое представление ОДНОГО значения поля анкеты — общее для всех
 * потребителей, которые показывают сохранённые ответы человеку или отдают их
 * наружу: экран проверки (`src/web/renderValues.ts`) и плоская выгрузка
 * (`src/export/rows.ts`); лист одной анкеты (Task 5) — следующий.
 *
 * Живёт в `form-schema`, а не рядом с одним из потребителей, потому что всё,
 * из чего складывается показ, — знание схемы: формы значений
 * (`SelectValue`/`TemplateValue` из `./validation`), слоты и их единицы
 * (`Field.templateSlots`), сама шаблонная фраза (`Field.templateText`).
 * История, из-за которой модуль общий, а не третий по счёту: `slots.age`
 * поля `III.3.2` — единственный составной ответ анкеты — уже ДВАЖДЫ молча
 * выпадал из независимых реализаций этого же показа (черновик
 * `renderValues.ts`, затем образец Task 4 в плане 3), и это тот же класс
 * «одно правило в N местах», который на этой ветке чинился семь раз.
 *
 * Чем потребители легитимно РАЗЛИЧАЮТСЯ, вынесено в параметры:
 *
 *  - «ответа нет» — это `null`, без представления: экран проверки рисует
 *    прочерк, выгрузка кладёт пустую ячейку. Заглушка здесь была бы решением
 *    за обоих.
 *  - шаблонное поле читается двумя способами (`FieldValueStyle.template`):
 *    `slots` — списком значений в единицах схемы («3 years old, — years
 *    old»), чтобы ревьюер видел, КАКОЙ слот пропущен; `phrase` — исходной
 *    фразой формы («Access is permitted 3 hours prior…»), потому что в файле
 *    выгрузки ячейка живёт без контекста экрана и должна читаться сама.
 */
export type FieldValueStyle = {
  locale: 'en' | 'ru'
  template: 'slots' | 'phrase'
}

/**
 * Проверяющая версия `typeof value === 'object'`: узнаёт настоящий объект
 * (не `null`, не массив) и после вызова сужает `value` до
 * `Record<string, unknown>` без единого `as`. Черновик показа писал
 * `raw as { option: string; ... }` сразу за проверкой одного свойства — тот
 * самый класс дефекта, который эта ветка чинила четыре раза (`toFlagReason`
 * в `review/flags.ts`, `isSelectValue` в `form-schema/validation.ts`,
 * `optionOf`/`stringArrayOf` в `review/decide.ts`): со стороны показа нет
 * способа увидеть гарантию формы, которую даёт запись (`saveFieldValue`), а
 * неверная форма в базе (ручная правка, будущий писатель с багом) должна
 * читаться как «непохоже на известную форму», а не выдаваться `as` за неё.
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
 * `raw['option']` — единственное свойство, что делает значение «похожим на
 * `SelectValue`» (см. `validation.ts`'s собственный `isSelectValue`, ту же
 * проверку). Возвращает `null`, а не полу-заполненный объект, если `option`
 * не строка — вызывающий тогда падает в общую ветку «просто объект» ниже,
 * а не рисует пустую/сломанную строку, притворяясь составным полем.
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
 * в `slots.age` как `number | null` (см. `validation.ts`'s
 * `SelectValue.slots`/`TEMPLATE_REQUIRED_BY_OPTION`) — единственное составное
 * поле анкеты. Значение, отличное от `number`, становится `null` (то есть
 * «не показывать»), а не `String(val)` вслепую: слот, куда что-то записалось
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
 * схемы (`TemplateSlot.unit`, см. `fields.ts`) — там она уже есть на двух
 * языках именно для показа человеку, и её же видит оператор рядом с полем
 * ввода (`FieldInput`'s `template` ветка).
 *
 * `null` (то есть «не отвечено», в том же смысле, что и у
 * `asNumberOrNullRecord` выше) печатается как «—», а не пропускается и не
 * превращается в `String(null)`. Печатать пропуск важно: у `III.3.3` три
 * слота, и молча выброшенный второй оставил бы читателю «3 years old,
 * 13 years and older» — по этой строке невозможно понять, какой именно
 * слот оператор не заполнил, а именно это ревьюер и должен отметить.
 */
function formatSlot(slot: TemplateSlot, value: number | null, locale: 'en' | 'ru'): string {
  return `${value ?? '—'} ${slot.unit[locale]}`
}

/**
 * Значение поля `type: 'template'` — это `Record<string, number | null>` по
 * ключам `field.templateSlots`, без `option` (см. `FieldInput`'s `template`
 * ветка и `validateTemplate`). Черновик показа не имел этой ветки: такое
 * значение не проходило `asSelectLike` (нет `option`) и падало в общую ветку
 * «просто объект», которая печатала внутренние ключи слотов и литеральный
 * `null`: `childFrom: 2, childTo: null, adultFrom: 12`.
 *
 * Порядок и состав — по схеме (`field.templateSlots`), а не по ключам
 * записанного объекта: так же поступает `validateTemplate`, так что показ и
 * проверка говорят об одном наборе слотов, порядок совпадает с порядком
 * пропусков в `templateText` (та самая фраза, которую заполнял оператор), и
 * посторонний ключ, попавший в базу мимо схемы, не выдаётся за ответ.
 *
 * Если не отвечен НИ ОДИН слот — `null`, как у любого пустого поля: «— years
 * old, — years old» (и фраза из одних пропусков) ничего не сообщает, кроме
 * того, что поле пустое.
 */
function formatTemplate(field: Field, raw: Record<string, unknown>, style: FieldValueStyle): string | null {
  const slots = asNumberOrNullRecord(raw)
  const answered = field.templateSlots.filter((slot) => slots[slot.key] !== null)
  if (answered.length === 0) return null

  if (style.template === 'slots') {
    return field.templateSlots
      .map((slot) => formatSlot(slot, slots[slot.key] ?? null, style.locale))
      .join(', ')
  }

  // Режим phrase: значения раскладываются по пропускам `(  )` исходной фразы.
  //
  // Именно РАЗРЕЗАНИЕМ фразы по всем пропускам сразу, а не последовательным
  // `text.replace(/\(\s*\)/, …)` по слоту за раз, как в образце плана: у
  // replace без /g каждый вызов берёт ПЕРВОЕ совпадение, и любая метка
  // пропуска, которую ставишь вместо незаполненного слота (у образца —
  // '( )'), сама подходит под /\(\s*\)/ — значение следующего слота вставало
  // в пропуск предыдущего («children from 12 to (  )» при пустом childFrom).
  // Число пропусков равно числу слотов на обоих языках — это свойство схемы,
  // закреплённое тестом рядом с этим модулем (`__tests__/render.test.ts`).
  //
  // Незаполненный слот — «—», та же метка «не отвечено», что и в режиме
  // slots: читатель ячейки видит, ЧТО пропущено и где, а «( )» читалось бы
  // как разметка бланка, а не как ответ.
  const parts = field.templateText![style.locale].split(/\(\s*\)/)
  let text = parts[0] ?? ''
  field.templateSlots.forEach((slot, position) => {
    const filled = slots[slot.key] ?? null
    text += `${filled ?? '—'}${parts[position + 1] ?? ''}`
  })
  return text
}

/**
 * Значение одного поля анкеты, готовое к показу; `null` — «ответа нет».
 *
 * `field` обязателен не для галочки: только схема знает, что поле шаблонное,
 * какие у него слоты, в каком они порядке и в каких единицах. Без неё
 * значение можно напечатать лишь внутренними ключами записи — что черновики
 * и делали (см. `formatTemplate`).
 */
export function formatFieldValue(field: Field, raw: unknown, style: FieldValueStyle): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (Array.isArray(raw)) return raw.join(', ')
  if (!isPlainObject(raw)) return String(raw)

  if (field.type === 'template' && field.templateText) return formatTemplate(field, raw, style)

  const selectLike = asSelectLike(raw)
  if (selectLike) {
    const parts = [selectLike.option]
    if (selectLike.detail) parts.push(selectLike.detail)
    if (selectLike.slots) {
      // Единицы из схемы, как и в `formatTemplate` — черновик печатал здесь
      // внутренние ключи (`age: 10`). Незаполненные слоты, наоборот,
      // пропускаются, а не показываются как «—»: у составного select-поля
      // слоты обязательны лишь при определённом варианте
      // (`TEMPLATE_REQUIRED_BY_OPTION`), поэтому у `III.3.2` с ответом
      // «not allowed» пустой возраст — это правильный ответ, а не пропуск,
      // и рисовать на него прочерк значило бы намекать читателю на
      // недоделку там, где её нет.
      const slots = selectLike.slots
      const slotText = field.templateSlots
        .filter((slot) => (slots[slot.key] ?? null) !== null)
        .map((slot) => formatSlot(slot, slots[slot.key] ?? null, style.locale))
        .join(', ')
      if (slotText) parts.push(slotText)
    }
    return parts.join(' — ')
  }

  return Object.entries(raw)
    .map(([key, val]) => `${key}: ${String(val)}`)
    .join(', ')
}
