import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { teamMembers, sessions } from '@/db/schema'
import {
  addTeamMember,
  requestLogin,
  consumeLoginToken,
  resolveSession,
  loginWithPassword,
} from '@/access/team'

/**
 * Действия экрана команды (`../team/actions.ts`). Тот же стенд, что у
 * `manage-actions.test.ts` (см. его шапку), плюс мок `next/headers`:
 * `endMemberSessionsAction` для СЕБЯ читает id текущей сессии из cookie,
 * чтобы её пощадить, — стенд подставляет `holder.cookieSessionId`.
 *
 * Сессионные последствия проверяются НАСТОЯЩИМИ функциями входа
 * (`loginWithPassword`, `resolveSession`) на той же PGlite-базе, а не
 * перечитыванием таблиц вслепую: «участник может войти с новым паролем» и
 * «его сессия умерла» — это то, что действие обещает человеку.
 */
const holder = vi.hoisted(() => ({
  db: undefined as Db | undefined,
  noSession: false,
  session: { memberId: '', email: 'actor@easyto.travel' },
  cookieSessionId: '',
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

vi.mock('@/access/session', async (importOriginal) => ({
  // SESSION_COOKIE и прочие константы — настоящие; подменяется только вход.
  ...(await importOriginal<typeof import('@/access/session')>()),
  requireSession: async () => {
    if (holder.noSession) throw new Error('no session')
    return holder.session
  },
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (_name: string) => ({ value: holder.cookieSessionId }),
  }),
}))

const {
  inviteMemberAction,
  setMemberPasswordAction,
  endMemberSessionsAction,
  removeMemberAction,
} = await import('../team/actions')

async function sessionFor(db: Db, email: string): Promise<string> {
  const issued = await requestLogin(db, email)
  if (!('token' in issued)) throw new Error('токен не выдан')
  const consumed = await consumeLoginToken(db, issued.token)
  return consumed!.sessionId
}

/** Актёр (текущая сессия стенда) + второй участник с одной живой сессией. */
async function seedTwo(db: Db): Promise<{ targetId: string; targetSessionId: string }> {
  const actor = await addTeamMember(db, { email: 'actor@easyto.travel', name: 'Actor' })
  holder.session = { memberId: actor.id, email: 'actor@easyto.travel' }
  holder.cookieSessionId = await sessionFor(db, 'actor@easyto.travel')

  const target = await addTeamMember(db, { email: 'target@easyto.travel', name: 'Target' })
  const targetSessionId = await sessionFor(db, 'target@easyto.travel')
  return { targetId: target.id, targetSessionId }
}

beforeEach(async () => {
  holder.db = await createTestDb()
  holder.noSession = false
})

describe('inviteMemberAction', () => {
  it('без сессии не выполняется, ничего не записав', async () => {
    holder.noSession = true
    await expect(inviteMemberAction('x@example.com', 'X')).rejects.toThrow('no session')
    expect(await holder.db!.select().from(teamMembers)).toHaveLength(0)
    holder.noSession = false
  })

  it('заводит участника; дубликат — локализованный отказ, не пятисотка', async () => {
    const db = holder.db!
    await seedTwo(db)

    const first = await inviteMemberAction(' New@Example.com ', 'New Member')
    expect(first.ok).toBe(true)

    const dup = await inviteMemberAction('new@example.com', 'Copy')
    expect(dup.ok).toBe(false)
    if (dup.ok) throw new Error('unreachable')
    expect(dup.error.ru).toContain('уже в команде')

    const rows = await db.select().from(teamMembers)
    expect(rows.map((r) => r.email).sort()).toEqual([
      'actor@easyto.travel', 'new@example.com', 'target@easyto.travel',
    ])
  })
})

describe('setMemberPasswordAction', () => {
  it('ставит коллеге пароль (он входит с ним), отзывает ВСЕ его сессии и не возвращает пароль', async () => {
    const db = holder.db!
    const { targetId, targetSessionId } = await seedTwo(db)
    const secondSessionId = await sessionFor(db, 'target@easyto.travel')

    const result = await setMemberPasswordAction(targetId, 'temp-password-1')

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.notice).toBeTruthy()
    // Пароль не утёк в результат ни под каким ключом.
    expect(JSON.stringify(result)).not.toContain('temp-password-1')

    // Обе сессии участника мертвы — сброс чужого пароля значит «выйти везде»
    // (в отличие от смены СВОЕГО на /admin/password, щадящей текущую).
    expect(await resolveSession(db, targetSessionId)).toBeNull()
    expect(await resolveSession(db, secondSessionId)).toBeNull()
    // Сессия того, кто сбрасывал, жива.
    expect(await resolveSession(db, holder.cookieSessionId)).not.toBeNull()

    // Новый пароль настоящий: участник входит с ним настоящим путём входа.
    expect(await loginWithPassword(db, 'target@easyto.travel', 'temp-password-1')).not.toBeNull()
  })

  it('себе — отказ (свой пароль меняется через /admin/password с текущим), хэш не тронут', async () => {
    const db = holder.db!
    await seedTwo(db)

    const result = await setMemberPasswordAction(holder.session.memberId, 'temp-password-1')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.ru).toContain('пароля')
    const [actor] = await db
      .select({ passwordHash: teamMembers.passwordHash })
      .from(teamMembers)
      .where(eq(teamMembers.id, holder.session.memberId))
    expect(actor!.passwordHash).toBeNull()
    // И сессии участника пережили отказ.
    expect(await resolveSession(db, holder.cookieSessionId)).not.toBeNull()
  })

  it('короткий пароль — отказ правила из access/password, сессии участника целы', async () => {
    const db = holder.db!
    const { targetId, targetSessionId } = await seedTwo(db)

    const result = await setMemberPasswordAction(targetId, 'short')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.ru).toContain('не короче')
    expect(await resolveSession(db, targetSessionId)).not.toBeNull()
  })

  it('исчезнувший участник — отказ, а не «пароль установлен» про никого', async () => {
    const db = holder.db!
    await seedTwo(db)

    const result = await setMemberPasswordAction(
      '00000000-0000-0000-0000-000000000000',
      'temp-password-1',
    )

    expect(result.ok).toBe(false)
  })
})

describe('endMemberSessionsAction', () => {
  it('для другого — kill switch: все его сессии мертвы, чужие целы', async () => {
    const db = holder.db!
    const { targetId, targetSessionId } = await seedTwo(db)
    const secondSessionId = await sessionFor(db, 'target@easyto.travel')

    const result = await endMemberSessionsAction(targetId)

    expect(result.ok).toBe(true)
    expect(await resolveSession(db, targetSessionId)).toBeNull()
    expect(await resolveSession(db, secondSessionId)).toBeNull()
    expect(await resolveSession(db, holder.cookieSessionId)).not.toBeNull()
  })

  it('для себя — щадит текущую сессию из cookie, убивает остальные', async () => {
    const db = holder.db!
    await seedTwo(db)
    const otherOwnSessionId = await sessionFor(db, 'actor@easyto.travel')

    const result = await endMemberSessionsAction(holder.session.memberId)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // Подписи веток различаются — «остальные устройства», не «все сессии».
    expect(result.notice?.ru).toContain('Остальные')
    expect(await resolveSession(db, otherOwnSessionId)).toBeNull()
    expect(await resolveSession(db, holder.cookieSessionId)).not.toBeNull()
  })
})

describe('removeMemberAction', () => {
  it('удаляет по совпавшей почте; сессии участника умирают каскадом', async () => {
    const db = holder.db!
    const { targetId, targetSessionId } = await seedTwo(db)

    const result = await removeMemberAction(targetId, ' Target@EasyTo.Travel ')

    expect(result).toEqual({ ok: true })
    expect(await db.select().from(teamMembers)).toHaveLength(1)
    expect(await resolveSession(db, targetSessionId)).toBeNull()
    expect(
      await db.select().from(sessions).where(eq(sessions.memberId, targetId)),
    ).toHaveLength(0)
  })

  it('себя — отказ с объяснением, даже с верной почтой', async () => {
    const db = holder.db!
    await seedTwo(db)

    const result = await removeMemberAction(holder.session.memberId, 'actor@easyto.travel')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.ru).toContain('самого себя')
    expect(await db.select().from(teamMembers)).toHaveLength(2)
  })

  it('несовпавшая почта — отказ, участник цел', async () => {
    const db = holder.db!
    const { targetId } = await seedTwo(db)

    const result = await removeMemberAction(targetId, 'typo@easyto.travel')

    expect(result.ok).toBe(false)
    expect(await db.select().from(teamMembers)).toHaveLength(2)
  })
})
