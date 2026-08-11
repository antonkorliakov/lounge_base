import { describe, it, expect } from 'vitest'
import { navState } from '../BlockNav'

describe('состояния блоков в навигации', () => {
  it('подтверждённый блок помечен зелёным', () => {
    const [item] = navState([{ blockKey: 'I', confirmed: true, openFlagCount: 0 }])
    expect(item?.mark).toBe('confirmed')
  })

  it('блок с замечанием помечен красным', () => {
    const [item] = navState([{ blockKey: 'I', confirmed: false, openFlagCount: 2 }])
    expect(item?.mark).toBe('flagged')
  })

  it('нетронутый блок не помечен', () => {
    const [item] = navState([{ blockKey: 'I', confirmed: false, openFlagCount: 0 }])
    expect(item?.mark).toBe('untouched')
  })

  it('замечание перевешивает подтверждение', () => {
    const [item] = navState([{ blockKey: 'I', confirmed: true, openFlagCount: 1 }])
    expect(item?.mark).toBe('flagged')
  })

  it('порядок блоков сохраняется', () => {
    const items = navState([
      { blockKey: 'I', confirmed: true, openFlagCount: 0 },
      { blockKey: 'II.1', confirmed: false, openFlagCount: 0 },
    ])
    expect(items.map((i) => i.blockKey)).toEqual(['I', 'II.1'])
  })
})
