import { eq } from 'drizzle-orm'
import { FIELDS, SERVICE_ITEMS, PHOTO_SLOTS, MIN_PHOTOS } from '@/form-schema'
import { photos } from '@/db/schema'
import type { Db } from '@/db/types'
import { loadSubmissionValues } from './values'

export type MissingItems = {
  fieldKeys: string[]
  serviceKeys: string[]
  photoSlots: string[]
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

export async function missingItems(
  db: Db,
  submissionId: string,
): Promise<MissingItems> {
  const values = await loadSubmissionValues(db, submissionId)

  const fieldKeys = FIELDS.filter(
    (field) => field.required && isBlank(values.fields[field.key]),
  ).map((field) => field.key)

  // Позиция считается заполненной, как только на неё дан любой ответ,
  // включая «нет» — это осознанное решение заполняющего, а не пропуск.
  const serviceKeys = SERVICE_ITEMS.filter(
    (item) => values.services[item.key]?.available == null,
  ).map((item) => item.key)

  const uploaded = await db
    .select({ slot: photos.slot }).from(photos).where(eq(photos.submissionId, submissionId))
  const filledSlots = new Set(uploaded.map((row) => row.slot))

  const missingRequiredSlots = PHOTO_SLOTS.filter(
    (slot) => slot.required && !filledSlots.has(slot.key),
  ).map((slot) => slot.key)

  /**
   * `PHOTO_SLOTS` has three required named slots (entrance, reception,
   * landmarks) but `MIN_PHOTOS` is 4 — so filling every required slot alone
   * does not reach the minimum. Once the required slots are all present,
   * make up the gap by asking for photos in the one slot that accepts
   * extras (`extra: true`); that keeps `MIN_PHOTOS` load-bearing instead of
   * decorative. If there were no extra-accepting slot, this rule would have
   * no way to satisfy the minimum — but there is exactly one, so it holds.
   */
  let photoSlots = missingRequiredSlots
  if (missingRequiredSlots.length === 0 && uploaded.length < MIN_PHOTOS) {
    const extraSlot = PHOTO_SLOTS.find((slot) => slot.extra)
    photoSlots = extraSlot ? [extraSlot.key] : []
  }

  return { fieldKeys, serviceKeys, photoSlots }
}
