import { randomBytes, createHash } from 'node:crypto'
import { and, eq, gt } from 'drizzle-orm'
import { fillTokens } from '@/db/schema'
import type { Db } from '@/db/types'

const hash = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

const daysFromNow = (days: number): Date =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000)

/**
 * Сколько живёт выданная ссылка заполнения. Одно значение на всю систему, а
 * не параметр, который каждый вызывающий подбирает сам: до этого число `30`
 * стояло голым литералом в ДВУХ местах (`requestChangesAction` и
 * `resendFillLinkAction` в `src/app/admin/s/[submissionId]/actions.ts`) —
 * то есть одна политика была записана дважды, ровно тот класс дефекта,
 * который эта ветка уже находила трижды (см. `EDITABLE_STATUSES`,
 * `SaveResult`, `FLAG_REASONS`). Расхождение здесь было бы тихим: оба места
 * компилируются и оба «работают», просто ссылка из письма о возврате на
 * правку жила бы не столько же, сколько пересланная ссылка на ту же анкету.
 *
 * Число не из спеки — спека (design.md, «Заполняющий — по ссылке с токеном»)
 * требует от токена только наличия срока жизни и его продления при возврате
 * на правку, но никакой цифры не называет. 30 дней — то значение, которое
 * оба вызывающих уже использовали; здесь оно названо один раз, а не выбрано
 * заново. `ttlDays` у `issueFillToken` остаётся параметром: `scripts/
 * seed-dev.ts` осознанно берёт 90 дней (удобство разработки, не политика
 * продукта), а тесты — своё, чтобы проверять и живой, и истёкший токен.
 */
export const FILL_TOKEN_TTL_DAYS = 30

/**
 * Issuing a fresh token is the only sanctioned way to restore access to a
 * submission. There is no `extendFillToken` — only the SHA-256 hash of a
 * token is ever stored, so a specific token (leaked or otherwise) can never
 * be selectively identified after the fact and revived or revoked. An
 * expired token is dead by design, permanently. On return-for-fixes (or any
 * time a link needs to work again), call this again and send the new token.
 *
 * Issuing a fresh token does NOT invalidate the ones already outstanding —
 * for the same reason there is no revocation: the raw token is not stored,
 * so "the previous link" cannot be identified. Any still-unexpired link for
 * this submission keeps working. No mail this system sends may claim
 * otherwise (see `fillLinkMail` in `src/notify/messages.ts`).
 */
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
