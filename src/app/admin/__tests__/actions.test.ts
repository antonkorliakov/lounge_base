import { eq } from 'drizzle-orm'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, events } from '@/db/schema'

/**
 * Действия реестра (`../actions.ts`) под их собственным гейтом: «токен
 * заполнения не может менять эксплуатационный статус» — тест из списка самого
 * плана 3, который ничем не был закреплён. Смена статуса — решение кабинета
 * проверяющего; у оператора лаунжа есть только fill-токен, и единственное,
 * что стоит между ним и `setOperationalStatus`, — `requireSession()` первым
 * оператором действия.
 *
 * Проверяется ПОСЛЕДСТВИЕМ, а не чтением кода — тот же стенд и та же форма,
 * что у `unconfirm-block.test.ts` (см. его разбор, почему мокаются ровно три
 * модуля): настоящее действие зовётся с сессией, которой нет, и после отказа
 * база читается заново — статус прежний, событий ноль. Это сильнее пина
 * «requireSession стоит первым текстуально»: упади сессия ПОСЛЕ записи, тест
 * увидел бы изменённый статус при том же reject'е.
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

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { setStatusAction, statusHistoryAction } = await import('../actions')

async function seedLounge(db: Db): Promise<string> {
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
  return lounge!.id
}

async function loungeStatus(db: Db, loungeId: string) {
  const [row] = await db
    .select({
      status: lounges.operationalStatus,
      until: lounges.statusUntil,
      comment: lounges.statusComment,
    })
    .from(lounges)
    .where(eq(lounges.id, loungeId))
  return row
}

describe('setStatusAction: смена статуса — только из сессии кабинета', () => {
  beforeEach(async () => {
    holder.db = await createTestDb()
    holder.noSession = false
  })

  it('с сессией меняет статус и подписывает событие почтой ревьюера', async () => {
    const db = holder.db!
    const loungeId = await seedLounge(db)

    const result = await setStatusAction(
      loungeId, 'under_renovation', '2026-09-15', 'Реконструкция зоны питания',
    )

    expect(result.ok).toBe(true)
    expect(await loungeStatus(db, loungeId)).toEqual({
      status: 'under_renovation',
      until: '2026-09-15',
      comment: 'Реконструкция зоны питания',
    })
    // `actor` — почта из сессии (`session.email`), тем же полем, каким
    // `requestChanges`/`approveSubmission` подписывают свои решения.
    const written = await db.select({ actor: events.actor }).from(events)
    expect(written).toEqual([{ actor: 'reviewer@easyto.travel' }])
  })

  it('без сессии (fill-токен) не меняет статус и не пишет события', async () => {
    const db = holder.db!
    const loungeId = await seedLounge(db)

    holder.noSession = true
    await expect(
      setStatusAction(loungeId, 'closed', null, null),
    ).rejects.toThrow(/no session/)

    // Отказ — ДО записи, и проверено это последствием: статус прежний,
    // событий нет. `requireSession()` первым оператором — см. шапку файла.
    holder.noSession = false
    expect((await loungeStatus(db, loungeId))?.status).toBe('active')
    expect(await db.select({ id: events.id }).from(events)).toEqual([])
  })

  it('отказ сервера возвращается значением с полным Localized', async () => {
    const db = holder.db!
    const loungeId = await seedLounge(db)

    // `active` даты не несёт — отказ `setOperationalStatus`, донесённый как
    // общий `ActionResult`: `error` — весь Localized, язык выберет клиент.
    const result = await setStatusAction(loungeId, 'active', '2026-09-15', null)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.en).not.toBe('')
    expect(result.error.ru).not.toBe('')
  })
})

describe('statusHistoryAction: история читается только из сессии кабинета', () => {
  beforeEach(async () => {
    holder.db = await createTestDb()
    holder.noSession = false
  })

  it('отдаёт смены в порядке записи, с датой ISO-строкой', async () => {
    const db = holder.db!
    const loungeId = await seedLounge(db)

    expect((await setStatusAction(loungeId, 'under_renovation', '2026-09-15', 'ремонт')).ok)
      .toBe(true)
    expect((await setStatusAction(loungeId, 'active', null, null)).ok).toBe(true)

    const history = await statusHistoryAction(loungeId)

    expect(history.map((entry) => [entry.from, entry.to])).toEqual([
      ['active', 'under_renovation'],
      ['under_renovation', 'active'],
    ])
    expect(history[0]).toMatchObject({
      until: '2026-09-15', comment: 'ремонт', actor: 'reviewer@easyto.travel',
    })
    // `at` — сериализуемая ISO-строка, не Date: контракт для клиента.
    expect(history[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('без сессии историю не отдаёт', async () => {
    const db = holder.db!
    const loungeId = await seedLounge(db)
    expect((await setStatusAction(loungeId, 'closed', null, null)).ok).toBe(true)

    holder.noSession = true
    await expect(statusHistoryAction(loungeId)).rejects.toThrow(/no session/)
  })
})
