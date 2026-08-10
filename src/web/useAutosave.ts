'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * `'rejected'` is distinct from `'saved'`: the queue is empty (nothing left
 * to retry — the server answered) but at least one key's last answer was
 * permanently refused (see `rejected`, below). Before this state existed,
 * an empty queue after a refusal collapsed to `'saved'` — the exact bug
 * Critical 2 of the whole-branch review names: every rejection was reported
 * to the operator as success.
 */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'offline' | 'rejected'

export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Shape returned by a save attempt. Deliberately loose (`ok: boolean`, not a
 * discriminated union), and deliberately a plain `string` rather than the
 * `Localized` pair `ActionResult` in `src/app/f/[token]/actions.ts` actually
 * carries: this `error` is only ever used internally, for this hook's own
 * `rejected` bookkeeping, and is never rendered — so the caller's `save`
 * callback picks a locale down to a string at that boundary (see
 * `FillForm.tsx`) before it ever reaches here.
 */
export type SaveOutcome = { ok: boolean; error?: string }

type Queue = Record<string, unknown>

const storageKey = (submissionId: string): string => `lounge.draft.${submissionId}`

/**
 * Reads the locally queued (not yet confirmed saved) values for a
 * submission.
 *
 * A corrupted or non-object payload is treated as an empty queue rather
 * than thrown. `push` calls this on every keystroke to merge the new value
 * in — a throw here would stop the operator from typing at all, which is
 * worse than losing whatever was already unreadable (it was corrupted
 * before this call; there is nothing left to recover). `console.warn` keeps
 * the loss visible to developers instead of making it silent.
 */
export function readQueue(storage: StorageLike, submissionId: string): Queue {
  const raw = storage.getItem(storageKey(submissionId))
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Queue
  } catch {
    console.warn(`[useAutosave] draft queue for ${submissionId} was unreadable, reset to empty`)
    return {}
  }
}

export function writeQueue(storage: StorageLike, submissionId: string, queue: Queue): void {
  storage.setItem(storageKey(submissionId), JSON.stringify(queue))
}

/**
 * Structural equality, insensitive to object key order. `ServiceValueInput`
 * and `SelectValue`/`TemplateValue` field values are plain (at most
 * one-level-nested) JSON objects; two logically identical ones built by
 * different code paths can easily end up with keys in a different order.
 * A `JSON.stringify` comparison would treat those as different values and
 * cause a pointless resend (or, worse inside `clearIfUnchanged`, a refusal
 * to clear a key that was in fact confirmed saved).
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b || a === null || b === null) return false

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => sameValue(item, b[i]))
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    const bRecord = b as Record<string, unknown>
    return aKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        sameValue((a as Record<string, unknown>)[key], bRecord[key]),
    )
  }

  return false
}

/**
 * Removes exactly one key from the *live* queue, and only if it still holds
 * the value that was just confirmed saved. See the race explained on
 * `queueDrain`: never delete based on a stale snapshot, always re-read
 * first, and back off if a newer edit has landed on this key since the send
 * started.
 */
function clearIfUnchanged(
  storage: StorageLike,
  submissionId: string,
  key: string,
  sentValue: unknown,
): void {
  const current = readQueue(storage, submissionId)
  if (!Object.prototype.hasOwnProperty.call(current, key)) return
  if (!sameValue(current[key], sentValue)) return
  delete current[key]
  writeQueue(storage, submissionId, current)
}

/**
 * Drains everything queued locally, one key at a time, and reports back any
 * key the server permanently refused.
 *
 * Race with `push`: this only ever reads a *snapshot* of the queue to know
 * which keys to attempt, and it removes each key individually — immediately
 * after that key's own save is confirmed, and only via `clearIfUnchanged`
 * (re-read-then-maybe-delete). It never does a single read-modify-write of
 * the *whole* queue at the end.
 *
 * That distinction is the entire point. A naive drain that reads the queue
 * once, awaits every send, and then writes back one leftover object at the
 * end has this failure: `push` runs synchronously between two awaited
 * sends (a keystroke on I.4 while I.2 is still in flight), so it
 * read-modify-writes the *live* queue to add I.4. The naive drain's final
 * write is built from its start-of-drain snapshot, which never had I.4 in
 * it — so that write clobbers storage and I.4 is gone. It was never sent to
 * the server and now isn't queued either. Worse, the same shape of bug can
 * *resurrect* a stale value: if I.3's send throws (offline) while the user
 * has already corrected I.3 to a new value via `push`, a naive drain still
 * remembers only the *old* I.3 value from its snapshot and writes that back
 * over the corrected one — the operator's fix silently reverts to what they
 * already changed their mind about. Deleting key-by-key against the live
 * queue, guarded by a value comparison, avoids both: an unrelated key added
 * mid-drain is untouched (it simply isn't part of this drain's snapshot),
 * and a key that changed value mid-drain is left queued rather than erased
 * or rolled back, because the guard in `clearIfUnchanged` sees it no longer
 * matches what was sent.
 *
 * Retryable vs. terminal failure: `save` *rejecting* (thrown error) means
 * the attempt never reached the server — a network hiccup, offline device,
 * etc. That value stays queued for the next drain. `save` *resolving*
 * `{ ok: false }` means the request reached the server and the server's
 * validation refused it (`saveFieldValue` / `saveServiceValue`'s own
 * refusal, relayed by the server action). Retrying the exact same rejected
 * input will only ever produce the same rejection, so that key is removed
 * from the retry queue — retrying forever would spin the network and leave
 * the UI stuck on "offline" for a value that was never a connectivity
 * problem. Its key and message are returned in `rejected` instead of being
 * silently dropped, so a caller can surface it to the operator.
 *
 * A rejection is only recorded if the live queue still holds the exact
 * value that was sent — the same guard `clearIfUnchanged` uses for
 * deletion. If the operator corrected this key while the rejected request
 * was in flight, the rejection is stale news about a value that no longer
 * exists anywhere (not in the queue, not on screen): recording it would
 * mark the field invalid for an answer the operator already changed their
 * mind about. `saved` reports every key that *did* go through this drain
 * successfully, so a caller can drop any previously-recorded rejection for
 * that key — a value the server just accepted is not rejected, regardless
 * of how it got marked that way earlier.
 */
export async function queueDrain(
  storage: StorageLike,
  submissionId: string,
  save: (key: string, value: unknown) => Promise<SaveOutcome>,
): Promise<{ saved: string[]; rejected: Record<string, string> }> {
  const snapshot = readQueue(storage, submissionId)
  const saved: string[] = []
  const rejected: Record<string, string> = {}

  for (const [key, value] of Object.entries(snapshot)) {
    let result: SaveOutcome
    try {
      result = await save(key, value)
    } catch {
      // Network/offline: leave it queued exactly as-is, retry on the next drain.
      continue
    }

    if (result.ok) {
      saved.push(key)
    } else {
      const current = readQueue(storage, submissionId)
      const stillCurrent =
        Object.prototype.hasOwnProperty.call(current, key) && sameValue(current[key], value)
      if (stillCurrent) rejected[key] = result.error ?? 'rejected'
    }
    clearIfUnchanged(storage, submissionId, key, value)
  }

  return { saved, rejected }
}

/**
 * Pure merge step for the hook's `rejected` state, applied after every
 * drain. Kept outside the hook, and exported, so this state transition is
 * testable without rendering the hook (this suite has no DOM environment).
 *
 * Any key this drain saved successfully is dropped from the previous
 * rejection set first — a value the server just accepted cannot still be
 * "rejected", no matter when or why it was marked that way. This drain's
 * own new rejections (already guarded by `queueDrain` against staleness)
 * are then merged in.
 */
export function mergeRejected(
  prev: Record<string, string>,
  drain: { saved: string[]; rejected: Record<string, string> },
): Record<string, string> {
  if (drain.saved.length === 0 && Object.keys(drain.rejected).length === 0) return prev
  const next = { ...prev }
  for (const key of drain.saved) delete next[key]
  Object.assign(next, drain.rejected)
  return next
}

/**
 * Whether a just-mounted hook instance should immediately attempt to drain
 * whatever is already queued for this submission — the case of an operator
 * reopening a fill link after their tab died mid-form. Exported and pure
 * for the same reason as `mergeRejected`: no DOM environment is configured
 * for this suite, so the mount effect itself stays a one-line call into
 * this predicate rather than logic that needs a rendered hook to exercise.
 *
 * `queuedCount === 0` short-circuits so a fresh/empty draft never fires a
 * pointless round trip on every mount. `isOnline === false` also defers:
 * there is no point attempting a send the browser already knows will fail,
 * and the existing `online` event listener will trigger the drain once
 * connectivity actually returns.
 */
export function shouldDrainOnMount(queuedCount: number, isOnline: boolean): boolean {
  return queuedCount > 0 && isOnline
}

/**
 * Local-storage safety net plus autosave for a single submission's draft.
 *
 * `push` writes to the local queue synchronously and unconditionally — that
 * write is the safety net and must never wait on the network. The network
 * send is debounced (`debounceMs`, default 600ms of inactivity): saving
 * hundreds of fields one network round trip per keystroke would flood the
 * connection this feature exists to be resilient to, when what actually
 * matters is that every value eventually lands, not that it lands the
 * instant it is typed. Drains are serialized (a drain already in flight
 * absorbs the next request instead of running a second one concurrently
 * against the same storage key) — `queueDrain` is safe under overlapping
 * drains too (see its own doc comment), but serializing avoids doubling
 * network calls for no benefit.
 */
export function useAutosave<T>(input: {
  submissionId: string
  save: (key: string, value: T) => Promise<SaveOutcome>
  debounceMs?: number
}): {
  status: SaveStatus
  push: (key: string, value: T) => void
  pendingCount: number
  rejected: Record<string, string>
  /**
   * Whatever was still queued in local storage when this hook mounted —
   * exposed so the caller can restore it into its own visible form state,
   * not just resend it over the network. Populated once, at mount, from
   * whatever `readQueue` finds; never touched again afterwards (a later
   * `push` already lands directly in the caller's own state via its normal
   * `onChange` path, so re-populating this on every queue change would only
   * risk clobbering a newer edit with a stale one).
   *
   * Before this existed, the mount effect below only ever *resent* a
   * surviving queue to the server — it never told the caller what was in
   * it. That silently fixed the backend (the value did reach the database)
   * while leaving the on-screen field blank: an operator who typed an
   * answer and reloaded before the 600ms debounce fired would watch their
   * own answer vanish from the form, with no error and no visible trace,
   * recoverable only by reloading a *second* time. That gap had no unit
   * test (this suite has no DOM — see the file-level comments below) and
   * was only ever going to surface in a real browser; see `e2e/fill.spec.ts`
   * ("перезагрузка сохраняет значение...").
   */
  recovered: Record<string, T>
} {
  const debounceMs = input.debounceMs ?? 600
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [pendingCount, setPendingCount] = useState(0)
  const [rejected, setRejected] = useState<Record<string, string>>({})
  const [recovered, setRecovered] = useState<Record<string, T>>({})

  const saveRef = useRef(input.save)
  saveRef.current = input.save

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const drainingRef = useRef(false)
  const rerunRef = useRef(false)

  // Mirrors `rejected` state, updated in lockstep by `updateRejected` below.
  // The `finally` block in `drain` needs the *current* rejected set the
  // instant the drain loop ends, to decide `'saved'` vs `'rejected'` — it
  // cannot wait for React to commit a `setRejected` update and re-render,
  // and it cannot trust a `rejected` closed over from when `drain` was
  // created, since that value is stale by the time an async drain finishes.
  const rejectedRef = useRef<Record<string, string>>({})

  const getStorage = (): StorageLike => window.localStorage

  function updateRejected(
    updater: (prev: Record<string, string>) => Record<string, string>,
  ): void {
    rejectedRef.current = updater(rejectedRef.current)
    setRejected(rejectedRef.current)
  }

  const drain = useCallback((): void => {
    if (drainingRef.current) {
      // A drain is already running against this submission's queue; let it
      // pick up whatever is queued by now instead of starting a second one.
      rerunRef.current = true
      return
    }
    drainingRef.current = true
    setStatus('saving')

    void (async () => {
      try {
        do {
          rerunRef.current = false
          const result = await queueDrain(getStorage(), input.submissionId, (key, value) =>
            saveRef.current(key, value as T),
          )
          updateRejected((prev) => mergeRejected(prev, result))
        } while (rerunRef.current)
      } finally {
        drainingRef.current = false
        const left = Object.keys(readQueue(getStorage(), input.submissionId)).length
        setPendingCount(left)
        // A refusal is not a network problem: the queue can be empty (the
        // server answered, nothing left to retry) while a key's last answer
        // still stands rejected. `'offline'` takes priority when the queue
        // is non-empty (still unsent — that IS a connectivity problem, and
        // arguably more urgent to surface); otherwise any outstanding
        // rejection must block `'saved'` from being reported at all — see
        // Critical 2 in the whole-branch review.
        const hasRejected = Object.keys(rejectedRef.current).length > 0
        setStatus(left > 0 ? 'offline' : hasRejected ? 'rejected' : 'saved')
      }
    })()
  }, [input.submissionId])

  const push = useCallback(
    (key: string, value: T) => {
      const storage = getStorage()
      const queue = readQueue(storage, input.submissionId)
      queue[key] = value
      writeQueue(storage, input.submissionId, queue)
      setPendingCount(Object.keys(queue).length)
      setStatus('saving')

      // A fresh edit deserves a fresh attempt, even if the previous value
      // at this key was permanently rejected.
      updateRejected((prev) => {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      })

      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(drain, debounceMs)
    },
    [input.submissionId, debounceMs, drain],
  )

  useEffect(() => {
    // Regaining connectivity is exactly when a stuck queue should be retried.
    window.addEventListener('online', drain)
    return () => window.removeEventListener('online', drain)
  }, [drain])

  useEffect(() => {
    // Reopening a fill link after the tab died mid-form is exactly the
    // scenario this queue exists for: whatever survived in local storage
    // needs to actually go out, not sit there until the operator happens
    // to touch another field or the `online` event fires. `drain()` already
    // serializes against a concurrent first `push` (see its own guard
    // above), so calling it directly here cannot race one.
    const queued = readQueue(getStorage(), input.submissionId)
    const queuedCount = Object.keys(queued).length
    setPendingCount(queuedCount)
    // Exposed regardless of `shouldDrainOnMount`: even offline, this is the
    // operator's actual last input and belongs on screen, not just in the
    // retry queue — see this state's own doc comment above.
    if (queuedCount > 0) setRecovered(queued as Record<string, T>)

    const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine
    if (shouldDrainOnMount(queuedCount, isOnline)) drain()
  }, [input.submissionId, drain])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return { status, push, pendingCount, rejected, recovered }
}
