import { dirname, resolve, sep } from 'node:path'

/**
 * Pure detection logic backing the form-schema purity guard
 * (`src/form-schema/__tests__/purity.test.ts`). Lives outside `src/form-schema/*.ts`
 * on purpose: the purity scan walks `src/form-schema` and skips `__tests__`, so if
 * this helper lived in the scanned tree it would never be checked against its own
 * rule (and would trivially "pass" by omission).
 */

const REACT_PACKAGES = ['react', 'react-dom']
const DB_ALIAS = '@/db'

function isReactSpecifier(spec: string): boolean {
  return (
    REACT_PACKAGES.includes(spec) ||
    REACT_PACKAGES.some((pkg) => spec.startsWith(`${pkg}/`))
  )
}

function isDrizzleSpecifier(spec: string): boolean {
  return spec === 'drizzle-orm' || spec.startsWith('drizzle-orm/')
}

function isDbAliasSpecifier(spec: string): boolean {
  return spec === DB_ALIAS || spec.startsWith(`${DB_ALIAS}/`)
}

/**
 * True when a relative specifier, resolved against the directory of the
 * importing file, lands inside the repo's `src/db` directory.
 */
function isDbRelativeSpecifier(spec: string, filePath: string): boolean {
  if (!spec.startsWith('.')) return false
  const resolved = resolve(dirname(filePath), spec)
  const dbDir = resolve(process.cwd(), 'src/db')
  return resolved === dbDir || resolved.startsWith(`${dbDir}${sep}`)
}

/**
 * The module-specifier syntaxes this detector recognizes. Enumerated as a
 * value, not just as regex alternatives, because `purity.test.ts` drives one
 * positive-match case per entry off this list: an alternative dropped from
 * `SPECIFIER_RE` (or narrowed until it stops matching) then fails a test that
 * names the form, instead of silently reducing this guard to a scan that finds
 * nothing and reports success.
 *
 * That is not a hypothetical. This regex family has now had the same failure
 * twice: it first missed *relative* specifiers into `src/db`
 * (`isDbRelativeSpecifier` exists because of that), and it then missed the
 * `bare` form below entirely — `import '@/db/client'` at the top of
 * `src/form-schema/blocks.ts` left all 87 form-schema tests green, while that
 * import executes the DB layer at module load and pulls drizzle into every
 * bundle that touches the schema. A side-effect import has no binding and no
 * `from`, so a detector built around `from '…'` cannot see the one import form
 * that needs no syntax at all.
 *
 *  - `from`    — `import … from '…'`, and `export … from '…'` (same clause)
 *  - `bare`    — `import '…'` (side-effect only, no bindings)
 *  - `require` — `require('…')` (CJS)
 *  - `dynamic` — `import('…')`
 */
export const IMPORT_FORMS = ['from', 'bare', 'require', 'dynamic'] as const
export type ImportForm = (typeof IMPORT_FORMS)[number]
export type ImportSpecifier = { form: ImportForm; spec: string }

/**
 * One alternative per `IMPORT_FORMS` entry, each capturing into a named group
 * with the form's own name so `importedSpecifiersIn` can report *which* form
 * matched without a positional-group table that drifts as alternatives move.
 *
 * `(?:^|[^\w$])` rather than `(?:^|\s)` before the `from`/`import` keywords,
 * and `\s*` rather than `\s+` before the quote: whitespace includes newlines
 * (so multi-line specifier lists were always covered), but the compact
 * `import{a}from'react'` form has no whitespace on either side of `from`, and
 * escaped a whitespace-anchored version — verified, it did. The leading
 * `[^\w$]` is what keeps `\s*` safe: an identifier ending in `from`/`import`
 * cannot start a match.
 *
 * `dynamic` is listed before `bare` and both are safe either way: `bare`
 * requires a quote immediately after the keyword, so `import('…')` can never
 * be misread as a side-effect import.
 */
const SPECIFIER_RE = new RegExp(
  [
    String.raw`(?:^|[^\w$])from\s*['"](?<from>[^'"]+)['"]`,
    String.raw`\brequire\s*\(\s*['"](?<require>[^'"]+)['"]\s*\)`,
    String.raw`\bimport\s*\(\s*['"](?<dynamic>[^'"]+)['"]\s*\)`,
    String.raw`(?:^|[^\w$])import\s*['"](?<bare>[^'"]+)['"]`,
  ].join('|'),
  'g',
)

/**
 * Every module specifier `fileText` imports, in source order, tagged with the
 * syntax it was written in. Exported for the guard's anti-vacuity checks — the
 * scan over the real `src/form-schema` tree asserts this returns a non-empty
 * result, so "no offenders" is known to mean "looked and found nothing
 * forbidden" rather than "matched nothing at all".
 *
 * Known limits, both in the safe (loud) direction, and neither new here:
 *  - No comment or string stripping (unlike
 *    `src/review/__tests__/lock-order-guard.ts`, which needs it because a doc
 *    comment mentioning a lock would count as *evidence* there). A
 *    commented-out or prose-quoted `import 'react'` inside a scanned file
 *    would be a false positive — a failing test asking a human to look, not a
 *    silent pass.
 *  - Only literal specifiers. `import(\`@/db/${name}\`)` and
 *    `require(someVariable)` are invisible; a computed specifier cannot be
 *    resolved by text at all, and none exist in the scanned tree.
 */
export function importedSpecifiersIn(fileText: string): ImportSpecifier[] {
  const found: ImportSpecifier[] = []
  const re = new RegExp(SPECIFIER_RE.source, SPECIFIER_RE.flags)
  let match: RegExpExecArray | null
  while ((match = re.exec(fileText))) {
    const groups: Record<string, string | undefined> = match.groups ?? {}
    for (const form of IMPORT_FORMS) {
      const spec = groups[form]
      if (spec) {
        found.push({ form, spec })
        break
      }
    }
  }
  return found
}

/**
 * Extracts every module specifier `fileText` pulls in — by any of
 * `IMPORT_FORMS` — and returns the subset that violates form-schema's purity
 * boundary: React (`react`, `react-dom`, or a subpath of either — but not
 * lookalikes such as `react-hook-form`), drizzle-orm (or any subpath), or the
 * DB layer (the `@/db` alias, or a relative specifier that resolves into
 * `src/db`). `filePath` is the absolute path of the file being scanned and is
 * required to resolve relative specifiers.
 *
 * A type-only import (`import type { Db } from '@/db/types'`) is reported like
 * any other: it carries no runtime cost, but form-schema's boundary is about
 * what this layer is allowed to *know*, and a type dependency on the DB layer
 * is still that. No form-schema module needs one today, so this stays the
 * strict reading rather than being loosened on speculation.
 */
export function forbiddenImportsIn(fileText: string, filePath: string): string[] {
  const offenders: string[] = []
  for (const { spec } of importedSpecifiersIn(fileText)) {
    if (
      isReactSpecifier(spec) ||
      isDrizzleSpecifier(spec) ||
      isDbAliasSpecifier(spec) ||
      isDbRelativeSpecifier(spec, filePath)
    ) {
      offenders.push(spec)
    }
  }
  return offenders
}
