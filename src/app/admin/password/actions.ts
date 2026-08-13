'use server'

import { cookies } from 'next/headers'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireSession, SESSION_COOKIE } from '@/access/session'
import { setMemberPassword, endOtherSessionsForMember } from '@/access/team'
import { verifyPassword } from '@/access/password'
import { teamMembers } from '@/db/schema'
import type { Localized } from '@/form-schema'
import type { ActionResult } from '../s/[submissionId]/actions'

const WRONG_CURRENT: Localized = {
  en: 'Current password is incorrect',
  ru: 'Текущий пароль не подходит',
}

const DONE_NOTICE: Localized = {
  en: 'Password updated. Other signed-in sessions were signed out.',
  ru: 'Пароль обновлён. Остальные открытые сессии завершены.',
}

/**
 * Смена пароля участником. `requireSession()` — первым оператором, как у
 * всех действий кабинета.
 *
 * Текущий пароль обязателен, ЕСЛИ он установлен: сессия — доказательство
 * входа, но не владения паролем (открытый ноутбук в переговорке не должен
 * позволять тихо перехватить аккаунт сменой пароля). У участника без пароля
 * (первый заводится через `ops set-password`, но страница обязана работать
 * и до этого) требовать нечего — поле не показывается (`hasPassword` у
 * страницы) и не проверяется.
 *
 * Ошибка «текущий пароль не подходит» здесь РАЗЛИЧИМАЯ, в отличие от формы
 * входа: собеседник уже аутентифицирован, существование аккаунта ему
 * известно — прятать причину не от кого, а немой отказ мешал бы человеку.
 * По той же причине здесь нет пола на время ответа. Защита от подбора
 * текущего пароля через эту форму — та же сессионная граница: подбирать
 * может только тот, кто уже держит живую сессию.
 *
 * Успех отзывает ВСЕ ОСТАЛЬНЫЕ сессии участника (`endOtherSessionsForMember`) —
 * смена пароля и есть канонический момент для этого: если пароль меняют из-за
 * подозрения на утечку, чужая живая сессия обесценила бы смену. Текущая
 * сессия (эта, из cookie) переживает — разлогинить человека в ответ на
 * правильное действие было бы наказанием за осторожность.
 */
export async function changePasswordAction(
  currentPassword: string,
  newPassword: string,
): Promise<ActionResult> {
  const session = await requireSession()

  const rows = await db()
    .select({ passwordHash: teamMembers.passwordHash })
    .from(teamMembers)
    .where(eq(teamMembers.id, session.memberId))
    .limit(1)

  const storedHash = rows[0]?.passwordHash ?? null
  if (storedHash !== null && !(await verifyPassword(currentPassword, storedHash))) {
    return { ok: false, error: WRONG_CURRENT }
  }

  const result = await setMemberPassword(db(), session.memberId, newPassword)
  if (!result.ok) return result

  // requireSession уже гарантировал, что cookie есть и сессия живая.
  const store = await cookies()
  const currentSessionId = store.get(SESSION_COOKIE)!.value
  await endOtherSessionsForMember(db(), session.memberId, currentSessionId)

  return { ok: true, notice: DONE_NOTICE }
}
