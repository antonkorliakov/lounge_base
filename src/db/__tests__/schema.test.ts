import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from './harness'
import { lounges, submissions, fieldValues, serviceValues } from '../schema'

describe('схема базы', () => {
  it('заводит лаунж со статусом «действующий» по умолчанию', async () => {
    const db = await createTestDb()
    const [row] = await db
      .insert(lounges)
      .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
      .returning()

    expect(row?.operationalStatus).toBe('active')
    expect(row?.terminal).toBeNull()
  })

  it('анкета создаётся черновиком и привязана к лаунжу', async () => {
    const db = await createTestDb()
    const [lounge] = await db
      .insert(lounges)
      .values({ name: 'IGA', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
      .returning()

    const [submission] = await db
      .insert(submissions)
      .values({ loungeId: lounge!.id })
      .returning()

    expect(submission?.status).toBe('draft')
  })

  it('значение поля переживает запись и чтение', async () => {
    const db = await createTestDb()
    const [lounge] = await db
      .insert(lounges)
      .values({ name: 'THY', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
      .returning()
    const [submission] = await db
      .insert(submissions).values({ loungeId: lounge!.id }).returning()

    await db.insert(fieldValues).values({
      submissionId: submission!.id,
      fieldKey: 'III.2.4',
      value: { option: 'specific', detail: 'Turkish Airlines' },
    })

    const rows = await db
      .select()
      .from(fieldValues)
      .where(eq(fieldValues.submissionId, submission!.id))

    expect(rows[0]?.value).toEqual({ option: 'specific', detail: 'Turkish Airlines' })
  })

  it('пара анкета+поле уникальна', async () => {
    const db = await createTestDb()
    const [lounge] = await db
      .insert(lounges)
      .values({ name: 'Dup', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
      .returning()
    const [submission] = await db
      .insert(submissions).values({ loungeId: lounge!.id }).returning()

    await db.insert(fieldValues).values({
      submissionId: submission!.id, fieldKey: 'I.2', value: 'first',
    })

    await expect(
      db.insert(fieldValues).values({
        submissionId: submission!.id, fieldKey: 'I.2', value: 'second',
      }),
    ).rejects.toThrow()
  })

  it('пара анкета+услуга уникальна', async () => {
    const db = await createTestDb()
    const [lounge] = await db
      .insert(lounges)
      .values({ name: 'Svc', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
      .returning()
    const [submission] = await db
      .insert(submissions).values({ loungeId: lounge!.id }).returning()

    await db.insert(serviceValues).values({
      submissionId: submission!.id, itemKey: '2.1', available: 'yes',
    })

    await expect(
      db.insert(serviceValues).values({
        submissionId: submission!.id, itemKey: '2.1', available: 'no',
      }),
    ).rejects.toThrow()
  })
})
