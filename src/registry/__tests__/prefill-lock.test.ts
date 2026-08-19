import { describe, it, expect } from 'vitest'
import { fieldByKey } from '@/form-schema'
import { IDENTITY_PREFILL, lockedIdentityKeys, type IdentityColumns } from '../manage'

/**
 * Правило замка предзаполненных полей блока I (`lockedIdentityKeys`) — чистая
 * функция, и её краевые случаи — это ровно те три популяции лаунжей, которые
 * есть в живой базе:
 *  1. заведённые «Add lounge» ПОСЛЕ этой фичи — предзаполнены, ответы
 *     совпадают с колонками, замки стоят;
 *  2. заведённые ДО неё (UI или прежний ops) — колонки непусты, но ответов
 *     нет (или их набрал оператор) — замков НЕТ, иначе пустое обязательное
 *     поле было бы незаполнимым и анкета неотправляемой;
 *  3. прежний ops с пустой страной/городом/аэропортом — пустая колонка,
 *     поле редактируемо, что бы ни лежало в ответе.
 */

const LOUNGE: IdentityColumns = {
  name: 'Aurora Lounge',
  provider: 'dnata',
  country: 'Turkey',
  city: 'Istanbul',
  airport: 'Istanbul Airport',
  iataCode: 'IST',
}

/** Ответы, дословно совпадающие с колонками, — то, что пишет предзаполнение. */
const PREFILLED = {
  'I.2': 'Aurora Lounge',
  'I.3': 'dnata',
  'I.7': 'Turkey',
  'I.8': 'Istanbul',
  'I.9': 'Istanbul Airport',
  'I.10': 'IST',
}

describe('lockedIdentityKeys', () => {
  it('соответствие колонка↔поле указывает на настоящие текстовые поля схемы', () => {
    // Анти-вакуум: замок рендерится как readonly-текст (`FieldInput`'s
    // `locked`), что честно только для текстовых полей. Если у соответствия
    // появится ключ другого типа (или опечатка ключа), падать должно здесь,
    // а не молча в браузере.
    for (const entry of IDENTITY_PREFILL) {
      const field = fieldByKey(entry.fieldKey)
      expect(field, entry.fieldKey).toBeDefined()
      expect(field!.type, entry.fieldKey).toBe('text')
    }
  })

  it('свежезаведённый лаунж: замкнуты все предзаполненные, КРОМЕ названия', () => {
    expect(lockedIdentityKeys(LOUNGE, PREFILLED).sort()).toEqual(
      ['I.10', 'I.3', 'I.7', 'I.8', 'I.9'].sort(),
    )
  })

  it('название (I.2) не замыкается никогда — решение пользователя', () => {
    const nameEntry = IDENTITY_PREFILL.find((entry) => entry.fieldKey === 'I.2')
    expect(nameEntry?.lockable).toBe(false)
    expect(lockedIdentityKeys(LOUNGE, PREFILLED)).not.toContain('I.2')
  })

  it('старый лаунж без ответов: колонки непусты, но замков нет', () => {
    expect(lockedIdentityKeys(LOUNGE, {})).toEqual([])
  })

  it('ops-лаунж с пустым паспортом: пустая колонка — редактируемое поле', () => {
    const bare: IdentityColumns = {
      ...LOUNGE,
      provider: null,
      country: '',
      city: ' ',
      airport: '',
    }
    expect(lockedIdentityKeys(bare, PREFILLED)).toEqual(['I.10'])
  })

  it('исправленный на экране правок ответ растворяет замок этого поля', () => {
    // Ревьюер отметил I.10, оператор исправил на SAW — ответ разошёлся с
    // колонкой, и основной проход обязан отдать поле в правку тоже: замок
    // с подписью «заполнено вашей командой» на чужом значении был бы ложью.
    const fixed = { ...PREFILLED, 'I.10': 'SAW' }
    const locked = lockedIdentityKeys(LOUNGE, fixed)
    expect(locked).not.toContain('I.10')
    expect(locked.sort()).toEqual(['I.3', 'I.7', 'I.8', 'I.9'].sort())
  })

  it('совпадение сравнивается после trim, но НЕ без учёта регистра', () => {
    expect(lockedIdentityKeys(LOUNGE, { ...PREFILLED, 'I.10': '  IST  ' })).toContain('I.10')
    // `ist` ≠ `IST`: рукописный ответ старого лаунжа, совпавший с колонкой
    // только по буквам, — это ЕГО ответ, не предзаполнение.
    expect(lockedIdentityKeys(LOUNGE, { ...PREFILLED, 'I.10': 'ist' })).not.toContain('I.10')
  })

  it('нестроковый ответ (чужой тип в jsonb) не замыкает поле', () => {
    expect(lockedIdentityKeys(LOUNGE, { ...PREFILLED, 'I.7': 42 })).not.toContain('I.7')
  })
})
