import { describe, it, expect } from 'vitest'
import { FIELDS, PHOTO_SLOTS } from '@/form-schema'
import { renderValues } from '../renderValues'

const render = (
  fields: Record<string, unknown>,
  locale: 'en' | 'ru' = 'en',
): Record<string, { label: string; value?: string }> =>
  renderValues({ fields, services: {}, locale })

/**
 * Ключи берутся из живой схемы, а не вписываются строками: тест должен падать,
 * если поле перестало быть шаблонным или лишилось слотов, а не молча проверять
 * поле, которого больше нет.
 */
const templateKeys = FIELDS.filter((f) => f.type === 'template').map((f) => f.key)

describe('показ значений ревьюеру', () => {
  it('в анкете есть шаблонные поля — иначе проверять нечего', () => {
    expect(templateKeys.length).toBeGreaterThan(0)
  })

  it('шаблонное поле показано в единицах из схемы, а не ключами слотов', () => {
    const out = render({ 'III.2.1': { hours: 3 } })

    expect(out['III.2.1']?.value).toBe('3 hours')
    expect(out['III.2.1']?.value).not.toContain('hours:')
  })

  it('единицы локализованы вместе с остальным экраном', () => {
    const out = render({ 'III.2.1': { hours: 3 } }, 'ru')

    expect(out['III.2.1']?.value).toBe('3 часов')
  })

  it('незаполненный слот показан прочерком на своём месте, а не словом null', () => {
    const out = render({ 'III.3.3': { childFrom: 3, childTo: null, adultFrom: 13 } })

    expect(out['III.3.3']?.value).toBe('3 years old, — years old, 13 years and older')
    expect(out['III.3.3']?.value).not.toContain('null')
    expect(out['III.3.3']?.value).not.toContain('childFrom')
  })

  it('полностью незаполненное шаблонное поле — обычный прочерк', () => {
    const out = render({ 'III.3.3': { childFrom: null, childTo: null, adultFrom: null } })

    expect(out['III.3.3']?.value).toBe('—')
  })

  it('нечисло в слоте читается как «не отвечено», как и при записи', () => {
    // Тот же смысл, что у `asNumberOrNullRecord`: значение, попавшее в слот не
    // числом, — не содержательный ответ. Показ и запись обязаны совпадать в
    // том, что считается пропуском.
    const out = render({ 'III.2.1': { hours: 'три' } })

    expect(out['III.2.1']?.value).toBe('—')
  })

  it('слот составного select-поля тоже показан в единицах', () => {
    const out = render({
      'III.3.2': { option: 'allowed', detail: null, slots: { age: 10 } },
    })

    expect(out['III.3.2']?.value).toBe('allowed — 10 years old')
  })

  it('незаполненный слот составного select-поля не рисует прочерк', () => {
    // У `III.3.2` слот обязателен только при варианте `allowed`
    // (`TEMPLATE_REQUIRED_BY_OPTION`), поэтому при `not_allowed` пустой
    // возраст — правильный ответ, а не пропуск.
    const out = render({
      'III.3.2': { option: 'not_allowed', detail: null, slots: { age: null } },
    })

    expect(out['III.3.2']?.value).toBe('not_allowed')
  })

  it('у фото-слота есть подпись и нет текстового значения', () => {
    // Счётчик снимков ("3") здесь был мёртвым выводом: `FieldRow` игнорирует
    // `value`, когда получил URL-ы, а получает он их для этих ключей всегда.
    const out = render({})

    for (const slot of PHOTO_SLOTS) {
      expect(out[slot.key]?.label, slot.key).toBe(slot.label.en)
      expect(out[slot.key]?.value, slot.key).toBeUndefined()
    }
  })

  it('обычные поля не затронуты', () => {
    const out = render({ 'I.1': '2026-01-31', 'III.2.2': 3 })

    expect(out['I.1']?.value).toBe('2026-01-31')
    expect(out['III.2.2']?.value).toBe('3')
  })
})
