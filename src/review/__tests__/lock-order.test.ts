import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  lockOrderViolationsIn,
  tablesWrittenIn,
  stripComments,
  EXEMPTIONS,
  GUARDED_TABLES,
} from './lock-order-guard'

const ROOTS = [
  join(process.cwd(), 'src/review'),
  join(process.cwd(), 'src/submissions'),
  join(process.cwd(), 'src/photos'),
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' ? [] : sourceFiles(path)
    }
    return /\.tsx?$/.test(path) ? [path] : []
  })
}

describe('порядок блокировки: submissions лочится до записи в дочерние таблицы', () => {
  it('каждая экспортируемая функция из src/review, src/submissions и src/photos, пишущая в field_flags/block_reviews/field_values/service_values/photos, лочит submissions первой', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const text = readFileSync(file, 'utf8')
        for (const v of lockOrderViolationsIn(text)) {
          offenders.push(`${file}: ${v.functionName} — ${v.reason}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('в каждом каталоге есть хотя бы один файл', () => {
    for (const root of ROOTS) {
      expect(sourceFiles(root).length).toBeGreaterThan(0)
    }
  })

  it('исключение существует как экспортируемая функция', () => {
    // If a name in EXEMPTIONS stops existing (renamed, deleted), this
    // catches the exemption silently protecting nothing rather than the
    // function it was written for.
    const names = new Set(Object.keys(EXEMPTIONS))
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const text = readFileSync(file, 'utf8')
        for (const fn of text.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
          names.delete(fn[1]!)
        }
      }
    }
    expect(Array.from(names)).toEqual([])
  })

  /**
   * Guards against the guard passing vacuously: without this, a
   * `GUARDED_TABLES` entry that drifted from the real schema identifier
   * (a rename in `db/schema.ts`, a typo here) would make `WRITE_RE` stop
   * matching real source entirely, and the "no offenders" test above would
   * keep passing forever for the wrong reason — it never found anything to
   * complain about because it stopped finding anything at all, not because
   * everything is correctly locked. This asserts the opposite: every table
   * this guard claims to protect has at least one real, live write site in
   * the scanned roots today, so a drifted identifier fails loudly instead
   * of silently disarming the guard.
   */
  it('каждая защищаемая таблица имеет хотя бы одну настоящую запись в просканированных каталогах', () => {
    const found = new Set<string>()
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const text = readFileSync(file, 'utf8')
        for (const table of tablesWrittenIn(text)) found.add(table)
      }
    }
    const missing = GUARDED_TABLES.filter((t) => !found.has(t))
    expect(missing).toEqual([])
  })
})

// lockOrderViolationsIn is the mechanism the test above relies on. It gets
// its own coverage here, driven directly with synthetic in-memory sources,
// so a regression in the detector doesn't hide behind an (accidentally)
// clean src/review+src/submissions+src/photos tree — same rationale as
// forbiddenImportsIn's / unsafeDbUsagesIn's own tests.
describe('lockOrderViolationsIn', () => {
  it('пропускает функцию, которая лочит submissions перед записью', () => {
    const text = `
      export async function ok(db) {
        return db.transaction(async (tx) => {
          await tx
            .select({ status: submissions.status })
            .from(submissions)
            .where(eq(submissions.id, id))
            .for('update')
            .limit(1)
          await tx.insert(fieldFlags).values({})
        })
      }
    `
    expect(lockOrderViolationsIn(text)).toEqual([])
  })

  it('ловит функцию, которая пишет без блокировки вовсе', () => {
    const text = `
      export async function badNoLock(db) {
        return db.transaction(async (tx) => {
          await tx.insert(fieldFlags).values({})
        })
      }
    `
    const violations = lockOrderViolationsIn(text)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.functionName).toBe('badNoLock')
    expect(violations[0]?.reason).toMatch(/without ever locking submissions/)
  })

  it('ловит функцию, которая лочит submissions ПОСЛЕ записи', () => {
    const text = `
      export async function badLockAfter(db) {
        return db.transaction(async (tx) => {
          await tx.insert(fieldFlags).values({})
          await tx
            .select({ status: submissions.status })
            .from(submissions)
            .where(eq(submissions.id, id))
            .for('update')
        })
      }
    `
    const violations = lockOrderViolationsIn(text)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.functionName).toBe('badLockAfter')
    expect(violations[0]?.reason).toMatch(/after its write/)
  })

  it('не ловит функцию, которая ничего не пишет в защищённые таблицы', () => {
    const text = `
      export async function readOnly(db) {
        return db.select().from(submissions)
      }
    `
    expect(lockOrderViolationsIn(text)).toEqual([])
  })

  it('признаёт делегированную блокировку через assertEditable как достаточную', () => {
    const text = `
      export async function saveFieldValue(db, input) {
        return db.transaction(async (tx) => {
          const editable = await assertEditable(tx, input.submissionId)
          if (!editable.ok) return editable
          await tx.insert(fieldValues).values({})
        })
      }
    `
    expect(lockOrderViolationsIn(text)).toEqual([])
  })

  it('не ловит функцию из списка исключений, даже если она пишет без блокировки', () => {
    const text = `
      export async function clearFlagsFor(db, submissionId, key) {
        return db.transaction(async (tx) => {
          await tx.update(fieldFlags).set({}).where(eq(1, 1))
          await tx.delete(blockReviews).where(eq(1, 1))
        })
      }
    `
    expect(lockOrderViolationsIn(text)).toEqual([])
  })

  it('doc-комментарий с текстом про блокировку не маскирует удалённый реальный лок', () => {
    // The exact failure mode the coordinator's fix-round flagged: a
    // previous guard elsewhere in this project matched its own comment
    // and passed with the real lock deleted. `fn` here has no real lock —
    // only a comment claiming one — and must still be caught.
    const text = `
      /**
       * Locks the submissions row with .for('update') before writing —
       * or at least, that is what this comment claims. .from(submissions)
       */
      export async function fn(db) {
        return db.transaction(async (tx) => {
          await tx.insert(fieldFlags).values({})
        })
      }
    `
    const violations = lockOrderViolationsIn(text)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.functionName).toBe('fn')
  })

  describe('форма export const NAME = (...) => ...', () => {
    it('пропускает locked-блочную arrow-функцию (с аннотацией типа возврата)', () => {
      const text = `
        export const ok = async (db, input): Promise<SaveResult> => {
          return db.transaction(async (tx) => {
            await tx
              .select({ status: submissions.status })
              .from(submissions)
              .where(eq(submissions.id, input.id))
              .for('update')
            await tx.insert(fieldValues).values({})
          })
        }
      `
      expect(lockOrderViolationsIn(text)).toEqual([])
    })

    it('ловит блочную arrow-функцию, которая пишет без блокировки', () => {
      const text = `
        export const badArrow = async (db, input) => {
          return db.transaction(async (tx) => {
            await tx.insert(serviceValues).values({})
          })
        }
      `
      const violations = lockOrderViolationsIn(text)
      expect(violations).toHaveLength(1)
      expect(violations[0]?.functionName).toBe('badArrow')
      expect(violations[0]?.reason).toMatch(/without ever locking submissions/)
    })

    it('ловит expression-body arrow-функцию, которая пишет без блокировки', () => {
      const text = `
        export const badExpr = (db, input) =>
          db.transaction(async (tx) => tx.insert(photos).values({}));
        export async function next() {}
      `
      const violations = lockOrderViolationsIn(text)
      expect(violations).toHaveLength(1)
      expect(violations[0]?.functionName).toBe('badExpr')
      expect(violations[0]?.reason).toMatch(/without ever locking submissions/)
    })

    it('не путает следующий export с телом текущей expression-body функции', () => {
      // Regression check for the heuristic `;`-bound itself, not merely
      // that both functions get *a* violation: `next` is locked BEFORE its
      // own write, but that lock textually comes AFTER badExpr's write. If
      // the heuristic span leaked past badExpr's own `;` into `next`'s
      // body (the bug this guards against), badExpr's reported violation
      // would flip from "writes with no lock at all" to "locks after its
      // write" — because `next`'s later `.for('update')` would appear,
      // wrongly, to be a lock badExpr itself eventually takes. A correct
      // bound reports badExpr as having no lock whatsoever, and does not
      // flag the correctly-locked `next` at all.
      const text = `
        export const badExpr = (db, input) =>
          db.transaction(async (tx) => tx.insert(photos).values({}));
        export async function next(db) {
          return db.transaction(async (tx) => {
            await tx
              .select({ status: submissions.status })
              .from(submissions)
              .where(eq(submissions.id, db.id))
              .for('update')
            await tx.insert(blockReviews).values({})
          })
        }
      `
      const violations = lockOrderViolationsIn(text)
      expect(violations).toHaveLength(1)
      expect(violations[0]?.functionName).toBe('badExpr')
      expect(violations[0]?.reason).toMatch(/without ever locking submissions/)
    })
  })
})

describe('tablesWrittenIn', () => {
  it('находит таблицу из insert/update/delete вызовов', () => {
    const text = `
      export async function fn(db) {
        return db.transaction(async (tx) => {
          await tx.insert(fieldFlags).values({})
          await tx.update(blockReviews).set({})
          await tx.delete(photos).where(eq(1, 1))
        })
      }
    `
    expect(tablesWrittenIn(text)).toEqual(new Set(['fieldFlags', 'blockReviews', 'photos']))
  })

  it('не видит таблицу, упомянутую только в комментарии', () => {
    const text = `
      // this file used to write .insert(fieldFlags) here, no longer does
      export async function fn(db) {
        return db.select().from(submissions)
      }
    `
    expect(tablesWrittenIn(text)).toEqual(new Set())
  })
})

describe('stripComments', () => {
  it('удаляет блочный /* */ комментарий целиком', () => {
    expect(stripComments('a/* c1 */b')).toBe('ab')
  })

  it('удаляет строчный // комментарий до конца строки, сохраняя перевод строки', () => {
    expect(stripComments('a // c1\nb')).toBe('a \nb')
  })

  it('не трогает // внутри строкового литерала', () => {
    const text = `const url = 'http://x'`
    expect(stripComments(text)).toBe(text)
  })

  it('не трогает /* внутри строкового литерала', () => {
    const text = `const s = "/* not a comment */"`
    expect(stripComments(text)).toBe(text)
  })

  it('корректно проходит escaped-кавычку внутри строки', () => {
    const text = `const s = 'it\\'s // not a comment'`
    expect(stripComments(text)).toBe(text)
  })
})
