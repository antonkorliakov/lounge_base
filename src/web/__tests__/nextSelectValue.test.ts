import { describe, it, expect } from 'vitest'
import { nextSelectValue } from '../FieldInput'

describe('nextSelectValue', () => {
  it('changing the option preserves existing slots', () => {
    const current = { option: 'allowed', detail: null, slots: { age: 10 } }
    const next = nextSelectValue(current, { option: 'not_allowed' })
    expect(next).toEqual({ option: 'not_allowed', detail: null, slots: { age: 10 } })
  })

  it('changing the option preserves an existing detail', () => {
    const current = { option: 'other', detail: 'some clarifying text', slots: undefined }
    const next = nextSelectValue(current, { option: 'specific' })
    expect(next.detail).toBe('some clarifying text')
    expect(next.option).toBe('specific')
  })

  it('changing a slot preserves option and detail', () => {
    const current = { option: 'allowed', detail: 'unrelated note', slots: { age: 5 } }
    const next = nextSelectValue(current, { slots: { age: 12 } })
    expect(next).toEqual({ option: 'allowed', detail: 'unrelated note', slots: { age: 12 } })
  })

  it('changing detail preserves option and slots', () => {
    const current = { option: 'allowed', detail: null, slots: { age: 7 } }
    const next = nextSelectValue(current, { detail: 'clarification' })
    expect(next).toEqual({ option: 'allowed', detail: 'clarification', slots: { age: 7 } })
  })

  it('setting a slot to empty stores null, not 0 or empty string', () => {
    const current = { option: 'allowed', detail: null, slots: { age: 10 } }
    const next = nextSelectValue(current, { slots: { age: null } })
    expect(next.slots?.age).toBeNull()
    expect(next.slots?.age).not.toBe(0)
    expect(next.slots?.age).not.toBe('')
  })

  it('a patch that touches nothing leaves the value unchanged', () => {
    const current = { option: 'allowed', detail: 'x', slots: { age: 3 } }
    expect(nextSelectValue(current, {})).toEqual(current)
  })

  it('does not invent a slots object when neither side has one', () => {
    const current = { option: 'yes', detail: null }
    const next = nextSelectValue(current, { option: 'no' })
    expect(next.slots).toBeUndefined()
  })
})
