import { eq } from 'drizzle-orm'
import type { Localized } from '@/form-schema'
import { submissions } from '@/db/schema'
import type { SubmissionStatus } from '@/db/schema'
import type { Tx } from '@/db/types'

/**
 * Shared shape for every write that can be refused with a localized reason
 * instead of throwing. Used by `saveFieldValue`/`saveServiceValue`
 * (`submissions/values.ts`) and `attachPhoto`/`removePhoto`
 * (`photos/store.ts`) — anywhere a write either succeeds outright or fails
 * with an `{ en, ru }` message and nothing else. `transitions.ts`'s
 * `TransitionResult` is deliberately NOT this type: a transition also
 * carries the resulting `status` on success and an optional `missing` list
 * on failure, so forcing it into this shape would either lose those fields
 * or make them silently optional on every other caller.
 */
export type SaveResult = { ok: true } | { ok: false; error: Localized }

export const fail = (en: string, ru: string): SaveResult => ({ ok: false, error: { en, ru } })

/**
 * Правки принимаются только в состояниях, где форма открыта заполняющему.
 * Единственное определение этого множества для серверного слоя — раньше оно
 * дублировалось в values.ts и photos/store.ts как нетипизированный
 * `Set<string>`, и ничего не мешало им расползтись при переименовании
 * значения статуса (whole-branch review). `transitions.ts` использует то же
 * множество под именем `SUBMITTABLE` (форма отправляется из тех же
 * состояний, в которых она ещё открыта на правку) — это одно и то же
 * множество статусов, а не два похожих.
 *
 * `src/web/FillForm.tsx` держит собственную копию (`EDITABLE_STATUSES`,
 * тоже верно типизированную) для клиентского решения "что показать" —
 * этот модуль туда не подключается: он тянет `drizzle-orm` и `@/db/schema`
 * как значения, а не только типы, и такой импорт в клиентском компоненте
 * затащил бы их в браузерный бандл. Оставлено раздельно осознанно, см.
 * отчёт по подготовке.
 */
export const EDITABLE_STATUSES: ReadonlySet<SubmissionStatus> = new Set([
  'draft',
  'changes_requested',
])

export async function assertEditable(tx: Tx, submissionId: string): Promise<SaveResult> {
  // FOR UPDATE: the status check and the write land in different tables
  // (submissions vs. field_values/service_values/photos), so under the
  // default READ COMMITTED isolation a plain SELECT takes no lock and does
  // nothing to serialize against a concurrent status change. Locking this
  // row keeps a concurrent submit/approve from committing until this
  // transaction does — do not remove this thinking it's redundant with the
  // transaction.
  const rows = await tx
    .select({ status: submissions.status })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .for('update')
    .limit(1)

  const status = rows[0]?.status
  if (!status) return fail('Submission not found', 'Анкета не найдена')
  if (!EDITABLE_STATUSES.has(status)) {
    return fail('This submission is under review', 'Анкета сейчас на проверке')
  }
  return { ok: true }
}
