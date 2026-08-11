import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { fieldValues, lounges, photos, serviceValues, submissions } from '@/db/schema'
import { BLOCKS, FIELDS, SERVICE_ITEMS } from '@/form-schema'
import { blockKeyOf, raiseFlag } from '../flags'
import { confirmBlock, unconfirmBlock, blockProgress, keysOfBlock, REVIEW_STATUSES } from '../blocks'

async function seedSubmitted(db: Db): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  const [submission] = await db
    .insert(submissions).values({ loungeId: lounge!.id, status: 'submitted' }).returning()
  return submission!.id
}

describe('состав блока', () => {
  it('блок плоских полей содержит свои поля', () => {
    const keys = keysOfBlock('III.2')
    const expected = FIELDS.filter((f) => f.block === 'III.2').map((f) => f.key)
    expect(keys).toEqual(expected)
  })

  it('блок услуг содержит позиции своей группы', () => {
    const keys = keysOfBlock('svc.a1')
    const expected = SERVICE_ITEMS.filter((i) => i.group === 'a1').map((i) => i.key)
    expect(keys).toEqual(expected)
  })

  it('блок фотографий содержит слоты', () => {
    expect(keysOfBlock('photos')).toContain('reception')
  })

  it('каждый из 27 блоков непустой', () => {
    for (const block of BLOCKS) {
      expect(keysOfBlock(block.key).length, block.key).toBeGreaterThan(0)
    }
  })

  it('неизвестный ключ блока возвращает пустой список', () => {
    expect(keysOfBlock('IX.99')).toEqual([])
  })
})

describe('подтверждение блока', () => {
  it('подтверждённый блок виден в прогрессе', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const result = await confirmBlock(db, {
      submissionId, blockKey: 'III.2', reviewer: 'reviewer-1',
    })

    expect(result.ok).toBe(true)
    const progress = await blockProgress(db, submissionId)
    expect(progress.find((b) => b.blockKey === 'III.2')?.confirmed).toBe(true)
  })

  it('прогресс перечисляет все 27 блоков', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    expect(await blockProgress(db, submissionId)).toHaveLength(27)
  })

  it('блок с открытым замечанием подтвердить нельзя', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)
    await raiseFlag(db, {
      submissionId, fieldKey: 'III.2.4', reason: 'needs_detail',
      comment: 'Не перечислены авиакомпании', reviewer: 'reviewer-1',
    })

    const result = await confirmBlock(db, {
      submissionId, blockKey: 'III.2', reviewer: 'reviewer-1',
    })

    expect(result.ok).toBe(false)

    // Отказ не оставляет наполовину записанного подтверждения — блок в
    // прогрессе виден как неподтверждённый, а не "подтверждён, но с флагом".
    const progress = await blockProgress(db, submissionId)
    expect(progress.find((b) => b.blockKey === 'III.2')?.confirmed).toBe(false)
  })

  it('замечание в чужом блоке не мешает подтвердить этот', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)
    await raiseFlag(db, {
      submissionId, fieldKey: 'III.2.4', reason: null,
      comment: 'Не перечислены авиакомпании', reviewer: 'reviewer-1',
    })

    const result = await confirmBlock(db, {
      submissionId, blockKey: 'III.5', reviewer: 'reviewer-1',
    })
    expect(result.ok).toBe(true)
  })

  it('прогресс считает открытые замечания по блокам', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)
    await raiseFlag(db, {
      submissionId, fieldKey: 'III.2.4', reason: null, comment: 'раз', reviewer: 'r',
    })
    await raiseFlag(db, {
      submissionId, fieldKey: 'III.2.5', reason: null, comment: 'два', reviewer: 'r',
    })

    const progress = await blockProgress(db, submissionId)
    expect(progress.find((b) => b.blockKey === 'III.2')?.openFlagCount).toBe(2)
    expect(progress.find((b) => b.blockKey === 'III.5')?.openFlagCount).toBe(0)
  })

  it('повторное подтверждение не создаёт дубль', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    await confirmBlock(db, { submissionId, blockKey: 'III.2', reviewer: 'r1' })
    await confirmBlock(db, { submissionId, blockKey: 'III.2', reviewer: 'r1' })

    const progress = await blockProgress(db, submissionId)
    expect(progress.filter((b) => b.blockKey === 'III.2')).toHaveLength(1)
  })

  it('повторное подтверждение обновляет автора и время', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    await confirmBlock(db, { submissionId, blockKey: 'III.2', reviewer: 'r1' })
    const second = await confirmBlock(db, { submissionId, blockKey: 'III.2', reviewer: 'r2' })

    expect(second.ok).toBe(true)
    const progress = await blockProgress(db, submissionId)
    expect(progress.find((b) => b.blockKey === 'III.2')?.confirmed).toBe(true)
  })

  it('подтверждение снимается', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)
    await confirmBlock(db, { submissionId, blockKey: 'III.2', reviewer: 'r1' })

    await unconfirmBlock(db, { submissionId, blockKey: 'III.2' })

    const progress = await blockProgress(db, submissionId)
    expect(progress.find((b) => b.blockKey === 'III.2')?.confirmed).toBe(false)
  })

  it('неизвестный блок подтвердить нельзя', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const result = await confirmBlock(db, {
      submissionId, blockKey: 'IX.99', reviewer: 'r1',
    })
    expect(result.ok).toBe(false)
  })
})

/**
 * `confirmed` — вывод, а не просто наличие строки в `block_reviews`:
 * подтверждение действует, пока оно не старше самого свежего ответа в блоке.
 * Ниже по одному тесту на каждую из трёх таблиц, чьи времена участвуют в
 * сравнении (`field_values`, `service_values`, `photos`), плюс обратная
 * проверка — иначе «блок не подтверждён» проходило бы и в случае, когда правило
 * ломает вообще все подтверждения.
 *
 * Времена записи задаются явно и с заведомым отрывом. Так тест пиннит именно
 * правило, а не разрешение часов: `Date` в JS обрезает микросекунды постгреса
 * до миллисекунд, поэтому «на миллисекунду позже» в принципе неотличимо от
 * «одновременно», и полагаться на то, что подряд идущие операторы попадут в
 * разные миллисекунды, значило бы получить тест, зелёный или красный по
 * скорости машины. Путь «настоящая запись через `saveFieldValue`» покрыт в
 * `resubmit.test.ts`.
 */
describe('подтверждение против времени записи', () => {
  const laterThanConfirmation = sql`clock_timestamp() + interval '1 second'`

  it('ответ, записанный после подтверждения, снимает его', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)
    await confirmBlock(db, { submissionId, blockKey: 'III.2', reviewer: 'r1' })

    await db.insert(fieldValues).values({
      submissionId, fieldKey: 'III.2.4', value: 'Turkish Airlines',
      updatedAt: laterThanConfirmation,
    })

    const progress = await blockProgress(db, submissionId)
    expect(progress.find((b) => b.blockKey === 'III.2')?.confirmed).toBe(false)
  })

  it('подтверждение, выданное после записи ответа, остаётся в силе', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)
    await db.insert(fieldValues).values({
      submissionId, fieldKey: 'III.2.4', value: 'Turkish Airlines',
    })

    await confirmBlock(db, { submissionId, blockKey: 'III.2', reviewer: 'r1' })

    const progress = await blockProgress(db, submissionId)
    expect(progress.find((b) => b.blockKey === 'III.2')?.confirmed).toBe(true)
  })

  it('позиция услуг, записанная после подтверждения, снимает его', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)
    const item = SERVICE_ITEMS.find((i) => i.key === '2.1')!
    const blockKey = blockKeyOf(item.key)!
    await confirmBlock(db, { submissionId, blockKey, reviewer: 'r1' })

    await db.insert(serviceValues).values({
      submissionId, itemKey: item.key, available: 'yes', updatedAt: laterThanConfirmation,
    })

    const progress = await blockProgress(db, submissionId)
    expect(progress.find((b) => b.blockKey === blockKey)?.confirmed).toBe(false)
  })

  it('снимок, загруженный после подтверждения, снимает его', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)
    const blockKey = blockKeyOf('reception')!
    await confirmBlock(db, { submissionId, blockKey, reviewer: 'r1' })

    await db.insert(photos).values({
      submissionId, slot: 'reception', blobKey: 'k', url: 'https://blob.test/1.jpg',
      uploadedAt: laterThanConfirmation,
    })

    const progress = await blockProgress(db, submissionId)
    expect(progress.find((b) => b.blockKey === blockKey)?.confirmed).toBe(false)
  })

  it('правка в чужом блоке не снимает подтверждение этого', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)
    const field = FIELDS.find((f) => f.key === 'III.2.4')!
    expect(field.block).not.toBe('III.5') // предпосылка теста
    await confirmBlock(db, { submissionId, blockKey: 'III.5', reviewer: 'r1' })

    await db.insert(fieldValues).values({
      submissionId, fieldKey: field.key, value: 'Turkish Airlines',
      updatedAt: laterThanConfirmation,
    })

    const progress = await blockProgress(db, submissionId)
    expect(progress.find((b) => b.blockKey === 'III.5')?.confirmed).toBe(true)
  })
})

/**
 * Обе стороны сравнения `confirmedAt` ↔ `updatedAt` должны штамповаться ОДНИМИ
 * часами, иначе `<` между ними не упорядочивает события, а сравнивает
 * показания двух разных приборов: в проде node-процесс и postgres — разные
 * машины, и расхождение часов переворачивает сравнение в опасную сторону
 * («правка старше подтверждения» ⇒ блок остаётся подтверждённым). Плюс именно
 * `clock_timestamp()`, а не `now()`: `now()` — время начала транзакции, взятое
 * ДО того, как она получит блокировку `submissions`, так что транзакция записи
 * может отштамповаться раньше подтверждения, которое обесценивает, — шириной
 * во всё время ожидания блокировки.
 *
 * **Проверяется текст, а не поведение, и это осознанный предел.** Поведенчески
 * это здесь непроверяемо в обе стороны: часы приложения и базы в тестах
 * совпадают (PGlite — тот же процесс, что и vitest), а инверсия из-за `now()`
 * требует двух ОДНОВРЕМЕННЫХ сессий, которых у PGlite не бывает («single
 * user/connection», см. развёрнутое рассуждение в `flags.test.ts`). Тест,
 * который сделал бы вид, что проверяет это поведение, был бы хуже отсутствия
 * теста. Так что он пиннит механизм — ровно та же честная область, что у
 * теста порядка блокировок для `raiseFlag`.
 */
describe('одни часы на обеих сторонах сравнения', () => {
  const sourceOf = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8')

  it('confirmBlock штампует confirmedAt через clock_timestamp() на обоих путях', () => {
    const source = sourceOf('src/review/blocks.ts')
    // INSERT ... SELECT и ON CONFLICT DO UPDATE — два разных пути записи, и
    // раньше они брали время из двух разных источников.
    expect(source).toContain('clock_timestamp()')
    expect(source).toContain('confirmedAt: sql`clock_timestamp()`')
    expect(source).not.toContain('confirmedAt: new Date()')
  })

  it('saveFieldValue/saveServiceValue штампуют updatedAt тем же способом', () => {
    const source = sourceOf('src/submissions/values.ts')
    expect(source).toContain('const WRITTEN_AT = sql`clock_timestamp()`')
    expect(source).not.toContain('updatedAt: new Date()')
    // Оба пути upsert-а, а не только UPDATE: у впервые записанного ключа иначе
    // сработал бы `defaultNow()` столбца, то есть тот же `now()`.
    expect(source.match(/updatedAt: WRITTEN_AT/g)).toHaveLength(4)
  })
})

describe('окно ревьюера', () => {
  it('REVIEW_STATUSES — это только submitted, а не окно заполняющего', () => {
    expect(Array.from(REVIEW_STATUSES)).toEqual(['submitted'])
  })

  it('черновик подтвердить нельзя — анкета ещё не на проверке', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)
    await db.update(submissions).set({ status: 'draft' }).where(eq(submissions.id, submissionId))

    const result = await confirmBlock(db, {
      submissionId, blockKey: 'III.2', reviewer: 'r1',
    })
    expect(result.ok).toBe(false)
  })

  it('анкету, отправленную на правку, подтвердить нельзя', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)
    await db.update(submissions).set({ status: 'changes_requested' }).where(eq(submissions.id, submissionId))

    const result = await confirmBlock(db, {
      submissionId, blockKey: 'III.2', reviewer: 'r1',
    })
    expect(result.ok).toBe(false)
  })

  it('принятую анкету подтвердить нельзя', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)
    await db.update(submissions).set({ status: 'approved' }).where(eq(submissions.id, submissionId))

    const result = await confirmBlock(db, {
      submissionId, blockKey: 'III.2', reviewer: 'r1',
    })
    expect(result.ok).toBe(false)
  })

  it('несуществующая анкета не подтверждается', async () => {
    const db = await createTestDb()

    const result = await confirmBlock(db, {
      submissionId: '00000000-0000-0000-0000-000000000000',
      blockKey: 'III.2',
      reviewer: 'r1',
    })
    expect(result.ok).toBe(false)
  })

  it('снятие подтверждения не смотрит на статус анкеты', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)
    await confirmBlock(db, { submissionId, blockKey: 'III.2', reviewer: 'r1' })
    await db.update(submissions).set({ status: 'approved' }).where(eq(submissions.id, submissionId))

    await unconfirmBlock(db, { submissionId, blockKey: 'III.2' })

    const progress = await blockProgress(db, submissionId)
    expect(progress.find((b) => b.blockKey === 'III.2')?.confirmed).toBe(false)
  })
})
