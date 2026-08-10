import { eq } from 'drizzle-orm'
import type { Localized } from '@/form-schema'
import { submissions, events } from '@/db/schema'
import type { SubmissionStatus } from '@/db/schema'
import type { Db } from '@/db/types'
import { missingItems } from './completeness'

export type TransitionResult =
  | { ok: true; status: SubmissionStatus }
  | { ok: false; error: Localized }

const fail = (en: string, ru: string): TransitionResult => ({
  ok: false,
  error: { en, ru },
})

/** Отправить можно из состояний, где форма открыта заполняющему. */
const SUBMITTABLE = new Set<SubmissionStatus>(['draft', 'changes_requested'])

export async function submitSubmission(
  db: Db,
  input: { submissionId: string; actor: string },
): Promise<TransitionResult> {
  const rows = await db
    .select({ status: submissions.status })
    .from(submissions)
    .where(eq(submissions.id, input.submissionId))
    .limit(1)

  const status = rows[0]?.status
  if (!status) return fail('Submission not found', 'Анкета не найдена')
  if (!SUBMITTABLE.has(status)) {
    return fail('Already submitted', 'Анкета уже отправлена')
  }

  const missing = await missingItems(db, input.submissionId)
  const total =
    missing.fieldKeys.length + missing.serviceKeys.length + missing.photoSlots.length
  if (total > 0) {
    return fail(
      `${total} item(s) still need an answer`,
      `Осталось заполнить: ${total}`,
    )
  }

  const now = new Date()
  await db
    .update(submissions)
    .set({ status: 'submitted', submittedAt: now, statusChangedAt: now })
    .where(eq(submissions.id, input.submissionId))

  await db.insert(events).values({
    submissionId: input.submissionId,
    actor: input.actor,
    action: 'submitted',
    payload: { from: status },
  })

  return { ok: true, status: 'submitted' }
}
