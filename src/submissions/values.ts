import { eq } from 'drizzle-orm'
import type { ServiceValueInput } from '@/form-schema'
import {
  fieldByKey,
  serviceItemByKey,
  validateField,
  validateServiceValue,
  isOfferedAvailability,
} from '@/form-schema'
import { fieldValues, serviceValues } from '@/db/schema'
import type { Db, Tx } from '@/db/types'
import { assertEditable, fail, type SaveResult } from './editable'

export type { SaveResult }

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
      .values({ submissionId: input.submissionId, fieldKey: input.fieldKey, value: input.value })
      .onConflictDoUpdate({
        target: [fieldValues.submissionId, fieldValues.fieldKey],
        set: { value: input.value, updatedAt: new Date() },
      })

    return { ok: true }
  })
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

    // Normalise the deliberate-un-selection sentinel (`''`) to the DB's own
    // "unanswered" value (`null`) at the write boundary. `validateServiceValue`
    // accepts `''` (matching the client's `offeredKeys()`), but persisting
    // the literal `''` made `missingItems`'s availability check miss it —
    // `'' == null` is `false` — so a deliberately cleared item silently
    // counted as answered from then on (R2, whole-branch review second
    // round).
    const available = input.value.available === '' ? null : input.value.available

    // Whenever the item is not offered — cleared, or a closing "no"/
    // "not_allowed" answer — none of the offered-only attributes are
    // meaningful, so they're blanked here rather than carried over from
    // whatever they were before. Without this, un-checking (or reverting)
    // a previously-chargeable item would leave its old chargeType/price/
    // currency/slotMinutes/bookingRequired/details sitting in the row for
    // plan 3's export to read as if they still applied to an item the
    // operator just said the lounge doesn't have.
    //
    // The list is EVERY attribute besides `available` — i.e. exactly
    // `EMPTY_SERVICE_ATTRS` (`src/web/ServiceItemCard.tsx`), which is also
    // exactly the set `ServiceItemCard` renders behind its own
    // `isOfferedAvailability` gate. Naming the rule that way rather than
    // listing attributes is what keeps the two from drifting: `details` was
    // left out of the blanking below while being offered-only in the UI, so
    // flipping a flagged item from "yes" to "no" on the fixes screen kept
    // `details: 'Free for 4h, then chargeable'` against `available: 'no'` —
    // and `renderValues` shows `details` to the reviewer, so the review
    // screen displayed that contradiction verbatim. A new offered-only
    // attribute must be added here too; if it ever isn't, the same silent
    // staleness returns for it alone.
    const offered = isOfferedAvailability(item, available)

    const row = {
      submissionId: input.submissionId,
      itemKey: input.itemKey,
      available,
      chargeType: offered ? input.value.chargeType : null,
      price: offered && input.value.price !== null ? String(input.value.price) : null,
      currency: offered ? input.value.currency : null,
      slotMinutes: offered ? input.value.slotMinutes : null,
      bookingRequired: offered ? input.value.bookingRequired : null,
      details: offered ? input.value.details : null,
    }

    await tx
      .insert(serviceValues)
      .values(row)
      .onConflictDoUpdate({
        target: [serviceValues.submissionId, serviceValues.itemKey],
        set: { ...row, updatedAt: new Date() },
      })

    return { ok: true }
  })
}

export async function loadSubmissionValues(
  db: Db | Tx,
  submissionId: string,
): Promise<{
  fields: Record<string, unknown>
  services: Record<string, ServiceValueInput>
}> {
  const fieldRows = await db
    .select().from(fieldValues).where(eq(fieldValues.submissionId, submissionId))
  const serviceRows = await db
    .select().from(serviceValues).where(eq(serviceValues.submissionId, submissionId))

  const fields: Record<string, unknown> = {}
  for (const row of fieldRows) fields[row.fieldKey] = row.value

  const services: Record<string, ServiceValueInput> = {}
  for (const row of serviceRows) {
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

  return { fields, services }
}
