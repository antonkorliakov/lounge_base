import { and, eq, isNull, sql } from 'drizzle-orm'
import { FIELDS, SERVICE_ITEMS, PHOTO_SLOTS, blockKeyOf } from '@/form-schema'
import type { Db, Tx } from '@/db/types'
import { fieldFlags, blockReviews, submissions } from '@/db/schema'
import { fail, type SaveResult } from '@/submissions/editable'

/**
 * The array is the source of truth; `FlagReason` is derived from it rather
 * than hand-typed alongside it. A `new Set<FlagReason>([...])` built from a
 * separately-typed literal array only checks that everything *listed* is
 * assignable to the union — it does not check that every union member is
 * listed, so the union and the array could silently drift apart (add a
 * fifth reason code to one and forget the other, and `toFlagReason` would
 * quietly narrow the new legitimate value to `null`). Deriving the type
 * from the array instead of listing both separately makes that drift
 * impossible to introduce, not just something to remember to avoid — the
 * same fix this module already applied to `SaveResult`/`fail` (reuse the
 * one definition) and that `form-schema` applies to `detailRequiredFor`
 * (one place both the validator and the renderer read).
 */
export const FLAG_REASONS = ['empty', 'needs_detail', 'contradicts', 'wrong_format'] as const

export type FlagReason = (typeof FLAG_REASONS)[number]

const FLAG_REASON_SET: ReadonlySet<string> = new Set(FLAG_REASONS)

function isFlagReason(value: string): value is FlagReason {
  return FLAG_REASON_SET.has(value)
}

export type FlagRow = {
  id: string
  fieldKey: string
  reason: FlagReason | null
  comment: string
}

/**
 * Same shape as `submissions/editable.ts`'s `SaveResult` — a write that
 * either succeeds or fails with a localized reason and nothing else — so
 * it reuses that type rather than redeclaring it. This codebase just
 * finished a task consolidating exactly this shape into one definition;
 * a second one here would have quietly undone that. Kept as a local
 * alias only because `FlagResult` reads better at this module's call
 * sites than `SaveResult` does.
 */
export type FlagResult = SaveResult

/**
 * Замечание адресует то, что заполняющий видит как один вопрос: поле,
 * позицию услуг целиком или слот фотографии. Претензия к отдельному
 * атрибуту позиции (например, к отсутствующей цене) выражается текстом
 * комментария — на возврате всё равно открывается вся позиция, так что
 * адресовать один её атрибут в отрыве от остальных было бы бессмысленно.
 */
const FLAGGABLE: ReadonlySet<string> = new Set([
  ...FIELDS.map((f) => f.key),
  ...SERVICE_ITEMS.map((i) => i.key),
  ...PHOTO_SLOTS.map((s) => s.key),
])

export function isFlaggableKey(key: string): boolean {
  return FLAGGABLE.has(key)
}

export async function raiseFlag(
  db: Db,
  input: {
    submissionId: string
    fieldKey: string
    reason: FlagReason | null
    comment: string
    reviewer: string
  },
): Promise<FlagResult> {
  if (!isFlaggableKey(input.fieldKey)) {
    return fail('Unknown field', 'Неизвестное поле')
  }

  const comment = input.comment.trim()
  if (comment === '') {
    return fail('Say what is wrong', 'Напишите, что не так')
  }

  /**
   * "One open flag per (submission, field)" is enforced by a database
   * constraint, not by an application-level read-then-write. An earlier
   * draft here deleted any existing open flag for the key and then
   * inserted a new one as two separate statements. Under the default READ
   * COMMITTED isolation, two reviewers flagging the same field at the same
   * moment (or one reviewer double-clicking) can both run the DELETE
   * against a snapshot where the other's row does not exist yet, and both
   * then INSERT — leaving two open flags for the same key, which
   * `openFlags` would dutifully return both of, and which the review UI
   * (built to show one open note per question) is not designed to handle.
   *
   * `field_flags_open_unique` (migration 0003) is a partial unique index on
   * `(submission_id, field_key) WHERE resolved_at IS NULL`. This upsert
   * targets it directly: Postgres itself serializes concurrent attempts to
   * open a flag on the same key — one of them gets the row and updates it
   * in place, the other's insert becomes an update of the very row the
   * first one just wrote (or is still writing, in which case it blocks on
   * the row lock until that commits, then reapplies against the committed
   * row). There is never a window where two open rows for the same key both
   * exist. This is the same shape as the delete-then-write races already
   * found and fixed elsewhere on this branch (`access/team.ts`'s
   * `consumeLoginToken`, `submissions/values.ts`'s upserts): replace a
   * check-then-write pair with one atomic statement backed by a real
   * constraint.
   *
   * Re-raising an already-open flag intentionally overwrites reason/
   * comment/createdBy/createdAt in place rather than superseding it with a
   * fresh row — nothing about the previous open flag is "history" yet
   * (history is what `resolvedAt` marks), so there is nothing to preserve.
   */
  return db.transaction(async (tx) => {
    /**
     * `FOR UPDATE` on the `submissions` row, taken before the upsert below,
     * not because this function reads or needs anything from `submissions`
     * itself (it doesn't check status — see the module-boundary reasoning
     * this file already carries elsewhere), but because `confirmBlock`
     * (`src/review/blocks.ts`, Task 3) takes the exact same lock before
     * evaluating `WHERE NOT EXISTS (open flag in this block)`. Without this
     * lock, `raiseFlag`'s upsert and `confirmBlock`'s check-and-insert
     * contend on nothing at all — different tables, no shared row — so
     * under READ COMMITTED a flag committed by this function during
     * `confirmBlock`'s statement is invisible to it, and a block can end up
     * confirmed while carrying the very flag this upsert just opened. Once
     * both functions lock the same `submissions` row first, Postgres
     * genuinely serializes them: whichever gets the lock first runs to
     * completion (commit or rollback) before the other's lock acquisition
     * proceeds, so `confirmBlock`'s `NOT EXISTS` subquery is guaranteed to
     * run either strictly before this INSERT is visible or strictly after —
     * never straddling it. This is the same lock, same ordering (`submissions`
     * first, then the child table), that `confirmBlock` (`blocks.ts`) and
     * `assertEditable` (`src/submissions/editable.ts`) already use, so this
     * introduces no new deadlock risk.
     *
     * Every other child-table writer in this module takes the same lock in
     * the same position, including `clearFlagsFor`. An earlier version of
     * this comment argued at length that `clearFlagsFor` was the one
     * exception and did not need it; that argument was wrong, and its
     * specific reasoning error is recorded in `clearFlagsFor`'s own doc
     * comment below because it is the reusable part.
     *
     * Not gated on the locked row's status: that would change this
     * function's behaviour (Task 2 deliberately left `raiseFlag` ungated —
     * see the module's own history), which is not what this fix is for.
     * The `.select(...).for('update')` below reads nothing from the
     * returned row; it exists purely to take the lock.
     */
    await tx
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.id, input.submissionId))
      .for('update')

    await tx
      .insert(fieldFlags)
      .values({
        submissionId: input.submissionId,
        fieldKey: input.fieldKey,
        reason: input.reason,
        comment,
        createdBy: input.reviewer,
      })
      .onConflictDoUpdate({
        target: [fieldFlags.submissionId, fieldFlags.fieldKey],
        targetWhere: sql`${fieldFlags.resolvedAt} is null`,
        set: {
          reason: input.reason,
          comment,
          createdBy: input.reviewer,
          createdAt: new Date(),
        },
      })

    return { ok: true }
  })
}

/**
 * Снимает конкретное замечание по его id. Не принимает ни личность
 * вызывающего, ни ожидание о статусе анкеты — по интерфейсу задачи это
 * просто "resolveFlag(db, flagId): Promise<void>", и вопрос "кому можно" по
 * прежнему не относится к этому модулю: это авторизация проверяющего, а не
 * адресация замечания; решает слой серверных действий (тот же слой, что уже
 * проверяет сессию перед вызовом `access/team.ts`), а не этот модуль, который
 * вообще не знает о сессиях и ролях.
 *
 * "Уместно ли сейчас" — раньше здесь было рассуждение, что резолв безопасен
 * без блокировки `submissions`, потому что резолв только СУЖАЕТ множество
 * открытых замечаний, а значит не может сделать уже проверенное решение
 * неверным. Это рассуждение оказалось верным для `approveSubmission` и
 * `confirmBlock` (оба отказывают, когда замечания ЕСТЬ — сужение множества
 * может сделать отказ только более консервативным), но неверным для
 * `requestChanges`: он отказывает, когда замечаний НЕТ, так что для него
 * опасное направление — именно сужение. Не заблокированный на `submissions`
 * резолв мог применить `UPDATE` между тем, как `requestChanges` читает
 * `openFlags` внутри своей залоченной транзакции (увидев непустое множество)
 * и её коммитом — обнулив множество до того, как решение фактически
 * зафиксируется, и отправив анкету оператору без единой отметки, то есть
 * ровно то, что этот отказ должен предотвращать. Рассуждать по направлению
 * отдельно для каждого вызывающего — тот же способ мышления, что уже привёл
 * к пяти похожим гонкам на этой ветке; проще и надёжнее не рассуждать вовсе:
 * резолв теперь берёт ту же блокировку `submissions` (`FOR UPDATE`), что и
 * `raiseFlag`/`confirmBlock`/`unconfirmBlock`, тем же порядком (родитель
 * первым), поэтому он либо целиком до, либо целиком после любой транзакции
 * решения — никогда не посередине.
 *
 * Единственное, что резолв обязан гарантировать сам — идемпотентность:
 * `isNull(resolvedAt)` в WHERE делает повторный вызов на уже снятом
 * замечании no-op, а не переписыванием `resolvedAt` более поздним временем,
 * которое стёрло бы историю "когда это было снято на самом деле".
 */
export async function resolveFlag(db: Db, flagId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ submissionId: fieldFlags.submissionId })
      .from(fieldFlags)
      .where(eq(fieldFlags.id, flagId))
      .limit(1)

    const submissionId = rows[0]?.submissionId
    if (!submissionId) return

    await tx
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.id, submissionId))
      .for('update')

    await tx
      .update(fieldFlags)
      .set({ resolvedAt: new Date() })
      .where(and(eq(fieldFlags.id, flagId), isNull(fieldFlags.resolvedAt)))
  })
}

/**
 * Re-exported, not recomputed. `blockKeyOf` used to be its own scan over
 * `FIELDS`/`SERVICE_ITEMS`/`SERVICE_GROUPS`/`PHOTO_SLOTS` here, independent
 * of `keysOfBlock` (`src/review/blocks.ts`, Task 3), which needs the exact
 * inverse mapping over the same three arrays. Two independent
 * implementations of one mapping is the defect class this codebase keeps
 * finding (see `form-schema/blocks.ts`'s doc comment on `register` for the
 * full account) — Task 3 moved both directions into `form-schema` as a
 * single construction, since block↔key membership is questionnaire
 * structure, not a review-module concern. This re-export keeps every
 * existing caller and this module's own `clearFlagsFor` unchanged.
 */
export { blockKeyOf }

/**
 * Снимает открытое замечание по ключу и подтверждение его блока: раз
 * заполняющий отредактировал отмеченное поле, ревьюер должен посмотреть
 * блок заново, а остальные блоки остаются подтверждёнными. Возвращает
 * `true`, если замечание было (то есть было что снимать).
 *
 * Обе записи — снятие замечания и инвалидация подтверждения блока —
 * обёрнуты в одну транзакцию. Это не защита от параллельных вызовов
 * `clearFlagsFor` на один и тот же ключ (тот случай безопасен и без
 * транзакции: UPDATE с `isNull(resolvedAt)` в WHERE возвращает строку
 * ровно одному из конкурирующих вызовов, второй получает пустой
 * `.returning()` и молча пропускает DELETE, который в любом случае
 * идемпотентен). Транзакция здесь — про атомарность при сбое: без неё
 * падение процесса между UPDATE и DELETE оставило бы замечание снятым, но
 * старое подтверждение блока — на месте, то есть блок выглядел бы
 * подтверждённым ревьюером, хотя данные в нём изменились после того, как
 * он смотрел последний раз. Именно это подтверждение призвано
 * гарантировать не бывает, так что оба эффекта одного события ("поле
 * отредактировано") должны фиксироваться вместе или не фиксироваться
 * вовсе.
 *
 * The transaction also takes the same `submissions` `FOR UPDATE` every
 * sibling writer here takes, as its first statement, for the same reason
 * `resolveFlag` does: it can otherwise commit in the middle of
 * `requestChanges` (`src/review/decide.ts`), which reads `openFlags` inside
 * its own locked transaction and REFUSES on an empty set. An unlocked clear
 * landing between that read and that commit leaves a submission in
 * `changes_requested` with zero open flags — and `FillForm`'s fixes screen is
 * gated on `status === 'changes_requested' && flags.length > 0`, so the
 * filler gets the whole 19-step form back with no indication of what to fix.
 * That is exactly what the refusal exists to prevent.
 *
 * **This function was previously exempted from the lock-order guard, and the
 * exemption's argument was wrong.** It is worth recording why, because the
 * error is easy to repeat and this is far from the first check-then-write
 * race on this branch — the guard's own header enumerates them, so the count
 * lives in one place rather than being restated here to drift out of date.
 * The argument was: `clearFlagsFor` only fires when a
 * previously-flagged answer is edited, which `EDITABLE_STATUSES` limits to
 * `draft`/`changes_requested`; every review decision requires `submitted`
 * (`REVIEW_STATUSES`); the two sets are disjoint and a submission has one
 * status at a time; therefore no window exists, full stop.
 *
 * Every clause of that is true, and the conclusion still does not follow. It
 * confuses "cannot FIRE concurrently with a review decision" with "cannot BE
 * RUNNING concurrently with one" — i.e. it treats the status gate as if it
 * held for the duration of the work it admits, when in fact the gate's lock
 * is released the moment the gate's OWN transaction commits. The real path:
 * `saveFieldAction` (`src/app/f/[token]/actions.ts`) → `resolveFillToken`, a
 * plain SELECT on `fill_tokens` that checks no status at all → `saveFieldValue`,
 * whose `assertEditable` takes the lock and checks `EDITABLE_STATUSES` inside
 * its own transaction → that transaction COMMITS → only then does
 * `clearFlagsFor` open a fresh one. By the time this function's first
 * statement runs, nothing holds the row and the status is free to have
 * changed. Reachable, not theoretical: `FillForm`'s `submit()` calls
 * `submitAction` immediately, with no wait on the autosave queue and no
 * gating on `pendingCount`, so a filler typing a correction and clicking
 * Submit inside the 600ms debounce produces exactly these overlapping
 * requests.
 *
 * The generalizable form: a status precondition checked in an earlier
 * transaction is a statement about the past, not an invariant held over the
 * follow-up write, so "these two statuses are disjoint" never by itself
 * licenses skipping the lock. Reasoning per caller about whether a
 * particular interleaving happens to be harmful is what produced this
 * exemption and `resolveFlag`'s before it; uniform locking is what replaced
 * both, and the guard (`src/review/__tests__/lock-order-guard.ts`) now has no
 * exemptions at all.
 *
 * No deadlock introduced: this runs after `saveFieldValue`'s transaction has
 * committed, and takes `submissions` before the child tables — the one
 * ordering every writer in `src/review`, `src/submissions` and `src/photos`
 * uses.
 */
export async function clearFlagsFor(
  db: Db,
  submissionId: string,
  key: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.id, submissionId))
      .for('update')

    const cleared = await tx
      .update(fieldFlags)
      .set({ resolvedAt: new Date() })
      .where(
        and(
          eq(fieldFlags.submissionId, submissionId),
          eq(fieldFlags.fieldKey, key),
          isNull(fieldFlags.resolvedAt),
        ),
      )
      .returning({ id: fieldFlags.id })

    if (cleared.length === 0) return false

    const blockKey = blockKeyOf(key)
    if (blockKey) {
      await tx
        .delete(blockReviews)
        .where(
          and(
            eq(blockReviews.submissionId, submissionId),
            eq(blockReviews.blockKey, blockKey),
          ),
        )
    }

    return true
  })
}

/**
 * `Db | Tx`, not `Db`: Task 4's decision functions (`approveSubmission`/
 * `requestChanges`) must read open flags from *inside* their own
 * transaction (locked on `submissions`, the same `FOR UPDATE` shape
 * `assertEditable` already uses), the same reason `missingItems` in
 * `src/submissions/completeness.ts` already takes `Db | Tx` rather than
 * just `Db` — a read that also needs to run under an existing transaction's
 * lock cannot be typed to accept only a fresh, unlocked connection.
 */
export async function openFlags(db: Db | Tx, submissionId: string): Promise<FlagRow[]> {
  const rows = await db
    .select({
      id: fieldFlags.id,
      fieldKey: fieldFlags.fieldKey,
      reason: fieldFlags.reason,
      comment: fieldFlags.comment,
    })
    .from(fieldFlags)
    .where(
      and(eq(fieldFlags.submissionId, submissionId), isNull(fieldFlags.resolvedAt)),
    )

  return rows.map((row) => ({
    id: row.id,
    fieldKey: row.fieldKey,
    reason: toFlagReason(row.reason),
    comment: row.comment,
  }))
}

/**
 * `field_flags.reason` is a bare `text` column (see `db/schema.ts`) — the
 * database has no enum to guarantee its contents match `FlagReason`, only
 * `raiseFlag` writing exclusively through this module's own type does. A
 * bare `as FlagReason | null` here would assert that without checking it,
 * reintroducing the kind of unchecked cast this codebase's prep task
 * removed the last of. Narrowing against the known reason codes and
 * falling back to `null` for anything else means a row that somehow got a
 * value outside the union (a manual DB edit, a future migration that
 * doesn't update this list) is treated as "no reason given" rather than
 * silently mistyped as one of the four codes it isn't.
 */
function toFlagReason(value: string | null): FlagReason | null {
  return value !== null && isFlagReason(value) ? value : null
}
