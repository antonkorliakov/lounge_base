'use client'

import { useState } from 'react'
import type { Localized } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import {
  inviteMemberAction,
  setMemberPasswordAction,
  endMemberSessionsAction,
  removeMemberAction,
} from '@/app/admin/team/actions'

/**
 * Экран `/admin/team`. Всё разрешительное здесь — подсказки: настоящие
 * ворота (сверка почты при удалении, запрет удалять себя и ставить себе
 * пароль, минимальная длина пароля) — в действиях и `access/team.ts`,
 * серверное действие достижимо по сети напрямую (правило ветки).
 *
 * На своей строке нет ни удаления, ни «задать пароль» — не потому, что
 * сервер не откажет (откажет), а потому, что кнопка, единственный исход
 * которой — отказ, это приглашение в тупик: свой пароль меняется на
 * `/admin/password` (там спрашивают текущий), а «выйти на остальных
 * устройствах» — честный self-вариант kill switch'а, текущая сессия
 * переживает (см. `endMemberSessionsAction`).
 *
 * Список за спиной панелей обновляется `revalidatePath` из действий — тот
 * же механизм, что у `AddLounge`/`DeleteLounge` в реестре.
 */

const TITLE: Localized = { en: 'Team', ru: 'Команда' }
const BACK: Localized = { en: 'Back to lounges', ru: 'К списку лаунджей' }
const YOU: Localized = { en: '(you)', ru: '(вы)' }
const YES: Localized = { en: 'yes', ru: 'да' }
const NO: Localized = { en: 'no', ru: 'нет' }

const HEADERS: Localized[] = [
  { en: 'Name', ru: 'Имя' },
  { en: 'Email', ru: 'Почта' },
  { en: 'Joined', ru: 'В команде с' },
  { en: 'Password', ru: 'Пароль' },
]
const ACTIONS_HEADER: Localized = { en: 'Actions', ru: 'Действия' }

const INVITE_OPEN: Localized = { en: 'Invite member', ru: 'Пригласить в команду' }
const INVITE_TITLE: Localized = { en: 'New member', ru: 'Новый участник' }
const NAME_LABEL: Localized = { en: 'Name', ru: 'Имя' }
const EMAIL_LABEL: Localized = { en: 'Work email', ru: 'Рабочая почта' }
const INVITE_SUBMIT: Localized = { en: 'Add to team', ru: 'Добавить в команду' }
const CANCEL: Localized = { en: 'Cancel', ru: 'Отмена' }

const SET_PASSWORD: Localized = { en: 'Set password', ru: 'Задать пароль' }
const RESET_PASSWORD: Localized = { en: 'Reset password', ru: 'Сбросить пароль' }
const PASSWORD_LABEL: Localized = { en: 'Temporary password', ru: 'Временный пароль' }
const PASSWORD_SUBMIT: Localized = { en: 'Set', ru: 'Установить' }
const CHANGE_OWN: Localized = { en: 'Change password', ru: 'Сменить пароль' }

const SIGN_OUT_ALL: Localized = { en: 'Sign out everywhere', ru: 'Завершить все сессии' }
const SIGN_OUT_OTHERS: Localized = {
  en: 'Sign out my other devices',
  ru: 'Выйти на остальных устройствах',
}

const REMOVE: Localized = { en: 'Remove from team', ru: 'Удалить из команды' }
const REMOVE_CONFIRM: Localized = { en: 'Remove', ru: 'Удалить' }
// Диалог обязан назвать и цену, и то, что уцелеет: доступ обрывается сразу
// (сессии и ссылки входа умирают каскадом), а история проверки хранит почту
// текстом и остаётся — см. `removeTeamMember`.
const REMOVE_WARNING: Localized = {
  en: 'Removal takes effect immediately: their sessions end and sign-in stops working. Their past decisions and review comments stay in the history.',
  ru: 'Удаление действует сразу: сессии участника завершатся, вход перестанет работать. Их прошлые решения и замечания останутся в истории.',
}
const TYPE_EMAIL: Localized = {
  en: 'Type the member’s email to confirm',
  ru: 'Введите почту участника для подтверждения',
}

export type TeamMemberView = {
  id: string
  email: string
  name: string
  /** YYYY-MM-DD — день посчитан сервером, см. страницу. */
  joined: string
  hasPassword: boolean
  isSelf: boolean
}

/** Какая панель раскрыта — не больше одной на экран: две одновременно
 *  открытые опасные панели (пароль и удаление) — приглашение перепутать. */
type OpenPanel = { memberId: string; kind: 'password' | 'remove' } | null

export function TeamScreen(props: {
  members: TeamMemberView[]
  minPasswordLength: number
}): React.JSX.Element {
  const { pick } = useLocale()

  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [inviteError, setInviteError] = useState<Localized | null>(null)
  const [inviteNotice, setInviteNotice] = useState<Localized | null>(null)
  const [inviteBusy, setInviteBusy] = useState(false)

  const [open, setOpen] = useState<OpenPanel>(null)
  const [password, setPassword] = useState('')
  const [typedEmail, setTypedEmail] = useState('')
  const [rowError, setRowError] = useState<Localized | null>(null)
  // Уведомление живёт у строки, к которой относится, и переживает закрытие
  // панели — человек должен успеть прочитать «сессии завершены».
  const [rowNotice, setRowNotice] = useState<{ memberId: string; text: Localized } | null>(null)
  const [rowBusy, setRowBusy] = useState(false)

  // Микрокопия панели пароля собирается с настоящим правилом длины
  // (`MIN_PASSWORD_LENGTH` пропсом с сервера, см. страницу), и говорит
  // словами два обещания действия: почты нет — пароль передаётся из рук в
  // руки; установка завершает ВСЕ сессии участника.
  const passwordHint: Localized = {
    en: `At least ${props.minPasswordLength} characters. Email is not sent — tell the password to the colleague in person. Setting it signs them out everywhere.`,
    ru: `Не короче ${props.minPasswordLength} символов. Почта не отправляется — передайте пароль коллеге лично. Установка завершит все его сессии.`,
  }

  function closePanels(): void {
    setOpen(null)
    setPassword('')
    setTypedEmail('')
    setRowError(null)
  }

  function openPanel(memberId: string, kind: 'password' | 'remove'): void {
    closePanels()
    setRowNotice(null)
    setOpen({ memberId, kind })
  }

  async function invite(): Promise<void> {
    setInviteBusy(true)
    setInviteError(null)
    setInviteNotice(null)
    try {
      const result = await inviteMemberAction(inviteEmail, inviteName)
      if (result.ok) {
        setInviteEmail('')
        setInviteName('')
        setInviteOpen(false)
        setInviteNotice(result.notice ?? null)
      } else {
        setInviteError(result.error)
      }
    } finally {
      setInviteBusy(false)
    }
  }

  async function setMemberPassword(memberId: string): Promise<void> {
    setRowBusy(true)
    setRowError(null)
    try {
      const result = await setMemberPasswordAction(memberId, password)
      if (result.ok) {
        setRowNotice(result.notice ? { memberId, text: result.notice } : null)
        closePanels()
      } else {
        setRowError(result.error)
      }
    } finally {
      setRowBusy(false)
    }
  }

  async function endSessions(memberId: string): Promise<void> {
    setRowBusy(true)
    setRowNotice(null)
    try {
      const result = await endMemberSessionsAction(memberId)
      if (result.ok) {
        setRowNotice(result.notice ? { memberId, text: result.notice } : null)
      } else {
        setRowNotice({ memberId, text: result.error })
      }
    } finally {
      setRowBusy(false)
    }
  }

  async function remove(memberId: string): Promise<void> {
    setRowBusy(true)
    setRowError(null)
    try {
      const result = await removeMemberAction(memberId, typedEmail)
      if (result.ok) closePanels()
      else setRowError(result.error)
    } finally {
      setRowBusy(false)
    }
  }

  return (
    <main className="team">
      <header className="team-top">
        <h1>{pick(TITLE)}</h1>
        <a className="team-back" href="/admin">
          {pick(BACK)}
        </a>
      </header>

      {!inviteOpen ? (
        <button type="button" className="al-open" onClick={() => setInviteOpen(true)}>
          {pick(INVITE_OPEN)}
        </button>
      ) : (
        <div className="al-panel">
          <p className="al-title">{pick(INVITE_TITLE)}</p>
          <label className="al-field">
            {pick(EMAIL_LABEL)}
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
            />
          </label>
          <label className="al-field">
            {pick(NAME_LABEL)}
            <input value={inviteName} onChange={(e) => setInviteName(e.target.value)} />
          </label>
          {inviteError && <p className="se-error">{pick(inviteError)}</p>}
          <div className="se-actions">
            <button type="button" disabled={inviteBusy} onClick={() => void invite()}>
              {pick(INVITE_SUBMIT)}
            </button>
            <button
              type="button"
              disabled={inviteBusy}
              onClick={() => {
                setInviteOpen(false)
                setInviteError(null)
              }}
            >
              {pick(CANCEL)}
            </button>
          </div>
        </div>
      )}
      {inviteNotice && <p className="tm-notice">{pick(inviteNotice)}</p>}

      <table className="registry-table team-table">
        <thead>
          <tr>
            {HEADERS.map((header) => (
              <th key={header.en}>{pick(header)}</th>
            ))}
            <th>
              <span className="vh">{pick(ACTIONS_HEADER)}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {props.members.map((member) => {
            const panel = open?.memberId === member.id ? open.kind : null
            return (
              <tr key={member.id}>
                <td>
                  {member.name}
                  {member.isSelf && <span className="team-you"> {pick(YOU)}</span>}
                </td>
                <td>{member.email}</td>
                <td>{member.joined}</td>
                <td>{pick(member.hasPassword ? YES : NO)}</td>
                <td className="team-actions-cell">
                  <div className="team-actions">
                    {member.isSelf ? (
                      <>
                        <a className="tm-link" href="/admin/password">
                          {pick(CHANGE_OWN)}
                        </a>
                        <button
                          type="button"
                          className="tm-btn"
                          disabled={rowBusy}
                          onClick={() => void endSessions(member.id)}
                        >
                          {pick(SIGN_OUT_OTHERS)}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="tm-btn"
                          disabled={rowBusy}
                          onClick={() =>
                            panel === 'password'
                              ? closePanels()
                              : openPanel(member.id, 'password')
                          }
                        >
                          {pick(member.hasPassword ? RESET_PASSWORD : SET_PASSWORD)}
                        </button>
                        <button
                          type="button"
                          className="tm-btn"
                          disabled={rowBusy}
                          onClick={() => void endSessions(member.id)}
                        >
                          {pick(SIGN_OUT_ALL)}
                        </button>
                        <button
                          type="button"
                          className="tm-btn tm-remove"
                          disabled={rowBusy}
                          onClick={() =>
                            panel === 'remove' ? closePanels() : openPanel(member.id, 'remove')
                          }
                        >
                          {pick(REMOVE)}
                        </button>
                      </>
                    )}
                  </div>

                  {panel === 'password' && (
                    <div className="tm-panel">
                      <label className="al-field">
                        {pick(PASSWORD_LABEL)}
                        <input
                          type="password"
                          autoComplete="off"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                        />
                      </label>
                      <p className="tm-note">{pick(passwordHint)}</p>
                      {rowError && <p className="se-error">{pick(rowError)}</p>}
                      <div className="se-actions">
                        <button
                          type="button"
                          disabled={rowBusy || password.length < props.minPasswordLength}
                          onClick={() => void setMemberPassword(member.id)}
                        >
                          {pick(PASSWORD_SUBMIT)}
                        </button>
                        <button type="button" disabled={rowBusy} onClick={closePanels}>
                          {pick(CANCEL)}
                        </button>
                      </div>
                    </div>
                  )}

                  {panel === 'remove' && (
                    <div className="tm-panel tm-panel-danger">
                      <p className="dl-warning">{pick(REMOVE_WARNING)}</p>
                      <label className="al-field">
                        {pick(TYPE_EMAIL)}
                        <input value={typedEmail} onChange={(e) => setTypedEmail(e.target.value)} />
                      </label>
                      {rowError && <p className="se-error">{pick(rowError)}</p>}
                      <div className="se-actions">
                        <button
                          type="button"
                          className="dl-danger"
                          disabled={
                            rowBusy ||
                            typedEmail.trim().toLowerCase() !== member.email
                          }
                          onClick={() => void remove(member.id)}
                        >
                          {pick(REMOVE_CONFIRM)}
                        </button>
                        <button type="button" disabled={rowBusy} onClick={closePanels}>
                          {pick(CANCEL)}
                        </button>
                      </div>
                    </div>
                  )}

                  {rowNotice?.memberId === member.id && (
                    <p className="tm-notice">{pick(rowNotice.text)}</p>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </main>
  )
}
