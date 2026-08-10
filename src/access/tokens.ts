import { randomBytes, createHash } from 'node:crypto'
import { and, eq, gt } from 'drizzle-orm'
import { fillTokens } from '@/db/schema'
import type { Db } from '@/db/types'

const hash = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

const daysFromNow = (days: number): Date =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000)

export async function issueFillToken(
  db: Db,
  input: { submissionId: string; ttlDays: number },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = daysFromNow(input.ttlDays)

  await db.insert(fillTokens).values({
    submissionId: input.submissionId,
    tokenHash: hash(token),
    expiresAt,
  })

  return { token, expiresAt }
}

export async function resolveFillToken(
  db: Db,
  token: string,
): Promise<{ submissionId: string } | null> {
  const rows = await db
    .select({ submissionId: fillTokens.submissionId })
    .from(fillTokens)
    .where(and(eq(fillTokens.tokenHash, hash(token)), gt(fillTokens.expiresAt, new Date())))
    .limit(1)

  const row = rows[0]
  return row ? { submissionId: row.submissionId } : null
}

export async function extendFillToken(
  db: Db,
  submissionId: string,
  ttlDays: number,
): Promise<void> {
  await db
    .update(fillTokens)
    .set({ expiresAt: daysFromNow(ttlDays) })
    .where(eq(fillTokens.submissionId, submissionId))
}
