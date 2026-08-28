import { and, eq } from 'drizzle-orm'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { events, fieldValues, lounges, submissions } from '@/db/schema'
import { saveFieldValue } from '@/submissions/values'
import { TEAM_EDIT_EVENT } from '@/review/edit'

/**
 * Проверяется само ДЕЙСТВИЕ, а не `editAnswerDuringReview`: у двери тесты уже
 * есть (`src/review/__tests__/edit.test.ts`), а действие — единственное место,
 * где к правке пришивается ЛИЧНОСТЬ: `reviewer` берётся из `session.email`, и
 * никакой тест двери не заметит, если действие начнёт передавать туда пустую
 * строку, чужую почту или писать до авторизации. Ровно два утверждения, оба
 * про эту пришивку: без сессии — отказ И ничего не записано (порядок:
 * `requireSession()` стоит до вызова двери — проверено последствием); с
 * сессией — и `edited_by`, и `actor` события равны почте сессии.
 *
 * Стенд — тот же, что у `unconfirm-block.test.ts` рядом: три мока и ни
 * одного больше (`@/db/client` → PGlite с настоящими миграциями,
 * `@/access/session` — cookies вне запроса не существует, `next/cache` —
 * `revalidatePath` вне рантайма Next не имеет смысла).
 */
const SESSION_EMAIL = 'reviewer@easyto.travel'

const holder = vi.hoisted(() => ({
  db: undefined as Db | undefined,
  noSession: false,
}))

vi.mock('@/db/client', () => ({
  db: (): Db => {
    if (!holder.db) throw new Error('test db not ready')
    return holder.db
  },
  createDb: (): Db => {
    if (!holder.db) throw new Error('test db not ready')
    return holder.db
  },
}))

vi.mock('@/access/session', () => ({
  requireSession: async () => {
    if (holder.noSession) throw new Error('no session')
    return { memberId: 'member-1', email: SESSION_EMAIL }
  },
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { editAnswerAction } = await import('../actions')

/** Анкета в submitted с ответом I.2, записанным настоящей операторской
 *  дверью в черновике (включая `editedBy: null`), — тот же приём, что у
 *  сида `edit.test.ts`. */
async function seed(db: Db): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({
      name: 'Primeclass Lounge',
      country: 'Turkey',
      city: 'Istanbul',
      airport: 'Istanbul Airport',
      iataCode: 'IST',
    })
    .returning()
  const [submission] = await db
    .insert(submissions)
    .values({ loungeId: lounge!.id })
    .returning()
  const submissionId = submission!.id

  const saved = await saveFieldValue(db, { submissionId, fieldKey: 'I.2', value: 'Old name' })
  if (!saved.ok) throw new Error(`seed: I.2 refused — ${saved.error.en}`)
  await db.update(submissions).set({ status: 'submitted' }).where(eq(submissions.id, submissionId))
  return submissionId
}

async function fieldRow(db: Db, submissionId: string) {
  const rows = await db
    .select()
    .from(fieldValues)
    .where(and(eq(fieldValues.submissionId, submissionId), eq(fieldValues.fieldKey, 'I.2')))
  return rows[0]
}

describe('editAnswerAction: личность правки приходит из сессии', () => {
  beforeEach(async () => {
    holder.db = await createTestDb()
    holder.noSession = false
  })

  it('без сессии отказывает — и ничего не записано', async () => {
    const db = holder.db!
    const submissionId = await seed(db)

    holder.noSession = true
    await expect(
      editAnswerAction(submissionId, 'I.2', 'Team name'),
    ).rejects.toThrow(/no session/)

    // Утверждение — про ПОРЯДОК: `requireSession()` стоит до вызова двери,
    // поэтому до записи дело не дошло. Проверено последствиями: значение и
    // провенанс прежние, событий правки нет.
    holder.noSession = false
    const row = await fieldRow(db, submissionId)
    expect(row?.value).toBe('Old name')
    expect(row?.editedBy).toBeNull()
    const recorded = await db
      .select()
      .from(events)
      .where(and(eq(events.submissionId, submissionId), eq(events.action, TEAM_EDIT_EVENT)))
    expect(recorded).toEqual([])
  })

  it('с сессией — edited_by и actor события равны почте сессии', async () => {
    const db = holder.db!
    const submissionId = await seed(db)

    const result = await editAnswerAction(submissionId, 'I.2', 'Team name')

    expect(result).toEqual({ ok: true })
    const row = await fieldRow(db, submissionId)
    expect(row?.value).toBe('Team name')
    expect(row?.editedBy).toBe(SESSION_EMAIL)

    const recorded = await db
      .select({ actor: events.actor, payload: events.payload })
      .from(events)
      .where(and(eq(events.submissionId, submissionId), eq(events.action, TEAM_EDIT_EVENT)))
    expect(recorded).toEqual([
      {
        actor: SESSION_EMAIL,
        payload: { key: 'I.2', old: 'Old name', new: 'Team name', actor: SESSION_EMAIL },
      },
    ])
  })
})
