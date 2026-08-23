import { and, eq } from 'drizzle-orm'
import { describe, it, expect } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import {
  airportDirectory, events, fieldValues, lounges, serviceValues, submissions,
} from '@/db/schema'
import type { SubmissionStatus } from '@/db/schema'
import type { ServiceValueInput } from '@/form-schema'
import { saveFieldValue, saveServiceValue, loadSubmissionValues } from '@/submissions/values'
import { blockProgress, confirmBlock } from '../blocks'
import { blockKeyOf, openFlags, raiseFlag } from '../flags'
import { editAnswerDuringReview, TEAM_EDIT_EVENT } from '../edit'

const REVIEWER = 'reviewer@example.com'

/**
 * Лаунж + анкета в нужном статусе. Ответы, когда они нужны тесту, пишутся
 * НАСТОЯЩИМИ операторскими писателями в черновике (та же дверь, что в бою, —
 * включая `editedBy: null`), и только потом статус переводится напрямую:
 * сами переходы здесь не предмет теста, а `submitSubmission` потребовал бы
 * полной анкеты.
 */
async function seedSubmission(
  db: Db,
  status: SubmissionStatus,
  answers: { fields?: Record<string, unknown>; services?: Record<string, ServiceValueInput> } = {},
): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  const [submission] = await db
    .insert(submissions).values({ loungeId: lounge!.id }).returning()
  const submissionId = submission!.id

  for (const [fieldKey, value] of Object.entries(answers.fields ?? {})) {
    const saved = await saveFieldValue(db, { submissionId, fieldKey, value })
    if (!saved.ok) throw new Error(`seed: ${fieldKey} refused — ${saved.error.en}`)
  }
  for (const [itemKey, value] of Object.entries(answers.services ?? {})) {
    const saved = await saveServiceValue(db, { submissionId, itemKey, value })
    if (!saved.ok) throw new Error(`seed: ${itemKey} refused — ${saved.error.en}`)
  }

  if (status !== 'draft') {
    await db.update(submissions).set({ status }).where(eq(submissions.id, submissionId))
  }
  return submissionId
}

async function seedDirectory(db: Db): Promise<void> {
  await db.insert(airportDirectory).values([
    { iata: 'IST', airport: 'Istanbul Airport', city: 'Istanbul', country: 'Turkey', prominent: true },
    { iata: 'LGW', airport: 'Gatwick', city: 'London', country: 'United Kingdom', prominent: true },
  ])
}

async function fieldRow(db: Db, submissionId: string, key: string) {
  const rows = await db
    .select()
    .from(fieldValues)
    .where(and(eq(fieldValues.submissionId, submissionId), eq(fieldValues.fieldKey, key)))
  return rows[0]
}

async function teamEditEvents(db: Db, submissionId: string) {
  return db
    .select({ actor: events.actor, payload: events.payload })
    .from(events)
    .where(and(eq(events.submissionId, submissionId), eq(events.action, TEAM_EDIT_EVENT)))
}

const OFFERED_FREE: ServiceValueInput = {
  available: 'yes', chargeType: 'complimentary', price: null, currency: null,
  slotMinutes: null, bookingRequired: null, details: null,
}

describe('ворота статуса: правка команды принимается ТОЛЬКО в submitted', () => {
  for (const status of ['draft', 'changes_requested', 'approved'] as const) {
    it(`в ${status} — отказ, и ничего не записано`, async () => {
      const db = await createTestDb()
      const submissionId = await seedSubmission(db, 'draft', { fields: { 'I.2': 'Old name' } })
      if (status !== 'draft') {
        await db.update(submissions).set({ status }).where(eq(submissions.id, submissionId))
      }

      const result = await editAnswerDuringReview(db, {
        submissionId, key: 'I.2', value: 'Team name', reviewer: REVIEWER,
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.ru).toBe('Анкета сейчас не на проверке')
      // Ничего не записано — по следствиям: значение прежнее, провенанс
      // операторский, событий нет.
      const row = await fieldRow(db, submissionId, 'I.2')
      expect(row?.value).toBe('Old name')
      expect(row?.editedBy).toBeNull()
      expect(await teamEditEvents(db, submissionId)).toEqual([])
    })
  }

  it('в submitted — принимается', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted', { fields: { 'I.2': 'Old name' } })

    const result = await editAnswerDuringReview(db, {
      submissionId, key: 'I.2', value: 'Team name', reviewer: REVIEWER,
    })

    expect(result).toEqual({ ok: true })
    const row = await fieldRow(db, submissionId, 'I.2')
    expect(row?.value).toBe('Team name')
  })

  it('несуществующая анкета — «не найдена»', async () => {
    const db = await createTestDb()
    await seedSubmission(db, 'submitted')

    const result = await editAnswerDuringReview(db, {
      submissionId: '00000000-0000-0000-0000-000000000000',
      key: 'I.2', value: 'x', reviewer: REVIEWER,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.ru).toBe('Анкета не найдена')
  })
})

describe('паритет валидации с дверью оператора', () => {
  it('поле: значение, отказанное оператору, отказывается команде тем же текстом', async () => {
    const db = await createTestDb()
    // Двум одинаковым анкетам — по двери: одна в окне оператора, другая в окне
    // команды; вход один и тот же (пустое обязательное текстовое поле I.2).
    const operatorSide = await seedSubmission(db, 'draft')
    const teamSide = await seedSubmission(db, 'submitted')

    const operator = await saveFieldValue(db, {
      submissionId: operatorSide, fieldKey: 'I.2', value: '',
    })
    const team = await editAnswerDuringReview(db, {
      submissionId: teamSide, key: 'I.2', value: '', reviewer: REVIEWER,
    })

    expect(operator.ok).toBe(false)
    expect(team.ok).toBe(false)
    if (!operator.ok && !team.ok) expect(team.error).toEqual(operator.error)
  })

  it('услуга: chargeable без цены отказывается обеим дверям одинаково', async () => {
    const db = await createTestDb()
    const operatorSide = await seedSubmission(db, 'draft')
    const teamSide = await seedSubmission(db, 'submitted')
    const chargeableNoPrice: ServiceValueInput = {
      ...OFFERED_FREE, chargeType: 'chargeable', price: null, currency: null,
    }

    const operator = await saveServiceValue(db, {
      submissionId: operatorSide, itemKey: '2.1', value: chargeableNoPrice,
    })
    const team = await editAnswerDuringReview(db, {
      submissionId: teamSide, key: '2.1', value: chargeableNoPrice, reviewer: REVIEWER,
    })

    expect(operator.ok).toBe(false)
    expect(team.ok).toBe(false)
    if (!operator.ok && !team.ok) expect(team.error).toEqual(operator.error)
  })

  it('отказ валидации ничего не пишет', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted', { fields: { 'I.2': 'Old name' } })

    await editAnswerDuringReview(db, {
      submissionId, key: 'I.2', value: '', reviewer: REVIEWER,
    })

    const row = await fieldRow(db, submissionId, 'I.2')
    expect(row?.value).toBe('Old name')
    expect(row?.editedBy).toBeNull()
    expect(await teamEditEvents(db, submissionId)).toEqual([])
  })

  it('неизвестный ключ — отказ', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted')
    const result = await editAnswerDuringReview(db, {
      submissionId, key: 'IX.99', value: 'x', reviewer: REVIEWER,
    })
    expect(result.ok).toBe(false)
  })
})

describe('провенанс: значок следует за последней рукой', () => {
  it('правка команды ставит editedBy; операторская запись СБРАСЫВАЕТ его в null', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted', { fields: { 'I.2': 'Old name' } })

    await editAnswerDuringReview(db, {
      submissionId, key: 'I.2', value: 'Team name', reviewer: REVIEWER,
    })
    expect((await fieldRow(db, submissionId, 'I.2'))?.editedBy).toBe(REVIEWER)
    expect((await loadSubmissionValues(db, submissionId)).teamEditedKeys).toEqual(['I.2'])

    // Возврат на правку — окно оператора; его сохранение возвращает провенанс.
    await db.update(submissions).set({ status: 'changes_requested' })
      .where(eq(submissions.id, submissionId))
    const operator = await saveFieldValue(db, {
      submissionId, fieldKey: 'I.2', value: 'Operator name',
    })
    expect(operator.ok).toBe(true)
    expect((await fieldRow(db, submissionId, 'I.2'))?.editedBy).toBeNull()
    expect((await loadSubmissionValues(db, submissionId)).teamEditedKeys).toEqual([])
  })

  it('то же для позиции услуг — в обе стороны', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted', { services: { '2.1': OFFERED_FREE } })

    await editAnswerDuringReview(db, {
      submissionId, key: '2.1', value: { ...OFFERED_FREE, details: 'от команды' }, reviewer: REVIEWER,
    })
    const edited = await db.select().from(serviceValues)
      .where(eq(serviceValues.submissionId, submissionId))
    expect(edited[0]?.editedBy).toBe(REVIEWER)
    expect(edited[0]?.details).toBe('от команды')
    expect((await loadSubmissionValues(db, submissionId)).teamEditedKeys).toEqual(['2.1'])

    await db.update(submissions).set({ status: 'changes_requested' })
      .where(eq(submissions.id, submissionId))
    const operator = await saveServiceValue(db, {
      submissionId, itemKey: '2.1', value: OFFERED_FREE,
    })
    expect(operator.ok).toBe(true)
    const reset = await db.select().from(serviceValues)
      .where(eq(serviceValues.submissionId, submissionId))
    expect(reset[0]?.editedBy).toBeNull()
  })
})

describe('событие, замечания, подтверждение блока', () => {
  it('событие несёт точную пару old→new и актёра', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted', { fields: { 'I.2': 'Old name' } })

    await editAnswerDuringReview(db, {
      submissionId, key: 'I.2', value: 'Team name', reviewer: REVIEWER,
    })

    const recorded = await teamEditEvents(db, submissionId)
    expect(recorded).toEqual([
      {
        actor: REVIEWER,
        payload: { key: 'I.2', old: 'Old name', new: 'Team name', actor: REVIEWER },
      },
    ])
  })

  it('у прежде безответного ключа old — null', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted')

    await editAnswerDuringReview(db, {
      submissionId, key: 'I.2', value: 'Team name', reviewer: REVIEWER,
    })

    const recorded = await teamEditEvents(db, submissionId)
    expect(recorded[0]?.payload).toEqual({
      key: 'I.2', old: null, new: 'Team name', actor: REVIEWER,
    })
  })

  it('замечание правленого ключа снимается, замечание ДРУГОГО ключа переживает', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted', { fields: { 'I.2': 'Old name' } })
    await raiseFlag(db, {
      submissionId, fieldKey: 'I.2', reason: 'wrong_format', comment: 'не то', reviewer: REVIEWER,
    })
    await raiseFlag(db, {
      submissionId, fieldKey: 'I.4', reason: 'empty', comment: '', reviewer: REVIEWER,
    })

    await editAnswerDuringReview(db, {
      submissionId, key: 'I.2', value: 'Team name', reviewer: REVIEWER,
    })

    const open = await openFlags(db, submissionId)
    expect(open.map((flag) => flag.fieldKey)).toEqual(['I.4'])
  })

  it('подтверждение блока обесценивается правкой команды (производное правило)', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted', { fields: { 'I.2': 'Old name' } })
    const blockKey = blockKeyOf('I.2')!

    const confirmed = await confirmBlock(db, { submissionId, blockKey, reviewer: REVIEWER })
    expect(confirmed.ok).toBe(true)
    const before = await blockProgress(db, submissionId)
    expect(before.find((b) => b.blockKey === blockKey)?.confirmed).toBe(true)

    await editAnswerDuringReview(db, {
      submissionId, key: 'I.2', value: 'Team name', reviewer: REVIEWER,
    })

    const after = await blockProgress(db, submissionId)
    expect(after.find((b) => b.blockKey === blockKey)?.confirmed).toBe(false)
  })
})

describe('четвёрка паспорта', () => {
  it('прямая правка производного I.7 — отказ, указывающий на код', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted', { fields: { 'I.7': 'Turkey' } })

    const result = await editAnswerDuringReview(db, {
      submissionId, key: 'I.7', value: 'France', reviewer: REVIEWER,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.ru).toMatch(/исправьте код/)
    expect((await fieldRow(db, submissionId, 'I.7'))?.value).toBe('Turkey')
  })

  it('правка I.10 кодом из справочника переписывает четвёрку: провенанс, события, флаги — все четыре', async () => {
    const db = await createTestDb()
    await seedDirectory(db)
    const submissionId = await seedSubmission(db, 'submitted', {
      fields: { 'I.7': 'Turkey', 'I.8': 'Istanbul', 'I.9': 'Istanbul Airport', 'I.10': 'IST' },
    })
    for (const key of ['I.7', 'I.8', 'I.9', 'I.10']) {
      await raiseFlag(db, {
        submissionId, fieldKey: key, reason: 'wrong_format', comment: 'не та страна', reviewer: REVIEWER,
      })
    }

    const result = await editAnswerDuringReview(db, {
      submissionId, key: 'I.10', value: 'lgw', reviewer: REVIEWER,
    })
    expect(result).toEqual({ ok: true })

    const expected: Record<string, string> = {
      'I.7': 'United Kingdom', 'I.8': 'London', 'I.9': 'Gatwick', 'I.10': 'LGW',
    }
    for (const [key, value] of Object.entries(expected)) {
      const row = await fieldRow(db, submissionId, key)
      expect(row?.value, key).toBe(value)
      expect(row?.editedBy, key).toBe(REVIEWER)
    }

    const recorded = await teamEditEvents(db, submissionId)
    const byKey = new Map(
      recorded.map((event) => [(event.payload as { key: string }).key, event.payload]),
    )
    expect([...byKey.keys()].sort()).toEqual(['I.10', 'I.7', 'I.8', 'I.9'])
    expect(byKey.get('I.10')).toEqual({ key: 'I.10', old: 'IST', new: 'LGW', actor: REVIEWER })
    expect(byKey.get('I.7')).toEqual({
      key: 'I.7', old: 'Turkey', new: 'United Kingdom', actor: REVIEWER,
    })

    expect(await openFlags(db, submissionId)).toEqual([])
  })

  it('код не из справочника — отказ, ничего не записано', async () => {
    const db = await createTestDb()
    await seedDirectory(db)
    const submissionId = await seedSubmission(db, 'submitted', { fields: { 'I.10': 'IST' } })

    const result = await editAnswerDuringReview(db, {
      submissionId, key: 'I.10', value: 'ZZZ', reviewer: REVIEWER,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.ru).toMatch(/не найден в справочнике/)
    expect((await fieldRow(db, submissionId, 'I.10'))?.value).toBe('IST')
    expect(await teamEditEvents(db, submissionId)).toEqual([])
  })

  it('не-код («ab1») — отказ формата до похода в справочник', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted')
    const result = await editAnswerDuringReview(db, {
      submissionId, key: 'I.10', value: 'ab1', reviewer: REVIEWER,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.ru).toBe('Код IATA — три латинские буквы')
  })
})

describe('услуги: нормализация — тем же правилом, что у оператора', () => {
  it('ответ «нет» гасит offered-only атрибуты', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted', {
      services: {
        '2.1': {
          available: 'yes', chargeType: 'chargeable', price: 50, currency: 'USD',
          slotMinutes: 30, bookingRequired: true, details: 'старое',
        },
      },
    })

    const result = await editAnswerDuringReview(db, {
      submissionId,
      key: '2.1',
      value: {
        available: 'no', chargeType: 'chargeable', price: 50, currency: 'USD',
        slotMinutes: 30, bookingRequired: true, details: 'старое',
      },
      reviewer: REVIEWER,
    })
    expect(result).toEqual({ ok: true })

    const rows = await db.select().from(serviceValues)
      .where(eq(serviceValues.submissionId, submissionId))
    expect(rows[0]).toMatchObject({
      available: 'no', chargeType: null, price: null, currency: null,
      slotMinutes: null, bookingRequired: null, details: null,
      editedBy: REVIEWER,
    })
  })
})

describe('фотографии: серверного пути правки не существует', () => {
  it('ключ слота фотографии отказывается всегда — даже в submitted', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted')

    const result = await editAnswerDuringReview(db, {
      submissionId, key: 'entrance', value: 'https://example.com/x.jpg', reviewer: REVIEWER,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.ru).toMatch(/свидетельство с места/)
    expect(await teamEditEvents(db, submissionId)).toEqual([])
  })
})
