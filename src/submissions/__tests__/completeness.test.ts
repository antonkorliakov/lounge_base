import { describe, it, expect } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions, photos } from '@/db/schema'
import { FIELDS, SERVICE_ITEMS, PHOTO_SLOTS, MIN_PHOTOS } from '@/form-schema'
import { saveFieldValue, saveServiceValue } from '../values'
import { missingItems } from '../completeness'

async function seedDraft(db: Db): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  const [submission] = await db
    .insert(submissions).values({ loungeId: lounge!.id }).returning()
  return submission!.id
}

describe('полнота анкеты', () => {
  it('в пустой анкете не хватает всех обязательных полей', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const missing = await missingItems(db, submissionId)

    const requiredCount = FIELDS.filter((f) => f.required).length
    expect(missing.fieldKeys).toHaveLength(requiredCount)
    expect(missing.serviceKeys).toHaveLength(SERVICE_ITEMS.length)
    expect(missing.photoSlots.length).toBeGreaterThan(0)
  })

  it('заполненное поле уходит из списка недостающих', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    await saveFieldValue(db, { submissionId, fieldKey: 'I.2', value: 'Primeclass Lounge' })
    const missing = await missingItems(db, submissionId)

    expect(missing.fieldKeys).not.toContain('I.2')
  })

  it('позиция услуг считается заполненной даже при ответе «нет»', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    await saveServiceValue(db, {
      submissionId,
      itemKey: '1.2',
      value: {
        available: 'no', chargeType: null, price: null, currency: null,
        slotMinutes: null, bookingRequired: null, details: null,
      },
    })

    const missing = await missingItems(db, submissionId)
    expect(missing.serviceKeys).not.toContain('1.2')
  })

  // R1, whole-branch review second round: `validateServiceValue` no longer
  // requires a chargeType on save (that's what let Pass 1's own answer —
  // available only, no chargeType — save at all). This is the test that
  // proves the requirement didn't just vanish: it moved here, to
  // completeness, which is what actually gates submission now.
  it('предложенная позиция без chargeType остаётся недостающей — R1', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    await saveServiceValue(db, {
      submissionId,
      itemKey: '2.1', // Wifi Access
      value: {
        available: 'yes', chargeType: null, price: null, currency: null,
        slotMinutes: null, bookingRequired: null, details: null,
      },
    })

    const missing = await missingItems(db, submissionId)
    expect(missing.serviceKeys).toContain('2.1')
  })

  it('не предложенная позиция (available «нет») не требует chargeType для полноты', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    await saveServiceValue(db, {
      submissionId,
      itemKey: '2.1',
      value: {
        available: 'no', chargeType: null, price: null, currency: null,
        slotMinutes: null, bookingRequired: null, details: null,
      },
    })

    const missing = await missingItems(db, submissionId)
    expect(missing.serviceKeys).not.toContain('2.1')
  })

  it('добавление chargeType к уже предложенной позиции убирает её из недостающих', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    await saveServiceValue(db, {
      submissionId,
      itemKey: '2.1',
      value: {
        available: 'yes', chargeType: null, price: null, currency: null,
        slotMinutes: null, bookingRequired: null, details: null,
      },
    })
    expect((await missingItems(db, submissionId)).serviceKeys).toContain('2.1')

    await saveServiceValue(db, {
      submissionId,
      itemKey: '2.1',
      value: {
        available: 'yes', chargeType: 'complimentary', price: null, currency: null,
        slotMinutes: null, bookingRequired: null, details: null,
      },
    })
    expect((await missingItems(db, submissionId)).serviceKeys).not.toContain('2.1')
  })

  /**
   * Профили (`PROFILE_ATTRIBUTES` / `requiredAttributesFor`): что нужно
   * предложенной позиции для полноты, решает её профиль. `none` закрывается
   * первым проходом; `detail` с подсказкой требует details; `full` с
   * подсказкой — chargeType И details; `full` без подсказки — только
   * chargeType. Каждый случай — через настоящую запись и настоящий
   * `missingItems`, а не через предикат напрямую (тот пришпилен в
   * `services.test.ts`): здесь проверяется, что полнота его действительно
   * читает.
   */
  it('none (1.1): предложена без chargeType — и всё равно заполнена', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    await saveServiceValue(db, {
      submissionId,
      itemKey: '1.1',
      value: {
        available: 'yes', chargeType: null, price: null, currency: null,
        slotMinutes: null, bookingRequired: null, details: null,
      },
    })

    expect((await missingItems(db, submissionId)).serviceKeys).not.toContain('1.1')
  })

  it('detail с подсказкой (fb.3.4): предложена без details — недостаёт; с details — заполнена', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)
    const base = {
      available: 'yes', chargeType: null, price: null, currency: null,
      slotMinutes: null, bookingRequired: null,
    }

    await saveServiceValue(db, { submissionId, itemKey: 'fb.3.4', value: { ...base, details: null } })
    expect((await missingItems(db, submissionId)).serviceKeys).toContain('fb.3.4')

    await saveServiceValue(db, { submissionId, itemKey: 'fb.3.4', value: { ...base, details: '10:00–22:00' } })
    expect((await missingItems(db, submissionId)).serviceKeys).not.toContain('fb.3.4')
  })

  it('full с подсказкой (2.3): chargeType без details — недостаёт; full без подсказки (5.4) — заполнена', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)
    const free = {
      available: 'yes', chargeType: 'complimentary', price: null, currency: null,
      slotMinutes: null, bookingRequired: null, details: null,
    }

    await saveServiceValue(db, { submissionId, itemKey: '2.3', value: free })
    await saveServiceValue(db, { submissionId, itemKey: '5.4', value: free })
    const missing = (await missingItems(db, submissionId)).serviceKeys
    expect(missing).toContain('2.3')
    expect(missing).not.toContain('5.4')

    await saveServiceValue(db, { submissionId, itemKey: '2.3', value: { ...free, details: '12 seats' } })
    expect((await missingItems(db, submissionId)).serviceKeys).not.toContain('2.3')
  })

  it('необязательные поля не попадают в список недостающих', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const missing = await missingItems(db, submissionId)
    const optional = FIELDS.filter((f) => !f.required).map((f) => f.key)

    for (const key of optional) {
      expect(missing.fieldKeys).not.toContain(key)
    }
  })

  it('заполненных обязательных слотов недостаточно, если снимков меньше MIN_PHOTOS', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const requiredSlots = PHOTO_SLOTS.filter((s) => s.required)
    expect(requiredSlots.length).toBeLessThan(MIN_PHOTOS)

    for (const slot of requiredSlots) {
      await db.insert(photos).values({
        submissionId, slot: slot.key,
        blobKey: `${slot.key}.jpg`, url: `https://example.test/${slot.key}.jpg`,
      })
    }

    const missing = await missingItems(db, submissionId)
    const extraSlot = PHOTO_SLOTS.find((s) => s.extra)

    // Все обязательные именованные слоты заполнены, но общее число снимков
    // (3) всё ещё меньше MIN_PHOTOS (4) — недостающим считается слот,
    // принимающий дополнительные фото.
    expect(missing.photoSlots).toEqual([extraSlot!.key])
  })

  it('фото закрывает недостачу, когда общее число снимков достигает MIN_PHOTOS', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const requiredSlots = PHOTO_SLOTS.filter((s) => s.required)
    const extraSlot = PHOTO_SLOTS.find((s) => s.extra)!

    for (const slot of requiredSlots) {
      await db.insert(photos).values({
        submissionId, slot: slot.key,
        blobKey: `${slot.key}.jpg`, url: `https://example.test/${slot.key}.jpg`,
      })
    }
    for (let i = requiredSlots.length; i < MIN_PHOTOS; i++) {
      await db.insert(photos).values({
        submissionId, slot: extraSlot.key,
        blobKey: `${extraSlot.key}-${i}.jpg`, url: `https://example.test/${extraSlot.key}-${i}.jpg`,
      })
    }

    const missing = await missingItems(db, submissionId)
    expect(missing.photoSlots).toHaveLength(0)
  })
})
