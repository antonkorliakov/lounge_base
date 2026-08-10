import { describe, it, expect } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions, fillTokens } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { issueFillToken, resolveFillToken, extendFillToken } from '../tokens'

async function seed(db: Db): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  const [submission] = await db
    .insert(submissions).values({ loungeId: lounge!.id }).returning()
  return submission!.id
}

describe('токены заполнения', () => {
  it('выданный токен разрешается в свою анкету', async () => {
    const db = await createTestDb()
    const submissionId = await seed(db)

    const { token } = await issueFillToken(db, { submissionId, ttlDays: 30 })
    const resolved = await resolveFillToken(db, token)

    expect(resolved).toEqual({ submissionId })
  })

  it('сырой токен не хранится в базе', async () => {
    const db = await createTestDb()
    const submissionId = await seed(db)

    const { token } = await issueFillToken(db, { submissionId, ttlDays: 30 })
    const rows = await db.select().from(fillTokens)

    expect(rows[0]?.tokenHash).not.toBe(token)
    expect(rows[0]?.tokenHash).toHaveLength(64)
  })

  it('неизвестный токен не разрешается', async () => {
    const db = await createTestDb()
    await seed(db)
    expect(await resolveFillToken(db, 'нет-такого')).toBeNull()
  })

  it('просроченный токен не разрешается', async () => {
    const db = await createTestDb()
    const submissionId = await seed(db)
    const { token } = await issueFillToken(db, { submissionId, ttlDays: 30 })

    await db
      .update(fillTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(fillTokens.submissionId, submissionId))

    expect(await resolveFillToken(db, token)).toBeNull()
  })

  it('продление возвращает просроченный токен в строй', async () => {
    const db = await createTestDb()
    const submissionId = await seed(db)
    const { token } = await issueFillToken(db, { submissionId, ttlDays: 30 })

    await db
      .update(fillTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(fillTokens.submissionId, submissionId))
    await extendFillToken(db, submissionId, 14)

    expect(await resolveFillToken(db, token)).toEqual({ submissionId })
  })

  it('два токена не совпадают', async () => {
    const db = await createTestDb()
    const submissionId = await seed(db)
    const first = await issueFillToken(db, { submissionId, ttlDays: 30 })
    const second = await issueFillToken(db, { submissionId, ttlDays: 30 })
    expect(first.token).not.toBe(second.token)
  })
})
