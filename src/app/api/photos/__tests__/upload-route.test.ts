import { and, eq, isNull } from 'drizzle-orm'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions, photos, fieldFlags, blockReviews } from '@/db/schema'
import { issueFillToken } from '@/access/tokens'
import { raiseFlag, openFlags } from '@/review/flags'

/**
 * `POST /api/photos` cleared no flags at all: a filler could re-upload
 * exactly the photo the reviewer complained about and the flag stayed open,
 * so the review cycle could not converge for any of the four photo slots
 * (the Critical at the end of P2 Task 7). This covers the wiring that closes
 * it — and it is deliberately a test of the ROUTE, not of `clearFlagsFor`,
 * because `clearFlagsFor` was already covered and already worked: what was
 * missing was anything calling it from here. `src/review/__tests__/flags.test.ts`'s
 * own break-verification made that limit explicit ("deleting the
 * `clearFlagAfterSave` call left all 4 tests green, because the test cannot
 * see `actions.ts`").
 *
 * Two things are mocked and nothing else:
 *  - `@vercel/blob`, because there are no blob credentials in this
 *    environment or in CI (see `e2e/fill.spec.ts`'s own note), so `put()`
 *    throws before the route can reach any of the logic under test. The stub
 *    returns the one field the route reads (`url`).
 *  - `@/db/client`'s `db()`, pointed at the PGlite harness — the same
 *    database every other integration test in this repo runs against, with
 *    the real migrations applied. `attachPhoto`, `resolveFillToken`,
 *    `raiseFlag` and `clearFlagsFor` all run for real against it.
 */
const holder = vi.hoisted(() => ({ db: undefined as Db | undefined, broken: false }))

vi.mock('@vercel/blob', () => ({
  put: vi.fn(async (key: string) => ({ url: `https://blob.test/${key}` })),
  del: vi.fn(async () => {}),
}))

vi.mock('@/db/client', () => ({
  db: (): Db => {
    // `broken` simulates the flag-clearing step's own database failure — the
    // case whose handling `clearFlagAfterSave` documents at length. It has to
    // be a per-call decision, not a second mocked module, because the SAME
    // `db()` is used by the write that must still succeed.
    if (holder.broken) return { transaction: undefined } as unknown as Db
    if (!holder.db) throw new Error('test db not ready')
    return holder.db
  },
  createDb: (): Db => {
    if (!holder.db) throw new Error('test db not ready')
    return holder.db
  },
}))

const { POST } = await import('../route')
const { clearFlagAfterSave } = await import('@/app/clear-flag-after-save')

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])

function uploadRequest(token: string, slot: string): Request {
  const body = new FormData()
  body.set('token', token)
  body.set('slot', slot)
  body.set('file', new File([JPEG_BYTES], `${slot}.jpg`, { type: 'image/jpeg' }))
  return new Request('http://localhost/api/photos', { method: 'POST', body })
}

/**
 * A questionnaire already returned for changes, with a flag open on two
 * photo slots and the photos block previously confirmed by the reviewer.
 * `changes_requested` because `attachPhoto`'s `assertEditable` is what
 * decides whether an upload is allowed at all, and that is the state a
 * flagged photo is actually re-uploaded in.
 */
async function seedFlaggedPhotos(db: Db): Promise<{ token: string; submissionId: string }> {
  const [lounge] = await db
    .insert(lounges)
    .values({
      name: 'Primeclass', country: 'Turkey', city: 'Istanbul',
      airport: 'Istanbul Airport', iataCode: 'IST',
    })
    .returning()
  const [submission] = await db
    .insert(submissions)
    .values({ loungeId: lounge!.id, status: 'changes_requested' })
    .returning()
  const submissionId = submission!.id

  for (const slot of ['entrance', 'reception']) {
    const raised = await raiseFlag(db, {
      submissionId,
      fieldKey: slot,
      reason: 'empty',
      comment: `retake ${slot}`,
      reviewer: 'reviewer-1',
    })
    expect(raised.ok, `raiseFlag(${slot})`).toBe(true)
  }

  await db.insert(blockReviews).values({
    submissionId, blockKey: 'photos', confirmedBy: 'reviewer-1',
  })

  const { token } = await issueFillToken(db, { submissionId, ttlDays: 30 })
  return { token, submissionId }
}

describe('POST /api/photos снимает замечание по загруженному слоту', () => {
  beforeEach(async () => {
    holder.db = await createTestDb()
    holder.broken = false
  })

  it('загрузка проходит, снимок привязан, замечание по ЭТОМУ слоту снято', async () => {
    const db = holder.db!
    const { token, submissionId } = await seedFlaggedPhotos(db)

    const response = await POST(uploadRequest(token, 'entrance'))
    expect(response.status).toBe(200)
    expect(((await response.json()) as { url: string }).url).toContain('blob.test')

    const rows = await db
      .select({ slot: photos.slot })
      .from(photos)
      .where(eq(photos.submissionId, submissionId))
    expect(rows.map((r) => r.slot)).toEqual(['entrance'])

    // Снято именно замечание по entrance, и только оно: reception остаётся
    // открытым. Проверять «замечаний стало меньше» здесь недостаточно —
    // снятие всех подряд выглядело бы точно так же.
    const open = await openFlags(db, submissionId)
    expect(open.map((f) => f.fieldKey)).toEqual(['reception'])
  })

  it('и подтверждение блока фото снимается — ревьюер посмотрит его заново', async () => {
    const db = holder.db!
    const { token, submissionId } = await seedFlaggedPhotos(db)

    const response = await POST(uploadRequest(token, 'entrance'))
    expect(response.status).toBe(200)

    const confirmed = await db
      .select({ blockKey: blockReviews.blockKey })
      .from(blockReviews)
      .where(eq(blockReviews.submissionId, submissionId))
    expect(confirmed).toEqual([])
  })

  it('загрузка в НЕотмеченный слот ничего не снимает', async () => {
    const db = holder.db!
    const { token, submissionId } = await seedFlaggedPhotos(db)

    const response = await POST(uploadRequest(token, 'landmarks'))
    expect(response.status).toBe(200)

    const open = await openFlags(db, submissionId)
    expect(open.map((f) => f.fieldKey).sort()).toEqual(['entrance', 'reception'])
  })

  afterEach(() => {
    holder.broken = false
  })
})

/**
 * Единственный документированный способ, которым этот шаг может провалиться,
 * и обещание, которое `clearFlagAfterSave` на этот случай даёт: не бросать и
 * не превращать успешную запись в отказ. Проверяется на самой функции, а не
 * через маршрут: сломанный `db()` внутри маршрута сломал бы и `resolveFillToken`,
 * и `attachPhoto`, то есть тест перестал бы быть про этот шаг вовсе.
 */
describe('clearFlagAfterSave при сбое базы', () => {
  it('не бросает и не отменяет уже состоявшуюся запись — только пишет в лог', async () => {
    holder.db = await createTestDb()
    const db = holder.db
    const { submissionId } = await seedFlaggedPhotos(db)

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      holder.broken = true
      await expect(clearFlagAfterSave(submissionId, 'entrance')).resolves.toBeUndefined()
      expect(errors).toHaveBeenCalled()
    } finally {
      holder.broken = false
      errors.mockRestore()
    }

    // Цена выбора, названная в `clearFlagAfterSave`: замечание остаётся
    // открытым, ревьюер посмотрит ответ заново. Ничего не теряется.
    const stillOpen = await db
      .select({ fieldKey: fieldFlags.fieldKey })
      .from(fieldFlags)
      .where(
        and(eq(fieldFlags.submissionId, submissionId), isNull(fieldFlags.resolvedAt)),
      )
    expect(stillOpen.map((f) => f.fieldKey).sort()).toEqual(['entrance', 'reception'])
  })
})
