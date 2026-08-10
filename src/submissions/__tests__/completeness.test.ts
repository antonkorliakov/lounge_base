import { describe, it, expect } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions, photos } from '@/db/schema'
import { FIELDS, SERVICE_ITEMS, PHOTO_SLOTS, MIN_PHOTOS } from '@/form-schema'
import { saveFieldValue, saveServiceValue } from '../values'
import { missingItems } from '../completeness'

async function seedDraft(db: Db): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  const [submission] = await db
    .insert(submissions).values({ loungeId: lounge!.id }).returning()
  return submission!.id
}

describe('полнота анкеты', () => {
  it('в пустой анкете не хватает всех обязательных полей', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const missing = await missingItems(db, submissionId)

    const requiredCount = FIELDS.filter((f) => f.required).length
    expect(missing.fieldKeys).toHaveLength(requiredCount)
    expect(missing.serviceKeys).toHaveLength(SERVICE_ITEMS.length)
    expect(missing.photoSlots.length).toBeGreaterThan(0)
  })

  it('заполненное поле уходит из списка недостающих', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    await saveFieldValue(db, { submissionId, fieldKey: 'I.2', value: 'Primeclass Lounge' })
    const missing = await missingItems(db, submissionId)

    expect(missing.fieldKeys).not.toContain('I.2')
  })

  it('позиция услуг считается заполненной даже при ответе «нет»', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    await saveServiceValue(db, {
      submissionId,
      itemKey: '1.2',
      value: {
        available: 'no', chargeType: null, price: null, currency: null,
        slotMinutes: null, bookingRequired: null, details: null,
      },
    })

    const missing = await missingItems(db, submissionId)
    expect(missing.serviceKeys).not.toContain('1.2')
  })

  it('необязательные поля не попадают в список недостающих', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const missing = await missingItems(db, submissionId)
    const optional = FIELDS.filter((f) => !f.required).map((f) => f.key)

    for (const key of optional) {
      expect(missing.fieldKeys).not.toContain(key)
    }
  })

  it('заполненных обязательных слотов недостаточно, если снимков меньше MIN_PHOTOS', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const requiredSlots = PHOTO_SLOTS.filter((s) => s.required)
    expect(requiredSlots.length).toBeLessThan(MIN_PHOTOS)

    for (const slot of requiredSlots) {
      await db.insert(photos).values({
        submissionId, slot: slot.key,
        blobKey: `${slot.key}.jpg`, url: `https://example.test/${slot.key}.jpg`,
      })
    }

    const missing = await missingItems(db, submissionId)
    const extraSlot = PHOTO_SLOTS.find((s) => s.extra)

    // Все обязательные именованные слоты заполнены, но общее число снимков
    // (3) всё ещё меньше MIN_PHOTOS (4) — недостающим считается слот,
    // принимающий дополнительные фото.
    expect(missing.photoSlots).toEqual([extraSlot!.key])
  })

  it('фото закрывает недостачу, когда общее число снимков достигает MIN_PHOTOS', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const requiredSlots = PHOTO_SLOTS.filter((s) => s.required)
    const extraSlot = PHOTO_SLOTS.find((s) => s.extra)!

    for (const slot of requiredSlots) {
      await db.insert(photos).values({
        submissionId, slot: slot.key,
        blobKey: `${slot.key}.jpg`, url: `https://example.test/${slot.key}.jpg`,
      })
    }
    for (let i = requiredSlots.length; i < MIN_PHOTOS; i++) {
      await db.insert(photos).values({
        submissionId, slot: extraSlot.key,
        blobKey: `${extraSlot.key}-${i}.jpg`, url: `https://example.test/${extraSlot.key}-${i}.jpg`,
      })
    }

    const missing = await missingItems(db, submissionId)
    expect(missing.photoSlots).toHaveLength(0)
  })
})
