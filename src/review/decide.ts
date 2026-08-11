import { eq } from 'drizzle-orm'
import type { Db, Tx } from '@/db/types'
import { submissions, lounges, events } from '@/db/schema'
import type { SubmissionStatus } from '@/db/schema'
import type { TransitionResult } from '@/submissions/transitions'
import { loadSubmissionValues } from '@/submissions/values'
import { openFlags } from './flags'
import { blockProgress, REVIEW_STATUSES } from './blocks'

const fail = (en: string, ru: string): TransitionResult => ({
  ok: false,
  error: { en, ru },
})

export type ClassifyingFields = {
  terminal: string | null
  terminalType: string | null
  zone: string[] | null
  airsideLandside: string | null
}

/**
 * Both `III.6.1` (terminal type) and `III.6.2` (terminal name) are stored as
 * `SelectValue` (`{ option, detail }` — see `form-schema/validation.ts`),
 * same for `III.6.4` (airside/landside); only their `option` is a
 * classifying value here, `detail` is free text that has no column of its
 * own on `lounges`. A field that was never answered is simply absent from
 * `values` (`loadSubmissionValues` only returns rows that exist in
 * `field_values`), so `values['III.6.x']` is `undefined` — not an object,
 * not `'option' in value` — and this returns `null` for it, same as an
 * answer that was explicitly cleared back to `{ option: '' }` (see the
 * dropdown-placeholder note in `validation.ts`).
 */
function optionOf(value: unknown): string | null {
  if (typeof value === 'object' && value !== null && 'option' in value) {
    const option = (value as { option: unknown }).option
    return typeof option === 'string' && option !== '' ? option : null
  }
  return null
}

/**
 * Same rigor as `optionOf` above: checks every element is actually a string
 * before returning the array, rather than asserting the shape with a bare
 * cast. `validateMultiSelect` (`form-schema/validation.ts`) already
 * guarantees this at write time — `saveFieldValue` never persists a
 * `III.6.6` value with a non-string element — so this can't fail against
 * real data, but this function has no way to see that guarantee from here,
 * and the file's other extractor doesn't take shapes on faith either.
 */
function stringArrayOf(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  return value.every((item): item is string => typeof item === 'string') ? value : null
}

/**
 * Характеристики, по которым фильтруются реестр и выгрузка (план 3). Копируются
 * в `lounges` только при принятии — реестр показывает подтверждённые данные,
 * а не то, что кто-то печатает в черновике (см. `db/schema.ts`'s комментарий
 * над этими четырьмя колонками).
 *
 * `III.6.6` (zone) — единственное классифицирующее поле типа `multi_select`,
 * хранится как массив id опций. Нет ответа или явно очищенный ответ (`[]`) —
 * в обоих случаях `null`: пустой список зон несёт для реестра ровно столько
 * же информации, сколько отсутствующий, так что различать их здесь не нужно.
 */
export function classifyingFieldsFrom(
  values: Record<string, unknown>,
): ClassifyingFields {
  return {
    terminal: optionOf(values['III.6.2']),
    terminalType: optionOf(values['III.6.1']),
    zone: stringArrayOf(values['III.6.6']),
    airsideLandside: optionOf(values['III.6.4']),
  }
}

/**
 * Locks the `submissions` row (`FOR UPDATE`) and returns its status and
 * `loungeId` in the same statement — one round trip, not a status check
 * followed by a second locked-or-unlocked read for the lounge id.
 * `requestChanges` only needs the status; `approveSubmission` needs both,
 * since it writes `lounges` further down the same transaction.
 *
 * Same lock, same position (first statement, before any other table), as
 * `assertEditable` (`submissions/editable.ts`), `confirmBlock`/`raiseFlag`
 * (this package), and `submitSubmission` (`submissions/transitions.ts`) all
 * already take — see `approveSubmission`'s doc comment below for why this
 * ordering rules out deadlock against every one of them.
 */
async function lockSubmission(
  tx: Tx,
  submissionId: string,
): Promise<{ status: SubmissionStatus; loungeId: string } | null> {
  const rows = await tx
    .select({ status: submissions.status, loungeId: submissions.loungeId })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .for('update')
    .limit(1)
  return rows[0] ?? null
}

/**
 * Sends a submitted questionnaire back to the filler. Refuses if there is no
 * open flag: a `changes_requested` submission with nothing marked gives the
 * operator no signal of what to fix, and `raiseFlag` is the only channel a
 * reviewer has for leaving one (there is no "general comment" slot on a
 * submission — see the task report for the gap this leaves and why it's
 * out of this task's scope to close).
 *
 * Status check and write are one transaction locked on `submissions`, same
 * reasoning as `submitSubmission`: without the lock, a status flip and its
 * event land as two independent statements, and a crash between them (or a
 * second, concurrent transition) breaks "every status change writes an
 * event."
 */
export async function requestChanges(
  db: Db,
  input: { submissionId: string; reviewer: string },
): Promise<TransitionResult> {
  return db.transaction(async (tx) => {
    const locked = await lockSubmission(tx, input.submissionId)
    if (!locked) return fail('Submission not found', 'Анкета не найдена')
    if (!REVIEW_STATUSES.has(locked.status)) {
      return fail('Submission is not under review', 'Анкета не на проверке')
    }

    const flags = await openFlags(tx, input.submissionId)
    if (flags.length === 0) {
      return fail(
        'Flag at least one answer before sending it back',
        'Отметьте хотя бы один ответ, прежде чем возвращать',
      )
    }

    const now = new Date()
    await tx
      .update(submissions)
      .set({ status: 'changes_requested', reviewerId: input.reviewer, statusChangedAt: now })
      .where(eq(submissions.id, input.submissionId))

    await tx.insert(events).values({
      submissionId: input.submissionId,
      actor: input.reviewer,
      action: 'changes_requested',
      payload: { flagCount: flags.length },
    })

    return { ok: true, status: 'changes_requested' }
  })
}

/**
 * Approves a submitted questionnaire: only when every one of the 27 blocks
 * is confirmed AND no flag is open, both re-checked here (not trusted from
 * whatever the reviewer's screen last rendered) because either can go stale
 * between page load and click — a flag can be raised in an
 * already-confirmed block, or another reviewer's tab can still be mid-review.
 *
 * Writes three tables in one transaction, in this order: `submissions`
 * (locked first via `lockSubmission`), then `lounges`, then `events`. This
 * cannot deadlock against `raiseFlag`, `confirmBlock`, or
 * `saveFieldValue`/`saveServiceValue` (via `assertEditable`):
 *
 *  1. Every one of those, plus `submitSubmission` and this module's own
 *     `requestChanges`, locks the *same single* `submissions` row (`FOR
 *     UPDATE`) as its first statement, before touching any other table —
 *     the one lock-ordering rule this codebase enforces everywhere a
 *     submission's state is read-then-written. A transaction that only ever
 *     needs one lock from this set cannot be the "B" half of an A-waits-on-B
 *     -waits-on-A cycle; contention degenerates to plain queueing on that
 *     one row, not circular waiting.
 *  2. `lounges` is written here and in exactly one other place:
 *     `setOperationalStatus` (`src/registry/status.ts`, plan 3), which sets a
 *     lounge's operational status. That one CAN be holding a lock on the very
 *     row this transaction wants — it takes the `lounges` row `FOR UPDATE` as
 *     its first statement — so this is now a genuine second contended
 *     resource, and the earlier version of this note ("nowhere else touches
 *     that table at all") no longer holds. It still cannot deadlock against
 *     this transaction, for a reason that does not depend on lock ordering:
 *     `setOperationalStatus` waits for nothing except that one `lounges` row
 *     (its only other write is an append-only `events` INSERT, which acquires
 *     no lock anyone else holds). A transaction that never waits on a second
 *     resource cannot be the "B waits on A" half of a cycle — the worst that
 *     happens is this transaction queueing behind it on that row. If a future
 *     writer of `lounges` ever needs a second lock as well, that argument
 *     stops applying and the ordering has to be made explicit.
 *  3. `events` is append-only (a plain `INSERT`, no `WHERE`); a fresh row
 *     acquires no lock any other transaction can be holding, so it never
 *     becomes a second contended resource either.
 *  So the only lock this transaction can ever wait for is the `submissions`
 *  row it already took first — there is no second resource for a cycle to
 *  form around, hence no deadlock.
 */
export async function approveSubmission(
  db: Db,
  input: { submissionId: string; reviewer: string },
): Promise<TransitionResult> {
  return db.transaction(async (tx) => {
    const locked = await lockSubmission(tx, input.submissionId)
    if (!locked) return fail('Submission not found', 'Анкета не найдена')
    if (!REVIEW_STATUSES.has(locked.status)) {
      return fail('Submission is not under review', 'Анкета не на проверке')
    }

    const flags = await openFlags(tx, input.submissionId)
    if (flags.length > 0) {
      return fail(
        `${flags.length} flag(s) still open`,
        `Открытых замечаний: ${flags.length}`,
      )
    }

    const progress = await blockProgress(tx, input.submissionId)
    const pending = progress.filter((block) => !block.confirmed)
    if (pending.length > 0) {
      return fail(
        `${pending.length} block(s) not confirmed`,
        `Не подтверждено блоков: ${pending.length}`,
      )
    }

    const values = await loadSubmissionValues(tx, input.submissionId)
    const classifying = classifyingFieldsFrom(values.fields)

    const now = new Date()
    await tx
      .update(submissions)
      .set({ status: 'approved', reviewerId: input.reviewer, decidedAt: now, statusChangedAt: now })
      .where(eq(submissions.id, input.submissionId))

    await tx.update(lounges).set(classifying).where(eq(lounges.id, locked.loungeId))

    await tx.insert(events).values({
      loungeId: locked.loungeId,
      submissionId: input.submissionId,
      actor: input.reviewer,
      action: 'approved',
      payload: { classifying },
    })

    return { ok: true, status: 'approved' }
  })
}
