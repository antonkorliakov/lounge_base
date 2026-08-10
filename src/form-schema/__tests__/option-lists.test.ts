import { describe, it, expect } from 'vitest'
import { OPTION_LISTS } from '../option-lists'

describe('списки значений', () => {
  it('их ровно 17: 16 из исходника плюс зоны', () => {
    expect(Object.keys(OPTION_LISTS)).toHaveLength(17)
  })

  it('зоны заданы схемой, а не захардкожены в UI', () => {
    expect(OPTION_LISTS.zone.map((o) => o.id)).toEqual([
      'arrival', 'departure', 'transit',
    ])
  })

  it('в каждом списке минимум два варианта', () => {
    for (const [id, options] of Object.entries(OPTION_LISTS)) {
      expect(options.length, `список ${id}`).toBeGreaterThanOrEqual(2)
    }
  })

  it('идентификаторы вариантов уникальны внутри списка', () => {
    for (const [id, options] of Object.entries(OPTION_LISTS)) {
      const ids = options.map((o) => o.id)
      expect(new Set(ids).size, `список ${id}`).toBe(ids.length)
    }
  })

  it('у каждого варианта заполнены обе локали', () => {
    for (const options of Object.values(OPTION_LISTS)) {
      for (const option of options) {
        expect(option.label.en.trim()).not.toBe('')
        expect(option.label.ru.trim()).not.toBe('')
      }
    }
  })

  it('варианты со «Specify» требуют уточнения', () => {
    for (const options of Object.values(OPTION_LISTS)) {
      for (const option of options) {
        if (/specify/i.test(option.label.en)) {
          expect(option.requiresDetail, option.label.en).toBe(true)
        }
      }
    }
  })

  it('регистровые дубли схлопнуты в один список allowedNotAllowed', () => {
    const signatures = Object.values(OPTION_LISTS).map((options) =>
      options.map((o) => o.label.en.toLowerCase()).join('|'),
    )
    expect(new Set(signatures).size).toBe(signatures.length)
  })
})
