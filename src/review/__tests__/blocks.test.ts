import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions } from '@/db/schema'
import { BLOCKS, FIELDS, SERVICE_ITEMS } from '@/form-schema'
import { raiseFlag } from '../flags'
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
