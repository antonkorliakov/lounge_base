import { and, eq, sql } from 'drizzle-orm'
import { BLOCKS, keysOfBlock } from '@/form-schema'
import type { Db, Tx } from '@/db/types'
import { blockReviews, fieldFlags, submissions } from '@/db/schema'
import type { SubmissionStatus } from '@/db/schema'
import { fail, type SaveResult } from '@/submissions/editable'
import { openFlags } from './flags'

/**
 * `keysOfBlock` itself now lives in `@/form-schema` (see
 * `form-schema/blocks.ts`'s `register`/`keysOfBlock`/`blockKeyOf`): block↔key
 * membership is questionnaire structure, and building both directions from
 * one construction is what keeps this module's `confirmBlock`/`blockProgress`
 * (which need block → keys) permanently in agreement with `flags.ts`'s
 * `blockKeyOf` (key → block, used by `clearFlagsFor`) without either module
 * having to remember to keep a second copy in sync. Re-exported here because
 * the brief's own interface — and this module's test file — names
 * `keysOfBlock` as something `src/review/blocks.ts` produces.
 */
export { keysOfBlock }

export type BlockState = {
  blockKey: string
  confirmed: boolean
  openFlagCount: number
}

/**
 * Same shape as `submissions/editable.ts`'s `SaveResult` — reused, not
 * redeclared (a previous task in this file's own package tried redeclaring
 * this exact shape and it was a review finding). Kept as a local alias only
 * because `ConfirmResult` reads better at this module's call sites.
 */
export type ConfirmResult = SaveResult

/**
 * The reviewer's own window for acting on `block_reviews` — the only status
 * in which confirming a block is meaningful. Deliberately not
 * `EDITABLE_STATUSES` (`src/submissions/editable.ts`): that set (`draft`,
 * `changes_requested`) is the *filler's* window for editing answers, the
 * opposite concern from a reviewer confirming them. A questionnaire is
 * confirmable only while it is `submitted`:
 *  - `draft` — nothing has been handed to a reviewer yet; there is nothing
 *    to confirm.
 *  - `changes_requested` — the ball is back with the filler, who may still
 *    edit the very fields this confirmation would vouch for before
 *    resubmitting. A confirmation written now would outlive the review
 *    session that produced it and get silently read as still valid the next
 *    time the submission cycles back through `submitted`.
 *  - `approved` — the decision is already final; confirming afterward
 *    serves no purpose and would misrepresent when the block was actually
 *    reviewed.
 *
 * `unconfirmBlock` below is deliberately NOT gated by this set: retracting a
 * confirmation can never make an already-decided state worse (it only makes
 * the questionnaire *less* confirmed), and its interface is locked to
 * `Promise<void>` — there is no channel to report "refused" even if it were
 * gated, so a gate there could only silently no-op. That is the same
 * reasoning `resolveFlag` (`src/review/flags.ts`) already applies to itself:
 * corrective/retracting operations don't need a state gate the way a
 * forward-moving, approval-relevant write does.
 */
export const REVIEW_STATUSES: ReadonlySet<SubmissionStatus> = new Set(['submitted'])

/**
 * Confirms a block, refusing if the submission isn't in the reviewer's
 * window or if the block still carries an open flag.
 *
 * Both checks and the write happen inside one transaction that locks the
 * `submissions` row (`FOR UPDATE`), the same lock `assertEditable`
 * (`src/submissions/editable.ts`) already takes for the filler's side. That
 * closes two real gaps:
 *
 *  1. Without the lock, the status check and the write are two independent
 *     statements with app code in between (this function's own early
 *     `if (!REVIEW_STATUSES.has(status))`) — a concurrent transition (a
 *     second reviewer approving, or requestChanges firing) could commit in
 *     that gap and this confirmation would land after it, against a
 *     submission that is no longer `submitted`. Locking the row before
 *     reading its status serializes this against any other transaction that
 *     also locks it (every submission-status transition in this codebase
 *     already does, or will — Task 4's decision functions are documented,
 *     via `blockProgress`'s `Db | Tx` signature below, to run inside exactly
 *     this kind of locked transaction).
 *  2. It gives Task 4 the same serialization point for reading block state:
 *     `approveSubmission` locking this row before calling `blockProgress`
 *     cannot observe a confirmation landing mid-decision, and a
 *     `confirmBlock` call cannot land while a decision transaction holds
 *     the lock.
 *
 * The open-flags check is a *different* shape on purpose, not a second
 * locked `SELECT`: the brief's original draft read `openFlags` and then, as
 * a separate statement, inserted the confirmation — two round trips with
 * this function's own JS in between. A flag raised by `raiseFlag` in that
 * gap (a genuinely realistic window: `raiseFlag` is a plain, unlocked
 * upsert on `field_flags` — see its own doc comment in `flags.ts` — with no
 * lock on `submissions` for this transaction to serialize against) would be
 * invisible to the stale check, and the insert would go ahead regardless,
 * confirming a block that in fact carries an open flag. This is exactly the
 * check-then-write shape that has already produced four fixed races on this
 * branch.
 *
 * So the check and the write are folded into one statement: `INSERT ...
 * SELECT ... WHERE NOT EXISTS (open flag in this block)`, targeting the
 * same `block_reviews_unique` constraint via `ON CONFLICT DO UPDATE` for
 * idempotent re-confirmation. Under READ COMMITTED this closes the gap that
 * matters in practice — any flag already committed by the time this
 * statement runs, no matter how recently, is guaranteed to be seen, because
 * there is no second round trip for it to land in.
 *
 * That alone would still leave the same-instant case open: `raiseFlag`'s
 * INSERT *still in-flight, uncommitted*, when this statement's own MVCC
 * snapshot is taken — READ COMMITTED correctly hides uncommitted rows from
 * other transactions, so this statement could still see zero flags and
 * confirm, and `raiseFlag`'s flag could still commit a moment later. This
 * is closed too, in `flags.ts`: `raiseFlag` now takes the same `submissions`
 * `FOR UPDATE` lock as this function, before its upsert on `field_flags`.
 * Neither function needs anything *from* that row — the lock exists purely
 * so the two contend on something. Once both lock the same row first,
 * Postgres genuinely serializes them: whichever acquires the lock runs to
 * completion (commit or rollback) before the other's acquisition proceeds,
 * so this function's `NOT EXISTS` subquery is guaranteed to run either
 * strictly before a concurrent `raiseFlag`'s INSERT is visible or strictly
 * after it has committed — never straddling it. There is no longer a window,
 * of any width, in which a block can end up confirmed while carrying a flag
 * that was ever actually committed to `field_flags`.
 */
export async function confirmBlock(
  db: Db,
  input: { submissionId: string; blockKey: string; reviewer: string },
): Promise<ConfirmResult> {
  const keys = keysOfBlock(input.blockKey)
  if (keys.length === 0) {
    return fail('Unknown block', 'Неизвестный блок')
  }

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ status: submissions.status })
      .from(submissions)
      .where(eq(submissions.id, input.submissionId))
      .for('update')
      .limit(1)

    const status = rows[0]?.status
    if (!status) return fail('Submission not found', 'Анкета не найдена')
    if (!REVIEW_STATUSES.has(status)) {
      return fail('This submission is not open for review', 'Анкета сейчас не на проверке')
    }

    const keyList = sql.join(keys.map((key) => sql`${key}`), sql`, `)
    const inserted = await tx
      .insert(blockReviews)
      .select(
        sql`select ${input.submissionId}::uuid, ${input.blockKey}::text, ${input.reviewer}::text, now()
            where not exists (
              select 1 from ${fieldFlags}
              where ${fieldFlags.submissionId} = ${input.submissionId}
                and ${fieldFlags.resolvedAt} is null
                and ${fieldFlags.fieldKey} in (${keyList})
            )`,
      )
      .onConflictDoUpdate({
        target: [blockReviews.submissionId, blockReviews.blockKey],
        set: { confirmedBy: input.reviewer, confirmedAt: new Date() },
      })
      .returning({ blockKey: blockReviews.blockKey })

    if (inserted.length === 0) {
      return fail('Resolve the flags in this block first', 'Сначала снимите замечания в этом блоке')
    }
    return { ok: true }
  })
}

/**
 * Retracts a confirmation. No flag check (a reviewer taking back a
 * confirmation is never blocked by the state it is about to leave) and no
 * status gate (see `REVIEW_STATUSES`'s doc comment above) — an idempotent
 * delete matching the brief's locked `Promise<void>` signature.
 *
 * Still locks the `submissions` row (`FOR UPDATE`) first, even though it
 * reads nothing from that row and applies no status gate. Without this
 * lock, this function's `DELETE` on `block_reviews` contends with nothing
 * `approveSubmission` also locks, so it is free to commit in the exact
 * window between `approveSubmission`'s own `blockProgress` read and its
 * commit — landing an approval against a block that, at the moment
 * `submissions.status` actually flips to `approved`, is no longer
 * confirmed. That is precisely the "confirmed at the moment of the write,
 * not merely when the page loaded" guarantee `approveSubmission` exists to
 * provide. Taking the same `submissions` lock this module's own
 * `confirmBlock` and `flags.ts`'s `raiseFlag` already take — before
 * touching `block_reviews`, and for the same reason: to give this delete
 * something to genuinely serialize against — closes that window: once
 * `approveSubmission` holds the lock, this delete queues behind it and can
 * only apply to a submission `approveSubmission` has already finished
 * deciding on (or already committed as `approved`, in which case the
 * unconfirm still succeeds — retracting a confirmation on a decided
 * submission is harmless bookkeeping, not something that needs blocking).
 * No deadlock: this is the same single lock, same "submissions first"
 * ordering, every other writer in this module and `flags.ts` already uses.
 */
export async function unconfirmBlock(
  db: Db,
  input: { submissionId: string; blockKey: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.id, input.submissionId))
      .for('update')

    await tx
      .delete(blockReviews)
      .where(
        and(
          eq(blockReviews.submissionId, input.submissionId),
          eq(blockReviews.blockKey, input.blockKey),
        ),
      )
  })
}

/**
 * All 27 blocks with their confirmed state and open-flag count — what the
 * reviewer's navigation renders.
 *
 * `Db | Tx`, same reason `openFlags` (`flags.ts`) already takes `Db | Tx`:
 * Task 4's decision functions read block state from inside their own
 * `FOR UPDATE`-locked transaction (the same lock `confirmBlock` above takes),
 * so this must be callable with that transaction's `tx`, not only a fresh
 * unlocked `Db`.
 *
 * One pass over the flags is enough: `openFlags` is called exactly once
 * (not once per block), and the per-block partition is computed in memory
 * afterward. It is self-consistent by construction, not by inspection: both
 * this function's partition and `confirmBlock`'s own check above call the
 * *same* `keysOfBlock`, so the set of keys a block is judged by here is
 * always identical to the set it was judged by when it was confirmed — a
 * change to `keysOfBlock` cannot make this function partition flags
 * differently than `confirmBlock` checked them, because there is only one
 * `keysOfBlock`.
 *
 * This does NOT mean a block can never show `confirmed: true` alongside
 * `openFlagCount > 0` — see `confirmBlock`'s doc comment for the one narrow,
 * same-instant race that can produce that state, and a flag raised *after*
 * a block was legitimately confirmed produces the same visible state on
 * purpose (nothing here or in `raiseFlag` retroactively un-confirms a
 * block). Reporting that combination honestly, rather than hiding it behind
 * a cached "confirmed and clean" bit, is what makes both cases harmless: the
 * reviewer's UI sees the flag right next to the confirmation, and Task 4's
 * approval gate checks open flags globally regardless of any block's
 * confirmed state.
 */
export async function blockProgress(
  db: Db | Tx,
  submissionId: string,
): Promise<BlockState[]> {
  const confirmed = await db
    .select({ blockKey: blockReviews.blockKey })
    .from(blockReviews)
    .where(eq(blockReviews.submissionId, submissionId))
  const confirmedKeys = new Set(confirmed.map((row) => row.blockKey))

  const flags = await openFlags(db, submissionId)

  return BLOCKS.map((block) => {
    const keys = new Set(keysOfBlock(block.key))
    return {
      blockKey: block.key,
      confirmed: confirmedKeys.has(block.key),
      openFlagCount: flags.filter((f) => keys.has(f.fieldKey)).length,
    }
  })
}
