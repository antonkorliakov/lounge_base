import { describe, it, expect } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions } from '@/db/schema'
import { raiseFlag, resolveFlag, openFlags, isFlaggableKey } from '../flags'

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
})
