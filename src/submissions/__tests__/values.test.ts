import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions, fieldValues } from '@/db/schema'
import { saveFieldValue, saveServiceValue, loadSubmissionValues } from '../values'

async function seedDraft(db: Db): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  const [submission] = await db
    .insert(submissions).values({ loungeId: lounge!.id }).returning()
  return submission!.id
}

describe('сохранение значений', () => {
  it('пишет значение поля', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await saveFieldValue(db, {
      submissionId, fieldKey: 'I.2', value: 'Primeclass Lounge',
    })

    expect(result.ok).toBe(true)
    const loaded = await loadSubmissionValues(db, submissionId)
    expect(loaded.fields['I.2']).toBe('Primeclass Lounge')
  })

  it('перезапись поля не создаёт вторую строку', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    await saveFieldValue(db, { submissionId, fieldKey: 'I.2', value: 'Первое' })
    await saveFieldValue(db, { submissionId, fieldKey: 'I.2', value: 'Второе' })

    const rows = await db
      .select().from(fieldValues).where(eq(fieldValues.submissionId, submissionId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.value).toBe('Второе')
  })

  it('отклоняет неизвестный ключ поля', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await saveFieldValue(db, {
      submissionId, fieldKey: 'IX.99', value: 'что-то',
    })
    expect(result.ok).toBe(false)
  })

  it('отклоняет значение, не прошедшее валидацию схемы', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await saveFieldValue(db, {
      submissionId, fieldKey: 'III.5.2', value: { option: 'basement', detail: null },
    })

    expect(result.ok).toBe(false)
    const loaded = await loadSubmissionValues(db, submissionId)
    expect(loaded.fields['III.5.2']).toBeUndefined()
  })

  it('пишет позицию услуги со всеми атрибутами', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await saveServiceValue(db, {
      submissionId,
      itemKey: '7.2',
      value: {
        available: 'yes', chargeType: 'chargeable', price: 15,
        currency: 'EUR', slotMinutes: 30, bookingRequired: true, details: null,
      },
    })

    expect(result.ok).toBe(true)
    const loaded = await loadSubmissionValues(db, submissionId)
    expect(loaded.services['7.2']?.price).toBe(15)
    expect(loaded.services['7.2']?.currency).toBe('EUR')
  })

  it('отклоняет платную услугу без цены', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await saveServiceValue(db, {
      submissionId,
      itemKey: '7.2',
      value: {
        available: 'yes', chargeType: 'chargeable', price: null,
        currency: null, slotMinutes: null, bookingRequired: null, details: null,
      },
    })
    expect(result.ok).toBe(false)
  })

  it('не даёт править отправленную анкету', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)
    await db
      .update(submissions).set({ status: 'submitted' })
      .where(eq(submissions.id, submissionId))

    const result = await saveFieldValue(db, {
      submissionId, fieldKey: 'I.2', value: 'Поздно',
    })
    expect(result.ok).toBe(false)
  })
})
