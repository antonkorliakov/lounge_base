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

// `offeredKeys` now delegates to `isOfferedAvailability` (see
// `src/form-schema/services.ts`), which looks the answer up against the
// ITEM's own `availabilityList` rather than matching the bare string
// against a hardcoded closing-id list — see R1/R2 in the whole-branch
// review's second round: the old bare-string check here and the one in
// `validation.ts` agreed only by accident, the same shape of bug as
// Critical 1. That means a real key is now load-bearing: '2.1' (Wifi
// Access) is a real `yesNo` item, and '8.3' (Vaping policy) is the one
// real item with its own list — a synthetic key with no matching
// `ServiceItem` (the old 'a') is no longer a faithful stand-in, since every
// real key in `values` always names a real `SERVICE_ITEMS` entry.
describe('offeredKeys', () => {
  it('includes an item answered "yes"', () => {
    expect(offeredKeys({ '2.1': withAvailable('yes') })).toEqual(['2.1'])
  })

  it('excludes an item answered "no"', () => {
    expect(offeredKeys({ '2.1': withAvailable('no') })).toEqual([])
  })

  it('excludes an item answered "not_allowed"', () => {
    expect(offeredKeys({ '8.3': withAvailable('not_allowed') })).toEqual([])
  })

  it('excludes an item never answered (null)', () => {
    expect(offeredKeys({ '2.1': withAvailable(null) })).toEqual([])
  })

  it('excludes an item deliberately reverted to the placeholder ("")', () => {
    // This is exactly what ServicesPass1's <select> writes when the
    // operator picks the "—" option to undo an earlier answer.
    expect(offeredKeys({ '2.1': withAvailable('') })).toEqual([])
  })

  it('includes a non-binary availability answer other than no/not_allowed', () => {
    expect(offeredKeys({ '8.3': withAvailable('throughout') })).toEqual(['8.3'])
  })

  it('excludes a key with no matching ServiceItem, rather than throwing', () => {
    expect(() => offeredKeys({ 'unknown.key': withAvailable('yes') })).not.toThrow()
    expect(offeredKeys({ 'unknown.key': withAvailable('yes') })).toEqual([])
  })
})
