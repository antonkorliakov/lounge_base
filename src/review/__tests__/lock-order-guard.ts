/**
 * Pure detection logic backing the "submissions locked before the write"
 * guard (`src/review/__tests__/lock-order.test.ts`). Lives outside the
 * scanned tree on purpose, mirroring `src/form-schema/__tests__/import-guard.ts`
 * and `src/db/__tests__/unsafe-db-usage-guard.ts`: the scan walks
 * `src/review` and `src/submissions` but skips `__tests__` subdirectories,
 * so a helper that necessarily contains the literal patterns it looks for
 * (`.insert(fieldFlags)`, `.for('update')`, …) must live inside `__tests__`
 * or it would trip its own rule.
 *
 * Why this guard exists: five check-then-write races have been found and
 * fixed on this branch by review, not by a test — the value-save path
 * (`assertEditable`), `submitSubmission`, the magic-link consume
 * (`access/team.ts`), `raiseFlag`, and `unconfirmBlock` (this fix round).
 * Every one was the identical shape: a write to a child table that isn't
 * serialized against a concurrent status-changing transaction because
 * nothing makes the two contend for the same lock. The fix was always the
 * same one line — lock `submissions` (`FOR UPDATE`) before the write — so
 * this makes that line's presence, and its position relative to the write,
 * a structural property of every exported function in these two
 * directories that touches one of the five tables a review decision's
 * validity depends on, rather than something the next reviewer has to
 * rediscover by re-deriving the same race.
 */

export const GUARDED_TABLES = ['fieldFlags', 'blockReviews', 'fieldValues', 'serviceValues', 'photos'] as const

/**
 * Function names known to take the `submissions` `FOR UPDATE` lock
 * themselves, as their own first statement, and to be called with `tx`
 * (the caller's own locked transaction) rather than opening a fresh one —
 * so a caller that only calls one of these need not repeat the lock
 * inline to satisfy this guard. Each entry is trusted here because its own
 * body was read and independently found to contain the exact inline
 * pattern this guard itself recognizes (`.from(submissions)` followed by
 * `.for('update')`) — not asserted on faith:
 *
 *  - `assertEditable` (`src/submissions/editable.ts`) — locks, then only
 *    reads `submissions.status`; called by `saveFieldValue`/
 *    `saveServiceValue` (`src/submissions/values.ts`) before their writes
 *    to `field_values`/`service_values`.
 *  - `lockSubmission` (`src/review/decide.ts`, module-local) — locks, then
 *    reads status and `loungeId`; not currently load-bearing for any
 *    function this guard flags (`requestChanges`/`approveSubmission` write
 *    `submissions`/`lounges`/`events`, none of which are in
 *    `GUARDED_TABLES`), kept listed so a future function built on top of it
 *    is recognized without editing this list again.
 *
 * If a new delegate is added, add it here with the same kind of note —
 * this list is the guard's only way of knowing an indirect lock is real,
 * so it must stay honest about why each entry is trusted.
 */
export const LOCK_DELEGATES = ['assertEditable', 'lockSubmission'] as const

/**
 * Exported functions that write to a guarded table but are deliberately
 * NOT required to lock `submissions` first, because the write cannot
 * invalidate a decision (`requestChanges`/`approveSubmission`) that was
 * valid when that decision's own locked transaction read the relevant
 * state. Each reason below is the actual argument for that specific
 * function, not a copy of another exemption's reasoning — the two
 * currently listed are safe for two different reasons.
 */
export const EXEMPTIONS: Readonly<Record<string, string>> = {
  clearFlagsFor:
    "src/review/flags.ts — fires only on an operator's edit of a " +
    'previously-flagged field, which EDITABLE_STATUSES limits to `draft`/' +
    '`changes_requested`. confirmBlock (the only thing this write could ' +
    "race against approveSubmission's benefit of protecting) requires " +
    '`submitted` (REVIEW_STATUSES). Those status sets are disjoint and a ' +
    'submission has exactly one status at a time, so clearFlagsFor and a ' +
    'review decision can never legally run against the same submission at ' +
    'the same time regardless of locking — there is no window for this ' +
    'write to land in.',
  resolveFlag:
    'src/review/flags.ts — only moves a flag from open to resolved, never ' +
    'the other way; it can only shrink the open-flag set. approveSubmission ' +
    "refuses when open flags are non-zero AT THE MOMENT IT READS THEM inside " +
    'its own locked transaction — that read is accurate regardless of what ' +
    "resolveFlag does concurrently, because resolveFlag cannot make a flag " +
    "that was genuinely open at read time appear resolved retroactively, and " +
    'it cannot manufacture a NEW open flag the read would have needed to ' +
    'see. The dangerous direction is raising a flag (which raiseFlag locks ' +
    'for) or unconfirming a block (which unconfirmBlock now locks for) — ' +
    'both move a submission from "approvable" to "not approvable" and so ' +
    'can race a decision that already checked. Resolving only moves the ' +
    'other way, so there is nothing for this write to invalidate.',
}

/**
 * Strips `//` line comments and `/* … *\/` block comments from `text`,
 * without touching either kind of sequence when it appears inside a
 * string or template literal. Comment-blind scanning is what let a
 * previous version of a different guard in this project match its own doc
 * comment and report a lock as present when the real one had been
 * deleted — this exists so that mistake cannot repeat here: a doc comment
 * that *mentions* `.for('update')` in prose must never be read as evidence
 * that the code actually takes the lock.
 *
 * Character-walking rather than a single regex because comments and
 * quotes both need to suppress each other correctly (a `//` inside a
 * string is not a comment; a quote inside a comment does not open a
 * string) — a regex alternation over both would have to reimplement the
 * same state machine anyway, just less legibly.
 */
export function stripComments(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      out += ch
      i++
      while (i < n) {
        const c = text[i]
        if (c === '\\' && i + 1 < n) {
          out += c + text[i + 1]
          i += 2
          continue
        }
        out += c
        i++
        if (c === quote) break
      }
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

/**
 * Given the index of an opening `(`, `{`, or `[` in `text`, returns the
 * index of its matching close, tracking depth across all three bracket
 * kinds together (same technique as
 * `src/db/__tests__/unsafe-db-usage-guard.ts`'s `matchingCallArgs`) so a
 * mismatched-*kind* nesting — a `{` opened inside a call's `(...)` — still
 * resolves correctly as long as the input is syntactically valid, which
 * source that already typechecks always is. Returns `null` if the
 * brackets never balance.
 */
function matchingClose(text: string, openIndex: number): number | null {
  const OPEN = '([{'
  const CLOSE = ')]}'
  if (!OPEN.includes(text[openIndex] ?? '')) return null
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i] ?? ''
    if (OPEN.includes(ch)) depth++
    else if (CLOSE.includes(ch)) {
      depth--
      if (depth === 0) return i
    }
  }
  return null
}

type FunctionSpan = { name: string; body: string }

/**
 * Finds every top-level `export [async] function NAME(...) { ... }` in
 * (already comment-stripped) `text` and returns each one's name and full
 * body text (the `{ … }` span, inclusive). Relies on none of this
 * project's exported functions in `src/review`/`src/submissions` having an
 * inline object-literal *type* in their signature (e.g. a return type
 * written as `Promise<{ ok: boolean }>` rather than a named alias) — every
 * one uses a named type (`SaveResult`, `ConfirmResult`, `TransitionResult`,
 * `FlagRow[]`, `BlockState[]`, `void`, …), so the first `{` after the
 * parameter list's closing `)` is always the real function body, not a
 * return-type literal. This is a documented limitation, not a silent gap:
 * a future function that violates it would have its whole body
 * mis-detected, which the guard's own "at least one file scanned" sanity
 * check cannot catch — reviewers adding a new exported function with an
 * inline object return type should notice this comment.
 */
function exportedFunctionSpans(text: string): FunctionSpan[] {
  const spans: FunctionSpan[] = []
  const headerRe = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = headerRe.exec(text))) {
    const name = m[1]
    if (!name) continue
    const paramsOpen = m.index + m[0].length - 1
    const paramsEnd = matchingClose(text, paramsOpen)
    if (paramsEnd === null) continue
    const bodyOpen = text.indexOf('{', paramsEnd + 1)
    if (bodyOpen === -1) continue
    const bodyEnd = matchingClose(text, bodyOpen)
    if (bodyEnd === null) continue
    spans.push({ name, body: text.slice(bodyOpen, bodyEnd + 1) })
  }
  return spans
}

type WriteHit = { index: number; table: string }

const WRITE_RE = new RegExp(
  `\\.(?:insert|update|delete)\\(\\s*(${GUARDED_TABLES.join('|')})\\s*\\)`,
  'g',
)

function writeHitsIn(body: string): WriteHit[] {
  const hits: WriteHit[] = []
  const re = new RegExp(WRITE_RE.source, WRITE_RE.flags)
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    const table = m[1]
    if (table) hits.push({ index: m.index, table })
  }
  return hits
}

/**
 * Positions in `body` where a genuine `submissions` lock is established —
 * either inline (`.from(submissions)` reached, at some point before it,
 * by the nearest preceding `.from(IDENT)`, chained into `.for('update')`
 * or `.for("update")`) or via a call to one of `LOCK_DELEGATES`. Order
 * matters to the caller, not presence alone, so this returns positions
 * rather than a boolean.
 */
function lockPositionsIn(body: string): number[] {
  const positions: number[] = []

  const forRe = /\.for\(\s*['"]update['"]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = forRe.exec(body))) {
    const before = body.slice(0, m.index)
    const fromRe = /\.from\(\s*([A-Za-z_$][\w$]*)\s*\)/g
    let last: RegExpExecArray | null = null
    let fm: RegExpExecArray | null
    while ((fm = fromRe.exec(before))) last = fm
    if (last && last[1] === 'submissions') positions.push(m.index)
  }

  if (LOCK_DELEGATES.length > 0) {
    const delegateRe = new RegExp(`\\b(?:${LOCK_DELEGATES.join('|')})\\s*\\(`, 'g')
    let dm: RegExpExecArray | null
    while ((dm = delegateRe.exec(body))) positions.push(dm.index)
  }

  return positions
}

export type LockOrderViolation = { functionName: string; reason: string }

/**
 * The guard itself: every exported function in `fileText` that writes to
 * one of `GUARDED_TABLES` must have a `submissions` lock (inline or via
 * `LOCK_DELEGATES`) positioned strictly before the *earliest* such write —
 * checking against the earliest is sufficient to guarantee it precedes
 * every later one too, since "before the minimum" implies "before all".
 * Functions in `EXEMPTIONS` are skipped, with the reason available for
 * anyone auditing why. Functions that don't write to a guarded table at
 * all are not this guard's concern and are silently skipped — they have
 * nothing here to serialize.
 */
export function lockOrderViolationsIn(fileText: string): LockOrderViolation[] {
  const text = stripComments(fileText)
  const violations: LockOrderViolation[] = []

  for (const fn of exportedFunctionSpans(text)) {
    if (fn.name in EXEMPTIONS) continue

    const writes = writeHitsIn(fn.body)
    if (writes.length === 0) continue

    const firstWrite = writes.reduce((a, b) => (b.index < a.index ? b : a))
    const locks = lockPositionsIn(fn.body)

    if (locks.length === 0) {
      violations.push({
        functionName: fn.name,
        reason: `writes to ${firstWrite.table} without ever locking submissions`,
      })
      continue
    }

    const earliestLock = Math.min(...locks)
    if (earliestLock > firstWrite.index) {
      violations.push({
        functionName: fn.name,
        reason: `locks submissions after its write to ${firstWrite.table}, not before`,
      })
    }
  }

  return violations
}
