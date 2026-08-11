import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions } from '@/db/schema'
import { read } from '@/export/__tests__/readWorkbook'

/**
 * Маршрут выгрузки одной анкеты (`/admin/export/s/[submissionId]`) — то, чего
 * у `singleSubmissionWorkbook` не было вовсе (дефект I1 ревью: собран, заперт,
 * недостижим). Сама книга покрыта в `src/export/__tests__/workbook.test.ts`;
 * здесь — только то, что добавляет маршрут: сессия ПЕРЕД чтением, имя файла
 * из названия лаунжа и 404 (а не 500) на неизвестной анкете.
 *
 * Стенд — тот же, что у `unconfirm-block.test.ts`: PGlite с настоящими
 * миграциями и мок сессии с выключателем.
 */
const holder = vi.hoisted(() => ({
  db: undefined as Db | undefined,
  noSession: false,
}))

vi.mock('@/db/client', () => ({
  db: (): Db => {
    if (!holder.db) throw new Error('test db not ready')
    return holder.db
  },
  createDb: (): Db => {
    if (!holder.db) throw new Error('test db not ready')
    return holder.db
  },
}))

vi.mock('@/access/session', () => ({
  requireSession: async () => {
    if (holder.noSession) throw new Error('no session')
    return { memberId: 'member-1', email: 'reviewer@easyto.travel' }
  },
}))

const { GET } = await import('../s/[submissionId]/route')

async function seedSubmission(db: Db, name: string): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({
      name,
      country: 'Turkey',
      city: 'Istanbul',
      airport: 'Istanbul Airport',
      iataCode: 'IST',
    })
    .returning()
  const [submission] = await db
    .insert(submissions)
    .values({ loungeId: lounge!.id })
    .returning()
  return submission!.id
}

const request = new Request('http://localhost/admin/export/s/x')
const params = (submissionId: string) => ({
  params: Promise.resolve({ submissionId }),
})

describe('GET /admin/export/s/[submissionId]', () => {
  beforeEach(async () => {
    holder.db = await createTestDb()
    holder.noSession = false
  })

  it('отдаёт настоящий xlsx, названный лаунжем, а не uuid анкеты', async () => {
    const db = holder.db!
    const submissionId = await seedSubmission(db, 'Primeclass Lounge')

    const response = await GET(request, params(submissionId))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('spreadsheetml')

    const disposition = response.headers.get('content-disposition') ?? ''
    expect(disposition).toContain('attachment')
    expect(disposition).toContain('filename="Primeclass Lounge (IST).xlsx"')
    expect(disposition).not.toContain(submissionId)

    // Файл — настоящая книга с обоими листами исходной структуры, не пустой
    // ответ с правильными заголовками.
    const book = await read(Buffer.from(await response.arrayBuffer()))
    expect(book.worksheets.map((sheet) => sheet.name)).toEqual([
      'General Lounge Information',
      'Services & Amenities',
    ])
  })

  it('не-ASCII название: полное имя в filename*, ASCII-запасной без мусора', async () => {
    const db = holder.db!
    const submissionId = await seedSubmission(db, 'Лаунж «Аврора»')

    const response = await GET(request, params(submissionId))
    const disposition = response.headers.get('content-disposition') ?? ''

    // RFC 5987: полное название уезжает в filename* percent-encoded'ом…
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('Лаунж «Аврора» (IST).xlsx')}`)
    // …а сам заголовок остаётся чистым ASCII (не-ASCII в HTTP-заголовке —
    // недействительный байт, часть клиентов его отвергает).
    expect([...disposition].every((char) => char.charCodeAt(0) < 128)).toBe(true)
  })

  it('неизвестная анкета — 404, а не 500', async () => {
    const response = await GET(request, params(randomUUID()))
    expect(response.status).toBe(404)
  })

  it('без сессии файла нет — отказ до чтения анкеты', async () => {
    const db = holder.db!
    const submissionId = await seedSubmission(db, 'Primeclass Lounge')

    holder.noSession = true
    await expect(GET(request, params(submissionId))).rejects.toThrow(/no session/)
  })
})
