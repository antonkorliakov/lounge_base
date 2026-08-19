import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import {
  teamMembers, loginTokens, sessions, lounges, submissions, fieldFlags,
} from '@/db/schema'
import {
  addTeamMember,
  inviteTeamMember,
  listTeamMembers,
  removeTeamMember,
  requestLogin,
  consumeLoginToken,
  resolveSession,
  setMemberPassword,
} from '../team'

/**
 * Управление командой с экрана `/admin/team` (список, приглашение, удаление).
 * Вход и сессии держит `team.test.ts`; здесь — то, что появилось вместе с
 * экраном: проекция списка без хэша, перевод дубликата в локализованный
 * отказ вместо исключения и ворота удаления (сверка почты, запрет удалять
 * себя, что каскадится и что переживает).
 */

async function memberWithSession(db: Db, email: string): Promise<{
  memberId: string
  sessionId: string
}> {
  const { id } = await addTeamMember(db, { email, name: 'Member' })
  const issued = await requestLogin(db, email)
  if (!('token' in issued)) throw new Error('токен не выдан')
  const consumed = await consumeLoginToken(db, issued.token)
  return { memberId: id, sessionId: consumed!.sessionId }
}

describe('listTeamMembers', () => {
  it('отдаёт имя, почту, дату и факт пароля — и НЕ отдаёт сам хэш', async () => {
    const db = await createTestDb()
    const { id: withPw } = await addTeamMember(db, { email: 'pw@example.com', name: 'With' })
    await addTeamMember(db, { email: 'nopw@example.com', name: 'Without' })
    const set = await setMemberPassword(db, withPw, 'password-123')
    expect(set.ok).toBe(true)

    const listed = await listTeamMembers(db)

    expect(listed).toHaveLength(2)
    const byEmail = Object.fromEntries(listed.map((m) => [m.email, m]))
    expect(byEmail['pw@example.com']).toMatchObject({ name: 'With', hasPassword: true })
    expect(byEmail['nopw@example.com']).toMatchObject({ name: 'Without', hasPassword: false })
    for (const row of listed) {
      // Проекция не содержит колонки хэша ни под каким именем: булево
      // «есть ли пароль» вычислен в SQL, хэш не покидал базу.
      expect(Object.keys(row).sort()).toEqual(
        ['createdAt', 'email', 'hasPassword', 'id', 'name'],
      )
      expect(row.createdAt).toBeInstanceOf(Date)
    }
  })
})

describe('inviteTeamMember', () => {
  it('заводит участника с нормализованной почтой', async () => {
    const db = await createTestDb()

    const result = await inviteTeamMember(db, { email: ' New@Example.COM ', name: ' New Member ' })

    expect(result.ok).toBe(true)
    const rows = await db.select().from(teamMembers)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ email: 'new@example.com', name: 'New Member' })
  })

  it('дубликат почты — локализованный отказ, а не исключение', async () => {
    const db = await createTestDb()
    await addTeamMember(db, { email: 'dup@example.com', name: 'Original' })

    const result = await inviteTeamMember(db, { email: 'dup@example.com', name: 'Copy' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.ru).toContain('уже в команде')
    expect(result.error.en).toBeTruthy()
    expect(await db.select().from(teamMembers)).toHaveLength(1)
  })

  it('адрес, отличающийся только регистром, — тот же дубликат', async () => {
    const db = await createTestDb()
    await addTeamMember(db, { email: 'case@example.com', name: 'Original' })

    const result = await inviteTeamMember(db, { email: 'CASE@Example.com', name: 'Copy' })

    expect(result.ok).toBe(false)
    expect(await db.select().from(teamMembers)).toHaveLength(1)
  })

  it('адрес без @ и пустое имя отвергаются до записи', async () => {
    const db = await createTestDb()

    expect((await inviteTeamMember(db, { email: 'not-an-email', name: 'X' })).ok).toBe(false)
    expect((await inviteTeamMember(db, { email: '   ', name: 'X' })).ok).toBe(false)
    expect((await inviteTeamMember(db, { email: 'ok@example.com', name: '  ' })).ok).toBe(false)
    expect(await db.select().from(teamMembers)).toHaveLength(0)
  })
})

describe('setMemberPassword по id', () => {
  it('несуществующий участник — отказ, а не тихий успех', async () => {
    const db = await createTestDb()

    const result = await setMemberPassword(
      db,
      '00000000-0000-0000-0000-000000000000',
      'password-123',
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.ru).toContain('уже нет в команде')
  })
})

describe('removeTeamMember', () => {
  it('удаляет участника после сверки почты; его сессии и токены умирают каскадом', async () => {
    const db = await createTestDb()
    const actor = await memberWithSession(db, 'actor@example.com')
    const target = await memberWithSession(db, 'target@example.com')

    const result = await removeTeamMember(db, {
      memberId: target.memberId,
      // Регистр и края — опечатки ввода, не другой адрес (правило записи).
      confirmEmail: ' Target@Example.COM ',
      actorMemberId: actor.memberId,
    })

    expect(result).toEqual({ ok: true })
    expect(await db.select().from(teamMembers)).toHaveLength(1)
    expect(await resolveSession(db, target.sessionId)).toBeNull()
    expect(
      await db.select().from(sessions).where(eq(sessions.memberId, target.memberId)),
    ).toHaveLength(0)
    expect(
      await db.select().from(loginTokens).where(eq(loginTokens.memberId, target.memberId)),
    ).toHaveLength(0)
    // Чужая сессия не тронута.
    expect(await resolveSession(db, actor.sessionId)).not.toBeNull()
  })

  it('себя удалить нельзя — даже с верно набранной почтой', async () => {
    const db = await createTestDb()
    const actor = await memberWithSession(db, 'self@example.com')

    const result = await removeTeamMember(db, {
      memberId: actor.memberId,
      confirmEmail: 'self@example.com',
      actorMemberId: actor.memberId,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.ru).toContain('самого себя')
    expect(await db.select().from(teamMembers)).toHaveLength(1)
    expect(await resolveSession(db, actor.sessionId)).not.toBeNull()
  })

  it('несовпавшая почта — отказ, участник цел', async () => {
    const db = await createTestDb()
    const actor = await memberWithSession(db, 'actor@example.com')
    const target = await memberWithSession(db, 'target@example.com')

    const result = await removeTeamMember(db, {
      memberId: target.memberId,
      confirmEmail: 'wrong@example.com',
      actorMemberId: actor.memberId,
    })

    expect(result.ok).toBe(false)
    expect(await db.select().from(teamMembers)).toHaveLength(2)
    expect(await resolveSession(db, target.sessionId)).not.toBeNull()
  })

  it('уже удалённый участник — честный отказ «нет в команде»', async () => {
    const db = await createTestDb()
    const actor = await memberWithSession(db, 'actor@example.com')

    const result = await removeTeamMember(db, {
      memberId: '00000000-0000-0000-0000-000000000000',
      confirmEmail: 'gone@example.com',
      actorMemberId: actor.memberId,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.ru).toContain('уже нет в команде')
  })

  it('история проверки переживает удаление: reviewerId и замечания хранят почту текстом', async () => {
    const db = await createTestDb()
    const actor = await memberWithSession(db, 'actor@example.com')
    const target = await memberWithSession(db, 'reviewer@example.com')

    const [lounge] = await db
      .insert(lounges)
      .values({ name: 'L', iataCode: 'IST', country: 'TR', city: 'Ist', airport: 'IST' })
      .returning({ id: lounges.id })
    const [submission] = await db
      .insert(submissions)
      .values({ loungeId: lounge!.id, reviewerId: 'reviewer@example.com' })
      .returning({ id: submissions.id })
    await db.insert(fieldFlags).values({
      submissionId: submission!.id,
      fieldKey: 'II.1.1',
      comment: 'проверить часы работы',
      createdBy: 'reviewer@example.com',
    })

    const result = await removeTeamMember(db, {
      memberId: target.memberId,
      confirmEmail: 'reviewer@example.com',
      actorMemberId: actor.memberId,
    })
    expect(result).toEqual({ ok: true })

    // Прошлые решения и замечания остались читаемыми — именно это обещает
    // диалог подтверждения на экране.
    const subs = await db.select().from(submissions)
    expect(subs[0]!.reviewerId).toBe('reviewer@example.com')
    const flags = await db.select().from(fieldFlags)
    expect(flags).toHaveLength(1)
    expect(flags[0]!.createdBy).toBe('reviewer@example.com')
    expect(flags[0]!.comment).toBe('проверить часы работы')
  })
})
