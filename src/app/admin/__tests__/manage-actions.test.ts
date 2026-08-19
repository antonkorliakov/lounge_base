import { eq } from 'drizzle-orm'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import {
  lounges, submissions, fieldValues, photos, fillTokens, events,
} from '@/db/schema'
import { resolveFillToken } from '@/access/tokens'

/**
 * Действия управления реестром (`../actions.ts`): завести лаунж с первой
 * ссылкой заполнения, удалить лаунж с подтверждением названием. Тот же стенд
 * и те же три мока, что у `actions.test.ts` (см. его шапку), плюс четвёртый —
 * `@vercel/blob`: чистка блобов удалённых снимков — внешний вызов, которого
 * в тестовом стенде быть не должно, а есть ли он и с чем — как раз предмет
 * проверки.
 *
 * Отказы проверяются ПОСЛЕДСТВИЕМ, а не только возвратом: после отказа база
 * перечитывается — создание не записало ничего, удаление ничего не стёрло.
 */
const holder = vi.hoisted(() => ({
  db: undefined as Db | undefined,
  noSession: false,
}))

const blob = vi.hoisted(() => ({
  del: vi.fn(async (_urls: string | string[]): Promise<void> => {}),
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

vi.mock('@vercel/blob', () => ({ del: blob.del }))

const { createLoungeAction, deleteLoungeAction } = await import('../actions')

const INPUT = {
  name: 'Aurora Lounge',
  iataCode: 'IST',
  provider: null,
  country: 'Turkey',
  city: 'Istanbul',
  airport: 'Istanbul Airport',
}

async function allRows(db: Db) {
  return {
    lounges: await db.select({ id: lounges.id }).from(lounges),
    submissions: await db.select({ id: submissions.id }).from(submissions),
    fieldValues: await db.select({ key: fieldValues.fieldKey }).from(fieldValues),
    photos: await db.select({ id: photos.id }).from(photos),
    fillTokens: await db.select({ id: fillTokens.id }).from(fillTokens),
    events: await db.select({ id: events.id }).from(events),
  }
}

beforeEach(async () => {
  holder.db = await createTestDb()
  holder.noSession = false
  blob.del.mockReset()
  blob.del.mockResolvedValue(undefined)
})

describe('createLoungeAction: лаунж + анкета + первая ссылка заполнения', () => {
  it('создаёт лаунж с пустой анкетой, а токен из возвращённой ссылки резолвится в эту анкету', async () => {
    const db = holder.db!

    const result = await createLoungeAction({
      ...INPUT,
      // Нормализация IATA: регистр и края — опечатки ввода, не другой код.
      iataCode: ' ist ',
      provider: '  ',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    const loungeRows = await db.select().from(lounges)
    expect(loungeRows).toHaveLength(1)
    expect(loungeRows[0]).toMatchObject({
      name: 'Aurora Lounge',
      iataCode: 'IST',
      // Пустой provider — null (колонка nullable), не пустая строка.
      provider: null,
      country: 'Turkey',
      city: 'Istanbul',
      airport: 'Istanbul Airport',
      operationalStatus: 'active',
    })

    const submissionRows = await db.select().from(submissions)
    expect(submissionRows).toHaveLength(1)
    expect(submissionRows[0]).toMatchObject({
      loungeId: loungeRows[0]!.id,
      status: 'draft',
    })

    // Ссылка — та самая форма `/f/<токен>`, которой ходит оператор, и токен
    // из неё РЕЗОЛВИТСЯ настоящим `resolveFillToken` (живой, не истёкший) в
    // только что созданную анкету — а не просто «какая-то строка в URL».
    const token = result.fillUrl.split('/f/')[1]
    expect(token).toBeTruthy()
    expect(await resolveFillToken(db, token!)).toEqual({
      submissionId: submissionRows[0]!.id,
    })

    // Паспорт лаунжа предзаполнен В АНКЕТЕ той же транзакцией создания —
    // через настоящий `saveFieldValue`, так что валидация и полнота видят
    // эти ответы как обычные. I.10 — НОРМАЛИЗОВАННЫЙ код (` ist ` → `IST`):
    // в ответ уходит то, что легло в колонку, а не сырой ввод. I.3 при
    // пустом provider отсутствует вовсе (не пустая строка): пустая колонка —
    // редактируемое поле, см. `lockedIdentityKeys`.
    const answers = await db.select().from(fieldValues)
    const byKey = Object.fromEntries(answers.map((row) => [row.fieldKey, row.value]))
    expect(byKey).toEqual({
      'I.2': 'Aurora Lounge',
      'I.7': 'Turkey',
      'I.8': 'Istanbul',
      'I.9': 'Istanbul Airport',
      'I.10': 'IST',
    })
  })

  it('заполненный provider предзаполняет I.3', async () => {
    const db = holder.db!

    const result = await createLoungeAction({ ...INPUT, provider: '  dnata ' })
    expect(result.ok).toBe(true)

    const answers = await db.select().from(fieldValues)
    const byKey = Object.fromEntries(answers.map((row) => [row.fieldKey, row.value]))
    // Тот же trim, что у колонки: в анкету уходит записанное в реестр.
    expect(byKey['I.3']).toBe('dnata')
  })

  it('без сессии (fill-токен) не создаёт ничего', async () => {
    const db = holder.db!
    holder.noSession = true

    await expect(createLoungeAction(INPUT)).rejects.toThrow(/no session/)

    holder.noSession = false
    expect(await db.select().from(lounges)).toEqual([])
    expect(await db.select().from(submissions)).toEqual([])
    expect(await db.select().from(fillTokens)).toEqual([])
  })

  it('неверный ввод отклоняется значением с полным Localized, ничего не записав', async () => {
    const db = holder.db!

    // IATA не из трёх букв — и обязательность страны/города/аэропорта:
    // решение «обязательны в форме, а не пустые строки как в ops.ts»
    // закреплено здесь, а не только в комментарии `createLounge`.
    const refused = [
      await createLoungeAction({ ...INPUT, iataCode: 'ISTX' }),
      await createLoungeAction({ ...INPUT, name: '   ' }),
      await createLoungeAction({ ...INPUT, country: '' }),
      await createLoungeAction({ ...INPUT, city: ' ' }),
      await createLoungeAction({ ...INPUT, airport: '' }),
    ]

    for (const result of refused) {
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.error.en).not.toBe('')
      expect(result.error.ru).not.toBe('')
    }
    expect(await db.select().from(lounges)).toEqual([])
    expect(await db.select().from(fillTokens)).toEqual([])
  })
})

/** Полный граф лаунжа: анкета с ответом, два снимка, живой токен и событие —
 *  по одному представителю каждой каскадной ветки из `db/schema.ts`. */
async function seedGraph(db: Db): Promise<{ loungeId: string; urls: string[] }> {
  const created = await createLoungeAction(INPUT)
  if (!created.ok) throw new Error('seed: createLoungeAction failed')

  const [lounge] = await db.select({ id: lounges.id }).from(lounges)
  const [submission] = await db.select({ id: submissions.id }).from(submissions)

  // `I.4`, не `I.2`: паспорт блока I (включая I.2) уже предзаполнен самим
  // `createLoungeAction`, и второй insert того же ключа упал бы об
  // `field_values_unique`. Здесь нужен просто «ответ помимо предзаполненных».
  await db.insert(fieldValues).values({
    submissionId: submission!.id, fieldKey: 'I.4', value: 'https://aurora.example',
  })
  const urls = [
    'https://blob.example/aurora/entrance-1.jpg',
    'https://blob.example/aurora/seating-2.jpg',
  ]
  await db.insert(photos).values(
    urls.map((url, i) => ({
      submissionId: submission!.id,
      slot: i === 0 ? 'entrance' : 'seating',
      blobKey: url.replace('https://blob.example/', ''),
      url,
    })),
  )
  await db.insert(events).values({
    loungeId: lounge!.id, actor: 'reviewer@easyto.travel', action: 'operational_status_changed',
  })

  return { loungeId: lounge!.id, urls }
}

describe('deleteLoungeAction: удаление с подтверждением названием', () => {
  it('сносит весь граф лаунжа и отдаёт блобы снимков в чистку', async () => {
    const db = holder.db!
    const { loungeId, urls } = await seedGraph(db)

    const result = await deleteLoungeAction(loungeId, 'Aurora Lounge')

    expect(result).toEqual({ ok: true })
    // Каждая каскадная ветка пуста — включая токен, выданный при создании,
    // и событие на самом лаунже.
    expect(await allRows(db)).toEqual({
      lounges: [], submissions: [], fieldValues: [], photos: [], fillTokens: [], events: [],
    })
    // Блобы — ПОСЛЕ удаления строк, все URL-ы снимков одним вызовом
    // (`del` принимает массив).
    expect(blob.del).toHaveBeenCalledTimes(1)
    expect(blob.del).toHaveBeenCalledWith(urls)
  })

  it('несовпавшее название — отказ значением, граф цел, блобы не тронуты', async () => {
    const db = holder.db!
    const { loungeId } = await seedGraph(db)

    const result = await deleteLoungeAction(loungeId, 'Aurora lounge')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.en).not.toBe('')
    expect(result.error.ru).not.toBe('')

    const rows = await allRows(db)
    expect(rows.lounges).toHaveLength(1)
    expect(rows.submissions).toHaveLength(1)
    expect(rows.photos).toHaveLength(2)
    expect(rows.fillTokens).toHaveLength(1)
    expect(blob.del).not.toHaveBeenCalled()
  })

  it('несуществующий лаунж — отказ значением, не падение', async () => {
    const result = await deleteLoungeAction(
      '00000000-0000-0000-0000-000000000000', 'Aurora Lounge',
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.en).toBe('Lounge not found')
  })

  it('без сессии (fill-токен) не удаляет ничего', async () => {
    const db = holder.db!
    const { loungeId } = await seedGraph(db)

    holder.noSession = true
    await expect(deleteLoungeAction(loungeId, 'Aurora Lounge')).rejects.toThrow(/no session/)

    holder.noSession = false
    expect(
      await db.select({ id: lounges.id }).from(lounges).where(eq(lounges.id, loungeId)),
    ).toHaveLength(1)
    expect(blob.del).not.toHaveBeenCalled()
  })

  it('сбой чистки блобов не превращает состоявшееся удаление в отказ', async () => {
    const db = holder.db!
    const { loungeId } = await seedGraph(db)
    blob.del.mockRejectedValueOnce(new Error('blob store is down'))

    const result = await deleteLoungeAction(loungeId, 'Aurora Lounge')

    // Строки уже удалены — «не удалилось» было бы ложью (тот же выбор, что
    // у best-effort `del` в `/api/photos`). Орфан-блобы — цена, не отказ.
    expect(result).toEqual({ ok: true })
    expect(await db.select({ id: lounges.id }).from(lounges)).toEqual([])
  })
})
