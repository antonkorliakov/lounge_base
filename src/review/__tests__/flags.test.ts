import { eq } from 'drizzle-orm'
import { describe, it, expect } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions, blockReviews, fieldFlags } from '@/db/schema'
import { FIELDS, SERVICE_ITEMS, SERVICE_GROUPS, BLOCKS } from '@/form-schema'
import {
  raiseFlag, resolveFlag, openFlags, isFlaggableKey, blockKeyOf, clearFlagsFor,
} from '../flags'

async function seedSubmitted(db: Db): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  const [submission] = await db
    .insert(submissions).values({ loungeId: lounge!.id, status: 'submitted' }).returning()
  return submission!.id
}

const flag = (submissionId: string, fieldKey: string) => ({
  submissionId,
  fieldKey,
  reason: 'needs_detail' as const,
  comment: 'Не перечислены авиакомпании',
  reviewer: 'reviewer-1',
})

describe('адресация замечаний', () => {
  it('плоское поле можно отметить', () => {
    expect(isFlaggableKey('III.2.4')).toBe(true)
  })

  it('позицию услуг можно отметить целиком', () => {
    expect(isFlaggableKey('2.1')).toBe(true)
  })

  it('отдельный атрибут позиции отметить нельзя', () => {
    expect(isFlaggableKey('2.1.price')).toBe(false)
  })

  it('слот фотографии можно отметить', () => {
    expect(isFlaggableKey('reception')).toBe(true)
  })

  it('выдуманный ключ отметить нельзя', () => {
    expect(isFlaggableKey('IX.99')).toBe(false)
  })
})

describe('замечания', () => {
  it('замечание попадает в список открытых', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const result = await raiseFlag(db, flag(submissionId, 'III.2.4'))

    expect(result.ok).toBe(true)
    const open = await openFlags(db, submissionId)
    expect(open).toHaveLength(1)
    expect(open[0]?.comment).toBe('Не перечислены авиакомпании')
  })

  it('замечание на неизвестный ключ отклоняется', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const result = await raiseFlag(db, flag(submissionId, 'IX.99'))
    expect(result.ok).toBe(false)
  })

  it('пустой комментарий отклоняется', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const result = await raiseFlag(db, {
      ...flag(submissionId, 'III.2.4'), comment: '   ',
    })
    expect(result.ok).toBe(false)
  })

  it('причина необязательна', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const result = await raiseFlag(db, {
      ...flag(submissionId, 'III.2.4'), reason: null,
    })
    expect(result.ok).toBe(true)
  })

  it('повторное замечание на то же поле заменяет прежнее', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    await raiseFlag(db, flag(submissionId, 'III.2.4'))
    await raiseFlag(db, {
      ...flag(submissionId, 'III.2.4'), comment: 'Уточнённая формулировка',
    })

    const open = await openFlags(db, submissionId)
    expect(open).toHaveLength(1)
    expect(open[0]?.comment).toBe('Уточнённая формулировка')
  })

  it('снятое замечание уходит из открытых', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)
    await raiseFlag(db, flag(submissionId, 'III.2.4'))

    const [open] = await openFlags(db, submissionId)
    await resolveFlag(db, open!.id)

    expect(await openFlags(db, submissionId)).toHaveLength(0)
  })

  it('снятое замечание не мешает поставить новое', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)
    await raiseFlag(db, flag(submissionId, 'III.2.4'))
    const [first] = await openFlags(db, submissionId)
    await resolveFlag(db, first!.id)

    await raiseFlag(db, { ...flag(submissionId, 'III.2.4'), comment: 'Снова не то' })

    const open = await openFlags(db, submissionId)
    expect(open).toHaveLength(1)
    expect(open[0]?.comment).toBe('Снова не то')
  })

  it('гонка: две одновременные попытки замечания на одно поле дают одно открытое', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    // Не await по очереди — оба вызова запускаются, не дожидаясь друг
    // друга, чтобы проверить именно то, от чего защищает
    // `field_flags_open_unique`: два одновременных raiseFlag на тот же
    // ключ не должны привести к двум открытым строкам.
    const [a, b] = await Promise.all([
      raiseFlag(db, { ...flag(submissionId, 'III.2.4'), comment: 'Первое' }),
      raiseFlag(db, { ...flag(submissionId, 'III.2.4'), comment: 'Второе' }),
    ])

    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(await openFlags(db, submissionId)).toHaveLength(1)
  })

  it('строка с неизвестным reason читается как null, а не как невалидный FlagReason', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    // Вставлено напрямую, минуя raiseFlag, — `reason` в базе это простой
    // `text`, ничто на уровне БД не гарантирует членство в `FlagReason`.
    await db.insert(fieldFlags).values({
      submissionId,
      fieldKey: 'III.2.4',
      reason: 'bogus-value-not-in-union',
      comment: 'вставлено напрямую',
      createdBy: 'reviewer-1',
    })

    const open = await openFlags(db, submissionId)
    expect(open).toHaveLength(1)
    expect(open[0]?.reason).toBeNull()
  })
})

/** Подтверждает блок в базе — то же действие, что делает ревьюер task 3. */
async function confirmBlock(db: Db, submissionId: string, blockKey: string): Promise<void> {
  await db.insert(blockReviews).values({ submissionId, blockKey, confirmedBy: 'reviewer-1' })
}

async function confirmedBlocks(db: Db, submissionId: string): Promise<string[]> {
  const rows = await db
    .select({ blockKey: blockReviews.blockKey })
    .from(blockReviews)
    .where(eq(blockReviews.submissionId, submissionId))
  return rows.map((r) => r.blockKey)
}

describe('blockKeyOf', () => {
  it('плоское поле отображается на блок из его собственного описания', () => {
    const field = FIELDS.find((f) => f.key === 'III.2.4')
    expect(field).toBeDefined()
    expect(blockKeyOf('III.2.4')).toBe(field!.block)
  })

  it('позиция услуг отображается на блок её группы', () => {
    const item = SERVICE_ITEMS.find((i) => i.key === '2.1')
    expect(item).toBeDefined()
    const group = SERVICE_GROUPS.find((g) => g.key === item!.group)
    expect(group).toBeDefined()
    expect(blockKeyOf('2.1')).toBe(group!.block)
  })

  it('слот фотографии отображается на блок фотографий', () => {
    const photosBlock = BLOCKS.find((b) => b.kind === 'photos')
    expect(photosBlock).toBeDefined()
    expect(blockKeyOf('reception')).toBe(photosBlock!.key)
  })

  it('неотмечаемый ключ не отображается ни на один блок', () => {
    expect(blockKeyOf('IX.99')).toBeNull()
    expect(blockKeyOf('2.1.price')).toBeNull()
  })
})

describe('clearFlagsFor', () => {
  it('снимает замечание и инвалидирует подтверждение ЕГО блока, не трогая другой', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const flaggedField = FIELDS.find((f) => f.key === 'III.2.4')!
    const otherField = FIELDS.find((f) => f.key === 'I.1')!
    expect(flaggedField.block).not.toBe(otherField.block) // предпосылка теста

    await raiseFlag(db, flag(submissionId, 'III.2.4'))
    await confirmBlock(db, submissionId, flaggedField.block)
    await confirmBlock(db, submissionId, otherField.block)

    const result = await clearFlagsFor(db, submissionId, 'III.2.4')

    expect(result).toBe(true)
    expect(await openFlags(db, submissionId)).toHaveLength(0)
    const confirmed = await confirmedBlocks(db, submissionId)
    expect(confirmed).not.toContain(flaggedField.block)
    expect(confirmed).toContain(otherField.block)
  })

  it('без открытого замечания возвращает false и НЕ трогает подтверждение блока', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const field = FIELDS.find((f) => f.key === 'III.2.4')!
    await confirmBlock(db, submissionId, field.block)

    const result = await clearFlagsFor(db, submissionId, 'III.2.4')

    expect(result).toBe(false)
    expect(await confirmedBlocks(db, submissionId)).toContain(field.block)
  })

  it('работает для слота фотографии', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const photosBlock = BLOCKS.find((b) => b.kind === 'photos')!

    await raiseFlag(db, { ...flag(submissionId, 'reception') })
    await confirmBlock(db, submissionId, photosBlock.key)

    const result = await clearFlagsFor(db, submissionId, 'reception')

    expect(result).toBe(true)
    expect(await confirmedBlocks(db, submissionId)).not.toContain(photosBlock.key)
  })

  it('работает для позиции услуг', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const item = SERVICE_ITEMS.find((i) => i.key === '2.1')!
    const group = SERVICE_GROUPS.find((g) => g.key === item.group)!

    await raiseFlag(db, { ...flag(submissionId, '2.1') })
    await confirmBlock(db, submissionId, group.block)

    const result = await clearFlagsFor(db, submissionId, '2.1')

    expect(result).toBe(true)
    expect(await confirmedBlocks(db, submissionId)).not.toContain(group.block)
  })
})
