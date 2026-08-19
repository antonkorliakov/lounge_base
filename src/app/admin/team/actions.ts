'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { db } from '@/db/client'
import { requireSession, SESSION_COOKIE } from '@/access/session'
import {
  inviteTeamMember,
  removeTeamMember,
  setMemberPassword,
  endAllSessionsForMember,
  endOtherSessionsForMember,
} from '@/access/team'
import type { Localized } from '@/form-schema'
import type { ActionResult } from '../s/[submissionId]/actions'

/**
 * Действия экрана команды (`/admin/team`). Все четыре возвращают общий
 * `ActionResult` (импортирован, не переобъявлен): успех здесь не несёт
 * данных, а `error`/`notice` — весь `Localized`, выбирает клиент через
 * `pick()`. `requireSession()` — первым оператором каждого действия, как у
 * всех действий кабинета: серверное действие достижимо по сети напрямую,
 * клиентские кнопки — подсказки.
 *
 * Довод об энумерации (один нейтральный ответ на любой адрес — форма входа)
 * здесь НЕ применяется: собеседник уже аутентифицирован и видит список
 * команды целиком, прятать «эта почта уже в команде» не от кого. Что
 * действительно нельзя выносить — хэши (их не выбирает даже страница, см.
 * `listTeamMembers`) и пароль: он приходит в теле действия, не в URL, не
 * пишется ни в один лог и не возвращается ни в одном результате — действие
 * отвечает только ok/отказ.
 */

const INVITED_NOTICE: Localized = {
  en: 'Added to the team. No email is sent yet — set them a temporary password and pass it on in person.',
  ru: 'Добавлен в команду. Почта пока не отправляется — задайте временный пароль и передайте его лично.',
}

export async function inviteMemberAction(
  email: string,
  name: string,
): Promise<ActionResult> {
  await requireSession()

  const result = await inviteTeamMember(db(), { email, name })
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/admin/team')
  return { ok: true, notice: INVITED_NOTICE }
}

const OWN_PASSWORD_HERE: Localized = {
  en: 'Change your own password on the password page — it asks for your current one.',
  ru: 'Свой пароль меняйте на странице пароля — там спрашивается текущий.',
}

const PASSWORD_SET_NOTICE: Localized = {
  en: 'Password set. All their sessions were signed out — tell them the password in person, email is not sent.',
  ru: 'Пароль установлен. Все сессии участника завершены — передайте пароль лично, почта не отправляется.',
}

/**
 * Задать/сбросить пароль УЧАСТНИКУ — не себе. Себе — отказ с адресом
 * `/admin/password`, и это не удобство, а граница: путь смены СВОЕГО пароля
 * требует текущий (сессия — доказательство входа, но не владения паролем,
 * см. `changePasswordAction`), и действие, ставящее себе пароль без этой
 * проверки, было бы вторым путём в обход неё — открытый ноутбук в
 * переговорке тихо перехватывал бы аккаунт.
 *
 * Успех отзывает ВСЕ сессии участника (`endAllSessionsForMember`), включая
 * ту, в которой он, возможно, сейчас работает, — в отличие от смены СВОЕГО
 * пароля, где текущая сессия переживает (`endOtherSessionsForMember` в
 * `changePasswordAction`). Разница не случайна: сброс чужого пароля делают,
 * когда доступ человека под вопросом (забыл пароль — значит, старые сессии
 * бесхозны; скомпрометирован — тем более), и щадить какую-то из его сессий
 * значило бы оставить ровно то, что сброс должен закрыть. Владелец получает
 * новый пароль из рук коллеги и входит заново.
 */
export async function setMemberPasswordAction(
  memberId: string,
  password: string,
): Promise<ActionResult> {
  const session = await requireSession()

  if (memberId === session.memberId) {
    return { ok: false, error: OWN_PASSWORD_HERE }
  }

  const result = await setMemberPassword(db(), memberId, password)
  if (!result.ok) return result

  await endAllSessionsForMember(db(), memberId)

  // «Есть пароль» в списке мог поменяться с «нет» на «да».
  revalidatePath('/admin/team')
  return { ok: true, notice: PASSWORD_SET_NOTICE }
}

const ALL_SESSIONS_ENDED: Localized = {
  en: 'All their sessions were signed out. Sign-in (link or password) still works.',
  ru: 'Все сессии участника завершены. Вход (по ссылке или паролю) продолжает работать.',
}

const OTHER_SESSIONS_ENDED: Localized = {
  en: 'Your other devices were signed out. This one stays signed in.',
  ru: 'Остальные ваши устройства разлогинены. Это — осталось в системе.',
}

/**
 * Kill switch (`endAllSessionsForMember` — до этого экрана у него не было ни
 * одного вызывающего в продукте) с одним исключением: для СЕБЯ действие
 * щадит текущую сессию (`endOtherSessionsForMember`). «Разлогинить себя
 * везде, включая здесь» — это кнопка выхода, а не эта; честное имя
 * self-варианта — «выйти на остальных устройствах», и клиент подписывает
 * две ветки по-разному. Полный отзыв СВОЕГО доступа этим экраном не
 * выражается намеренно — как и самоудаление: обе операции оставили бы
 * человека за дверью по ошибочному клику.
 *
 * Участник без единой сессии — тот же тихий успех: цель «сессий нет»
 * достигнута, и отказ «нечего завершать» заставлял бы различать состояния,
 * которые для нажавшего неразличимы по последствиям.
 */
export async function endMemberSessionsAction(
  memberId: string,
): Promise<ActionResult> {
  const session = await requireSession()

  if (memberId === session.memberId) {
    // requireSession уже гарантировал, что cookie есть и сессия живая.
    const store = await cookies()
    const currentSessionId = store.get(SESSION_COOKIE)!.value
    await endOtherSessionsForMember(db(), memberId, currentSessionId)
    return { ok: true, notice: OTHER_SESSIONS_ENDED }
  }

  await endAllSessionsForMember(db(), memberId)
  return { ok: true, notice: ALL_SESSIONS_ENDED }
}

/**
 * Удалить участника. Ворота — почта, набранная руками, и сверяет её СЕРВЕР
 * (`removeTeamMember`): там же запрет удалять себя (самозапирание) и
 * перечень того, что умирает каскадом (sessions, login_tokens), а что
 * остаётся (история проверки — почта в ней хранится текстом).
 */
export async function removeMemberAction(
  memberId: string,
  confirmEmail: string,
): Promise<ActionResult> {
  const session = await requireSession()

  const result = await removeTeamMember(db(), {
    memberId,
    confirmEmail,
    actorMemberId: session.memberId,
  })
  if (!result.ok) return result

  revalidatePath('/admin/team')
  return { ok: true }
}
