import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { teamMembers, loginTokens, sessions } from '@/db/schema'
import {
  addTeamMember,
  requestLogin,
  consumeLoginToken,
  resolveSession,
  endSession,
  endAllSessionsForMember,
} from '../team'

const DAY_MS = 24 * 60 * 60 * 1000

async function seedMember(db: Db, email = 'a.korlyakov@easyto.travel'): Promise<string> {
  const { id } = await addTeamMember(db, { email, name: 'A. Korliakov' })
  return id
}

describe('вход команды', () => {
  it('известной почте выдаётся токен', async () => {
    const db = await createTestDb()
    await seedMember(db)

    const result = await requestLogin(db, 'a.korlyakov@easyto.travel')

    expect('token' in result).toBe(true)
  })

  it('неизвестной почте токен не выдаётся', async () => {
    const db = await createTestDb()
    await seedMember(db)

    const result = await requestLogin(db, 'stranger@example.com')

    expect('error' in result).toBe(true)
    expect(await db.select().from(loginTokens)).toHaveLength(0)
  })

  it('почта сверяется без учёта регистра', async () => {
    const db = await createTestDb()
    await seedMember(db)

    const result = await requestLogin(db, 'A.Korlyakov@EasyTo.Travel')

    expect('token' in result).toBe(true)
  })

  it('смешанный регистр адреса разрешается в того же участника, что и его нижний регистр', async () => {
    const db = await createTestDb()
    const memberId = await seedMember(db, 'mixed@example.com')

    const issued = await requestLogin(db, 'Mixed@Example.COM')
    if (!('token' in issued)) throw new Error('токен не выдан')

    const consumed = await consumeLoginToken(db, issued.token)
    expect(consumed?.memberId).toBe(memberId)
  })

  it('участник с адресом, отличающимся только регистром от уже существующего, не создаётся', async () => {
    const db = await createTestDb()
    await addTeamMember(db, { email: 'dup@example.com', name: 'Original' })

    await expect(
      addTeamMember(db, { email: 'DUP@Example.com', name: 'Duplicate' }),
    ).rejects.toThrow()
  })

  it('токен обменивается на сессию', async () => {
    const db = await createTestDb()
    const memberId = await seedMember(db)
    const issued = await requestLogin(db, 'a.korlyakov@easyto.travel')
    if (!('token' in issued)) throw new Error('токен не выдан')

    const consumed = await consumeLoginToken(db, issued.token)

    expect(consumed?.memberId).toBe(memberId)
    const session = await resolveSession(db, consumed!.sessionId)
    expect(session?.email).toBe('a.korlyakov@easyto.travel')
  })

  it('токен одноразовый', async () => {
    const db = await createTestDb()
    await seedMember(db)
    const issued = await requestLogin(db, 'a.korlyakov@easyto.travel')
    if (!('token' in issued)) throw new Error('токен не выдан')

    await consumeLoginToken(db, issued.token)
    expect(await consumeLoginToken(db, issued.token)).toBeNull()
  })

  it('просроченный токен не обменивается', async () => {
    const db = await createTestDb()
    await seedMember(db)
    const issued = await requestLogin(db, 'a.korlyakov@easyto.travel')
    if (!('token' in issued)) throw new Error('токен не выдан')

    await db.update(loginTokens).set({ expiresAt: new Date(Date.now() - 1000) })
    expect(await consumeLoginToken(db, issued.token)).toBeNull()
  })

  it('сырой токен не хранится в базе', async () => {
    const db = await createTestDb()
    await seedMember(db)
    const issued = await requestLogin(db, 'a.korlyakov@easyto.travel')
    if (!('token' in issued)) throw new Error('токен не выдан')

    const rows = await db.select().from(loginTokens)
    expect(rows[0]?.tokenHash).not.toBe(issued.token)
  })

  it('завершённая сессия больше не разрешается', async () => {
    const db = await createTestDb()
    await seedMember(db)
    const issued = await requestLogin(db, 'a.korlyakov@easyto.travel')
    if (!('token' in issued)) throw new Error('токен не выдан')
    const consumed = await consumeLoginToken(db, issued.token)

    await endSession(db, consumed!.sessionId)
    expect(await resolveSession(db, consumed!.sessionId)).toBeNull()
  })

  it('просроченная сессия не разрешается', async () => {
    const db = await createTestDb()
    await seedMember(db)
    const issued = await requestLogin(db, 'a.korlyakov@easyto.travel')
    if (!('token' in issued)) throw new Error('токен не выдан')
    const consumed = await consumeLoginToken(db, issued.token)

    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, consumed!.sessionId))

    expect(await resolveSession(db, consumed!.sessionId)).toBeNull()
  })

  it('несуществующая сессия не разрешается', async () => {
    const db = await createTestDb()
    const missing = await resolveSession(db, '00000000-0000-0000-0000-000000000000')
    expect(missing).toBeNull()
  })

  it('удаление участника команды каскадно удаляет его токены и сессии', async () => {
    const db = await createTestDb()
    const memberId = await seedMember(db)
    const issued = await requestLogin(db, 'a.korlyakov@easyto.travel')
    if (!('token' in issued)) throw new Error('токен не выдан')
    const consumed = await consumeLoginToken(db, issued.token)

    await db.delete(teamMembers).where(eq(teamMembers.id, memberId))

    expect(await db.select().from(loginTokens)).toHaveLength(0)
    expect(await db.select().from(sessions)).toHaveLength(0)
    expect(await resolveSession(db, consumed!.sessionId)).toBeNull()
    expect(await consumeLoginToken(db, issued.token)).toBeNull()
  })

  it('одновременный обмен одного токена выдаёт ровно одну сессию', async () => {
    // Имитирует префетч ссылки почтовым клиентом: два параллельных вызова
    // с одним и тем же токеном. Без атомарной проверки usedAt внутри самого
    // UPDATE оба запроса читают usedAt IS NULL до того, как любой из них
    // зафиксирует изменение, и оба создают сессию — токен становится
    // многоразовым. Ровно один вызов должен получить сессию, второй — null.
    const db = await createTestDb()
    await seedMember(db)
    const issued = await requestLogin(db, 'a.korlyakov@easyto.travel')
    if (!('token' in issued)) throw new Error('токен не выдан')

    const [first, second] = await Promise.all([
      consumeLoginToken(db, issued.token),
      consumeLoginToken(db, issued.token),
    ])

    const successes = [first, second].filter((r) => r !== null)
    expect(successes).toHaveLength(1)
  })

  it('срок сессии закреплён на 7 дней', async () => {
    // Пин на конкретное значение, а не диапазон "меньше 30" — правка
    // константы (случайная или намеренная) должна ронять этот тест, а не
    // молча расширять окно экспозиции.
    const db = await createTestDb()
    await seedMember(db)
    const issued = await requestLogin(db, 'a.korlyakov@easyto.travel')
    if (!('token' in issued)) throw new Error('токен не выдан')
    const before = Date.now()
    const consumed = await consumeLoginToken(db, issued.token)

    const rows = await db.select().from(sessions).where(eq(sessions.id, consumed!.sessionId))
    const lifetimeMs = rows[0]!.expiresAt.getTime() - before

    expect(lifetimeMs).toBeGreaterThan(7 * DAY_MS - 10_000)
    expect(lifetimeMs).toBeLessThan(7 * DAY_MS + 10_000)
  })

  it('активная сессия продлевается при обращении, если прошло больше половины срока', async () => {
    const db = await createTestDb()
    await seedMember(db)
    const issued = await requestLogin(db, 'a.korlyakov@easyto.travel')
    if (!('token' in issued)) throw new Error('токен не выдан')
    const consumed = await consumeLoginToken(db, issued.token)

    // До порога продления (половина от 7 дней = 3.5 дня) остаётся 1 день —
    // должно сработать скользящее продление.
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + 1 * DAY_MS) })
      .where(eq(sessions.id, consumed!.sessionId))

    const resolved = await resolveSession(db, consumed!.sessionId)
    expect(resolved).not.toBeNull()

    const rows = await db.select().from(sessions).where(eq(sessions.id, consumed!.sessionId))
    const remainingMs = rows[0]!.expiresAt.getTime() - Date.now()

    // Было продлено обратно к полному TTL (7 дней), а не осталось около
    // 1 дня, который был установлен выше.
    expect(remainingMs).toBeGreaterThan(6 * DAY_MS)
  })

  it('просроченная сессия не резолвится и не продлевается', async () => {
    // Наивная реализация "продлить, потом проверить" воскресила бы мёртвую
    // сессию: она безусловно отодвинула бы expiresAt в будущее ДО проверки
    // истечения, и последующая проверка always passed. Проверяем оба
    // инварианта: resolveSession возвращает null, и строка в базе не
    // тронута — expiresAt остаётся в прошлом, а не улетает на 7 дней вперёд.
    const db = await createTestDb()
    await seedMember(db)
    const issued = await requestLogin(db, 'a.korlyakov@easyto.travel')
    if (!('token' in issued)) throw new Error('токен не выдан')
    const consumed = await consumeLoginToken(db, issued.token)

    const past = new Date(Date.now() - 1000)
    await db.update(sessions).set({ expiresAt: past }).where(eq(sessions.id, consumed!.sessionId))

    expect(await resolveSession(db, consumed!.sessionId)).toBeNull()

    const rows = await db.select().from(sessions).where(eq(sessions.id, consumed!.sessionId))
    expect(rows[0]!.expiresAt.getTime()).toBe(past.getTime())
  })

  it('endAllSessionsForMember убивает все сессии участника и не трогает чужие', async () => {
    const db = await createTestDb()
    const memberA = await seedMember(db, 'a@example.com')
    const memberB = await seedMember(db, 'b@example.com')

    const issuedA1 = await requestLogin(db, 'a@example.com')
    const issuedA2 = await requestLogin(db, 'a@example.com')
    const issuedB = await requestLogin(db, 'b@example.com')
    if (!('token' in issuedA1) || !('token' in issuedA2) || !('token' in issuedB)) {
      throw new Error('токен не выдан')
    }
    const sessionA1 = await consumeLoginToken(db, issuedA1.token)
    const sessionA2 = await consumeLoginToken(db, issuedA2.token)
    const sessionB = await consumeLoginToken(db, issuedB.token)

    await endAllSessionsForMember(db, memberA)

    expect(await resolveSession(db, sessionA1!.sessionId)).toBeNull()
    expect(await resolveSession(db, sessionA2!.sessionId)).toBeNull()
    expect(await resolveSession(db, sessionB!.sessionId)).not.toBeNull()

    const remainingA = await db
      .select()
      .from(sessions)
      .where(eq(sessions.memberId, memberA))
    expect(remainingA).toHaveLength(0)

    const remainingB = await db
      .select()
      .from(sessions)
      .where(eq(sessions.memberId, memberB))
    expect(remainingB).toHaveLength(1)
  })
})
