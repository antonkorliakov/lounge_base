import { describe, it, expect } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions } from '@/db/schema'
import { attachPhoto, listPhotos, removePhoto } from '../store'

async function seedDraft(db: Db): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  const [submission] = await db
    .insert(submissions).values({ loungeId: lounge!.id }).returning()
  return submission!.id
}

const photo = (slot: string) => ({
  slot,
  blobKey: `${slot}-1.jpg`,
  url: `https://blob.test/${slot}-1.jpg`,
  caption: null,
})

describe('фотографии', () => {
  it('привязывает снимок к именованному слоту', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await attachPhoto(db, { submissionId, ...photo('entrance') })

    expect(result.ok).toBe(true)
    const rows = await listPhotos(db, submissionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.slot).toBe('entrance')
  })

  it('отклоняет неизвестный слот', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await attachPhoto(db, { submissionId, ...photo('rooftop') })
    expect(result.ok).toBe(false)
  })

  it('именованный слот держит один снимок — повтор заменяет прежний', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    await attachPhoto(db, { submissionId, ...photo('entrance') })
    await attachPhoto(db, {
      submissionId, slot: 'entrance',
      blobKey: 'entrance-2.jpg', url: 'https://blob.test/entrance-2.jpg', caption: null,
    })

    const rows = await listPhotos(db, submissionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.blobKey).toBe('entrance-2.jpg')
  })

  it('дополнительный слот принимает несколько снимков', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    await attachPhoto(db, {
      submissionId, slot: 'additional',
      blobKey: 'a1.jpg', url: 'https://blob.test/a1.jpg', caption: null,
    })
    await attachPhoto(db, {
      submissionId, slot: 'additional',
      blobKey: 'a2.jpg', url: 'https://blob.test/a2.jpg', caption: null,
    })

    expect(await listPhotos(db, submissionId)).toHaveLength(2)
  })

  it('снимок удаляется', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)
    await attachPhoto(db, { submissionId, ...photo('reception') })

    const [row] = await listPhotos(db, submissionId)
    await removePhoto(db, row!.id)

    expect(await listPhotos(db, submissionId)).toHaveLength(0)
  })
})
