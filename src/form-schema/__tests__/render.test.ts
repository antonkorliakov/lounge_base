import { describe, it, expect } from 'vitest'
import { FIELDS, fieldByKey, formatFieldValue, type Field } from '..'

const field = (key: string): Field => {
  const found = fieldByKey(key)
  if (!found) throw new Error(`нет поля ${key} — тест проверяет несуществующее`)
  return found
}

const en = { locale: 'en' as const }

describe('formatFieldValue: общее для обоих потребителей', () => {
  it('пустое значение — null, а не строка-заглушка', () => {
    // Прочерк ('—' на экране проверки) и пустая ячейка (null в выгрузке) —
    // решения потребителей; сам форматтер отвечает лишь «ответа нет».
    for (const raw of [null, undefined, '']) {
      expect(formatFieldValue(field('I.2'), raw, { ...en, template: 'slots' })).toBeNull()
      expect(formatFieldValue(field('I.2'), raw, { ...en, template: 'phrase' })).toBeNull()
    }
  })

  it('мультивыбор склеивается через запятую', () => {
    expect(
      formatFieldValue(field('III.6.6'), ['departure', 'transit'], { ...en, template: 'phrase' }),
    ).toBe('departure, transit')
  })

  it('выбор с уточнением показывает оба значения', () => {
    expect(
      formatFieldValue(
        field('III.2.4'),
        { option: 'specific', detail: 'Turkish Airlines' },
        { ...en, template: 'phrase' },
      ),
    ).toBe('specific — Turkish Airlines')
  })

  it('составное select-поле несёт слоты в обоих режимах', () => {
    // III.3.2 — тот самый возраст, который два черновика подряд теряли
    // (см. renderValues.ts и образец Task 4): `slots.age` — содержательный
    // ответ, и режим шаблона на select-поле не влияет.
    const raw = { option: 'allowed', detail: null, slots: { age: 10 } }
    expect(formatFieldValue(field('III.3.2'), raw, { ...en, template: 'slots' })).toBe(
      'allowed — 10 years old',
    )
    expect(formatFieldValue(field('III.3.2'), raw, { ...en, template: 'phrase' })).toBe(
      'allowed — 10 years old',
    )
  })
})

describe('formatFieldValue: режим phrase', () => {
  it('заполненный шаблон разворачивается в исходную фразу', () => {
    expect(formatFieldValue(field('III.2.1'), { hours: 3 }, { ...en, template: 'phrase' })).toBe(
      'Access is permitted 3 hours prior to scheduled flight departure.',
    )
  })

  it('пропуск в НАЧАЛЕ не съедает место следующего слота', () => {
    // Образец плана заполнял фразу последовательным `replace(/\(\s*\)/, ...)`,
    // ставя '( )' на пропуск. '( )' сам подходит под /\(\s*\)/ — и значение
    // СЛЕДУЮЩЕГО слота вставало в пропуск предыдущего: «children from 12
    // to (  )» вместо «children from ( ) to 12». Этот тест ломается на той
    // реализации (break-verified) и держит правильную раскладку по местам.
    expect(
      formatFieldValue(
        field('III.3.3'),
        { childFrom: null, childTo: 12, adultFrom: 13 },
        { ...en, template: 'phrase' },
      ),
    ).toBe('Child rate: children from — to 12 years old \nAdult rate: children 13 years and older')
  })

  it('полностью незаполненный шаблон — null, а не фраза из пропусков', () => {
    expect(
      formatFieldValue(field('III.2.1'), { hours: null }, { ...en, template: 'phrase' }),
    ).toBeNull()
  })

  it('фраза локализована', () => {
    expect(
      formatFieldValue(field('III.2.1'), { hours: 3 }, { locale: 'ru', template: 'phrase' }),
    ).toBe('Доступ разрешён за 3 часов до вылета по расписанию.')
  })
})

describe('formatFieldValue: режим slots (поведение экрана проверки)', () => {
  it('слоты в единицах схемы, пропуск — прочерком на своём месте', () => {
    expect(
      formatFieldValue(
        field('III.3.3'),
        { childFrom: 3, childTo: null, adultFrom: 13 },
        { ...en, template: 'slots' },
      ),
    ).toBe('3 years old, — years old, 13 years and older')
  })
})

describe('шаблонные фразы схемы пригодны для заполнения', () => {
  // Раскладка значений по фразе держится на том, что пропусков во фразе
  // ровно столько же, сколько слотов, — на обоих языках. Это свойство ДАННЫХ
  // схемы, и его проверка живёт рядом с механизмом, который на него опирается.
  const templated = FIELDS.filter((f) => f.templateText !== null)

  it('в схеме есть поля с шаблонной фразой — иначе проверять нечего', () => {
    expect(templated.length).toBeGreaterThan(0)
  })

  for (const f of templated) {
    it(`${f.key}: пропусков во фразе ровно столько же, сколько слотов`, () => {
      for (const locale of ['en', 'ru'] as const) {
        const gaps = f.templateText![locale].split(/\(\s*\)/).length - 1
        expect(gaps, locale).toBe(f.templateSlots.length)
      }
    })
  }
})
