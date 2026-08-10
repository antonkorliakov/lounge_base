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

// Matches module specifiers from all three import forms:
//   from '...'          (static import/export)
//   require('...')      (CJS)
//   import('...')       (dynamic import)
const SPECIFIER_RE =
  /(?:^|\s)from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g

/**
 * Extracts every module specifier imported/required/dynamically-imported by
 * `fileText`, and returns the subset that violates form-schema's purity
 * boundary: React (`react`, `react-dom`, or a subpath of either — but not
 * lookalikes such as `react-hook-form`), drizzle-orm (or any subpath), or the
 * DB layer (the `@/db` alias, or a relative specifier that resolves into
 * `src/db`). `filePath` is the absolute path of the file being scanned and is
 * required to resolve relative specifiers.
 */
export function forbiddenImportsIn(fileText: string, filePath: string): string[] {
  const offenders: string[] = []
  const re = new RegExp(SPECIFIER_RE.source, SPECIFIER_RE.flags)
  let match: RegExpExecArray | null
  while ((match = re.exec(fileText))) {
    const spec = match[1] ?? match[2] ?? match[3]
    if (!spec) continue
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
