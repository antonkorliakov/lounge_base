/**
 * Pure detection logic backing the "submissions locked before the write"
 * guard (`src/review/__tests__/lock-order.test.ts`). Lives outside the
 * scanned tree on purpose, mirroring `src/form-schema/__tests__/import-guard.ts`
 * and `src/db/__tests__/unsafe-db-usage-guard.ts`: the scan walks
 * `src/review`, `src/submissions`, and `src/photos`, but skips `__tests__`
 * subdirectories, so a helper that necessarily contains the literal
 * patterns it looks for (`.insert(fieldFlags)`, `.for('update')`, …) must
 * live inside `__tests__` or it would trip its own rule.
 *
 * Why this guard exists: the same check-then-write race has been found and
 * fixed on this branch by review, not by a test, once for each of — the
 * value-save path (`assertEditable`), `submitSubmission`, the magic-link
 * consume (`access/team.ts`), `raiseFlag`, `unconfirmBlock`, `resolveFlag`,
 * and `clearFlagsFor`. The list is the count, deliberately: the previous
 * wording carried a numeral that no longer matched the names beside it, and
 * `flags.ts` now points here rather than restating a second count of its
 * own. Every one was the identical shape: a write to a child
 * table that isn't serialized against a concurrent status-changing
 * transaction because nothing makes the two contend for the same lock. The
 * fix was always the same one line — lock `submissions` (`FOR UPDATE`)
 * before the write — so this makes that line's presence, and its position
 * relative to the write, a structural property of every exported function
 * in these three directories that touches one of the five tables a review
 * decision's validity depends on, rather than something the next reviewer
 * has to rediscover by re-deriving the same race by hand, per caller.
 *
 * **This guard has no exemption mechanism, deliberately, and it used to.**
 * The two entries it ever held both turned out to be wrong, each in a
 * different way, and both were argued in as convincingly as the code they
 * excused:
 *  - `resolveFlag` was exempted as "only ever SHRINKS the open-flag set, so
 *    it cannot invalidate a decision." True for `approveSubmission` and
 *    `confirmBlock` (both refuse when flags ARE open, so shrinking only
 *    makes their refusal more conservative), false for `requestChanges`,
 *    which refuses when flags are NOT open — for it, shrinking is the
 *    dangerous direction. A per-caller directional argument is only as good
 *    as the caller list it was written against, and callers get added.
 *  - `clearFlagsFor` was exempted for a reason believed stronger and
 *    direction-independent: its firing condition (`EDITABLE_STATUSES`) is
 *    disjoint from every review decision's (`REVIEW_STATUSES`), so "there is
 *    no window, full stop." Also wrong, and more instructively: the status
 *    gate lives in an EARLIER transaction that has already committed and
 *    released its lock by the time the follow-up write opens its own. A
 *    precondition checked under a lock that has since been released is a
 *    statement about the past, not an invariant. See `clearFlagsFor`'s own
 *    doc comment in `flags.ts` for the full path.
 * Both exemptions read as airtight when written and neither was. That is
 * the argument against having the mechanism at all: a hand-maintained
 * exemption list asks every future reader to re-derive a concurrency proof
 * and get it right, when the alternative costs one line of SQL. Uniform
 * locking removes the need for that reasoning; this guard exists so
 * removing the need is actually enforced, not just recommended. The one
 * hand-maintained list that remains, `LOCK_DELEGATES`, is machine-checked
 * (see `provenLockDelegatesIn`) precisely because these two were not.
 *
 * Accepted gaps, inherited from the regex-based approach (the same
 * trade-off `import-guard.ts`/`unsafe-db-usage-guard.ts` already accept,
 * not new here):
 *  - **Helper indirection.** A write hidden behind a helper NOT listed in
 *    `LOCK_DELEGATES` — including a *legitimately* locked one this list
 *    simply hasn't been told about yet — is invisible to `writeHitsIn`
 *    (which only sees literal `.insert/.update/.delete(TABLE)` text in the
 *    scanned function's own body) and would be silently skipped rather
 *    than flagged. `LOCK_DELEGATES` closes this for the two delegates that
 *    exist today; a third one would need a conscious edit to this file.
 *  - **Table aliasing.** The scan matches the literal identifiers
 *    `fieldFlags`/`blockReviews`/`fieldValues`/`serviceValues`/`photos` as
 *    imported from `@/db/schema` under their real names. A local rename
 *    (`import { fieldFlags as ff } from '@/db/schema'`, then
 *    `.insert(ff)`) would not match `WRITE_RE` and would pass unseen. No
 *    file in the scanned roots renames a schema table import today.
 *  - **Raw SQL / `.execute()`.** Neither this guard nor its write/lock
 *    detectors understand `sql\`...\`` template bodies at all — a write
 *    expressed as raw SQL rather than the query builder would not match
 *    `WRITE_RE`. This is accepted specifically because `.execute()` itself
 *    is already forbidden outside `src/db` by a separate, dedicated guard
 *    (`src/db/__tests__/unsafe-db-usage-guard.ts`), so a raw-SQL write
 *    escaping *this* guard's notice would already have been caught by
 *    *that* one before it could exist outside `src/db` in the first place.
 * None of these are silently assumed away: they are true limits of a
 * text-based scanner that does not parse TypeScript, the same limit every
 * other guard in this codebase already lives with.
 */

export const GUARDED_TABLES = ['fieldFlags', 'blockReviews', 'fieldValues', 'serviceValues', 'photos'] as const

/**
 * Function names known to take the `submissions` `FOR UPDATE` lock
 * themselves, as their own first statement, and to be called with `tx`
 * (the caller's own locked transaction) rather than opening a fresh one —
 * so a caller that only calls one of these need not repeat the lock
 * inline to satisfy this guard. Each entry's body really does contain the
 * exact inline pattern this guard itself recognizes (`.from(submissions)`
 * followed by `.for('update')`), and that is not asserted on faith or on
 * one reviewer having read it once: `provenLockDelegatesIn` re-derives it
 * from the source on every run, and `lock-order.test.ts` fails if any entry
 * here stops being a real function whose own body takes the lock inline.
 * That check exists because this is now the guard's only hand-maintained
 * trust list, and the two entries the previous one (`EXEMPTIONS`) ever held
 * were both wrong — see this file's header.
 *
 * A stale name in this list is loud in the safe direction on its own (it
 * simply never matches, so callers relying on it get flagged); the
 * dangerous direction is an entry that stays listed after its body loses
 * the lock, which is what `provenLockDelegatesIn` covers.
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
 * Given the index of a parameter list's closing `)`, returns the index of
 * the `{` that opens the function body, skipping over a return-type
 * annotation if one is present — including one containing an inline object
 * literal, e.g. `): Promise<{ status: SubmissionStatus } | null> {`.
 *
 * This used to be `text.indexOf('{', paramsEnd + 1)`, documented as safe
 * because no scanned signature used an inline object return type. That was
 * not true (or stopped being true): `loadSubmissionValues`
 * (`src/submissions/values.ts`) and `lockSubmission` (`src/review/decide.ts`)
 * both write their return type that way, so both had their whole "body"
 * mis-detected as the type literal — harmless in those two cases only
 * because neither's real body writes to a guarded table, i.e. the guard was
 * skipping them for the wrong reason. Handled rather than documented now.
 *
 * Depth is tracked over `<([`/`>)]` only, NOT over `{}`: braces are exactly
 * what we are looking for, and an inline object type can only appear nested
 * inside a generic argument or a parenthesized/bracketed type, so the body
 * brace is the first `{` seen at depth zero. `=>` is stepped over so a
 * function-typed return (`): (x: number) => string {`) doesn't drive the
 * depth negative on the `>`.
 */
function bodyBraceAfterParams(text: string, paramsEnd: number): number {
  let depth = 0
  for (let i = paramsEnd + 1; i < text.length; i++) {
    const ch = text[i] ?? ''
    if (ch === '=' && text[i + 1] === '>') {
      i++
      continue
    }
    if ('<(['.includes(ch)) depth++
    else if ('>)]'.includes(ch)) depth--
    else if (ch === '{' && depth <= 0) return i
  }
  return -1
}

/**
 * Finds every top-level `export [async] function NAME(...) { ... }` in
 * (already comment-stripped) `text` and returns each one's name and full
 * body text (the `{ … }` span, inclusive). Relies on none of this
 * project's exported functions in `src/review`/`src/submissions`/
 * `src/photos` having an inline object-literal *type* in their signature
 * (e.g. a return type written as `Promise<{ ok: boolean }>` rather than a
 * named alias) — every one uses a named type (`SaveResult`,
 * `ConfirmResult`, `TransitionResult`, `FlagRow[]`, `BlockState[]`,
 * `PhotoRow[]`, `void`, …), so the first `{` after the parameter list's
 * closing `)` is always the real function body, not a return-type literal.
 * This is a documented limitation, not a silent gap: a future function
 * that violates it would have its whole body mis-detected, which the
 * guard's own "at least one file scanned" sanity check cannot catch —
 * reviewers adding a new exported function with an inline object return
 * type should notice this comment.
 *
 * `requireExport: false` drops the `export` requirement, for
 * `provenLockDelegatesIn`'s benefit only: `lockSubmission`
 * (`src/review/decide.ts`) is a `LOCK_DELEGATES` entry and module-local, so
 * checking that a delegate really takes the lock has to see unexported
 * declarations too. The violations scan itself still passes `true` — an
 * unexported helper is reached only through an exported one, whose own span
 * contains the call, so scanning both would double-report.
 */
function functionDeclarationSpans(text: string, requireExport = true): FunctionSpan[] {
  const spans: FunctionSpan[] = []
  const headerRe = new RegExp(
    `${requireExport ? 'export\\s+' : ''}(?:async\\s+)?function\\s+([A-Za-z_$][\\w$]*)\\s*\\(`,
    'g',
  )
  let m: RegExpExecArray | null
  while ((m = headerRe.exec(text))) {
    const name = m[1]
    if (!name) continue
    const paramsOpen = m.index + m[0].length - 1
    const paramsEnd = matchingClose(text, paramsOpen)
    if (paramsEnd === null) continue
    const bodyOpen = bodyBraceAfterParams(text, paramsEnd)
    if (bodyOpen === -1) continue
    const bodyEnd = matchingClose(text, bodyOpen)
    if (bodyEnd === null) continue
    spans.push({ name, body: text.slice(bodyOpen, bodyEnd + 1) })
  }
  return spans
}

/**
 * Given the index right after a parameter list's closing `)`, returns the
 * index of the `=` of the arrow function's `=>`, skipping over an optional
 * return-type annotation in between (`: Promise<SaveResult> =>`, matching
 * the style every `function` declaration in this codebase already uses).
 * Tracks bracket depth over `(){}[]` AND `<>` together in this one
 * narrow window only — safe here specifically because a return-type
 * annotation is pure type syntax with no runtime expressions, so a `<`/`>`
 * appearing before the arrow can only be a generic delimiter, never a
 * comparison operator (which could only appear once actual code starts,
 * i.e. after the arrow this function is searching for). Returns `null` if
 * no top-level `=>` is found before the text ends.
 */
function findArrowAfterParams(text: string, afterParamsClose: number): number | null {
  let depth = 0
  for (let i = afterParamsClose; i < text.length - 1; i++) {
    const ch = text[i] ?? ''
    if ('([{<'.includes(ch)) depth++
    else if (')]}>'.includes(ch)) depth--
    else if (depth === 0 && ch === '=' && text[i + 1] === '>') return i
  }
  return null
}

/**
 * Finds every top-level `export const NAME = [async] (...) [: ReturnType]
 * => ...` in (already comment-stripped) `text`. Nothing in the scanned
 * roots is written this way today (every writer is `export async
 * function`), but the shape is common enough elsewhere that a future
 * writer using it must not be invisible to this guard — including one
 * with an explicit return-type annotation, the style every `function`
 * declaration here already uses (`findArrowAfterParams` skips exactly
 * that).
 *
 * Two body shapes are handled:
 *  - Block body (`=> { ... }`): body is the brace-matched span, same
 *    technique as `functionDeclarationSpans`.
 *  - Expression body (`=> someExpression`, no immediate `{`): there is no
 *    brace to match, so the span is bounded heuristically — from right
 *    after `=>` to the next top-level (bracket-depth-zero) `;`, or to the
 *    next `export` keyword at depth zero, or to the end of the file,
 *    whichever comes first. This is a heuristic, not a parse: it is
 *    documented here rather than silently assumed, and is the reason this
 *    function's own tests exercise the expression-body shape directly
 *    rather than trusting it by construction.
 */
function arrowConstSpans(text: string, requireExport = true): FunctionSpan[] {
  const spans: FunctionSpan[] = []
  const headerRe = new RegExp(
    `${requireExport ? 'export\\s+' : ''}const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:async\\s*)?\\(`,
    'g',
  )
  let m: RegExpExecArray | null
  while ((m = headerRe.exec(text))) {
    const name = m[1]
    if (!name) continue
    const paramsOpen = m.index + m[0].length - 1
    const paramsEnd = matchingClose(text, paramsOpen)
    if (paramsEnd === null) continue

    const arrowAt = findArrowAfterParams(text, paramsEnd + 1)
    if (arrowAt === null) continue
    let afterArrow = arrowAt + 2
    while (/\s/.test(text[afterArrow] ?? '')) afterArrow++

    if (text[afterArrow] === '{') {
      const bodyEnd = matchingClose(text, afterArrow)
      if (bodyEnd === null) continue
      spans.push({ name, body: text.slice(afterArrow, bodyEnd + 1) })
      continue
    }

    // Expression body: bound the span at the next top-level `;`/`export`/EOF.
    let depth = 0
    let end = text.length
    for (let i = afterArrow; i < text.length; i++) {
      const ch = text[i] ?? ''
      if ('([{'.includes(ch)) depth++
      else if (')]}'.includes(ch)) depth--
      else if (depth === 0 && ch === ';') {
        end = i + 1
        break
      } else if (depth === 0 && ch !== '' && !/\s/.test(ch) && i > afterArrow) {
        if (/^export\b/.test(text.slice(i))) {
          end = i
          break
        }
      }
    }
    spans.push({ name, body: text.slice(afterArrow, end) })
  }
  return spans
}

function exportedFunctionSpans(text: string): FunctionSpan[] {
  return [...functionDeclarationSpans(text), ...arrowConstSpans(text)]
}

function allFunctionSpans(text: string): FunctionSpan[] {
  return [...functionDeclarationSpans(text, false), ...arrowConstSpans(text, false)]
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
 * Every `GUARDED_TABLES` entry `writeHitsIn` matches anywhere in
 * (comment-stripped) `fileText` — not scoped to a particular function,
 * unlike `writeHitsIn` above. Backs the "the guard actually found a real
 * write for every table it claims to guard" sanity check in
 * `lock-order.test.ts`: without it, a `GUARDED_TABLES` entry that drifted
 * from the real schema identifier (a rename, a typo) would make `WRITE_RE`
 * silently stop matching anything for that table, and
 * `lockOrderViolationsIn` would report zero violations for a reason that
 * has nothing to do with every writer being correctly locked — the same
 * "passes because it never actually looked" failure mode this project has
 * already hit more than once. A table with a real positive match here is
 * proof the regex still lines up with a real, live call site, not just an
 * absence of complaints.
 */
export function tablesWrittenIn(fileText: string): Set<string> {
  const text = stripComments(fileText)
  return new Set(writeHitsIn(text).map((hit) => hit.table))
}

/**
 * Positions in `body` where a `submissions` lock is established by this
 * body's own SQL: `.from(submissions)` — as the nearest preceding
 * `.from(IDENT)` — chained into `.for('update')` or `.for("update")`. Order
 * matters to the caller, not presence alone, so this returns positions
 * rather than a boolean.
 */
function inlineLockPositionsIn(body: string): number[] {
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

  return positions
}

/**
 * Every position `inlineLockPositionsIn` finds, plus every call to a
 * `LOCK_DELEGATES` entry — the two ways a scanned writer can satisfy this
 * guard.
 */
function lockPositionsIn(body: string): number[] {
  const positions = inlineLockPositionsIn(body)

  if (LOCK_DELEGATES.length > 0) {
    const delegateRe = new RegExp(`\\b(?:${LOCK_DELEGATES.join('|')})\\s*\\(`, 'g')
    let dm: RegExpExecArray | null
    while ((dm = delegateRe.exec(body))) positions.push(dm.index)
  }

  return positions
}

/**
 * The `LOCK_DELEGATES` names declared in (comment-stripped) `fileText` whose
 * own body really does take the `submissions` lock. Backs the "every
 * delegate this guard trusts actually locks" check in `lock-order.test.ts`,
 * which is the anti-vacuity property for the guard's one remaining
 * hand-maintained list — without it, deleting `assertEditable`'s
 * `.for('update')` would silently disarm the guard for every writer in
 * `src/submissions`/`src/photos` that delegates to it, and the scan would go
 * on reporting zero violations.
 *
 * Deliberately `inlineLockPositionsIn`, not `lockPositionsIn`: a delegate
 * must show the lock in its OWN SQL. Accepting delegated evidence here would
 * let two listed delegates that merely call each other certify one another
 * with no real `FOR UPDATE` anywhere — a self-referential proof, the
 * dressed-up version of the same "passes because it never actually looked"
 * failure this file keeps guarding against.
 *
 * Unexported declarations count (`lockSubmission` is module-local), and a
 * name declared in a shape neither span finder recognizes is reported as
 * unproven rather than assumed fine — the test then fails, which is the
 * direction that asks a human to look.
 */
export function provenLockDelegatesIn(fileText: string): Set<string> {
  const text = stripComments(fileText)
  const names: ReadonlySet<string> = new Set(LOCK_DELEGATES)
  const proven = new Set<string>()
  for (const fn of allFunctionSpans(text)) {
    if (names.has(fn.name) && inlineLockPositionsIn(fn.body).length > 0) proven.add(fn.name)
  }
  return proven
}

export type LockOrderViolation = { functionName: string; reason: string }

/**
 * The guard itself: every exported function in `fileText` that writes to
 * one of `GUARDED_TABLES` must have a `submissions` lock (inline or via
 * `LOCK_DELEGATES`) positioned strictly before the *earliest* such write —
 * checking against the earliest is sufficient to guarantee it precedes
 * every later one too, since "before the minimum" implies "before all".
 * There is no exemption list and no way to opt a function out — see this
 * file's header for why the one that existed was removed. Functions that
 * don't write to a guarded table at all are not this guard's concern and
 * are silently skipped — they have nothing here to serialize.
 */
export function lockOrderViolationsIn(fileText: string): LockOrderViolation[] {
  const text = stripComments(fileText)
  const violations: LockOrderViolation[] = []

  for (const fn of exportedFunctionSpans(text)) {
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
