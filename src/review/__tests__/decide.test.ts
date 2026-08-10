import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions, events, fieldValues } from '@/db/schema'
import { BLOCKS } from '@/form-schema'
import { raiseFlag, openFlags } from '../flags'
import { confirmBlock, blockProgress } from '../blocks'
import { requestChanges, approveSubmission, classifyingFieldsFrom } from '../decide'

async function seedSubmitted(db: Db): Promise<{ submissionId: string; loungeId: string }> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  const [submission] = await db
    .insert(submissions).values({ loungeId: lounge!.id, status: 'submitted' }).returning()
  return { submissionId: submission!.id, loungeId: lounge!.id }
}

async function confirmAll(db: Db, submissionId: string): Promise<void> {
  for (const block of BLOCKS) {
    await confirmBlock(db, { submissionId, blockKey: block.key, reviewer: 'r1' })
  }
}

describe('классифицирующие поля', () => {
  it('собираются из значений анкеты', () => {
    const result = classifyingFieldsFrom({
      'III.6.1': { option: 'both', detail: null },
      'III.6.2': { option: 't3', detail: null },
      'III.6.4': { option: 'airside', detail: null },
      'III.6.6': ['departure', 'transit'],
    })

    expect(result).toEqual({
      terminal: 't3',
      terminalType: 'both',
      zone: ['departure', 'transit'],
      airsideLandside: 'airside',
    })
  })

  it('незаполненные поля дают null', () => {
    expect(classifyingFieldsFrom({})).toEqual({
      terminal: null, terminalType: null, zone: null, airsideLandside: null,
    })
  })
})

describe('возврат на правку', () => {
  it('без замечаний вернуть нельзя', async () => {
    const db = await createTestDb()
    const { submissionId } = await seedSubmitted(db)

    const result = await requestChanges(db, { submissionId, reviewer: 'r1' })
    expect(result.ok).toBe(false)
  })

  it('с замечанием переводит в changes_requested', async () => {
    const db = await createTestDb()
    const { submissionId } = await seedSubmitted(db)
    await raiseFlag(db, {
      submissionId, fieldKey: 'III.2.4', reason: null, comment: 'уточните', reviewer: 'r1',
    })

    const result = await requestChanges(db, { submissionId, reviewer: 'r1' })

    expect(result).toEqual({ ok: true, status: 'changes_requested' })
    const rows = await db.select().from(submissions).where(eq(submissions.id, submissionId))
    expect(rows[0]?.status).toBe('changes_requested')
  })

  it('вернуть можно, не размечая остальные блоки', async () => {
    const db = await createTestDb()
    const { submissionId } = await seedSubmitted(db)
    await confirmBlock(db, { submissionId, blockKey: 'I', reviewer: 'r1' })
    await raiseFlag(db, {
      submissionId, fieldKey: 'III.2.4', reason: null, comment: 'уточните', reviewer: 'r1',
    })

    const result = await requestChanges(db, { submissionId, reviewer: 'r1' })
    expect(result.ok).toBe(true)
  })

  it('подтверждённые блоки переживают возврат', async () => {
    const db = await createTestDb()
    const { submissionId } = await seedSubmitted(db)
    await confirmBlock(db, { submissionId, blockKey: 'I', reviewer: 'r1' })
    await raiseFlag(db, {
      submissionId, fieldKey: 'III.2.4', reason: null, comment: 'уточните', reviewer: 'r1',
    })
    await requestChanges(db, { submissionId, reviewer: 'r1' })

    const progress = await blockProgress(db, submissionId)
    expect(progress.find((b) => b.blockKey === 'I')?.confirmed).toBe(true)
  })
})

describe('принятие анкеты', () => {
  it('с открытым замечанием принять нельзя', async () => {
    const db = await createTestDb()
    const { submissionId } = await seedSubmitted(db)
    await confirmAll(db, submissionId)
    await raiseFlag(db, {
      submissionId, fieldKey: 'III.2.4', reason: null, comment: 'уточните', reviewer: 'r1',
    })

    const result = await approveSubmission(db, { submissionId, reviewer: 'r1' })
    expect(result.ok).toBe(false)
  })

  it('с неподтверждённым блоком принять нельзя', async () => {
    const db = await createTestDb()
    const { submissionId } = await seedSubmitted(db)
    await confirmBlock(db, { submissionId, blockKey: 'I', reviewer: 'r1' })

    const result = await approveSubmission(db, { submissionId, reviewer: 'r1' })
    expect(result.ok).toBe(false)
  })

  it('все блоки подтверждены — анкета принимается', async () => {
    const db = await createTestDb()
    const { submissionId } = await seedSubmitted(db)
    await confirmAll(db, submissionId)

    const result = await approveSubmission(db, { submissionId, reviewer: 'r1' })

    expect(result).toEqual({ ok: true, status: 'approved' })
    const rows = await db.select().from(submissions).where(eq(submissions.id, submissionId))
    expect(rows[0]?.decidedAt).not.toBeNull()
  })

  it('принятие копирует классифицирующие поля в лаунж', async () => {
    const db = await createTestDb()
    const { submissionId, loungeId } = await seedSubmitted(db)
    await db.insert(fieldValues).values([
      { submissionId, fieldKey: 'III.6.1', value: { option: 'both', detail: null } },
      { submissionId, fieldKey: 'III.6.2', value: { option: 't3', detail: null } },
      { submissionId, fieldKey: 'III.6.4', value: { option: 'airside', detail: null } },
      { submissionId, fieldKey: 'III.6.6', value: ['departure', 'transit'] },
    ])
    await confirmAll(db, submissionId)

    await approveSubmission(db, { submissionId, reviewer: 'r1' })

    const [lounge] = await db.select().from(lounges).where(eq(lounges.id, loungeId))
    expect(lounge?.terminal).toBe('t3')
    expect(lounge?.terminalType).toBe('both')
    expect(lounge?.zone).toEqual(['departure', 'transit'])
    expect(lounge?.airsideLandside).toBe('airside')
  })

  it('снятые замечания не мешают принять', async () => {
    const db = await createTestDb()
    const { submissionId } = await seedSubmitted(db)
    await raiseFlag(db, {
      submissionId, fieldKey: 'III.2.4', reason: null, comment: 'уточните', reviewer: 'r1',
    })
    const [flag] = await openFlags(db, submissionId)
    const { resolveFlag } = await import('../flags')
    await resolveFlag(db, flag!.id)
    await confirmAll(db, submissionId)

    const result = await approveSubmission(db, { submissionId, reviewer: 'r1' })
    expect(result.ok).toBe(true)
  })

  it('оба решения пишутся в журнал', async () => {
    const db = await createTestDb()

    const approved = await seedSubmitted(db)
    await confirmAll(db, approved.submissionId)
    await approveSubmission(db, { submissionId: approved.submissionId, reviewer: 'r1' })
    const approvedRows = await db
      .select().from(events).where(eq(events.submissionId, approved.submissionId))
    expect(approvedRows.map((r) => r.action)).toContain('approved')

    const returned = await seedSubmitted(db)
    await raiseFlag(db, {
      submissionId: returned.submissionId, fieldKey: 'III.2.4', reason: null, comment: 'уточните', reviewer: 'r1',
    })
    await requestChanges(db, { submissionId: returned.submissionId, reviewer: 'r1' })
    const returnedRows = await db
      .select().from(events).where(eq(events.submissionId, returned.submissionId))
    expect(returnedRows.map((r) => r.action)).toContain('changes_requested')
  })

  it('принятую анкету нельзя принять повторно', async () => {
    const db = await createTestDb()
    const { submissionId } = await seedSubmitted(db)
    await confirmAll(db, submissionId)
    await approveSubmission(db, { submissionId, reviewer: 'r1' })

    const again = await approveSubmission(db, { submissionId, reviewer: 'r1' })
    expect(again.ok).toBe(false)
  })
})
