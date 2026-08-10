import { describe, it, expect } from 'vitest'
import { buildSteps } from '../FormShell'
import { BLOCKS } from '@/form-schema'

describe('шаги формы', () => {
  it('начинается с блоков плоской части в порядке формы', () => {
    const steps = buildSteps()
    const fieldBlocks = BLOCKS.filter((b) => b.kind === 'fields').map((b) => b.key)
    expect(steps.slice(0, fieldBlocks.length).map((s) => s.blockKey)).toEqual(fieldBlocks)
  })

  it('услуги идут двумя проходами, отбор раньше деталей', () => {
    const steps = buildSteps()
    const pass1 = steps.findIndex((s) => s.kind === 'services1')
    const pass2 = steps.findIndex((s) => s.kind === 'services2')
    expect(pass1).toBeGreaterThan(-1)
    expect(pass2).toBeGreaterThan(pass1)
  })

  it('отбор — один шаг на все 58 позиций', () => {
    const steps = buildSteps()
    expect(steps.filter((s) => s.kind === 'services1')).toHaveLength(1)
  })

  it('фото и итоговый экран идут последними', () => {
    const steps = buildSteps()
    expect(steps.at(-2)?.kind).toBe('photos')
    expect(steps.at(-1)?.kind).toBe('review')
  })

  it('ключи шагов уникальны', () => {
    const keys = buildSteps().map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
