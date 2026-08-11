import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { forbiddenImportsIn } from './import-guard'

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
})
