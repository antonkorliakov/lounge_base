/**
 * Pure detection logic backing the lock-ordering guards in
 * `src/review/__tests__/lock-order.test.ts`. Lives outside the scanned tree
 * on purpose, mirroring `src/form-schema/__tests__/import-guard.ts`
 * and `src/db/__tests__/unsafe-db-usage-guard.ts`: the scan walks
 * `src/review`, `src/submissions`, `src/photos`, and `src/registry`, but
 * skips `__tests__` subdirectories, so a helper that necessarily contains
 * the literal patterns it looks for (`.insert(fieldFlags)`, `.for('update')`,
 * …) must live inside `__tests__` or it would trip its own rule.
 *
 * There are TWO checks here, over one shared set of scanned roots:
 * `lockOrderViolationsIn` (the `submissions` family, below) and
 * `loungeLockViolationsIn` (the `lounges` family, at the bottom of this
 * file). Read the section "WHY TWO CHECKS AND NOT ONE TABLE OF (PARENT,
 * CHILDREN) PAIRS" further down before adding a third: the two are not two
 * instances of one rule, and the difference is the whole reason the second
 * one exists.
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
 * in the scanned directories that touches one of the five tables a review
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
 *    That composed claim was weaker than it read until recently: the other
 *    guard's `EXECUTE_RE` matched only the bare receivers `db`/`tx`, so it
 *    covered these roots (where a `Db` really does arrive as a parameter) but
 *    not the app layer's `db().execute(…)`. Both receiver shapes are covered
 *    there now; what remains accepted in both files is a `Db` held under some
 *    other local name (`const d = db()`).
 *  - **Two arrow forms are invisible to `arrowConstSpans`**, on top of the
 *    helper/alias gaps above: `export const f = <T>(…) => …` (a generic, so
 *    what follows `=` is `<`, not the `(` the header regex requires) and
 *    `export const f: Type = (…) => …` (an annotated const, so what follows
 *    the name is `:`, not `=`). Neither exists in the scanned roots today —
 *    every writer is `export async function` — but a writer added in either
 *    shape would be skipped silently rather than flagged, which is the
 *    direction that does not ask anyone to look. Named here because it was
 *    carried as an unwritten "minor" for two rounds; closing it is a change to
 *    `arrowConstSpans`'s header regex, not to any rule.
 * None of these are silently assumed away: they are true limits of a
 * text-based scanner that does not parse TypeScript, the same limit every
 * other guard in this codebase already lives with.
 *
 * ---------------------------------------------------------------------------
 * WHY TWO CHECKS AND NOT ONE TABLE OF (PARENT, CHILDREN) PAIRS
 * ---------------------------------------------------------------------------
 * `src/registry` needs its own invariant — "lock the `lounges` row before
 * writing its operational status and history" (`setOperationalStatus`,
 * `src/registry/status.ts`). The obvious move is to generalize this file into
 * a list of `{ parent, children }` pairs and run one loop over it. That was
 * considered and rejected, because the two invariants do not have the same
 * shape, and the difference is not cosmetic:
 *
 *  - **Family 1 (`submissions`) is unconditional.** Its children are
 *    DIFFERENT ROWS in DIFFERENT TABLES from the parent. Nothing in the
 *    database makes an `INSERT INTO field_flags` contend with an `UPDATE
 *    submissions` — under READ COMMITTED there is no serialization between
 *    them at all — so the lock is the ONLY thing that creates any. It is
 *    therefore required of every writer, whether or not that writer itself
 *    reads `submissions`: `unconfirmBlock` was a bare unlocked `DELETE` that
 *    read nothing, and it was one of the races this guard was built for.
 *  - **Family 2 (`lounges`) is conditional on the writer also READING the
 *    row.** Here the "child" is the parent row itself: `setOperationalStatus`
 *    reads `lounges.operational_status` to record it as the event's `from`,
 *    then updates that same row. The `UPDATE` already takes that row's
 *    exclusive lock on its own, so two concurrent writers cannot interleave
 *    their writes; what an unlocked version loses is that the earlier READ
 *    was not covered by it, so both transactions can read the same `previous`
 *    and each write an event claiming the same `from` — the history stops
 *    being a chain (`to` of one no longer equals `from` of the next).
 *    Deriving a write from an unlocked read is exactly the check-then-write
 *    shape this file was built around; a write that derives nothing from a
 *    read of that row has nothing to serialize beyond what Postgres already
 *    does for it.
 *
 * A single `{ parent, children }` table would have to pick ONE quantifier for
 * both families. Picking family 2's ("only when the writer reads the parent")
 * would weaken family 1 to the point of exempting the bare-`DELETE` race that
 * started all of this. Picking family 1's ("every writer, always") would
 * demand a `FOR UPDATE` from `approveSubmission` that its correctness does not
 * rest on (see below) — a lock added to satisfy a scanner rather than to fix a
 * race, in a file whose own history is a list of concurrency arguments that
 * read as airtight and were not. So: two checks, each stating its own
 * invariant in its own terms, sharing every primitive (`stripComments`, the
 * span finders, `writeHitsIn`, `inlineLockPositionsIn`) so there is one
 * detector to keep honest, not two.
 *
 * **`events` is a child of BOTH families, and is guarded by NEITHER.** It is
 * written by `submitSubmission` (`src/submissions/transitions.ts`),
 * `requestChanges`/`approveSubmission` (`src/review/decide.ts`) and
 * `setOperationalStatus` (`src/registry/status.ts`). "Which lock counts for
 * `events`?" has no good answer, and that is the point: it is append-only. A
 * fresh row acquires no lock any other transaction can be holding, so there is
 * no ordering between two `events` writers to enforce in the first place — and
 * the property `events` really does need, "every state change writes its event
 * in the SAME transaction as the change", is atomicity, which no lock-order
 * scan can observe (see the accepted gaps below). Naming it as a child of
 * either parent would produce pure false failures in both directions:
 * `submitSubmission` writes an event about a submission and has no lounge id
 * in hand at all, so demanding a `lounges` lock from it would be asking for a
 * lock on a row it cannot name; `setOperationalStatus` has no submission, so
 * the mirror image holds for a `submissions` lock. Family 1 already made this
 * call — `events` was never in `GUARDED_TABLES` despite two of its writers
 * living in the scanned roots — and family 2 makes the same one for the same
 * reason.
 *
 * **`approveSubmission` writes `lounges` and does NOT lock it — correctly.**
 * It is a blind write: `tx.update(lounges).set(classifying)` where
 * `classifying` comes from `field_values`, not from `lounges`. It never issues
 * a `.from(lounges)` at all, so it reads nothing it then overwrites, and the
 * columns it sets (`terminal`/`terminalType`/`zone`/`airsideLandside`) are
 * disjoint from the ones `setOperationalStatus` sets. The row lock its own
 * `UPDATE` takes is all the serialization it needs, and `loungeLockViolationsIn`
 * passes it for exactly that reason rather than by exemption — there is no
 * exemption mechanism here, deliberately (see above), and this is the test of
 * whether the check's shape is honest: it must pass `approveSubmission` on a
 * property derived from its source, not on a name in a list. Its doc comment
 * in `decide.ts` explains why it cannot deadlock against
 * `setOperationalStatus` (that transaction waits on nothing but its one
 * `lounges` row, so it cannot be the "B waits on A" half of a cycle); nothing
 * here weakens or restates that argument, and if `approveSubmission` ever
 * starts reading `lounges` before writing it, this check will begin demanding
 * the lock — which would be the correct demand at that point, because the
 * read-then-write shape would then be real.
 *
 * Accepted gaps specific to family 2, on top of the ones above:
 *  - **A blind writer of the status columns escapes.** A future function that
 *    sets `lounges.operational_status` without reading it first (a bulk
 *    "close every lounge in this airport", say) is not subject to the check.
 *    It cannot write a truthful `from` in its event without a read, so such a
 *    function is either incomplete or reads and is caught; but if it simply
 *    writes no event, the property it breaks is "every status change is
 *    recorded", which is about transaction content, not lock order, and would
 *    need its own guard. Named here rather than left to be discovered.
 *  - **Read and write are not known to be the same row.** The scan sees
 *    `.from(lounges)` and `.update(lounges)` in one body; it cannot tell
 *    whether they concern the same lounge (`listRegistry` reads every row).
 *    It errs toward demanding the lock, which is the safe direction: the cost
 *    of a false demand is one line of SQL, the cost of a missed one is a
 *    history that no longer reconstructs.
 *  - **No delegate mechanism.** `LOCK_DELEGATES` is about `submissions`; a
 *    `lounges` lock taken inside a helper would not be recognized. No such
 *    helper exists today (`setOperationalStatus` locks inline), and adding one
 *    would need a conscious edit here — same trade-off, and same reason for
 *    machine-checking any such list, as family 1's.
 */

export const GUARDED_TABLES = ['fieldFlags', 'blockReviews', 'fieldValues', 'serviceValues', 'photos'] as const

/**
 * The two parent rows a scanned writer can be required to hold `FOR UPDATE`.
 * Named constants rather than literals inside the detectors so that a
 * detector's call site says which family it belongs to.
 */
const SUBMISSIONS = 'submissions'
const LOUNGES = 'lounges'

/**
 * Family 2's write set: the `lounges` row itself. `events` is deliberately
 * absent — see this file's header for why a table with two parents is guarded
 * by neither lock.
 */
const LOUNGE_WRITE_TABLES = [LOUNGES] as const

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
 *    is recognized without editing this list again. `lounges` is not
 *    unguarded, it is guarded by the OTHER check in this file
 *    (`loungeLockViolationsIn`), which asks for a lock on the `lounges` row
 *    and to which this list is irrelevant.
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
 * body text (the `{ … }` span, inclusive).
 *
 * An inline object-literal *return type* — `Promise<{ status: … } | null>`
 * rather than a named alias — is HANDLED, not assumed absent: finding the body
 * brace is `bodyBraceAfterParams`'s job and it skips return-type annotations
 * (read its comment). This doc used to say the opposite, that no scanned
 * signature was written that way and therefore "the first `{` after the
 * parameter list is always the real function body". That was false when
 * written — `loadSubmissionValues` (`src/submissions/values.ts`) and
 * `lockSubmission` (`src/review/decide.ts`) both write `Promise<{ … }>` — and
 * it stayed here after the premise was fixed in code, so the two comments
 * about one mechanism contradicted each other and this one told readers to
 * watch for a hazard that no longer exists. Recorded rather than quietly
 * deleted, because "a comment asserting a premise nobody checked" is a defect
 * class this branch has now hit several times.
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
 * The header regex requires `(` immediately after `NAME =`, so two arrow
 * shapes are NOT recognized — a generic (`= <T>(…) =>`) and an annotated const
 * (`f: Type = (…) =>`). Listed in this file's "Accepted gaps" section rather
 * than only here, since a skipped writer is a hole in the guard, not a quirk
 * of this helper.
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

/**
 * `.insert/.update/.delete(TABLE)` hits in `body`, for the given table set —
 * `GUARDED_TABLES` for family 1, `LOUNGE_WRITE_TABLES` for family 2. The
 * table set is a parameter rather than a module constant so that both
 * families share one write detector: a fix or a gap found in it applies to
 * both, instead of the second family growing a near-copy that drifts.
 */
function writeHitsIn(body: string, tables: readonly string[]): WriteHit[] {
  const hits: WriteHit[] = []
  const re = new RegExp(`\\.(?:insert|update|delete)\\(\\s*(${tables.join('|')})\\s*\\)`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    const table = m[1]
    if (table) hits.push({ index: m.index, table })
  }
  return hits
}

/**
 * Positions of `.from(TABLE)` in `body` — every place this body READS the
 * given table. Family 2 needs this and family 1 does not: family 1's rule
 * holds whether or not the writer reads its parent, while family 2's applies
 * exactly when a write is derived from a read of the row being written (see
 * this file's header).
 */
function tableReadPositionsIn(body: string, table: string): number[] {
  const positions: number[] = []
  const re = new RegExp(`\\.from\\(\\s*${table}\\s*\\)`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) positions.push(m.index)
  return positions
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
  return new Set(writeHitsIn(text, GUARDED_TABLES).map((hit) => hit.table))
}

/**
 * Positions in `body` where a lock on `table` is established by this body's
 * own SQL: `.from(TABLE)` — as the nearest preceding `.from(IDENT)` —
 * chained into `.for('update')` or `.for("update")`. Order matters to the
 * caller, not presence alone, so this returns positions rather than a
 * boolean.
 *
 * `table` is a parameter so both families use the same lock detector: family
 * 1 asks for `submissions`, family 2 for `lounges`. Requiring the nearest
 * preceding `.from` to BE that table is what makes a lock on the wrong row
 * fail to count — a function that takes `FOR UPDATE` on `submissions` and
 * then read-then-writes `lounges` is not locked for family 2's purposes, and
 * is reported.
 */
function inlineLockPositionsIn(body: string, table: string): number[] {
  const positions: number[] = []

  const forRe = /\.for\(\s*['"]update['"]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = forRe.exec(body))) {
    const before = body.slice(0, m.index)
    const fromRe = /\.from\(\s*([A-Za-z_$][\w$]*)\s*\)/g
    let last: RegExpExecArray | null = null
    let fm: RegExpExecArray | null
    while ((fm = fromRe.exec(before))) last = fm
    if (last && last[1] === table) positions.push(m.index)
  }

  return positions
}

/**
 * Every position `inlineLockPositionsIn` finds, plus every call to a
 * `LOCK_DELEGATES` entry — the two ways a scanned writer can satisfy this
 * guard.
 */
function lockPositionsIn(body: string): number[] {
  const positions = inlineLockPositionsIn(body, SUBMISSIONS)

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
    if (names.has(fn.name) && inlineLockPositionsIn(fn.body, SUBMISSIONS).length > 0) {
      proven.add(fn.name)
    }
  }
  return proven
}

export type LockOrderViolation = { functionName: string; reason: string }

/**
 * Family 1's guard: every exported function in `fileText` that writes to
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
    const writes = writeHitsIn(fn.body, GUARDED_TABLES)
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

/**
 * How an exported function writes `lounges`, as family 2's check sees it:
 *  - `read-then-write` — its body also reads `lounges` (`.from(lounges)`), so
 *    the write can be derived from that read and the check applies to it.
 *  - `blind` — it writes `lounges` and never reads it, so there is nothing to
 *    derive and nothing for the lock to add over the row lock the `UPDATE`
 *    itself takes. `approveSubmission` is this, and it is the only one today.
 */
export type LoungeWriteShape = 'blind' | 'read-then-write'

/**
 * Every exported function in `fileText` that writes `lounges`, with the shape
 * family 2 classified it as. Backs BOTH anti-vacuity assertions for family 2
 * in `lock-order.test.ts`, which are two different questions with two
 * different meanings when they fail:
 *
 *  1. Is this map non-empty at all? An empty one means the scan found no
 *     `lounges` write anywhere in the roots — i.e. the identifier drifted (a
 *     rename in `db/schema.ts`, a local import alias, a typo in
 *     `LOUNGE_WRITE_TABLES`) or the root list stopped covering `src/registry`.
 *     `loungeLockViolationsIn` would then report zero violations for a reason
 *     that has nothing to do with anything being locked, which is the exact
 *     failure this project has now hit five times.
 *  2. Does at least one entry say `read-then-write`? Family 2's rule is
 *     conditional on the read, so a run in which nothing is classified that
 *     way is a run in which the check had no subject — it passed over
 *     nothing. That happens if `setOperationalStatus` stops reading the row
 *     it writes (say its `previous` read is moved out of the transaction, or
 *     behind a helper — the accepted helper-indirection gap), and it is
 *     precisely the case where a human should look rather than be reassured.
 */
export function loungeWritersIn(fileText: string): Map<string, LoungeWriteShape> {
  const text = stripComments(fileText)
  const writers = new Map<string, LoungeWriteShape>()

  for (const fn of exportedFunctionSpans(text)) {
    if (writeHitsIn(fn.body, LOUNGE_WRITE_TABLES).length === 0) continue
    const reads = tableReadPositionsIn(fn.body, LOUNGES)
    writers.set(fn.name, reads.length > 0 ? 'read-then-write' : 'blind')
  }

  return writers
}

/**
 * Family 2's guard: every exported function in `fileText` that READS `lounges`
 * and also WRITES it must take that row's `FOR UPDATE` (in its own SQL, and
 * on `lounges` specifically — a lock on `submissions` does not count) strictly
 * before the earliest such write.
 *
 * Deliberately NOT the same quantifier as `lockOrderViolationsIn`, and not
 * shareable with it: see this file's header for why family 1 is unconditional
 * while this one applies exactly to the read-then-write shape, and for why
 * `events` — written by both families — is guarded by neither. Blind writers
 * are skipped here for a stated reason, not exempted by name: there is no
 * exemption mechanism in this file and this check does not introduce one.
 *
 * `LOCK_DELEGATES` is not consulted: those helpers lock `submissions`, which
 * is a different row. A `lounges` lock taken inside a helper would not be
 * recognized here (accepted gap, header).
 */
export function loungeLockViolationsIn(fileText: string): LockOrderViolation[] {
  const text = stripComments(fileText)
  const violations: LockOrderViolation[] = []

  for (const fn of exportedFunctionSpans(text)) {
    const writes = writeHitsIn(fn.body, LOUNGE_WRITE_TABLES)
    if (writes.length === 0) continue
    if (tableReadPositionsIn(fn.body, LOUNGES).length === 0) continue

    const firstWrite = writes.reduce((a, b) => (b.index < a.index ? b : a))
    const locks = inlineLockPositionsIn(fn.body, LOUNGES)

    if (locks.length === 0) {
      violations.push({
        functionName: fn.name,
        reason: `reads lounges and then writes ${firstWrite.table} without ever locking the lounges row`,
      })
      continue
    }

    const earliestLock = Math.min(...locks)
    if (earliestLock > firstWrite.index) {
      violations.push({
        functionName: fn.name,
        reason: `locks the lounges row after its write to ${firstWrite.table}, not before`,
      })
    }
  }

  return violations
}
