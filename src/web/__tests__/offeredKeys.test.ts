import { describe, it, expect } from 'vitest'
import { offeredKeys } from '../ServicesPass2'
import type { ServiceValueInput } from '@/form-schema'

const EMPTY: Omit<ServiceValueInput, 'available'> = {
  chargeType: null, price: null, currency: null,
  slotMinutes: null, bookingRequired: null, details: null,
}

const withAvailable = (available: string | null): ServiceValueInput => ({
  ...EMPTY,
  available,
})

describe('offeredKeys', () => {
  it('includes an item answered "yes"', () => {
    expect(offeredKeys({ a: withAvailable('yes') })).toEqual(['a'])
  })

  it('excludes an item answered "no"', () => {
    expect(offeredKeys({ a: withAvailable('no') })).toEqual([])
  })

  it('excludes an item answered "not_allowed"', () => {
    expect(offeredKeys({ a: withAvailable('not_allowed') })).toEqual([])
  })

  it('excludes an item never answered (null)', () => {
    expect(offeredKeys({ a: withAvailable(null) })).toEqual([])
  })

  it('excludes an item deliberately reverted to the placeholder ("")', () => {
    // This is exactly what ServicesPass1's <select> writes when the
    // operator picks the "—" option to undo an earlier answer.
    expect(offeredKeys({ a: withAvailable('') })).toEqual([])
  })

  it('includes a non-binary availability answer other than no/not_allowed', () => {
    expect(offeredKeys({ a: withAvailable('conditional') })).toEqual(['a'])
  })
})
