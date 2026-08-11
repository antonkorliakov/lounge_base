import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { unsafeDbUsagesIn } from './unsafe-db-usage-guard'

const ROOT = join(process.cwd(), 'src')
const DB_DIR = join(process.cwd(), 'src/db')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (path === DB_DIR) return []
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(path) ? [path] : []
  })
}

describe('Db-специфичные небезопасные пути остаются внутри src/db', () => {
  it('вне src/db не используются db.execute/.prepare/.transaction(fn, options)', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(ROOT)) {
      const text = readFileSync(file, 'utf8')
      for (const spec of unsafeDbUsagesIn(text)) {
        offenders.push(`${file}: ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('содержит хотя бы один файл вне src/db', () => {
    expect(sourceFiles(ROOT).length).toBeGreaterThan(0)
  })
})

// unsafeDbUsagesIn is the mechanism the test above relies on. It gets its
// own coverage here, driven directly with in-memory strings, so a
// regression in the detector doesn't hide behind an (accidentally) clean
// src tree — same rationale as forbiddenImportsIn's own tests in
// src/form-schema/__tests__/purity.test.ts.
describe('unsafeDbUsagesIn', () => {
  it('catches db.execute(...)', () => {
    const text = `async function f(db: Db) {\n  await db.execute(sql\`select 1\`)\n}\n`
    expect(unsafeDbUsagesIn(text)).toEqual(['db.execute('])
  })

  it('catches tx.execute(...) inside a transaction callback', () => {
    const text = `db.transaction(async (tx) => {\n  await tx.execute(sql\`select 1\`)\n})\n`
    expect(unsafeDbUsagesIn(text)).toEqual(['tx.execute('])
  })

  // The app layer's only DB idiom: nothing under src/app receives a `Db`, it
  // calls the `db()` factory at the point of use (40 sites). A version of
  // EXECUTE_RE scoped to bare `db`/`tx` could not see any of them, so
  // `await db().execute(sql`…`)` typechecked and passed this guard.
  it('catches db().execute(...) — the factory-call receiver', () => {
    const text = `export async function f() {\n  await db().execute(sql\`select 1\`)\n}\n`
    expect(unsafeDbUsagesIn(text)).toEqual(['db().execute('])
  })

  it('catches db().execute(...) chained over several lines', () => {
    const text = `await db()\n  .execute(sql\`select 1\`)\n`
    expect(unsafeDbUsagesIn(text)).toEqual(['db().execute('])
  })

  it('catches a factory call that takes an argument', () => {
    const text = `await db(url).execute(sql\`select 1\`)\n`
    expect(unsafeDbUsagesIn(text)).toEqual(['db(url).execute('])
  })

  it('does not flag an unrelated factory whose result has execute()', () => {
    const text = `queue().execute(job)\n`
    expect(unsafeDbUsagesIn(text)).toEqual([])
  })

  it('catches a chained .prepare(...) call', () => {
    const text = `const q = db.select().from(x).prepare('named')\n`
    expect(unsafeDbUsagesIn(text)).toEqual(['.prepare('])
  })

  it('catches .transaction(fn, options) — the two-argument form', () => {
    const text = `db.transaction(async (tx) => {\n  return tx.select()\n}, { isolationLevel: 'serializable' })\n`
    expect(unsafeDbUsagesIn(text)).toEqual(['.transaction(<fn>, <options>)'])
  })

  it('does not flag the bare single-argument db.transaction(async (tx) => ...) form', () => {
    const text = `return db.transaction(async (tx) => {\n  const rows = await tx.select().from(x)\n  return rows\n})\n`
    expect(unsafeDbUsagesIn(text)).toEqual([])
  })

  it('does not flag a comma inside the callback body as a second argument', () => {
    const text = `db.transaction(async (tx) => {\n  const a = 1, b = 2\n  return a + b\n})\n`
    expect(unsafeDbUsagesIn(text)).toEqual([])
  })

  it('does not flag an unrelated object method named execute', () => {
    const text = `queue.execute(job)\n`
    expect(unsafeDbUsagesIn(text)).toEqual([])
  })

  it('produces no offenders for a clean file', () => {
    const text = `export type Localized = { en: string; ru: string }\n`
    expect(unsafeDbUsagesIn(text)).toEqual([])
  })
})
