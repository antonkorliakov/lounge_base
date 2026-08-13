import { LocaleProvider } from '@/i18n/context'
import { LoginForm } from '@/web/LoginForm'

// `initial="en"` — то же записанное отложенное решение, что у остальных
// страниц /admin (см. комментарий в `admin/page.tsx`): интерфейс кабинета
// сегодня показывается по-английски, RU-строки лежат в компонентах рядом.
export default function LoginPage(): React.JSX.Element {
  return (
    <LocaleProvider initial="en">
      <LoginForm />
    </LocaleProvider>
  )
}
