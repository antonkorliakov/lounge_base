import { eq, sql } from 'drizzle-orm'
import type { ServiceItem, ServiceValueInput } from '@/form-schema'
import {
  fieldByKey,
  serviceItemByKey,
  validateField,
  validateServiceValue,
  attributeApplies,
} from '@/form-schema'
import { fieldValues, serviceValues } from '@/db/schema'
import type { Db, Tx } from '@/db/types'
import { assertEditable, fail, type SaveResult } from './editable'

export type { SaveResult }

/**
 * Когда ответ был записан — по часам БАЗЫ, и именно `clock_timestamp()`.
 * Оба уточнения обязательны, потому что этот столбец больше не просто
 * бухгалтерия: `blockProgress` (`src/review/blocks.ts`) сравнивает его с
 * `block_reviews.confirmedAt`, чтобы решить, покрывает ли подтверждение
 * ревьюера те данные, за которые его давали. Сравнение `<` осмысленно только
 * между показаниями ОДНИХ часов, а здесь раньше стояло `new Date()` — часы
 * node-процесса, в проде это другая машина, чем postgres, и расхождение часов
 * могло перевернуть порядок в опасную сторону («правка старше подтверждения»,
 * то есть блок остаётся подтверждённым).
 *
 * `clock_timestamp()`, а не `now()` (и не значение по умолчанию у столбца,
 * которое как раз `now()`): `now()` — время НАЧАЛА транзакции, взятое до того,
 * как `assertEditable` получит блокировку `submissions`. Транзакция записи
 * может начаться, застрять на блокировке, которую держит `confirmBlock`, и
 * записать `updatedAt` со штампом раньше `confirmedAt` того подтверждения,
 * которое она обесценивает; ширина этого окна — всё время ожидания
 * блокировки. `clock_timestamp()` читается в момент выполнения оператора,
 * поэтому два писателя штампуются в том порядке, в который их выстроила
 * блокировка.
 *
 * Ставится и на INSERT, и на UPDATE, а не только на UPDATE: у первого
 * значения ключа `updatedAt` иначе взялся бы из `defaultNow()`, то есть из
 * `now()`, — то же окно, только для впервые появившегося ответа.
 */
const WRITTEN_AT = sql`clock_timestamp()`

/**
 * Провенанс, который пишут ОБА писателя этого модуля, всегда: `edited_by =
 * NULL` — «последнюю правку внёс оператор» (см. комментарий у колонки в
 * `db/schema.ts`). NULL стоит и в insert, и в списке `set` конфликта
 * НАМЕРЕННО: оператор, пересохранивший ответ, который до того исправила
 * команда (`editAnswerDuringReview`, `src/review/edit.ts`), СБРАСЫВАЕТ
 * провенанс — значок «исправлено командой» говорит о последней руке, и
 * пропуск `editedBy` в `set` тихо оставил бы его висеть на ответе, который
 * команда больше не писала. Закреплено тестом — сброс провенанса
 * операторской записью держат тесты «провенанс: значок следует за последней
 * рукой» в `src/review/__tests__/edit.test.ts` (в `values.test.ts` его нет).
 */
const OPERATOR_PROVENANCE = { editedBy: null }

/**
 * ВОРОТ производных полей паспорта (I.7/I.8/I.9 из кода IATA) здесь НЕТ —
 * намеренно: этот писатель обслуживает и предзаполнение `createLounge`, и
 * синхронизацию `updateLoungePassport`, и сиды/стенды, которым нужны сырые
 * записи любых ключей. Дверь ОПЕРАТОРА — `saveOperatorField`
 * (`src/registry/manage.ts`): серверные действия ссылки заполнения ходят
 * только через неё, и отказывать держателю токена — её работа, не этого слоя.
 */
export async function saveFieldValue(
  db: Db,
  input: { submissionId: string; fieldKey: string; value: unknown },
): Promise<SaveResult> {
  const field = fieldByKey(input.fieldKey)
  if (!field) return fail('Unknown field', 'Неизвестное поле')

  // Статус и запись — одна транзакция, иначе автосохранение может
  // проскочить между проверкой и записью в момент отправки анкеты.
  return db.transaction(async (tx) => {
    const editable = await assertEditable(tx, input.submissionId)
    if (!editable.ok) return editable

    const validation = validateField(field, input.value)
    if (!validation.ok) return { ok: false, error: validation.error }

    await tx
      .insert(fieldValues)
      .values({
        submissionId: input.submissionId,
        fieldKey: input.fieldKey,
        value: input.value,
        ...OPERATOR_PROVENANCE,
        updatedAt: WRITTEN_AT,
      })
      .onConflictDoUpdate({
        target: [fieldValues.submissionId, fieldValues.fieldKey],
        set: { value: input.value, ...OPERATOR_PROVENANCE, updatedAt: WRITTEN_AT },
      })

    return { ok: true }
  })
}

/**
 * Строка `service_values` (без ключей и провенанса) из клиентского ввода —
 * ЕДИНСТВЕННАЯ запись правила нормализации на обоих писателей позиций услуг:
 * дверь оператора (`saveServiceValue` ниже) и дверь команды
 * (`editAnswerDuringReview`, `src/review/edit.ts`). Правило одно, и второй
 * рукописный экземпляр разошёлся бы с первым при первой же правке — тот же
 * класс дефекта, что `EMPTY_SERVICE_ATTRS`/`needsDetail` уже ловили.
 * Вызывается ПОСЛЕ `validateServiceValue` — сама ничего не проверяет.
 */
export function serviceRowFromInput(
  item: ServiceItem,
  value: ServiceValueInput,
): Omit<typeof serviceValues.$inferInsert, 'submissionId' | 'itemKey' | 'editedBy' | 'updatedAt'> {
  // Normalise the deliberate-un-selection sentinel (`''`) to the DB's own
  // "unanswered" value (`null`) at the write boundary. `validateServiceValue`
  // accepts `''` (matching the client's `offeredKeys()`), but persisting
  // the literal `''` made `missingItems`'s availability check miss it —
  // `'' == null` is `false` — so a deliberately cleared item silently
  // counted as answered from then on (R2, whole-branch review second
  // round).
  const available = value.available === '' ? null : value.available

  // An attribute that does not APPLY to this item right now — because the
  // item is not offered (cleared, or a closing "no"/"not_allowed" answer),
  // or because the item's PROFILE never asks it (`PROFILE_ATTRIBUTES` in
  // `form-schema/services.ts`) — is blanked here rather than carried over
  // from whatever the client still held. The predicate is the schema's
  // `attributeApplies`, the same one `ServiceItemCard` renders controls by
  // and `renderValues` shows the reviewer by: what the operator cannot see
  // or edit is exactly what the row must not keep.
  //
  // History, in two steps. First, the rule was "offered-only": un-checking
  // a previously-chargeable item used to leave its old chargeType/price/
  // currency/slotMinutes/bookingRequired/details in the row for the export
  // to read as if they still applied — and `details` was once left out of
  // that blanking, so flipping a flagged item to "no" on the fixes screen
  // kept `details: 'Free for 4h, then chargeable'` against `available: 'no'`
  // and the review screen displayed the contradiction verbatim. Naming the
  // rule (rather than listing attributes) fixed that class. Second, profiles
  // narrowed "offered-only" to "applicable": a `charge` item never stores a
  // slot, a `none` item stores nothing beyond `available`.
  //
  // Rows written BEFORE profiles existed keep their now-inapplicable
  // attributes as they are — nothing rewrites stored rows — until the item
  // is next saved through either door (operator or team), when this
  // blanking applies. Until then the export prints them (it is the source's
  // 488-column structure and reads storage as-is) and the review screen
  // hides them (it reads the profile).
  const keep = (attribute: keyof ServiceValueInput): boolean =>
    attributeApplies(item, attribute, available)

  return {
    available,
    chargeType: keep('chargeType') ? value.chargeType : null,
    price: keep('price') && value.price !== null ? String(value.price) : null,
    currency: keep('currency') ? value.currency : null,
    slotMinutes: keep('slotMinutes') ? value.slotMinutes : null,
    bookingRequired: keep('bookingRequired') ? value.bookingRequired : null,
    details: keep('details') ? value.details : null,
  }
}

export async function saveServiceValue(
  db: Db,
  input: { submissionId: string; itemKey: string; value: ServiceValueInput },
): Promise<SaveResult> {
  const item = serviceItemByKey(input.itemKey)
  if (!item) return fail('Unknown service item', 'Неизвестная позиция услуг')

  return db.transaction(async (tx) => {
    const editable = await assertEditable(tx, input.submissionId)
    if (!editable.ok) return editable

    const validation = validateServiceValue(item, input.value)
    if (!validation.ok) return { ok: false, error: validation.error }

    // Нормализация — общим правилом с дверью команды (`serviceRowFromInput`
    // выше: сентинель `''`, гашение offered-only атрибутов).
    const row = {
      submissionId: input.submissionId,
      itemKey: input.itemKey,
      ...serviceRowFromInput(item, input.value),
    }

    await tx
      .insert(serviceValues)
      .values({ ...row, ...OPERATOR_PROVENANCE, updatedAt: WRITTEN_AT })
      .onConflictDoUpdate({
        target: [serviceValues.submissionId, serviceValues.itemKey],
        set: { ...row, ...OPERATOR_PROVENANCE, updatedAt: WRITTEN_AT },
      })

    return { ok: true }
  })
}

/**
 * `teamEditedKeys` — ключи (полей И позиций услуг, один плоский список: ключи
 * не пересекаются по построению анкеты), чью последнюю правку внесла команда
 * (`edited_by IS NOT NULL`). Читается из ТЕХ ЖЕ двух выборок, что и сами
 * значения, — ни у страницы заполнения, ни у экрана проверки не появляется
 * второй формы запроса ради значка «исправлено командой»; кому список не
 * нужен (`approveSubmission`), тот его просто не деструктурирует.
 */
export async function loadSubmissionValues(
  db: Db | Tx,
  submissionId: string,
): Promise<{
  fields: Record<string, unknown>
  services: Record<string, ServiceValueInput>
  teamEditedKeys: string[]
}> {
  const fieldRows = await db
    .select().from(fieldValues).where(eq(fieldValues.submissionId, submissionId))
  const serviceRows = await db
    .select().from(serviceValues).where(eq(serviceValues.submissionId, submissionId))

  const teamEditedKeys: string[] = []

  const fields: Record<string, unknown> = {}
  for (const row of fieldRows) {
    fields[row.fieldKey] = row.value
    if (row.editedBy !== null) teamEditedKeys.push(row.fieldKey)
  }

  const services: Record<string, ServiceValueInput> = {}
  for (const row of serviceRows) {
    if (row.editedBy !== null) teamEditedKeys.push(row.itemKey)
    services[row.itemKey] = {
      available: row.available,
      chargeType: row.chargeType,
      price: row.price === null ? null : Number(row.price),
      currency: row.currency,
      slotMinutes: row.slotMinutes,
      bookingRequired: row.bookingRequired,
      details: row.details,
    }
  }

  return { fields, services, teamEditedKeys }
}
