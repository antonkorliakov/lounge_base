import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  forbiddenImportsIn,
  importedSpecifiersIn,
  IMPORT_FORMS,
  type ImportForm,
} from './import-guard'

const ROOT = join(process.cwd(), 'src/form-schema')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' ? [] : sourceFiles(path)
    }
    return /\.tsx?$/.test(path) ? [path] : []
  })
}

describe('form-schema остаётся чистым', () => {
  it('не импортирует React и слой БД', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(ROOT)) {
      const text = readFileSync(file, 'utf8')
      for (const spec of forbiddenImportsIn(text, file)) {
        offenders.push(`${file}: ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('содержит хотя бы один модуль', () => {
    expect(sourceFiles(ROOT).length).toBeGreaterThan(0)
  })

  // Anti-vacuity, the property the other guards in this project grew after
  // three of them turned out to pass while proving nothing (see
  // `src/review/__tests__/lock-order-guard.ts`'s `tablesWrittenIn` and
  // `provenLockDelegatesIn`): "no offenders" must mean the detector LOOKED and
  // found nothing forbidden, not that it matched nothing at all. Without this,
  // a narrowed or broken `SPECIFIER_RE` extracts zero specifiers from the real
  // tree and the test above goes on reporting success.
  it('детектор реально находит импорты в живом дереве', () => {
    const specs = sourceFiles(ROOT).flatMap((file) =>
      importedSpecifiersIn(readFileSync(file, 'utf8')),
    )
    expect(specs.length).toBeGreaterThan(0)
  })
})

/**
 * One positive-match case per `IMPORT_FORMS` entry, keyed by the form so
 * `satisfies Record<ImportForm, string>` refuses to compile if a form is added
 * to the detector without a sample here. Every sample names the SAME forbidden
 * specifier, so each case asserts two things at once: the form is still
 * recognized as an import at all, and it still reaches the purity verdict.
 *
 * `bare` is the case that mattered: `import '@/db/client'` added to
 * `src/form-schema/blocks.ts` left all 87 form-schema tests green, because a
 * side-effect import has no bindings and no `from` for the old regex to anchor
 * on — while at runtime it executes the DB layer and pulls drizzle into every
 * bundle that touches the schema.
 */
const FORM_SAMPLES = {
  from: `import { db } from '@/db/client'\n`,
  bare: `import '@/db/client'\n`,
  require: `const { db } = require('@/db/client')\n`,
  dynamic: `async function f() {\n  await import('@/db/client')\n}\n`,
} satisfies Record<ImportForm, string>

describe('каждая распознаваемая форма импорта даёт срабатывание', () => {
  const FILE = join(process.cwd(), 'src/form-schema/example.ts')

  for (const form of IMPORT_FORMS) {
    it(`форма ${form}: специфаер извлечён и признан запрещённым`, () => {
      const text = FORM_SAMPLES[form]
      expect(importedSpecifiersIn(text)).toEqual([{ form, spec: '@/db/client' }])
      expect(forbiddenImportsIn(text, FILE)).toEqual(['@/db/client'])
    })
  }
})

// forbiddenImportsIn is the mechanism the test above relies on. It gets its
// own coverage here, driven directly with in-memory strings and synthetic
// paths, so a regression in the detector doesn't hide behind an
// (accidentally) clean src/form-schema tree.
describe('forbiddenImportsIn', () => {
  // Must sit inside src/form-schema for relative-path resolution against
  // src/db to line up with the real repo layout; the file itself never
  // needs to exist on disk.
  const FILE = join(process.cwd(), 'src/form-schema/example.ts')

  it('catches a relative import that resolves into src/db', () => {
    const text = `import { schema } from '../db/schema'\n`
    expect(forbiddenImportsIn(text, FILE)).toEqual(['../db/schema'])
  })

  it('catches require("react")', () => {
    const text = `const react = require('react')\n`
    expect(forbiddenImportsIn(text, FILE)).toEqual(['react'])
  })

  it('catches a dynamic import of a drizzle-orm subpath', () => {
    const text = `async function f() {\n  await import('drizzle-orm/pg-core')\n}\n`
    expect(forbiddenImportsIn(text, FILE)).toEqual(['drizzle-orm/pg-core'])
  })

  it('does not flag react-hook-form as a false positive', () => {
    const text = `import { useForm } from 'react-hook-form'\n`
    expect(forbiddenImportsIn(text, FILE)).toEqual([])
  })

  it('produces no offenders for a clean file', () => {
    const text = `export type Localized = { en: string; ru: string }\n`
    expect(forbiddenImportsIn(text, FILE)).toEqual([])
  })

  // The exact case that was break-verified against the real tree: a bare
  // side-effect import of the DB layer, which has no bindings and no `from`.
  it('catches a bare side-effect import of the DB layer', () => {
    const text = `import '@/db/client'\n\nexport const BLOCKS = []\n`
    expect(forbiddenImportsIn(text, FILE)).toEqual(['@/db/client'])
  })

  it('catches a bare side-effect import written relative into src/db', () => {
    const text = `import '../db/client'\n`
    expect(forbiddenImportsIn(text, FILE)).toEqual(['../db/client'])
  })

  it('does not flag a bare side-effect import of an allowed module', () => {
    const text = `import './register-blocks'\n`
    expect(forbiddenImportsIn(text, FILE)).toEqual([])
  })

  // `export … from` shares the `from` clause, so it was never a separate gap —
  // pinned so nobody has to re-derive that from the regex.
  it('catches a re-export from a forbidden specifier', () => {
    const text = `export { sql } from 'drizzle-orm'\n`
    expect(forbiddenImportsIn(text, FILE)).toEqual(['drizzle-orm'])
  })

  it('catches a specifier list spread over several lines', () => {
    const text = `import {\n  fieldValues,\n  submissions,\n} from '@/db/schema'\n`
    expect(forbiddenImportsIn(text, FILE)).toEqual(['@/db/schema'])
  })

  // No whitespace before `from` at all: valid, and it escaped the previous
  // whitespace-anchored regex.
  it('catches the compact import{a}from"x" form', () => {
    const text = `import{drizzle}from'drizzle-orm/pg-core'\n`
    expect(forbiddenImportsIn(text, FILE)).toEqual(['drizzle-orm/pg-core'])
  })

  // Current, deliberate behaviour, pinned so a change to it is a decision
  // rather than a side effect: a type-only import of the DB layer is reported
  // like any other. It costs nothing at runtime, but form-schema's boundary is
  // about what this layer may know — see `forbiddenImportsIn`'s doc comment.
  it('reports a type-only import of the DB layer', () => {
    const text = `import type { Db } from '@/db/types'\n`
    expect(forbiddenImportsIn(text, FILE)).toEqual(['@/db/types'])
  })

  it('does not flag a type-only import of an allowed module', () => {
    const text = `import type { ReadonlyDeep } from 'type-fest'\n`
    expect(forbiddenImportsIn(text, FILE)).toEqual([])
  })
})
