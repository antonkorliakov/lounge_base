import { describe, it, expect } from 'vitest'
import {
  BLOCKS, PHOTO_SLOTS, FIELDS, SERVICE_GROUPS, SERVICE_ITEMS, keysOfBlock, blockKeyOf,
} from '../index'

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

/**
 * `keysOfBlock` (block → keys) and `blockKeyOf` (key → block) are built from
 * one shared construction (see `register` in `../blocks.ts`) specifically so
 * they cannot drift apart the way two independently-maintained scans over
 * the same data could. These tests pin that agreement directly, in both
 * directions and over every key/block that exists — not just the two
 * example blocks the review module's own tests happen to touch — so a
 * future edit that reintroduces a second, separate implementation of either
 * direction (or that changes one without the other) fails here first.
 */
describe('keysOfBlock и blockKeyOf — согласованное отображение', () => {
  it('каждый ключ, который keysOfBlock отдаёт блоку, blockKeyOf отображает обратно на тот же блок', () => {
    for (const block of BLOCKS) {
      for (const key of keysOfBlock(block.key)) {
        expect(blockKeyOf(key), `${block.key} → ${key}`).toBe(block.key)
      }
    }
  })

  it('каждый ключ поля, позиции услуг и слота фото отображается на блок, который его содержит', () => {
    const leafKeys = [
      ...FIELDS.map((f) => f.key),
      ...SERVICE_ITEMS.map((i) => i.key),
      ...PHOTO_SLOTS.map((s) => s.key),
    ]
    for (const key of leafKeys) {
      const blockKey = blockKeyOf(key)
      expect(blockKey, key).not.toBeNull()
      expect(keysOfBlock(blockKey!), `${key} → ${blockKey}`).toContain(key)
    }
  })

  it('суммарно keysOfBlock по всем блокам покрывает ровно универсум ключей — без пропусков и без лишних', () => {
    const expected = new Set([
      ...FIELDS.map((f) => f.key),
      ...SERVICE_ITEMS.map((i) => i.key),
      ...PHOTO_SLOTS.map((s) => s.key),
    ])
    const actual = new Set(BLOCKS.flatMap((b) => keysOfBlock(b.key)))
    expect(actual).toEqual(expected)
  })

  it('незнакомый ключ не отображается ни на один блок, незнакомый блок не отдаёт ключей', () => {
    expect(blockKeyOf('IX.99')).toBeNull()
    expect(keysOfBlock('IX.99')).toEqual([])
  })
})
