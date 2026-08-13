'use client'

import { useState } from 'react'
import type { Localized } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { changePasswordAction } from '@/app/admin/password/actions'

/**
 * Форма смены пароля (`/admin/password`). Совпадение нового пароля с
 * повтором — клиентская проверка: это защита от опечатки, а не правило
 * доступа; правило (минимальная длина, единственная точка записи) живёт в
 * `setMemberPassword`, и действие вернёт его отказ, если клиента обошли.
 *
 * `hasPassword` приходит со страницы (серверное знание): у участника без
 * пароля поля «текущий» нет — требовать пароль, которого не существует,
 * значило бы запереть его от самой возможности пароль завести.
 */
const TITLE: Localized = { en: 'Change password', ru: 'Смена пароля' }
const SET_TITLE: Localized = { en: 'Set a password', ru: 'Задать пароль' }
const CURRENT_LABEL: Localized = { en: 'Current password', ru: 'Текущий пароль' }
const NEW_LABEL: Localized = { en: 'New password', ru: 'Новый пароль' }
const REPEAT_LABEL: Localized = { en: 'New password, again', ru: 'Новый пароль ещё раз' }
const SUBMIT: Localized = { en: 'Change password', ru: 'Сменить пароль' }
const SET_SUBMIT: Localized = { en: 'Set password', ru: 'Задать пароль' }
const MISMATCH: Localized = {
  en: 'The two entries do not match',
  ru: 'Введённые пароли не совпадают',
}
const BACK: Localized = { en: 'Back to lounges', ru: 'К списку лаунджей' }

export function PasswordChange(props: { hasPassword: boolean }): React.JSX.Element {
  const { pick } = useLocale()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState<Localized | null>(null)
  const [notice, setNotice] = useState<Localized | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (): Promise<void> => {
    if (next !== repeat) {
      setError(MISMATCH)
      return
    }
    setPending(true)
    setError(null)
    setNotice(null)
    const result = await changePasswordAction(current, next)
    if (result.ok) {
      setNotice(result.notice ?? null)
      setCurrent('')
      setNext('')
      setRepeat('')
    } else {
      setError(result.error)
    }
    setPending(false)
  }

  const filled = next !== '' && repeat !== '' && (!props.hasPassword || current !== '')

  return (
    <main className="login pw">
      <h1>{pick(props.hasPassword ? TITLE : SET_TITLE)}</h1>
      {props.hasPassword && (
        <>
          <label htmlFor="pw-current">{pick(CURRENT_LABEL)}</label>
          <input
            id="pw-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </>
      )}
      <label htmlFor="pw-new">{pick(NEW_LABEL)}</label>
      <input
        id="pw-new"
        type="password"
        autoComplete="new-password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />
      <label htmlFor="pw-repeat">{pick(REPEAT_LABEL)}</label>
      <input
        id="pw-repeat"
        type="password"
        autoComplete="new-password"
        value={repeat}
        onChange={(e) => setRepeat(e.target.value)}
      />
      <button type="button" disabled={pending || !filled} onClick={() => void submit()}>
        {pick(props.hasPassword ? SUBMIT : SET_SUBMIT)}
      </button>
      {error && <p className="pw-error">{pick(error)}</p>}
      {notice && <p className="pw-notice">{pick(notice)}</p>}
      <a className="pw-back" href="/admin">
        {pick(BACK)}
      </a>
    </main>
  )
}
