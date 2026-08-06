import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(process.cwd(), 'src/form-schema')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' ? [] : sourceFiles(path)
    }
    return path.endsWith('.ts') ? [path] : []
  })
}

describe('form-schema остаётся чистым', () => {
  it('не импортирует React и слой БД', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(ROOT)) {
      const text = readFileSync(file, 'utf8')
      if (/from ['"](react|@\/db|drizzle-orm)/.test(text)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('содержит хотя бы один модуль', () => {
    expect(sourceFiles(ROOT).length).toBeGreaterThan(0)
  })
})
