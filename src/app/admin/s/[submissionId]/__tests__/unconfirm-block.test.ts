import { eq } from 'drizzle-orm'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import type { SubmissionStatus } from '@/db/schema'
import { lounges, submissions } from '@/db/schema'
import { BLOCKS } from '@/form-schema'
import { blockProgress } from '@/review/blocks'
import { reviewStateFor } from '../gates'

/**
 * Подтверждение блока нельзя было отозвать НИГДЕ в продукте: `unconfirmBlock`
 * (`@/review/blocks`) был написан, заблокирован, покрыт тестами и указан в
 * плане — и не имел ни одного вызывающего в приложении, а на экране проверки
 * стояла одна кнопка «Подтвердить блок», не выключавшаяся после нажатия. Один
 * промах мыши навсегда шёл в счёт 27/27, которые проверяет `approveSubmission`.
 *
 * Проверяется само действие, а не `unconfirmBlock`: у того тесты уже есть, и
 * дефект был не в нём. Не хватало ровно того, кто его позовёт, — и гейта,
 * которого у него по устройству быть не может (сигнатура `Promise<void>`,
 * отказ сообщить нечем).
 *
 * Замокано три модуля и ни одного больше — тот же приём и тот же стенд, что у
 * `fill-link.test.ts` рядом:
 *  - `@/db/client` — на PGlite с настоящими миграциями, так что `confirmBlock`,
 *    `unconfirmBlock` и `blockProgress` работают по-настоящему;
 *  - `@/access/session` — `requireSession` иначе полез бы в `next/headers` за
 *    cookie, которых вне запроса не существует;
 *  - `next/cache` — `revalidatePath` вне рантайма Next не имеет смысла.
 * `@/notify/mailer` НЕ мокается: ни `confirmBlockAction`, ни
 * `unconfirmBlockAction` писем не отправляют, и если бы отправляли — тест
 * упал бы, что здесь и нужно.
 */
const holder = vi.hoisted(() => ({
  db: undefined as Db | undefined,
  /** Сессии нет — единственный способ проверить, что авторизация стоит ДО
   *  записи, а не после неё. */
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

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { confirmBlockAction, unconfirmBlockAction } = await import('../actions')

/** Два разных настоящих блока из схемы — «снятие затронуло только свой блок»
 *  без второго блока проверялось бы вакуумно. */
const BLOCK = BLOCKS[0]!.key
const OTHER_BLOCK = BLOCKS[1]!.key

async function seed(db: Db, status: SubmissionStatus): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({
      name: 'Primeclass Lounge',
      country: 'Turkey',
      city: 'Istanbul',
      airport: 'Istanbul Airport',
      iataCode: 'IST',
    })
    .returning()
  const [submission] = await db
    .insert(submissions)
    .values({ loungeId: lounge!.id, status })
    .returning()
  return submission!.id
}

async function confirmedBlocks(db: Db, submissionId: string): Promise<string[]> {
  const progress = await blockProgress(db, submissionId)
  return progress.filter((block) => block.confirmed).map((block) => block.blockKey)
}

describe('unconfirmBlockAction: подтверждение блока можно отозвать', () => {
  beforeEach(async () => {
    holder.db = await createTestDb()
    holder.noSession = false
  })

  it('снимает подтверждение своего блока и не трогает остальные', async () => {
    const db = holder.db!
    const submissionId = await seed(db, 'submitted')

    for (const blockKey of [BLOCK, OTHER_BLOCK]) {
      expect((await confirmBlockAction(submissionId, blockKey)).ok, blockKey).toBe(true)
    }
    expect(await confirmedBlocks(db, submissionId)).toEqual([BLOCK, OTHER_BLOCK])

    const result = await unconfirmBlockAction(submissionId, BLOCK)

    expect(result.ok).toBe(true)
    expect(await confirmedBlocks(db, submissionId)).toEqual([OTHER_BLOCK])
  })

  it('повторный вызов на неподтверждённом блоке ничего не ломает', async () => {
    const db = holder.db!
    const submissionId = await seed(db, 'submitted')

    expect((await unconfirmBlockAction(submissionId, BLOCK)).ok).toBe(true)
    expect(await confirmedBlocks(db, submissionId)).toEqual([])
  })

  it('вне окна проверки отказывает — тем же текстом, которым экран выключает кнопку', async () => {
    const db = holder.db!
    const submissionId = await seed(db, 'submitted')
    expect((await confirmBlockAction(submissionId, BLOCK)).ok).toBe(true)

    // Анкету принимаем «сбоку»: `approveSubmission` потребовал бы подтверждения
    // всех 27 блоков, а этому тесту нужна принятая анкета С подтверждением, а
    // не путь принятия.
    await db
      .update(submissions)
      .set({ status: 'approved' })
      .where(eq(submissions.id, submissionId))

    const result = await unconfirmBlockAction(submissionId, BLOCK)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    // Не «похожий текст», а тот же самый объект: причина отказа и подсказка на
    // выключенной кнопке приходят из одного `reviewStateFor`. Разойтись они
    // могут только если кто-то заведёт вторую формулировку — и тогда падает
    // это утверждение.
    const shown = reviewStateFor('approved').decisions
    expect(shown.allowed).toBe(false)
    if (shown.allowed) throw new Error('unreachable')
    expect(result.error).toEqual(shown.reason)

    // И отказ — настоящий: подтверждение на месте.
    expect(await confirmedBlocks(db, submissionId)).toEqual([BLOCK])
  })

  it('несуществующая анкета: отказ, а не тихий успех', async () => {
    const result = await unconfirmBlockAction('00000000-0000-0000-0000-000000000000', BLOCK)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.en).toMatch(/not found/i)
  })

  it('без сессии не снимает подтверждение', async () => {
    const db = holder.db!
    const submissionId = await seed(db, 'submitted')
    expect((await confirmBlockAction(submissionId, BLOCK)).ok).toBe(true)

    holder.noSession = true
    await expect(unconfirmBlockAction(submissionId, BLOCK)).rejects.toThrow(/no session/)

    // Утверждение здесь именно про ПОРЯДОК: `requireSession()` стоит первым
    // оператором действия, поэтому до записи дело не доходит. Проверено
    // последствием, а не чтением кода — единственное, что здесь можно
    // проверить по-настоящему.
    holder.noSession = false
    expect(await confirmedBlocks(db, submissionId)).toEqual([BLOCK])
  })
})
