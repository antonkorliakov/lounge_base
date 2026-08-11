import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  lockOrderViolationsIn,
  loungeLockViolationsIn,
  loungeWritersIn,
  tablesWrittenIn,
  stripComments,
  provenLockDelegatesIn,
  GUARDED_TABLES,
  LOCK_DELEGATES,
} from './lock-order-guard'

/**
 * One root list for BOTH checks in `lock-order-guard.ts`, not one per family.
 * The alternative — scanning `src/registry` for the `lounges` rule only —
 * would answer "which parent's lock does this function owe?" by which
 * directory it happens to live in, so a `lounges` read-then-writer added to
 * `src/review` would escape both checks. Scanning everything with both rules
 * means each function is judged by what its own body does: `approveSubmission`
 * (`src/review`) IS examined by the `lounges` check and passes it because it
 * never reads the row it writes, and `setOperationalStatus` (`src/registry`) IS
 * examined by the `submissions` check and is silently fine there because it
 * writes none of that family's tables.
 */
const ROOTS = [
  join(process.cwd(), 'src/review'),
  join(process.cwd(), 'src/submissions'),
  join(process.cwd(), 'src/photos'),
  join(process.cwd(), 'src/registry'),
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

function scannedSources(): string[] {
  return ROOTS.flatMap((root) => sourceFiles(root))
}

describe('порядок блокировки: submissions лочится до записи в дочерние таблицы', () => {
  it('каждая экспортируемая функция из просканированных каталогов, пишущая в field_flags/block_reviews/field_values/service_values/photos, лочит submissions первой', () => {
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

  /**
   * Catches a root that stopped resolving to real files (a directory renamed
   * or moved), but NOT `ROOTS` itself being emptied — a loop over an empty
   * list passes. That case is covered by the positive-match assertions
   * instead (`каждая защищаемая таблица …` below and the two `lounges`
   * anti-vacuity ones), and verified by emptying the list: four tests fail
   * across both families, this one among them not being one of them. Stated
   * here so the gap is known rather than assumed covered.
   */
  it('в каждом каталоге есть хотя бы один файл', () => {
    for (const root of ROOTS) {
      expect(sourceFiles(root).length).toBeGreaterThan(0)
    }
  })

  /**
   * `LOCK_DELEGATES` is the guard's only remaining hand-maintained list —
   * `EXEMPTIONS` is gone — and it is the one place a listed name can make
   * the guard *weaker*: every writer in `src/submissions`/`src/photos`
   * satisfies the scan by calling `assertEditable` rather than locking
   * inline, so if `assertEditable` ever loses its own `.for('update')`, the
   * scan above would keep reporting zero violations while nothing in that
   * whole path locks anything. This replaces the old "every EXEMPTIONS name
   * still exists" assertion with the same anti-staleness idea aimed at the
   * list that still exists, and asks for more than existence: each delegate
   * must be found in the scanned roots AND take the lock in its own body.
   */
  it('каждый LOCK_DELEGATES действительно берёт блокировку submissions в своём теле', () => {
    const proven = new Set<string>()
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const text = readFileSync(file, 'utf8')
        for (const name of provenLockDelegatesIn(text)) proven.add(name)
      }
    }
    const unproven = LOCK_DELEGATES.filter((name) => !proven.has(name))
    expect(unproven).toEqual([])
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

/**
 * The second, parallel check — the `lounges` family. Separate `describe`
 * rather than more cases inside the one above, because it enforces a
 * DIFFERENT invariant with a different quantifier (see the header of
 * `lock-order-guard.ts`: family 1 requires the parent lock of every writer of
 * a child table; this one requires the `lounges` row lock of every function
 * that reads that row and then writes it). Keeping them separate is what lets
 * each one's name state its own rule instead of one name covering two.
 *
 * What it exists to catch, concretely: `setOperationalStatus`
 * (`src/registry/status.ts`) reads the previous operational status and writes
 * both the new one and the `events` row recording `from → to`. Without the
 * row lock, two concurrent changes read the same `previous` and each record
 * the same `from`, so the history stops chaining and can no longer be
 * replayed. Before this check existed, deleting that `.for('update')` left
 * every test in this file and in `src/registry/__tests__` green.
 */
describe('порядок блокировки: lounges лочится до записи статуса и истории', () => {
  it('каждая экспортируемая функция, которая читает строку lounges и пишет её, лочит эту строку до записи', () => {
    const offenders: string[] = []
    for (const file of scannedSources()) {
      const text = readFileSync(file, 'utf8')
      for (const v of loungeLockViolationsIn(text)) {
        offenders.push(`${file}: ${v.functionName} — ${v.reason}`)
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * Anti-vacuity, question 1: the scan found a real `lounges` write at all.
   * Without this, a drifted identifier (`lounges` renamed in `db/schema.ts`,
   * imported under an alias, mistyped in `LOUNGE_WRITE_TABLES`) or a root list
   * that stopped covering `src/registry` would make the check above report
   * zero offenders because it stopped looking, not because everything locks.
   */
  it('в просканированных каталогах есть хотя бы одна настоящая запись в lounges', () => {
    const writers = new Map<string, string>()
    for (const file of scannedSources()) {
      for (const [name, shape] of loungeWritersIn(readFileSync(file, 'utf8'))) {
        writers.set(name, shape)
      }
    }
    expect([...writers.keys()]).not.toEqual([])
  })

  /**
   * Anti-vacuity, question 2, and the one specific to this check's shape:
   * the rule applies only to a function that READS the row it writes, so a
   * run in which nothing is classified `read-then-write` is a run in which
   * the rule had no subject. That is the state the codebase was in before
   * `src/registry` existed, and it is also what would happen if
   * `setOperationalStatus`'s `previous` read moved out of its body (into a
   * helper, or into an earlier transaction — the second being the mistake
   * `clearFlagsFor` was fixed for). Either way the answer is "a human should
   * look", not "green".
   */
  it('хотя бы одна функция действительно читает-и-пишет lounges, иначе правилу нечего проверять', () => {
    const shapes: string[] = []
    for (const file of scannedSources()) {
      for (const [, shape] of loungeWritersIn(readFileSync(file, 'utf8'))) shapes.push(shape)
    }
    expect(shapes).toContain('read-then-write')
  })

  /**
   * `approveSubmission` writes `lounges` too, and passes this check without
   * any exemption: it never issues `.from(lounges)`, so it derives nothing
   * from the row it overwrites (its values come from `field_values`), and the
   * row lock its own `UPDATE` takes is all it needs. Pinned as a positive
   * fact about the SOURCE rather than left implicit in "no offenders": if it
   * ever starts reading `lounges` before writing it, this test fails and says
   * so, at the same time as the check above starts demanding the lock — which
   * is the right demand at that point, because the read-then-write shape
   * would then be real. Its own doc comment in `decide.ts` carries the
   * deadlock argument; nothing here restates or weakens it.
   */
  it('approveSubmission пишет lounges вслепую (не читая её) — поэтому блокировка ему не нужна', () => {
    const text = readFileSync(join(process.cwd(), 'src/review/decide.ts'), 'utf8')
    expect(loungeWritersIn(text).get('approveSubmission')).toBe('blind')
    expect(loungeLockViolationsIn(text)).toEqual([])
  })
})

// Same rationale as lockOrderViolationsIn's synthetic tests below: the
// real-source scan above is only as good as this detector, so it is driven
// directly with in-memory sources — both directions, so neither "recognizes
// nothing" nor "accepts anything" can hide behind a currently-clean tree.
describe('loungeLockViolationsIn', () => {
  const locked = `
    export async function setOperationalStatus(db, input) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({ status: lounges.operationalStatus })
          .from(lounges)
          .where(eq(lounges.id, input.loungeId))
          .for('update')
          .limit(1)
        await tx.update(lounges).set({ operationalStatus: input.status }).where(eq(lounges.id, input.loungeId))
        await tx.insert(events).values({ payload: { from: rows[0].status } })
      })
    }
  `

  it('пропускает функцию, которая лочит строку lounges перед записью', () => {
    expect(loungeLockViolationsIn(locked)).toEqual([])
  })

  it('ловит ту же функцию, если убрать только .for(\'update\')', () => {
    // Exactly break-verify #1, as a unit test: the ONE line deleted, nothing
    // else — the realistic drift, not a whole hunk reverted.
    const text = locked.replace(/\s*\.for\('update'\)/, '')
    const violations = loungeLockViolationsIn(text)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.functionName).toBe('setOperationalStatus')
    expect(violations[0]?.reason).toMatch(/without ever locking the lounges row/)
  })

  it('ловит функцию, которая лочит lounges ПОСЛЕ записи', () => {
    const text = `
      export async function badOrder(db, input) {
        return db.transaction(async (tx) => {
          const previous = await tx.select().from(lounges).where(eq(lounges.id, input.id))
          await tx.update(lounges).set({ operationalStatus: input.status })
          await tx.select().from(lounges).where(eq(lounges.id, input.id)).for('update')
        })
      }
    `
    const violations = loungeLockViolationsIn(text)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.functionName).toBe('badOrder')
    expect(violations[0]?.reason).toMatch(/after its write/)
  })

  it('блокировка ЧУЖОЙ строки (submissions) не считается блокировкой lounges', () => {
    // The case that makes this a genuinely separate check rather than a
    // rename of the first one: `approveSubmission`'s lock satisfies family 1
    // and says nothing about the `lounges` row. A function shaped like it but
    // which also READS `lounges` must be reported.
    const text = `
      export async function readsThenWritesUnderTheWrongLock(db, input) {
        return db.transaction(async (tx) => {
          await tx.select({ status: submissions.status }).from(submissions).where(eq(submissions.id, input.id)).for('update')
          const current = await tx.select().from(lounges).where(eq(lounges.id, input.loungeId))
          await tx.update(lounges).set({ zone: current[0].zone })
        })
      }
    `
    const violations = loungeLockViolationsIn(text)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.reason).toMatch(/without ever locking the lounges row/)
  })

  it('не ловит слепую запись в lounges (ничего не читает — нечего сериализовать)', () => {
    const text = `
      export async function approveSubmission(db, input) {
        return db.transaction(async (tx) => {
          await tx.update(lounges).set(classifying).where(eq(lounges.id, locked.loungeId))
          await tx.insert(events).values({ action: 'approved' })
        })
      }
    `
    expect(loungeLockViolationsIn(text)).toEqual([])
    expect(loungeWritersIn(text)).toEqual(new Map([['approveSubmission', 'blind']]))
  })

  it('не ловит чтение lounges без записи (реестр только читает)', () => {
    const text = `
      export async function listRegistry(db) {
        return db.select().from(lounges).orderBy(lounges.name)
      }
    `
    expect(loungeLockViolationsIn(text)).toEqual([])
    expect(loungeWritersIn(text)).toEqual(new Map())
  })

  it('не считает events дочерней таблицей lounges — запись события без блокировки не нарушение', () => {
    // `submitSubmission`'s real shape: an `events` INSERT about a submission,
    // with no lounge in hand at all. Naming `events` a child of `lounges`
    // would report this as a violation and there would be no row for it to
    // lock — see the guard header on why a table with two parents is guarded
    // by neither.
    const text = `
      export async function submitSubmission(db, input) {
        return db.transaction(async (tx) => {
          await tx.insert(events).values({ submissionId: input.submissionId })
        })
      }
    `
    expect(loungeLockViolationsIn(text)).toEqual([])
    expect(loungeWritersIn(text)).toEqual(new Map())
  })

  it('doc-комментарий про блокировку lounges не маскирует удалённый реальный лок', () => {
    const text = `
      /**
       * Locks the lounges row: .from(lounges) … .for('update') — so says the
       * comment, while the body below does no such thing.
       */
      export async function fn(db, input) {
        return db.transaction(async (tx) => {
          const rows = await tx.select().from(lounges).where(eq(lounges.id, input.id))
          await tx.update(lounges).set({ operationalStatus: input.status })
        })
      }
    `
    const violations = loungeLockViolationsIn(text)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.functionName).toBe('fn')
  })

  it('видит тело функции с инлайновым объектным типом возврата', () => {
    // `bodyBraceAfterParams` is shared with family 1; this pins that family 2
    // inherits the fix rather than re-opening the hole for its own spans.
    const text = `
      export async function badInlineReturnType(db, input): Promise<{ ok: boolean } | null> {
        return db.transaction(async (tx) => {
          const rows = await tx.select().from(lounges).where(eq(lounges.id, input.id))
          await tx.update(lounges).set({ operationalStatus: input.status })
        })
      }
    `
    const violations = loungeLockViolationsIn(text)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.functionName).toBe('badInlineReturnType')
  })

  it('ловит arrow-функцию, которая читает и пишет lounges без блокировки', () => {
    const text = `
      export const setStatus = async (db, input): Promise<StatusResult> => {
        return db.transaction(async (tx) => {
          const rows = await tx.select().from(lounges).where(eq(lounges.id, input.id))
          await tx.update(lounges).set({ operationalStatus: input.status })
        })
      }
    `
    const violations = loungeLockViolationsIn(text)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.functionName).toBe('setStatus')
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

  it('видит тело функции с инлайновым объектным типом возврата', () => {
    // `bodyBraceAfterParams` used to take the first `{` after the parameter
    // list, so this signature's own return-type literal was mistaken for the
    // body and everything inside the real one — writes included — was
    // invisible. Two live functions in the scanned roots are written this
    // way (`loadSubmissionValues`, `lockSubmission`); both happen to be
    // read-only, so the hole cost nothing yet.
    const text = `
      export async function badInlineReturnType(db, id): Promise<{ ok: boolean } | null> {
        return db.transaction(async (tx) => {
          await tx.insert(fieldFlags).values({})
        })
      }
    `
    const violations = lockOrderViolationsIn(text)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.functionName).toBe('badInlineReturnType')
    expect(violations[0]?.reason).toMatch(/without ever locking submissions/)
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

  it('ловит clearFlagsFor без блокировки — исключений больше нет ни для кого', () => {
    // `clearFlagsFor` was the guard's last exemption, on an argument that
    // turned out to be wrong (see its doc comment in `flags.ts`). This is
    // the inverse of the test that used to stand here: the same lock-free
    // body, now expected to be REPORTED. Naming the function explicitly
    // pins that the exemption mechanism is gone rather than merely empty —
    // an `EXEMPTIONS = {}` would pass a generically-named case too.
    const text = `
      export async function clearFlagsFor(db, submissionId, key) {
        return db.transaction(async (tx) => {
          await tx.update(fieldFlags).set({}).where(eq(1, 1))
          await tx.delete(blockReviews).where(eq(1, 1))
        })
      }
    `
    const violations = lockOrderViolationsIn(text)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.functionName).toBe('clearFlagsFor')
    expect(violations[0]?.reason).toMatch(/without ever locking submissions/)
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

// Same rationale as lockOrderViolationsIn's own synthetic tests: the
// delegate-honesty check above is only as good as this detector, and a
// detector that quietly stopped recognizing anything would make that check
// fail loudly — but one that recognized too much (accepting a delegate that
// only calls another delegate) would make it pass for nothing. Both
// directions are pinned here.
describe('provenLockDelegatesIn', () => {
  it('признаёт делегата, который берёт блокировку в своём теле', () => {
    const text = `
      export async function assertEditable(tx, submissionId) {
        const rows = await tx
          .select({ status: submissions.status })
          .from(submissions)
          .where(eq(submissions.id, submissionId))
          .for('update')
          .limit(1)
        return rows[0]
      }
    `
    expect(provenLockDelegatesIn(text)).toEqual(new Set(['assertEditable']))
  })

  it('видит неэкспортируемого делегата (lockSubmission — модульно-локальный)', () => {
    const text = `
      async function lockSubmission(tx, submissionId) {
        const rows = await tx
          .select({ status: submissions.status })
          .from(submissions)
          .where(eq(submissions.id, submissionId))
          .for('update')
          .limit(1)
        return rows[0] ?? null
      }
    `
    expect(provenLockDelegatesIn(text)).toEqual(new Set(['lockSubmission']))
  })

  it('НЕ признаёт делегата, у которого блокировка удалена', () => {
    const text = `
      export async function assertEditable(tx, submissionId) {
        const rows = await tx
          .select({ status: submissions.status })
          .from(submissions)
          .where(eq(submissions.id, submissionId))
          .limit(1)
        return rows[0]
      }
    `
    expect(provenLockDelegatesIn(text)).toEqual(new Set())
  })

  it('НЕ признаёт делегата, который лишь вызывает другого делегата', () => {
    // Self-referential proof: two listed delegates certifying each other
    // with no real FOR UPDATE anywhere. Only the body's own SQL counts.
    const text = `
      async function lockSubmission(tx, id) {
        return assertEditable(tx, id)
      }
    `
    expect(provenLockDelegatesIn(text)).toEqual(new Set())
  })

  it('doc-комментарий про блокировку не делает делегата доказанным', () => {
    const text = `
      /** Locks with .from(submissions) … .for('update') — says the comment. */
      export async function assertEditable(tx, submissionId) {
        return tx.select().from(submissions).where(eq(submissions.id, submissionId))
      }
    `
    expect(provenLockDelegatesIn(text)).toEqual(new Set())
  })

  it('не признаёт функцию, которой нет в LOCK_DELEGATES, как бы она ни лочила', () => {
    const text = `
      export async function someOtherHelper(tx, id) {
        return tx.select().from(submissions).where(eq(submissions.id, id)).for('update')
      }
    `
    expect(provenLockDelegatesIn(text)).toEqual(new Set())
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
