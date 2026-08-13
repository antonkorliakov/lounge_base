import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { teamMembers, sessions } from '@/db/schema'
import {
  addTeamMember,
  loginWithPassword,
  setMemberPassword,
  setMemberPasswordByEmail,
  endOtherSessionsForMember,
  resolveSession,
  PASSWORD_LOCKOUT_THRESHOLD,
  PASSWORD_LOCKOUT_MINUTES,
  SESSION_TTL_DAYS,
} from '../team'

const DAY_MS = 24 * 60 * 60 * 1000
const EMAIL = 'reviewer@example.com'
const PASSWORD = 'correct horse battery staple'

async function seedWithPassword(db: Db): Promise<string> {
  const { id } = await addTeamMember(db, { email: EMAIL, name: 'Reviewer' })
  const set = await setMemberPassword(db, id, PASSWORD)
  if (!set.ok) throw new Error('пароль не установлен')
  return id
}

async function memberRow(db: Db, memberId: string) {
  const rows = await db.select().from(teamMembers).where(eq(teamMembers.id, memberId))
  return rows[0]!
}

describe('парольный вход', () => {
  it('верный пароль открывает сессию, которая резолвится как обычная', async () => {
    const db = await createTestDb()
    const memberId = await seedWithPassword(db)

    const result = await loginWithPassword(db, EMAIL, PASSWORD)

    expect(result).not.toBeNull()
    expect(result!.memberId).toBe(memberId)
    const session = await resolveSession(db, result!.sessionId)
    expect(session?.email).toBe(EMAIL)
  })

  it('сессия парольного входа живёт столько же, сколько сессия magic-ссылки — 7 дней', async () => {
    // Общий `createSession`: у второго пути входа не должно быть своего TTL.
    const db = await createTestDb()
    await seedWithPassword(db)
    const before = Date.now()

    const result = await loginWithPassword(db, EMAIL, PASSWORD)

    const rows = await db.select().from(sessions).where(eq(sessions.id, result!.sessionId))
    const lifetimeMs = rows[0]!.expiresAt.getTime() - before
    expect(lifetimeMs).toBeGreaterThan(SESSION_TTL_DAYS * DAY_MS - 10_000)
    expect(lifetimeMs).toBeLessThan(SESSION_TTL_DAYS * DAY_MS + 10_000)
  })

  it('почта сверяется без учёта регистра, как у magic-ссылки', async () => {
    const db = await createTestDb()
    const memberId = await seedWithPassword(db)

    const result = await loginWithPassword(db, 'Reviewer@Example.COM', PASSWORD)
    expect(result?.memberId).toBe(memberId)
  })

  it('неверный пароль, неизвестная почта и участник без пароля получают НЕОТЛИЧИМЫЙ результат', async () => {
    const db = await createTestDb()
    await seedWithPassword(db)
    await addTeamMember(db, { email: 'no-password@example.com', name: 'No Password' })

    const wrongPassword = await loginWithPassword(db, EMAIL, 'not the password')
    const unknownEmail = await loginWithPassword(db, 'stranger@example.com', PASSWORD)
    const noPassword = await loginWithPassword(db, 'no-password@example.com', PASSWORD)

    // Строгое равенство значений, не «все трое falsy»: различие обязано
    // умереть в loginWithPassword, а не в том, как его прочитал вызывающий.
    expect(wrongPassword).toBeNull()
    expect(unknownEmail).toBe(wrongPassword)
    expect(noPassword).toBe(wrongPassword)

    // И ни одной сессии ни по одной из веток.
    expect(await db.select().from(sessions)).toHaveLength(0)
  })

  it('после порога неудач верный пароль перестаёт открывать сессию — и ответ тот же null', async () => {
    const db = await createTestDb()
    const memberId = await seedWithPassword(db)

    for (let i = 0; i < PASSWORD_LOCKOUT_THRESHOLD; i++) {
      expect(await loginWithPassword(db, EMAIL, 'wrong')).toBeNull()
    }

    const row = await memberRow(db, memberId)
    expect(row.failedPasswordAttempts).toBe(PASSWORD_LOCKOUT_THRESHOLD)
    const remainingMs = row.passwordLockedUntil!.getTime() - Date.now()
    expect(remainingMs).toBeGreaterThan((PASSWORD_LOCKOUT_MINUTES - 1) * 60 * 1000)
    expect(remainingMs).toBeLessThan((PASSWORD_LOCKOUT_MINUTES + 1) * 60 * 1000)

    // Блокировка неотличима от неверного пароля — тот же null, никакого
    // отдельного «вы заблокированы», подтверждающего существование адреса.
    expect(await loginWithPassword(db, EMAIL, PASSWORD)).toBeNull()
    expect(await db.select().from(sessions)).toHaveLength(0)
  })

  it('до порога блокировки нет: одна неудача не мешает следующему верному входу', async () => {
    const db = await createTestDb()
    const memberId = await seedWithPassword(db)

    expect(await loginWithPassword(db, EMAIL, 'wrong')).toBeNull()
    expect((await memberRow(db, memberId)).failedPasswordAttempts).toBe(1)

    expect(await loginWithPassword(db, EMAIL, PASSWORD)).not.toBeNull()
  })

  it('истёкшая блокировка снимается: верный пароль входит, счётчик гаснет', async () => {
    const db = await createTestDb()
    const memberId = await seedWithPassword(db)
    await db
      .update(teamMembers)
      .set({
        failedPasswordAttempts: PASSWORD_LOCKOUT_THRESHOLD,
        passwordLockedUntil: new Date(Date.now() - 1000),
      })
      .where(eq(teamMembers.id, memberId))

    expect(await loginWithPassword(db, EMAIL, PASSWORD)).not.toBeNull()

    const row = await memberRow(db, memberId)
    expect(row.failedPasswordAttempts).toBe(0)
    expect(row.passwordLockedUntil).toBeNull()
  })

  it('неудача после истёкшей блокировки начинает счёт заново, а не блокирует с одной попытки', async () => {
    const db = await createTestDb()
    const memberId = await seedWithPassword(db)
    await db
      .update(teamMembers)
      .set({
        failedPasswordAttempts: PASSWORD_LOCKOUT_THRESHOLD,
        passwordLockedUntil: new Date(Date.now() - 1000),
      })
      .where(eq(teamMembers.id, memberId))

    expect(await loginWithPassword(db, EMAIL, 'wrong')).toBeNull()

    const row = await memberRow(db, memberId)
    expect(row.failedPasswordAttempts).toBe(1)
    expect(row.passwordLockedUntil).toBeNull()
  })

  it('успешный вход гасит накопленные неудачи', async () => {
    const db = await createTestDb()
    const memberId = await seedWithPassword(db)
    for (let i = 0; i < PASSWORD_LOCKOUT_THRESHOLD - 1; i++) {
      await loginWithPassword(db, EMAIL, 'wrong')
    }
    expect((await memberRow(db, memberId)).failedPasswordAttempts).toBe(
      PASSWORD_LOCKOUT_THRESHOLD - 1,
    )

    expect(await loginWithPassword(db, EMAIL, PASSWORD)).not.toBeNull()
    expect((await memberRow(db, memberId)).failedPasswordAttempts).toBe(0)
  })

  it('две параллельные неудачи считаются обе: инкремент — арифметика в SQL, а не read-modify-write', async () => {
    const db = await createTestDb()
    const memberId = await seedWithPassword(db)

    await Promise.all([
      loginWithPassword(db, EMAIL, 'wrong one'),
      loginWithPassword(db, EMAIL, 'wrong two'),
    ])

    expect((await memberRow(db, memberId)).failedPasswordAttempts).toBe(2)
  })

  it('setMemberPassword отклоняет короткий пароль и не пишет ничего', async () => {
    const db = await createTestDb()
    const { id } = await addTeamMember(db, { email: EMAIL, name: 'Reviewer' })

    const result = await setMemberPassword(db, id, 'short')

    expect(result.ok).toBe(false)
    expect((await memberRow(db, id)).passwordHash).toBeNull()
  })

  it('смена пароля гасит блокировку: новый пароль входит сразу', async () => {
    const db = await createTestDb()
    const memberId = await seedWithPassword(db)
    await db
      .update(teamMembers)
      .set({
        failedPasswordAttempts: PASSWORD_LOCKOUT_THRESHOLD,
        passwordLockedUntil: new Date(Date.now() + 10 * 60 * 1000),
      })
      .where(eq(teamMembers.id, memberId))

    const set = await setMemberPassword(db, memberId, 'brand new password')
    expect(set.ok).toBe(true)

    expect(await loginWithPassword(db, EMAIL, 'brand new password')).not.toBeNull()
    expect(await loginWithPassword(db, EMAIL, PASSWORD)).toBeNull()
  })

  it('сырой пароль не хранится в базе', async () => {
    const db = await createTestDb()
    const memberId = await seedWithPassword(db)
    const row = await memberRow(db, memberId)
    expect(row.passwordHash).not.toBeNull()
    expect(row.passwordHash).not.toContain(PASSWORD)
  })

  it('setMemberPasswordByEmail: ops-путь — от адреса в любом регистре до входа', async () => {
    const db = await createTestDb()
    await addTeamMember(db, { email: EMAIL, name: 'Reviewer' })

    const set = await setMemberPasswordByEmail(db, 'Reviewer@Example.COM', 'ops-set password')
    expect(set.ok).toBe(true)

    expect(await loginWithPassword(db, EMAIL, 'ops-set password')).not.toBeNull()
  })

  it('setMemberPasswordByEmail: неизвестная почта — честный отказ, участник не создаётся', async () => {
    const db = await createTestDb()

    const result = await setMemberPasswordByEmail(db, 'stranger@example.com', 'long enough password')

    expect(result.ok).toBe(false)
    expect(await db.select().from(teamMembers)).toHaveLength(0)
  })

  it('endOtherSessionsForMember: отзывает остальные сессии участника, текущую и чужие не трогает', async () => {
    const db = await createTestDb()
    const memberId = await seedWithPassword(db)
    const { id: otherId } = await addTeamMember(db, { email: 'other@example.com', name: 'Other' })
    const otherSet = await setMemberPassword(db, otherId, 'other password 1')
    if (!otherSet.ok) throw new Error('пароль не установлен')

    const current = await loginWithPassword(db, EMAIL, PASSWORD)
    const stale = await loginWithPassword(db, EMAIL, PASSWORD)
    const foreign = await loginWithPassword(db, 'other@example.com', 'other password 1')

    await endOtherSessionsForMember(db, memberId, current!.sessionId)

    expect(await resolveSession(db, current!.sessionId)).not.toBeNull()
    expect(await resolveSession(db, stale!.sessionId)).toBeNull()
    expect(await resolveSession(db, foreign!.sessionId)).not.toBeNull()
  })
})
