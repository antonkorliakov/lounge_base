import { describe, it, expect } from 'vitest'
import { BLOCKS, PHOTO_SLOTS, FIELDS, SERVICE_GROUPS } from '../index'

describe('блоки проверки', () => {
  it('их ровно 27', () => {
    expect(BLOCKS).toHaveLength(27)
  })

  it('ключи блоков уникальны', () => {
    const keys = BLOCKS.map((b) => b.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('каждое поле ссылается на существующий блок', () => {
    const keys = new Set(BLOCKS.map((b) => b.key))
    for (const field of FIELDS) {
      expect(keys.has(field.block), `${field.key} → ${field.block}`).toBe(true)
    }
  })

  it('каждая группа услуг ссылается на существующий блок', () => {
    const keys = new Set(BLOCKS.map((b) => b.key))
    for (const group of SERVICE_GROUPS) {
      expect(keys.has(group.block), `${group.key} → ${group.block}`).toBe(true)
    }
  })

  it('в каждом блоке есть содержимое', () => {
    for (const block of BLOCKS) {
      const fields = FIELDS.filter((f) => f.block === block.key).length
      const groups = SERVICE_GROUPS.filter((g) => g.block === block.key).length
      const isPhotos = block.key === 'photos'
      expect(fields + groups > 0 || isPhotos, block.key).toBe(true)
    }
  })

  it('состав блоков соответствует структуре формы', () => {
    const kinds = BLOCKS.map((b) => b.kind)
    expect(kinds.filter((k) => k === 'fields')).toHaveLength(15)
    expect(kinds.filter((k) => k === 'services')).toHaveLength(11)
    expect(kinds.filter((k) => k === 'photos')).toHaveLength(1)
  })
})

describe('слоты фотографий', () => {
  it('три именованных слота и свободные дополнительные', () => {
    const named = PHOTO_SLOTS.filter((s) => !s.extra)
    expect(named.map((s) => s.key)).toEqual([
      'entrance',
      'reception',
      'landmarks',
    ])
    expect(PHOTO_SLOTS.some((s) => s.extra)).toBe(true)
  })

  it('минимум четыре снимка обязательны суммарно', () => {
    const required = PHOTO_SLOTS.filter((s) => s.required).length
    expect(required).toBeGreaterThanOrEqual(3)
  })
})
