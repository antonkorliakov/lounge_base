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
  // Вся последовательность «прочитать статус — проверить полноту — записать
  // статус — записать событие» идёт в одной транзакции с блокировкой строки
  // `submissions` в самом начале (как в `assertEditable` из `values.ts`).
  // Без этого статус и событие пишутся как два независимых стейтмента:
  // падение между ними оставляет `submitted` без строки в `events`, а два
  // конкурентных вызова оба проходят проверку полноты и оба пишут событие —
  // и то и другое нарушает инвариант «каждая смена статуса пишет событие».
  // Порядок блокировок — тот же, что и у `saveFieldValue`/`saveServiceValue`:
  // сначала `submissions`, только потом (здесь — только чтение) детей;
  // эта транзакция никогда не пишет в `field_values`/`service_values`, так
  // что развернуть порядок и словить дедлок с ними невозможно.
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ status: submissions.status })
      .from(submissions)
      .where(eq(submissions.id, input.submissionId))
      .for('update')
      .limit(1)

    const status = rows[0]?.status
    if (!status) return fail('Submission not found', 'Анкета не найдена')
    if (!SUBMITTABLE.has(status)) {
      return fail('Already submitted', 'Анкета уже отправлена')
    }

    const missing = await missingItems(tx, input.submissionId)
    const total =
      missing.fieldKeys.length + missing.serviceKeys.length + missing.photoSlots.length
    if (total > 0) {
      return fail(
        `${total} item(s) still need an answer`,
        `Осталось заполнить: ${total}`,
      )
    }

    const now = new Date()
    await tx
      .update(submissions)
      .set({ status: 'submitted', submittedAt: now, statusChangedAt: now })
      .where(eq(submissions.id, input.submissionId))

    await tx.insert(events).values({
      submissionId: input.submissionId,
      actor: input.actor,
      action: 'submitted',
      payload: { from: status },
    })

    return { ok: true, status: 'submitted' }
  })
}
