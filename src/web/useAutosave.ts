'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'offline'

export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Shape returned by a save attempt. Deliberately loose (`ok: boolean`, not a
 * discriminated union) to structurally match `ActionResult` in
 * `src/app/f/[token]/actions.ts` without either module importing the other.
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

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

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
 */
export async function queueDrain(
  storage: StorageLike,
  submissionId: string,
  save: (key: string, value: unknown) => Promise<SaveOutcome>,
): Promise<Record<string, string>> {
  const snapshot = readQueue(storage, submissionId)
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
      clearIfUnchanged(storage, submissionId, key, value)
    } else {
      rejected[key] = result.error ?? 'rejected'
      clearIfUnchanged(storage, submissionId, key, value)
    }
  }

  return rejected
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
} {
  const debounceMs = input.debounceMs ?? 600
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [pendingCount, setPendingCount] = useState(0)
  const [rejected, setRejected] = useState<Record<string, string>>({})

  const saveRef = useRef(input.save)
  saveRef.current = input.save

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const drainingRef = useRef(false)
  const rerunRef = useRef(false)

  const getStorage = (): StorageLike => window.localStorage

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
          const newlyRejected = await queueDrain(getStorage(), input.submissionId, (key, value) =>
            saveRef.current(key, value as T),
          )
          if (Object.keys(newlyRejected).length > 0) {
            setRejected((prev) => ({ ...prev, ...newlyRejected }))
          }
        } while (rerunRef.current)
      } finally {
        drainingRef.current = false
        const left = Object.keys(readQueue(getStorage(), input.submissionId)).length
        setPendingCount(left)
        setStatus(left === 0 ? 'saved' : 'offline')
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
      setRejected((prev) => {
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
    setPendingCount(Object.keys(readQueue(getStorage(), input.submissionId)).length)
  }, [input.submissionId])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return { status, push, pendingCount, rejected }
}
