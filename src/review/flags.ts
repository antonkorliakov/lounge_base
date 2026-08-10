import { and, eq, isNull, sql } from 'drizzle-orm'
import { FIELDS, SERVICE_ITEMS, PHOTO_SLOTS, blockKeyOf } from '@/form-schema'
import type { Db, Tx } from '@/db/types'
import { fieldFlags, blockReviews } from '@/db/schema'
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
  await db
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
}

/**
 * Снимает конкретное замечание по его id. Не принимает ни личность
 * вызывающего, ни ожидание о статусе анкеты — по интерфейсу задачи это
 * просто "resolveFlag(db, flagId): Promise<void>", и оба вопроса на самом
 * деле не относятся к этому модулю:
 *
 *  - "кому можно" — вопрос авторизации проверяющего, а не адресации
 *    замечания; его решает слой серверных действий (тот же слой, что уже
 *    проверяет сессию перед вызовом `access/team.ts`), а не этот модуль,
 *    который вообще не знает о сессиях и ролях.
 *  - "уместно ли сейчас" — единственный сценарий, где резолв замечания
 *    после решения по анкете (task 4) был бы проблемой, это если решение
 *    читает `openFlags` внутри собственной транзакции, залоченной на
 *    `submissions` (как `assertEditable` уже делает для сохранения
 *    значений) — тогда resolveFlag снаружи этой транзакции просто не может
 *    попасть в её окно: он трогает только `field_flags`, а не `submissions`,
 *    так что ничьей блокировки он не видит и ни на что не блокируется. Он
 *    может выполниться до, после или (если ждёт снятой строки) сразу после
 *    коммита — решение в любом случае увидит консистентный, а не
 *    "наполовину обновлённый", снимок замечаний.
 *
 * Единственное, что резолв обязан гарантировать сам — идемпотентность:
 * `isNull(resolvedAt)` в WHERE делает повторный вызов на уже снятом
 * замечании no-op, а не переписыванием `resolvedAt` более поздним временем,
 * которое стёрло бы историю "когда это было снято на самом деле".
 */
export async function resolveFlag(db: Db, flagId: string): Promise<void> {
  await db
    .update(fieldFlags)
    .set({ resolvedAt: new Date() })
    .where(and(eq(fieldFlags.id, flagId), isNull(fieldFlags.resolvedAt)))
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
 */
export async function clearFlagsFor(
  db: Db,
  submissionId: string,
  key: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
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
