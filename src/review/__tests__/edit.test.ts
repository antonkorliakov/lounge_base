import { and, eq } from 'drizzle-orm'
import { describe, it, expect } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import {
  airportDirectory, blockReviews, events, fieldValues, lounges, serviceValues, submissions,
} from '@/db/schema'
import type { SubmissionStatus } from '@/db/schema'
import type { ServiceValueInput } from '@/form-schema'
import { saveFieldValue, saveServiceValue, loadSubmissionValues } from '@/submissions/values'
import { saveOperatorField } from '@/registry/manage'
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

/**
 * Позиция, у которой применим `details`: '5.4' (Massage, профиль `full`).
 * Тесты, правящие details командой, стояли на '2.1' (Wifi) — с появлением
 * профилей Wifi стал `charge`, и details у него обнуляется писателем, так
 * что «правка details» на нём была бы правкой в никуда. '2.1' остаётся там,
 * где правится chargeType/наличие — они у `charge` применимы.
 */
const WITH_DETAILS = '5.4'

/**
 * Матрица гейтов — по ВСЕМ ТРЁМ веткам записи (`'I.2'` поле, `'2.1'` позиция
 * услуг, `'I.10'` код IATA), а не по одной: у `editAnswerDuringReview` три
 * РАЗНЫЕ транзакции-сиблинга, у каждой свой `lockForReview`, и гейт,
 * проверенный на поле, ничего не говорил о ветках услуги и кода — их гейты
 * можно было удалить, не уронив ни одного теста (нашёл аудит; структурную
 * половину — «в каждой транзакции блокировка стоит до записи» — теперь держит
 * и guard, см. `lock-order-guard.ts`, per-span). Для `I.10` справочник сеется
 * и код берётся существующий: отказ обязан прийти именно от ГЕЙТА СТАТУСА, а
 * не от промаха справочника раньше него.
 */
describe('ворота статуса: правка команды принимается ТОЛЬКО в submitted — все три ветки', () => {
  const EDITS: { key: string; value: unknown; seedDirectory: boolean }[] = [
    { key: 'I.2', value: 'Team name', seedDirectory: false },
    { key: '2.1', value: OFFERED_FREE, seedDirectory: false },
    { key: 'I.10', value: 'LGW', seedDirectory: true },
  ]

  for (const status of ['draft', 'changes_requested', 'approved'] as const) {
    for (const edit of EDITS) {
      it(`${edit.key} в ${status} — отказ, и ничего не записано`, async () => {
        const db = await createTestDb()
        if (edit.seedDirectory) await seedDirectory(db)
        const submissionId = await seedSubmission(db, 'draft', {
          fields: { 'I.2': 'Old name', 'I.10': 'IST' },
        })
        if (status !== 'draft') {
          await db.update(submissions).set({ status }).where(eq(submissions.id, submissionId))
        }

        const result = await editAnswerDuringReview(db, {
          submissionId, key: edit.key, value: edit.value, reviewer: REVIEWER,
        })

        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error.ru).toBe('Анкета сейчас не на проверке')
        // Ничего не записано — по следствиям: значения прежние, провенанс
        // операторский, событий нет, строки услуг не появилось.
        const row = await fieldRow(db, submissionId, 'I.2')
        expect(row?.value).toBe('Old name')
        expect(row?.editedBy).toBeNull()
        expect((await fieldRow(db, submissionId, 'I.10'))?.value).toBe('IST')
        const serviceRows = await db.select().from(serviceValues)
          .where(eq(serviceValues.submissionId, submissionId))
        expect(serviceRows).toEqual([])
        expect(await teamEditEvents(db, submissionId)).toEqual([])
      })
    }
  }

  it('в submitted — принимается (поле)', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted', { fields: { 'I.2': 'Old name' } })

    const result = await editAnswerDuringReview(db, {
      submissionId, key: 'I.2', value: 'Team name', reviewer: REVIEWER,
    })

    expect(result).toEqual({ ok: true })
    const row = await fieldRow(db, submissionId, 'I.2')
    expect(row?.value).toBe('Team name')
  })

  for (const edit of EDITS) {
    it(`несуществующая анкета (${edit.key}) — «не найдена»`, async () => {
      const db = await createTestDb()
      if (edit.seedDirectory) await seedDirectory(db)
      await seedSubmission(db, 'submitted')

      const result = await editAnswerDuringReview(db, {
        submissionId: '00000000-0000-0000-0000-000000000000',
        key: edit.key, value: edit.value, reviewer: REVIEWER,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.ru).toBe('Анкета не найдена')
    })
  }
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

  // Три отказа головы ворот паспорта — производная тройка, не-код, промах
  // справочника — паритет тем же приёмом, что выше: обе двери на один вход,
  // `toEqual(operator.error)`. Раньше тексты были скопированы в `edit.ts` от
  // руки с комментарием, УТВЕРЖДАВШИМ паритет, которого ничто не проверяло;
  // теперь оба пути ходят через общие `DERIVED_FIELDS_REFUSAL` и
  // `resolveDirectoryCode` (`src/registry/manage.ts`), а эти тесты не дают
  // завести вторую формулировку заново.
  it('производное поле (I.7): отказ «исправьте код» одинаков у обеих дверей', async () => {
    const db = await createTestDb()
    const operatorSide = await seedSubmission(db, 'draft')
    const teamSide = await seedSubmission(db, 'submitted')

    const operator = await saveOperatorField(db, {
      submissionId: operatorSide, fieldKey: 'I.7', value: 'France',
    })
    const team = await editAnswerDuringReview(db, {
      submissionId: teamSide, key: 'I.7', value: 'France', reviewer: REVIEWER,
    })

    expect(operator.ok).toBe(false)
    expect(team.ok).toBe(false)
    if (!operator.ok && !team.ok) expect(team.error).toEqual(operator.error)
  })

  it('не-код («ab1»): отказ формата одинаков у обеих дверей', async () => {
    const db = await createTestDb()
    const operatorSide = await seedSubmission(db, 'draft')
    const teamSide = await seedSubmission(db, 'submitted')

    const operator = await saveOperatorField(db, {
      submissionId: operatorSide, fieldKey: 'I.10', value: 'ab1',
    })
    const team = await editAnswerDuringReview(db, {
      submissionId: teamSide, key: 'I.10', value: 'ab1', reviewer: REVIEWER,
    })

    expect(operator.ok).toBe(false)
    expect(team.ok).toBe(false)
    if (!operator.ok && !team.ok) expect(team.error).toEqual(operator.error)
  })

  it('код не из справочника («ZZZ»): отказ с лекарством одинаков у обеих дверей', async () => {
    const db = await createTestDb()
    await seedDirectory(db)
    const operatorSide = await seedSubmission(db, 'draft')
    const teamSide = await seedSubmission(db, 'submitted')

    const operator = await saveOperatorField(db, {
      submissionId: operatorSide, fieldKey: 'I.10', value: 'ZZZ',
    })
    const team = await editAnswerDuringReview(db, {
      submissionId: teamSide, key: 'I.10', value: 'ZZZ', reviewer: REVIEWER,
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
    const submissionId = await seedSubmission(db, 'submitted', { services: { [WITH_DETAILS]: OFFERED_FREE } })

    await editAnswerDuringReview(db, {
      submissionId, key: WITH_DETAILS, value: { ...OFFERED_FREE, details: 'от команды' }, reviewer: REVIEWER,
    })
    const edited = await db.select().from(serviceValues)
      .where(eq(serviceValues.submissionId, submissionId))
    expect(edited[0]?.editedBy).toBe(REVIEWER)
    expect(edited[0]?.details).toBe('от команды')
    expect((await loadSubmissionValues(db, submissionId)).teamEditedKeys).toEqual([WITH_DETAILS])

    await db.update(submissions).set({ status: 'changes_requested' })
      .where(eq(submissions.id, submissionId))
    const operator = await saveServiceValue(db, {
      submissionId, itemKey: WITH_DETAILS, value: OFFERED_FREE,
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

  // Сервисные близнецы двух тестов выше: ветка услуг — ДРУГАЯ транзакция
  // с собственными событием и `clearFlagsFor`, и покрытие ветки поля о ней
  // ничего не говорило (аудит: событие и снятие флага у ветки услуг можно
  // было удалить, не уронив ни одного теста).
  it('услуга: событие несёт точную пару old→new (нормализованные строки) и актёра', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted', { services: { [WITH_DETAILS]: OFFERED_FREE } })

    await editAnswerDuringReview(db, {
      submissionId, key: WITH_DETAILS, value: { ...OFFERED_FREE, details: 'от команды' }, reviewer: REVIEWER,
    })

    const recorded = await teamEditEvents(db, submissionId)
    const storedShape = {
      available: 'yes', chargeType: 'complimentary', price: null, currency: null,
      slotMinutes: null, bookingRequired: null, details: null,
    }
    expect(recorded).toEqual([
      {
        actor: REVIEWER,
        payload: {
          key: WITH_DETAILS,
          old: storedShape,
          new: { ...storedShape, details: 'от команды' },
          actor: REVIEWER,
        },
      },
    ])
  })

  it('услуга: замечание правленой позиции снимается, замечание другого ключа переживает', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted', { services: { [WITH_DETAILS]: OFFERED_FREE } })
    await raiseFlag(db, {
      submissionId, fieldKey: WITH_DETAILS, reason: 'needs_detail', comment: 'какой массаж?', reviewer: REVIEWER,
    })
    await raiseFlag(db, {
      submissionId, fieldKey: 'I.4', reason: 'empty', comment: '', reviewer: REVIEWER,
    })

    await editAnswerDuringReview(db, {
      submissionId, key: WITH_DETAILS, value: { ...OFFERED_FREE, details: 'от команды' }, reviewer: REVIEWER,
    })

    const open = await openFlags(db, submissionId)
    expect(open.map((flag) => flag.fieldKey)).toEqual(['I.4'])
  })

  // Подтверждение блока обесценивается ДВАЖДЫ, и это два МЕХАНИЗМА, а не
  // один исход (см. доводы в `edit.ts`): производное правило `confirmedAt <
  // updatedAt` и DELETE строки `block_reviews` внутри `clearFlagsFor`.
  // Прежний тест утверждал только исход (`blockProgress → confirmed: false`)
  // и оставался бы зелёным при потере ЛЮБОГО ОДНОГО из двух — здесь по ноге
  // на каждый механизм.
  it('правка двигает updated_at строго вперёд — дальше confirmedAt (производное правило)', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted', { fields: { 'I.2': 'Old name' } })
    const blockKey = blockKeyOf('I.2')!

    const confirmed = await confirmBlock(db, { submissionId, blockKey, reviewer: REVIEWER })
    expect(confirmed.ok).toBe(true)
    const confirmedRows = await db.select().from(blockReviews)
      .where(and(eq(blockReviews.submissionId, submissionId), eq(blockReviews.blockKey, blockKey)))
    const confirmedAt = confirmedRows[0]!.confirmedAt
    const updatedBefore = (await fieldRow(db, submissionId, 'I.2'))!.updatedAt

    await editAnswerDuringReview(db, {
      submissionId, key: 'I.2', value: 'Team name', reviewer: REVIEWER,
    })

    const updatedAfter = (await fieldRow(db, submissionId, 'I.2'))!.updatedAt
    expect(updatedAfter.getTime()).toBeGreaterThan(updatedBefore.getTime())
    expect(updatedAfter.getTime()).toBeGreaterThan(confirmedAt.getTime())
  })

  it('правка удаляет строку block_reviews своего блока (вторая нога, clearFlagsFor)', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted', { fields: { 'I.2': 'Old name' } })
    const blockKey = blockKeyOf('I.2')!

    const confirmed = await confirmBlock(db, { submissionId, blockKey, reviewer: REVIEWER })
    expect(confirmed.ok).toBe(true)

    await editAnswerDuringReview(db, {
      submissionId, key: 'I.2', value: 'Team name', reviewer: REVIEWER,
    })

    const rows = await db.select().from(blockReviews)
      .where(and(eq(blockReviews.submissionId, submissionId), eq(blockReviews.blockKey, blockKey)))
    expect(rows).toEqual([])
    // И производный исход по-прежнему таков (не вместо ног, а поверх них).
    const after = await blockProgress(db, submissionId)
    expect(after.find((b) => b.blockKey === blockKey)?.confirmed).toBe(false)
  })
})

/**
 * Граница записи двери (аудит, must-fix 3): правка ТЕМ ЖЕ значением — не
 * правка (один клик до неё есть: черновик редактора предзаполнен сохранённым
 * значением, а у I.10 выбор из списка и есть сохранение), и недоопределённый
 * сетевой вход (`undefined`, частичный объект услуги) не должен ни красть
 * провенанс, ни ронять транзакцию.
 */
describe('граница записи: no-op и недоопределённый вход', () => {
  it('поле: то же значение — ok без записи: провенанс, событие, замечание и updated_at нетронуты', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted', { fields: { 'I.2': 'Old name' } })
    await raiseFlag(db, {
      submissionId, fieldKey: 'I.2', reason: 'needs_detail', comment: 'уточните', reviewer: REVIEWER,
    })
    const before = (await fieldRow(db, submissionId, 'I.2'))!

    const result = await editAnswerDuringReview(db, {
      submissionId, key: 'I.2', value: 'Old name', reviewer: REVIEWER,
    })

    expect(result).toEqual({ ok: true })
    const after = (await fieldRow(db, submissionId, 'I.2'))!
    expect(after.editedBy).toBeNull()
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime())
    expect(await teamEditEvents(db, submissionId)).toEqual([])
    // Замечание НЕ снято: ответ не менялся, снимать его не за что.
    expect((await openFlags(db, submissionId)).map((f) => f.fieldKey)).toEqual(['I.2'])
  })

  it('поле: то же значение не обесценивает подтверждение блока', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted', { fields: { 'I.2': 'Old name' } })
    const blockKey = blockKeyOf('I.2')!
    expect((await confirmBlock(db, { submissionId, blockKey, reviewer: REVIEWER })).ok).toBe(true)

    await editAnswerDuringReview(db, {
      submissionId, key: 'I.2', value: 'Old name', reviewer: REVIEWER,
    })

    const progress = await blockProgress(db, submissionId)
    expect(progress.find((b) => b.blockKey === blockKey)?.confirmed).toBe(true)
  })

  it('услуга: та же позиция (цена — численно: 50 против хранимого 50.00) — ok без записи', async () => {
    const db = await createTestDb()
    const chargeable: ServiceValueInput = {
      available: 'yes', chargeType: 'chargeable', price: 50, currency: 'USD',
      slotMinutes: null, bookingRequired: null, details: null,
    }
    const submissionId = await seedSubmission(db, 'submitted', { services: { '2.1': chargeable } })
    await raiseFlag(db, {
      submissionId, fieldKey: '2.1', reason: 'needs_detail', comment: 'какой wifi?', reviewer: REVIEWER,
    })

    const result = await editAnswerDuringReview(db, {
      submissionId, key: '2.1', value: chargeable, reviewer: REVIEWER,
    })

    expect(result).toEqual({ ok: true })
    const rows = await db.select().from(serviceValues)
      .where(eq(serviceValues.submissionId, submissionId))
    expect(rows[0]?.editedBy).toBeNull()
    expect(await teamEditEvents(db, submissionId)).toEqual([])
    expect((await openFlags(db, submissionId)).map((f) => f.fieldKey)).toEqual(['2.1'])
  })

  it('I.10: выбор ТОГО ЖЕ аэропорта — ok без записи по всей четвёрке', async () => {
    const db = await createTestDb()
    await seedDirectory(db)
    const submissionId = await seedSubmission(db, 'submitted', {
      fields: { 'I.7': 'Turkey', 'I.8': 'Istanbul', 'I.9': 'Istanbul Airport', 'I.10': 'IST' },
    })
    await raiseFlag(db, {
      submissionId, fieldKey: 'I.10', reason: 'contradicts', comment: 'точно IST?', reviewer: REVIEWER,
    })

    const result = await editAnswerDuringReview(db, {
      submissionId, key: 'I.10', value: 'ist', reviewer: REVIEWER,
    })

    expect(result).toEqual({ ok: true })
    for (const key of ['I.7', 'I.8', 'I.9', 'I.10']) {
      expect((await fieldRow(db, submissionId, key))?.editedBy, key).toBeNull()
    }
    expect(await teamEditEvents(db, submissionId)).toEqual([])
    expect((await openFlags(db, submissionId)).map((f) => f.fieldKey)).toEqual(['I.10'])
  })

  it('I.10: тот же код при разошедшейся тройке — НЕ no-op, четвёрка выравнивается', async () => {
    const db = await createTestDb()
    await seedDirectory(db)
    // Тройка врёт про код: не «выбрали тот же аэропорт», а данные, которые
    // надо чинить, — и no-op по одному только коду спрятал бы починку.
    const submissionId = await seedSubmission(db, 'submitted', {
      fields: { 'I.7': 'France', 'I.8': 'Paris', 'I.9': 'CDG T1', 'I.10': 'IST' },
    })

    const result = await editAnswerDuringReview(db, {
      submissionId, key: 'I.10', value: 'IST', reviewer: REVIEWER,
    })

    expect(result).toEqual({ ok: true })
    expect((await fieldRow(db, submissionId, 'I.7'))?.value).toBe('Turkey')
    expect((await fieldRow(db, submissionId, 'I.8'))?.value).toBe('Istanbul')
    expect((await fieldRow(db, submissionId, 'I.9'))?.value).toBe('Istanbul Airport')
  })

  it('undefined на необязательном поле пишет null, а не старое значение под новым провенансом', async () => {
    const db = await createTestDb()
    // III.5.3 (зал/галерея) — необязательное поле типа text: null для него
    // валиден. II.4.2 сюда больше не годится — оно теперь типа phone, а
    // `validateField` отказывает НЕ-строке (в том числе null) в ветках
    // phone/email всегда, до проверки `required` (см. `form-schema/validation.ts`,
    // комментарий над `case 'phone'`), так что очистить его в null через эту
    // дверь нельзя вовсе — это не следствие старого значения фикстуры.
    const submissionId = await seedSubmission(db, 'submitted', { fields: { 'III.5.3': 'Concourse B' } })

    const result = await editAnswerDuringReview(db, {
      submissionId, key: 'III.5.3', value: undefined, reviewer: REVIEWER,
    })

    expect(result).toEqual({ ok: true })
    const row = (await fieldRow(db, submissionId, 'III.5.3'))!
    // Именно null, а НЕ уцелевшее 'Concourse B': drizzle выбрасывает undefined
    // из SET, и без нормализации у двери «стёртый» ответ оставался бы прежним —
    // с провенансом команды и снятым замечанием поверх нетронутого значения.
    expect(row.value).toBeNull()
    expect(row.editedBy).toBe(REVIEWER)
    const recorded = await teamEditEvents(db, submissionId)
    expect(recorded[0]?.payload).toEqual({
      key: 'III.5.3', old: 'Concourse B', new: null, actor: REVIEWER,
    })
  })

  it('частичный объект услуги не роняет транзакцию и не пишет «undefined» в цену', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted', { services: { [WITH_DETAILS]: OFFERED_FREE } })

    // Только два ключа из семи — остальное дополняется null у двери.
    const result = await editAnswerDuringReview(db, {
      submissionId, key: WITH_DETAILS,
      value: { available: 'yes', chargeType: 'complimentary' },
      reviewer: REVIEWER,
    })

    // Вход совпал с хранимой строкой после нормализации — это честный no-op;
    // главное здесь — НЕ краш `String(undefined)` в numeric-колонке.
    expect(result).toEqual({ ok: true })
    const rows = await db.select().from(serviceValues)
      .where(eq(serviceValues.submissionId, submissionId))
    expect(rows[0]?.price).toBeNull()

    // А частичный объект с настоящим изменением — пишется, с null в дырах.
    const changed = await editAnswerDuringReview(db, {
      submissionId, key: WITH_DETAILS,
      value: { available: 'yes', chargeType: 'complimentary', details: 'от команды' },
      reviewer: REVIEWER,
    })
    expect(changed).toEqual({ ok: true })
    const after = await db.select().from(serviceValues)
      .where(eq(serviceValues.submissionId, submissionId))
    expect(after[0]).toMatchObject({
      available: 'yes', chargeType: 'complimentary', price: null, details: 'от команды',
      editedBy: REVIEWER,
    })
  })

  it('частичный объект с chargeable без цены — отказ валидации, не краш', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmission(db, 'submitted', { services: { '2.1': OFFERED_FREE } })

    const result = await editAnswerDuringReview(db, {
      submissionId, key: '2.1',
      value: { available: 'yes', chargeType: 'chargeable' },
      reviewer: REVIEWER,
    })

    expect(result.ok).toBe(false)
    const rows = await db.select().from(serviceValues)
      .where(eq(serviceValues.submissionId, submissionId))
    expect(rows[0]?.chargeType).toBe('complimentary')
    expect(rows[0]?.editedBy).toBeNull()
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
  /**
   * Паритет профилей: обе двери ходят через один `serviceRowFromInput`, так
   * что атрибут, которого профиль позиции не спрашивает, обнуляется у команды
   * ровно так же, как у оператора. Проверяется как РАВЕНСТВО двух строк,
   * записанных одним входом через разные двери (а не как два списка null):
   * если правило разойдётся, разойдутся и строки.
   */
  it('неприменимые по профилю атрибуты обнуляются обеими дверями одинаково', async () => {
    const db = await createTestDb()
    const operatorSide = await seedSubmission(db, 'draft')
    const teamSide = await seedSubmission(db, 'submitted')
    // '7.2' (Shower) — `charge`: слот, бронь и details у неё не применимы.
    const everything: ServiceValueInput = {
      available: 'yes', chargeType: 'chargeable', price: 15, currency: 'EUR',
      slotMinutes: 30, bookingRequired: true, details: 'stale',
    }

    const operator = await saveServiceValue(db, { submissionId: operatorSide, itemKey: '7.2', value: everything })
    const team = await editAnswerDuringReview(db, {
      submissionId: teamSide, key: '7.2', value: everything, reviewer: REVIEWER,
    })
    expect(operator).toEqual({ ok: true })
    expect(team).toEqual({ ok: true })

    const stored = (await loadSubmissionValues(db, operatorSide)).services['7.2']
    expect((await loadSubmissionValues(db, teamSide)).services['7.2']).toEqual(stored)
    expect(stored).toEqual({
      available: 'yes', chargeType: 'chargeable', price: 15, currency: 'EUR',
      slotMinutes: null, bookingRequired: null, details: null,
    })
  })

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
