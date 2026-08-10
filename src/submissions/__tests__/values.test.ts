import { describe, it, expect, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions, fieldValues } from '@/db/schema'
import { saveFieldValue, saveServiceValue, loadSubmissionValues } from '../values'

async function seedDraft(db: Db): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  const [submission] = await db
    .insert(submissions).values({ loungeId: lounge!.id }).returning()
  return submission!.id
}

describe('сохранение значений', () => {
  it('пишет значение поля', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await saveFieldValue(db, {
      submissionId, fieldKey: 'I.2', value: 'Primeclass Lounge',
    })

    expect(result.ok).toBe(true)
    const loaded = await loadSubmissionValues(db, submissionId)
    expect(loaded.fields['I.2']).toBe('Primeclass Lounge')
  })

  it('перезапись поля не создаёт вторую строку', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    await saveFieldValue(db, { submissionId, fieldKey: 'I.2', value: 'Первое' })
    await saveFieldValue(db, { submissionId, fieldKey: 'I.2', value: 'Второе' })

    const rows = await db
      .select().from(fieldValues).where(eq(fieldValues.submissionId, submissionId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.value).toBe('Второе')
  })

  it('отклоняет неизвестный ключ поля', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await saveFieldValue(db, {
      submissionId, fieldKey: 'IX.99', value: 'что-то',
    })
    expect(result.ok).toBe(false)
  })

  it('отклоняет значение, не прошедшее валидацию схемы', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await saveFieldValue(db, {
      submissionId, fieldKey: 'III.5.2', value: { option: 'basement', detail: null },
    })

    expect(result.ok).toBe(false)
    const loaded = await loadSubmissionValues(db, submissionId)
    expect(loaded.fields['III.5.2']).toBeUndefined()
  })

  it('пишет позицию услуги со всеми атрибутами', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await saveServiceValue(db, {
      submissionId,
      itemKey: '7.2',
      value: {
        available: 'yes', chargeType: 'chargeable', price: 15,
        currency: 'EUR', slotMinutes: 30, bookingRequired: true, details: null,
      },
    })

    expect(result.ok).toBe(true)
    const loaded = await loadSubmissionValues(db, submissionId)
    expect(loaded.services['7.2']?.price).toBe(15)
    expect(loaded.services['7.2']?.currency).toBe('EUR')
  })

  it('пишет предложенную позицию без chargeType — неполный, но валидный ответ (R1)', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await saveServiceValue(db, {
      submissionId,
      itemKey: '2.1',
      value: {
        available: 'yes', chargeType: null, price: null,
        currency: null, slotMinutes: null, bookingRequired: null, details: null,
      },
    })

    expect(result.ok).toBe(true)
    const loaded = await loadSubmissionValues(db, submissionId)
    expect(loaded.services['2.1']?.available).toBe('yes')
    expect(loaded.services['2.1']?.chargeType).toBeNull()
  })

  // R2, whole-branch review second round: `''` (deliberate un-selection,
  // written by `ServicesPass1` when the operator returns a dropdown item to
  // its placeholder) must not persist as the literal empty string — it has
  // to normalise to `null`, the value `missingItems`'s availability check
  // actually recognises as unanswered.
  it('нормализует available: "" в null при записи', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await saveServiceValue(db, {
      submissionId,
      itemKey: '2.1',
      value: {
        available: '', chargeType: null, price: null,
        currency: null, slotMinutes: null, bookingRequired: null, details: null,
      },
    })

    expect(result.ok).toBe(true)
    const loaded = await loadSubmissionValues(db, submissionId)
    expect(loaded.services['2.1']?.available).toBeNull()
  })

  // R2: once an item stops being offered (cleared, or reverted to "no"),
  // its old chargeType/price/currency/slotMinutes/bookingRequired must not
  // survive in the row — otherwise a not-offered item still carries a price
  // that plan 3's export would read as if it still applied.
  it('снятие ранее платной позиции обратно до «—» стирает цену/валюту/прочие атрибуты', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    await saveServiceValue(db, {
      submissionId,
      itemKey: '7.2',
      value: {
        available: 'yes', chargeType: 'chargeable', price: 15,
        currency: 'EUR', slotMinutes: 30, bookingRequired: true, details: 'note',
      },
    })
    expect((await loadSubmissionValues(db, submissionId)).services['7.2']?.price).toBe(15)

    const result = await saveServiceValue(db, {
      submissionId,
      itemKey: '7.2',
      // The operator reverts the dropdown to its placeholder — the client
      // still sends the stale attributes alongside `available: ''` (nothing
      // clears them locally until Pass 2 re-renders), exactly like a real
      // `ServicesPass1` round trip.
      value: {
        available: '', chargeType: 'chargeable', price: 15,
        currency: 'EUR', slotMinutes: 30, bookingRequired: true, details: 'note',
      },
    })

    expect(result.ok).toBe(true)
    const loaded = await loadSubmissionValues(db, submissionId)
    expect(loaded.services['7.2']?.available).toBeNull()
    expect(loaded.services['7.2']?.chargeType).toBeNull()
    expect(loaded.services['7.2']?.price).toBeNull()
    expect(loaded.services['7.2']?.currency).toBeNull()
    expect(loaded.services['7.2']?.slotMinutes).toBeNull()
    expect(loaded.services['7.2']?.bookingRequired).toBeNull()
  })

  it('отклоняет платную услугу без цены', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await saveServiceValue(db, {
      submissionId,
      itemKey: '7.2',
      value: {
        available: 'yes', chargeType: 'chargeable', price: null,
        currency: null, slotMinutes: null, bookingRequired: null, details: null,
      },
    })
    expect(result.ok).toBe(false)
  })

  it('не даёт править отправленную анкету', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)
    await db
      .update(submissions).set({ status: 'submitted' })
      .where(eq(submissions.id, submissionId))

    const result = await saveFieldValue(db, {
      submissionId, fieldKey: 'I.2', value: 'Поздно',
    })
    expect(result.ok).toBe(false)
  })

  it('не даёт править одобренную анкету', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)
    await db
      .update(submissions).set({ status: 'approved' })
      .where(eq(submissions.id, submissionId))

    const result = await saveFieldValue(db, {
      submissionId, fieldKey: 'I.2', value: 'Поздно',
    })
    expect(result.ok).toBe(false)
  })

  it('позволяет править анкету, отправленную на исправление', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)
    await db
      .update(submissions).set({ status: 'changes_requested' })
      .where(eq(submissions.id, submissionId))

    const result = await saveFieldValue(db, {
      submissionId, fieldKey: 'I.2', value: 'Исправлено',
    })
    expect(result.ok).toBe(true)
    const loaded = await loadSubmissionValues(db, submissionId)
    expect(loaded.fields['I.2']).toBe('Исправлено')
  })

  it('проверка статуса и запись выполняются в одной транзакции', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)
    const transactionSpy = vi.spyOn(db, 'transaction')

    const result = await saveFieldValue(db, {
      submissionId, fieldKey: 'I.2', value: 'Атомарно',
    })

    // Доказывает, что запись проходит через db.transaction (то есть статус
    // и запись — один атомарный шаг), а не через две отдельные операции.
    // Это НЕ доказывает отсутствие гонки при настоящей параллельной нагрузке
    // (unit-тест не может интерливить конкурентные соединения к PGlite) —
    // только то, что механизм на месте и его нельзя случайно откатить назад
    // к раздельным SELECT + INSERT без провала этого теста.
    expect(result.ok).toBe(true)
    expect(transactionSpy).toHaveBeenCalledTimes(1)
  })

  it('запрашивает блокировку строки анкеты (FOR UPDATE) при проверке статуса', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    // `.for` живёт на прототипе, общем для любого select-построителя,
    // включая тот, что assertEditable создаёт внутри db.transaction —
    // поэтому шпион, поставленный здесь через отдельный "пробный" select,
    // перехватывает и настоящий вызов внутри saveFieldValue, без
    // дублирования кода запроса из values.ts.
    const probe = db.select({ status: submissions.status }).from(submissions)
    const forSpy = vi.spyOn(Object.getPrototypeOf(probe), 'for')

    try {
      const result = await saveFieldValue(db, {
        submissionId, fieldKey: 'I.2', value: 'Под блокировкой',
      })

      // Доказывает, что assertEditable реально вызывает `.for('update')` и
      // что получившийся SQL содержит `for update` — то есть блокировка
      // строки запрошена. Это НЕ доказывает, что конкурентная транзакция
      // на самом деле заблокируется и будет ждать: unit-тест с одним
      // подключением к PGlite не может интерливить два реальных
      // одновременных соединения, поэтому семантика блокировки на уровне
      // движка (что именно делает Postgres/PGlite с FOR UPDATE) здесь не
      // проверяется — только то, что наш код её запрашивает.
      expect(result.ok).toBe(true)
      expect(forSpy).toHaveBeenCalledWith('update')
      const locked = forSpy.mock.results.at(-1)?.value
      expect(locked?.toSQL().sql.toLowerCase()).toContain('for update')
    } finally {
      forSpy.mockRestore()
    }
  })
})
