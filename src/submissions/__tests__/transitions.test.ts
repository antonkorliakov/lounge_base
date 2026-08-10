import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions, photos, events } from '@/db/schema'
import { FIELDS, SERVICE_ITEMS, PHOTO_SLOTS, OPTION_LISTS, MIN_PHOTOS } from '@/form-schema'
import { saveFieldValue, saveServiceValue } from '../values'
import { submitSubmission } from '../transitions'

/**
 * Составное поле `III.3.2`: `type: 'select'` на `allowedNotAllowed` плюс
 * шаблонный слот `age`, обязательный только когда выбран вариант `allowed`.
 * Первый вариант списка `allowedNotAllowed` — как раз `allowed`, поэтому
 * ниже (см. `field.key === 'III.3.2'`) к значению подмешивается `slots.age` —
 * иначе `validateField` отклонит его и сид тихо соберёт неполную анкету.
 */
async function seedComplete(db: Db): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  const [submission] = await db
    .insert(submissions).values({ loungeId: lounge!.id }).returning()
  const submissionId = submission!.id

  for (const field of FIELDS.filter((f) => f.required)) {
    const value =
      field.type === 'date' ? '2026-03-01'
      : field.type === 'number' ? 1
      : field.type === 'multi_select' ? ['departure']
      : field.type === 'template'
        ? Object.fromEntries(field.templateSlots.map((s) => [s.key, 1]))
      : field.type === 'select' || field.type === 'select_with_detail'
        ? {
            option: OPTION_LISTS[field.optionList!][0]!.id,
            detail: 'подробности',
            ...(field.key === 'III.3.2' ? { slots: { age: 10 } } : {}),
          }
        : 'заполнено'

    await saveFieldValue(db, { submissionId, fieldKey: field.key, value })
  }

  for (const item of SERVICE_ITEMS) {
    await saveServiceValue(db, {
      submissionId,
      itemKey: item.key,
      value: {
        available: item.availabilityList === 'vaping' ? 'not_allowed' : 'no',
        chargeType: null, price: null, currency: null,
        slotMinutes: null, bookingRequired: null, details: null,
      },
    })
  }

  for (const slot of PHOTO_SLOTS.filter((s) => s.required)) {
    await db.insert(photos).values({
      submissionId, slot: slot.key,
      blobKey: `${slot.key}.jpg`, url: `https://example.test/${slot.key}.jpg`,
    })
  }

  // Three required named slots fall short of MIN_PHOTOS (4) — completeness
  // makes up the gap from the one slot that accepts extras (`additional`),
  // so a "complete" seed needs to actually reach the minimum photo count.
  const requiredCount = PHOTO_SLOTS.filter((s) => s.required).length
  const extraSlot = PHOTO_SLOTS.find((s) => s.extra)
  if (extraSlot) {
    for (let i = requiredCount; i < MIN_PHOTOS; i++) {
      await db.insert(photos).values({
        submissionId, slot: extraSlot.key,
        blobKey: `${extraSlot.key}-${i}.jpg`, url: `https://example.test/${extraSlot.key}-${i}.jpg`,
      })
    }
  }

  return submissionId
}

describe('отправка анкеты', () => {
  it('неполная анкета не отправляется', async () => {
    const db = await createTestDb()
    const [lounge] = await db
      .insert(lounges)
      .values({ name: 'Пусто', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
      .returning()
    const [submission] = await db
      .insert(submissions).values({ loungeId: lounge!.id }).returning()

    const result = await submitSubmission(db, {
      submissionId: submission!.id, actor: 'filler',
    })

    expect(result.ok).toBe(false)
  })

  it('полная анкета переходит в submitted', async () => {
    const db = await createTestDb()
    const submissionId = await seedComplete(db)

    const result = await submitSubmission(db, { submissionId, actor: 'filler' })

    expect(result).toEqual({ ok: true, status: 'submitted' })
    const rows = await db
      .select().from(submissions).where(eq(submissions.id, submissionId))
    expect(rows[0]?.status).toBe('submitted')
    expect(rows[0]?.submittedAt).not.toBeNull()
  })

  it('отправка пишется в журнал', async () => {
    const db = await createTestDb()
    const submissionId = await seedComplete(db)
    await submitSubmission(db, { submissionId, actor: 'filler' })

    const rows = await db
      .select().from(events).where(eq(events.submissionId, submissionId))
    expect(rows.map((r) => r.action)).toContain('submitted')
  })

  it('повторная отправка отклоняется', async () => {
    const db = await createTestDb()
    const submissionId = await seedComplete(db)
    await submitSubmission(db, { submissionId, actor: 'filler' })

    const again = await submitSubmission(db, { submissionId, actor: 'filler' })
    expect(again.ok).toBe(false)
  })
})
