import { describe, it, expect } from 'vitest'
import { buildSteps, stepTitle, MERGED_FIELD_GROUPS } from '../FormShell'
import { BLOCKS, blockOf } from '@/form-schema'
import { UI } from '@/i18n/dictionaries'

describe('шаги формы', () => {
  it('начинается с шагов полей, и вместе они несут все fields-блоки в порядке формы', () => {
    const steps = buildSteps()
    const fieldBlocks = BLOCKS.filter((b) => b.kind === 'fields').map((b) => b.key)
    const fieldSteps = steps.filter((s) => s.kind === 'fields')
    expect(steps.slice(0, fieldSteps.length)).toEqual(fieldSteps)
    expect(fieldSteps.flatMap((s) => s.blockKeys)).toEqual(fieldBlocks)
  })

  /**
   * Разбиение fields-блоков по шагам — закреплено буквально, как и сам
   * список MERGED_FIELD_GROUPS: слияние — презентация, единица проверки
   * остаётся блоком (block_reviews в продовой БД, поблочные подтверждения и
   * замечания), и этот тест — то место, которое НОВЫЙ fields-блок обязан
   * сломать громко. Вместе с проверкой полноты выше он не оставляет блоку
   * пути проскочить тихо: появиться 28-м блоком и не попасть сюда нельзя
   * (полнота выше сойдётся, а это равенство — нет), выпасть из группы — тоже
   * (не сойдутся оба). Автор нового блока решает его дом здесь сам, а не
   * получает молча лишний экран.
   */
  it('разбиение блоков по шагам — ровно задуманное: I / контакты / график / доступ / место', () => {
    const fieldSteps = buildSteps().filter((s) => s.kind === 'fields')
    expect(fieldSteps.map((s) => s.blockKeys)).toEqual([
      ['I'],
      ['II.1', 'II.2', 'II.3', 'II.4'],
      ['III.1'],
      ['III.2', 'III.3', 'III.4'],
      ['III.5', 'III.6', 'III.7', 'III.8', 'IV', 'V'],
    ])
  })

  it('каждый ключ в MERGED_FIELD_GROUPS — существующий fields-блок, и ни один не назван дважды', () => {
    const seen = new Set<string>()
    for (const group of MERGED_FIELD_GROUPS) {
      for (const key of group.blocks) {
        expect(blockOf(key)?.kind, `${group.key} → ${key}`).toBe('fields')
        expect(seen.has(key), `${key} назван дважды`).toBe(false)
        seen.add(key)
      }
    }
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

// Навигатор перечисляет все 9 шагов по именам из stepTitle — те же имена
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

  it('шаг с ОДНИМ блоком схемы носит подпись самого блока, а не копию', () => {
    for (const step of buildSteps()) {
      if (step.blockKeys.length !== 1) continue
      // Тот же объект, не равный текст: имя существует в одном экземпляре.
      expect(stepTitle(step), step.key).toBe(blockOf(step.blockKeys[0]!)!.label)
    }
  })

  it('слитый шаг носит своё имя из словаря — тот же объект, что в MERGED_FIELD_GROUPS', () => {
    const steps = buildSteps()
    const titleOf = (key: string) => stepTitle(steps.find((s) => s.key === key)!)
    expect(titleOf('fields:contacts')).toBe(UI['form.stepContacts'])
    expect(titleOf('fields:access')).toBe(UI['form.stepAccess'])
    expect(titleOf('fields:location')).toBe(UI['form.stepLocation'])
  })

  it('проходы по услугам и итоговый шаг берут имена из словаря', () => {
    const steps = buildSteps()
    expect(stepTitle(steps.find((s) => s.kind === 'services1')!)).toBe(UI['services.pass1Title'])
    expect(stepTitle(steps.find((s) => s.kind === 'services2')!)).toBe(UI['services.pass2Title'])
    expect(stepTitle(steps.find((s) => s.kind === 'review')!)).toBe(UI['form.review'])
  })
})
