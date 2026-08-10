import { eq } from 'drizzle-orm'
import type { Localized, ServiceValueInput } from '@/form-schema'
import { fieldByKey, serviceItemByKey, validateField, validateServiceValue } from '@/form-schema'
import { fieldValues, serviceValues, submissions } from '@/db/schema'
import type { Db, Tx } from '@/db/types'

export type SaveResult = { ok: true } | { ok: false; error: Localized }

const fail = (en: string, ru: string): SaveResult => ({ ok: false, error: { en, ru } })

/** Правки принимаются только в состояниях, где форма открыта заполняющему. */
const EDITABLE = new Set(['draft', 'changes_requested'])

async function assertEditable(tx: Tx, submissionId: string): Promise<SaveResult> {
  // FOR UPDATE: the status check and the write land in different tables
  // (submissions vs. field_values/service_values), so under the default
  // READ COMMITTED isolation a plain SELECT takes no lock and does nothing
  // to serialize against a concurrent status change. Locking this row keeps
  // a concurrent submit/approve from committing until this transaction
  // does — do not remove this thinking it's redundant with the transaction.
  const rows = await tx
    .select({ status: submissions.status })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .for('update')
    .limit(1)

  const status = rows[0]?.status
  if (!status) return fail('Submission not found', 'Анкета не найдена')
  if (!EDITABLE.has(status)) {
    return fail('This submission is under review', 'Анкета сейчас на проверке')
  }
  return { ok: true }
}

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

    const row = {
      submissionId: input.submissionId,
      itemKey: input.itemKey,
      available: input.value.available,
      chargeType: input.value.chargeType,
      price: input.value.price === null ? null : String(input.value.price),
      currency: input.value.currency,
      slotMinutes: input.value.slotMinutes,
      bookingRequired: input.value.bookingRequired,
      details: input.value.details,
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
