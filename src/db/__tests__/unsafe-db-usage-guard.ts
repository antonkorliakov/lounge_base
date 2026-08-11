/**
 * Pure detection logic backing the "unsafe `Db` paths stay inside `src/db`"
 * guard (`src/db/__tests__/unsafe-db-paths.test.ts`). Lives outside the
 * scanned tree on purpose, mirroring `src/form-schema/__tests__/import-guard.ts`:
 * the guard scans every file under `src` EXCEPT `src/db`, so a helper that
 * necessarily contains the literal substrings it looks for (`db.execute(`,
 * `.prepare(`, `.transaction(` with a second argument) must live inside
 * `src/db` or it would trip its own rule.
 *
 * Context: `Db` (see `../types.ts`) is one common type shared by the
 * production postgres-js client and the PGlite test client. That type is
 * sound for the query-builder surface application code actually uses
 * (select/insert/update/delete/returning/onConflictDoUpdate, and the bare
 * `db.transaction(async (tx) => ...)` callback form) — confirmed by the
 * whole repo typechecking with zero casts once `Db` was retyped to the
 * shared `PgDatabase<PgQueryResultHKT, typeof schema>` base class. It is
 * NOT sound for three paths where postgres-js and PGlite genuinely diverge
 * at runtime, cast or no cast:
 *   - `db.execute(...)` / `tx.execute(...)` / `db().execute(...)` — raw SQL
 *     execution, whose actual result shape differs per driver.
 *   - `.prepare(...)` — prepared statements; the two drivers' sessions
 *     implement this differently.
 *   - `.transaction(fn, options)` — the two-argument form. `PgTransactionConfig`
 *     (isolationLevel/accessMode/deferrable) is the same TYPE on both
 *     drivers, which is exactly the trap: identical types do not mean
 *     identical engine behaviour, and PGlite's support for these options
 *     does not match postgres-js's.
 * Nothing in the type system stops code outside `src/db` from reaching
 * these three paths, so this guard makes that a build-breaking mistake
 * instead of a latent one.
 */

/**
 * True for `.execute(` on a receiver named `db` or `tx`, reached either
 * directly (`db.execute(`, `tx.execute(`) or through a call on that name
 * (`db().execute(`). Both halves are needed because this codebase holds a
 * `Db`-typed value in two different shapes, and the second one is the more
 * common:
 *  - **A parameter**, in the library layers: every
 *    `saveFieldValue`/`saveServiceValue`/`submitSubmission`/`attachPhoto`/
 *    `removePhoto` in `src/submissions` and `src/photos` takes `db: Db` (or
 *    `tx: Tx` inside a transaction callback), so the receiver is the bare
 *    name.
 *  - **The factory call**, in the app layer: nothing under `src/app`
 *    receives a `Db`, it calls `db()` from `src/db/client.ts` at the point of
 *    use — 40 such call sites today, and the only DB idiom that layer has. A
 *    version of this regex scoped to bare `db`/`tx` therefore could not see
 *    the app layer at all: `await db().execute(sql\`…\`)` typechecks and
 *    passed this guard, which is what it was written to prevent. The
 *    optional call is matched with a single non-nested argument list rather
 *    than a bare `()` so a factory that ever takes an argument does not
 *    reopen the same hole.
 *
 * Still scoped to those two names rather than a bare `.execute(`, so an
 * unrelated object's own `.execute()` method (there are none in this codebase
 * today, but the point of a guard is to not need to know that) is not a false
 * positive. What that scoping accepts, named rather than assumed away: a
 * `Db` held under any OTHER local name — `const d = db(); d.execute(…)` — is
 * invisible, the same alias-indirection limit
 * `src/review/__tests__/lock-order-guard.ts` accepts for table identifiers.
 */
const EXECUTE_RE = /\b(?:db|tx)\s*(?:\(\s*[^()]*\))?\s*\.execute\s*\(/g

/**
 * True for a `.prepare(` call on any receiver. Drizzle prepared statements
 * are built by chaining off a query builder with an arbitrary local
 * variable name (`const q = db.select()...; q.prepare('name')`), not off
 * `db`/`tx` directly, so — unlike `execute` above — this cannot be scoped to
 * a fixed receiver name without missing the real pattern. The trade-off:
 * an unrelated library's own `.prepare(` method (none exist in this
 * codebase's dependencies as used today) would be a false positive here.
 * That is accepted deliberately — this guard is a speed bump that forces a
 * conscious, reviewable opt-out (widening the exclusion below), not a full
 * static analyzer.
 */
const PREPARE_RE = /\.prepare\s*\(/g

/**
 * Finds every top-level `.transaction(` call in `text` and returns the
 * index right after its opening `(` for each, so the caller can walk the
 * argument list looking for a second argument.
 */
function transactionCallOpenParens(text: string): number[] {
  const positions: number[] = []
  const re = /\.transaction\s*\(/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    positions.push(match.index + match[0].length - 1)
  }
  return positions
}

/**
 * Given the index of the `(` that opens a call's argument list, returns the
 * raw text between it and its matching `)`, tracking `(`/`{`/`[` nesting so
 * a comma inside the callback body (e.g. inside the `async (tx) => { ... }`
 * argument itself) is not mistaken for the boundary between argument one and
 * argument two. Returns `null` if the parentheses never balance (malformed
 * input — treated as "nothing to flag" rather than a crash).
 */
function matchingCallArgs(text: string, openParenIndex: number): string | null {
  let depth = 0
  for (let i = openParenIndex; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return text.slice(openParenIndex + 1, i)
    }
  }
  return null
}

/**
 * True when `argsText` (the raw text between a call's outer parens) has more
 * than one top-level, comma-separated argument — i.e. `.transaction(fn, x)`
 * rather than `.transaction(fn)`. Depth-tracks nested `(`/`{`/`[` so a comma
 * inside the callback body or inside an options object literal doesn't count
 * as the top-level separator.
 */
function hasSecondArgument(argsText: string): boolean {
  let depth = 0
  for (const ch of argsText) {
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') depth--
    else if (ch === ',' && depth === 0) return true
  }
  return false
}

/**
 * Extracts every offending usage of the three paths where `Db`'s shared
 * type stops being sound (see module doc above). Purely text-based, like
 * `forbiddenImportsIn` — no TypeScript parser involved — so it shares that
 * function's limitation of not understanding comments or string literals,
 * which is an accepted trade-off for a guard whose job is to force a
 * conscious opt-out, not to replace a linter.
 *
 * One live consequence, since widening `EXECUTE_RE` to the factory-call
 * receiver made it easy to hit: writing one of these patterns in PROSE — a doc
 * comment naming the idiom this guard rejects — is reported as a real usage
 * anywhere under `src` except `src/db`. It happened immediately, in
 * `src/review/__tests__/lock-order-guard.ts`, whose accepted-gap note leans on
 * this guard and wanted to name what it now covers. The failure direction is
 * the right one (loud, in a file a human is already editing), and the workaround
 * is to describe the pattern instead of quoting it; only this file may quote it
 * freely, because the scan skips `src/db` for exactly that reason.
 */
export function unsafeDbUsagesIn(text: string): string[] {
  const offenders: string[] = []

  // Whitespace collapsed, not just trimmed: a chained call broken over lines
  // (`db()\n  .execute(`) should be reported as `db().execute(` rather than as
  // a multi-line fragment inside an assertion message.
  for (const match of text.matchAll(EXECUTE_RE)) {
    offenders.push(match[0].replace(/\s+/g, ''))
  }

  for (const match of text.matchAll(PREPARE_RE)) {
    offenders.push(match[0].trim())
  }

  for (const openParenIndex of transactionCallOpenParens(text)) {
    const argsText = matchingCallArgs(text, openParenIndex)
    if (argsText !== null && hasSecondArgument(argsText)) {
      offenders.push('.transaction(<fn>, <options>)')
    }
  }

  return offenders
}
