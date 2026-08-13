'use client'

import { useState } from 'react'
import type { Localized } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { loginWithPasswordAction, requestLoginAction } from '@/app/admin/login/actions'

/**
 * Экран входа: ОБА пути видны сразу, без переключателей-вкладок. Почта одна
 * на оба (человеку не приходится угадывать, «к какому из двух полей email»
 * относится его адрес); пароль + «Sign in» — основной путь, потому что
 * сегодня это единственный, который работает сам (SMTP не настроен, письмо
 * с magic-ссылкой не уходит — см. `scripts/ops.ts`); «Send sign-in link»
 * остаётся второстепенной кнопкой ниже разделителя и станет «забыли пароль»,
 * когда почта заработает. Тексты кнопки и подтверждения не менялись — их
 * закрепляет e2e (`review.spec.ts`, сценарий входа).
 *
 * Ошибка входа — один общий текст на любую причину; это свойство ДЕЙСТВИЯ
 * (`LOGIN_FAILED` в `actions.ts`), а экран его только показывает. RU-строки
 * лежат рядом с EN по общей договорённости об отложенном переключателе
 * (`LocaleProvider initial="en"` у страницы, как у остального /admin).
 */
const EMAIL_LABEL: Localized = { en: 'Work email', ru: 'Рабочая почта' }
const PASSWORD_LABEL: Localized = { en: 'Password', ru: 'Пароль' }
const SIGN_IN: Localized = { en: 'Sign in', ru: 'Войти' }
const OR: Localized = { en: 'or', ru: 'или' }
const SEND_LINK: Localized = { en: 'Send sign-in link', ru: 'Прислать ссылку входа' }
const SENT: Localized = {
  en: 'Check your inbox for the sign-in link.',
  ru: 'Проверьте почту — ссылка входа там.',
}

export function LoginForm(): React.JSX.Element {
  const { pick } = useLocale()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<Localized | null>(null)
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState(false)

  if (sent) {
    return (
      <main className="login">
        <p>{pick(SENT)}</p>
      </main>
    )
  }

  const signIn = async (): Promise<void> => {
    setPending(true)
    setError(null)
    const result = await loginWithPasswordAction(email, password)
    if (result.ok) {
      // Полная навигация, а не router.push: /admin — динамическая серверная
      // страница, читающая только что поставленную cookie; обычный переход
      // браузера несёт её гарантированно, без вопросов к клиентскому кэшу.
      window.location.assign('/admin')
      return
    }
    setError(result.error)
    setPending(false)
  }

  return (
    <main className="login">
      <h1>Lounge Onboarding</h1>
      <label htmlFor="email">{pick(EMAIL_LABEL)}</label>
      <input
        id="email"
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <label htmlFor="password">{pick(PASSWORD_LABEL)}</label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && email && password && !pending) void signIn()
        }}
      />
      <button type="button" disabled={pending || !email || !password} onClick={() => void signIn()}>
        {pick(SIGN_IN)}
      </button>
      {error && <p className="login-error">{pick(error)}</p>}
      <p className="login-sep">{pick(OR)}</p>
      <button
        type="button"
        className="login-alt"
        disabled={pending || !email}
        onClick={async () => {
          setPending(true)
          setError(null)
          await requestLoginAction(email)
          setSent(true)
        }}
      >
        {pick(SEND_LINK)}
      </button>
    </main>
  )
}
