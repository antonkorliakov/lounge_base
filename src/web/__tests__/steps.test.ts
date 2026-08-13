import { describe, it, expect } from 'vitest'
import { buildSteps, stepTitle } from '../FormShell'
import { BLOCKS, blockOf } from '@/form-schema'
import { UI } from '@/i18n/dictionaries'

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

// Навигатор перечисляет все 19 шагов по именам из stepTitle — те же имена
// стоят в заголовке шелла. Пункт без имени или два пункта с одним именем
// делают список бесполезным, поэтому оба свойства закреплены здесь, на
// уровне данных, а не браузера.
describe('имена шагов (stepTitle)', () => {
  it('у каждого шага непустое имя в обеих локалях', () => {
    for (const step of buildSteps()) {
      const title = stepTitle(step)
      expect(title.en.trim(), step.key).not.toBe('')
      expect(title.ru.trim(), step.key).not.toBe('')
    }
  })

  it('имена шагов не повторяются (в обеих локалях)', () => {
    const titles = buildSteps().map(stepTitle)
    for (const locale of ['en', 'ru'] as const) {
      const names = titles.map((t) => t[locale])
      expect(new Set(names).size, locale).toBe(names.length)
    }
  })

  it('шаг с блоком схемы носит подпись самого блока, а не копию', () => {
    for (const step of buildSteps()) {
      if (!step.blockKey) continue
      // Тот же объект, не равный текст: имя существует в одном экземпляре.
      expect(stepTitle(step), step.key).toBe(blockOf(step.blockKey)!.label)
    }
  })

  it('проходы по услугам и итоговый шаг берут имена из словаря', () => {
    const steps = buildSteps()
    expect(stepTitle(steps.find((s) => s.kind === 'services1')!)).toBe(UI['services.pass1Title'])
    expect(stepTitle(steps.find((s) => s.kind === 'services2')!)).toBe(UI['services.pass2Title'])
    expect(stepTitle(steps.find((s) => s.kind === 'review')!)).toBe(UI['form.review'])
  })
})
