import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireSession } from '@/access/session'
import { teamMembers } from '@/db/schema'
import { LocaleProvider } from '@/i18n/context'
import { PasswordChange } from '@/web/PasswordChange'

/**
 * Смена пароля залогиненного участника. `requireSession()` — первым, как у
 * каждого экрана и действия кабинета. Клиенту уходит только факт
 * `hasPassword` (показывать ли поле «текущий пароль»), не сам хэш: хэш не
 * покидает сервер нигде — ни в пропсах, ни в результатах действий.
 */
export default async function PasswordPage(): Promise<React.JSX.Element> {
  const session = await requireSession()

  const rows = await db()
    .select({ passwordHash: teamMembers.passwordHash })
    .from(teamMembers)
    .where(eq(teamMembers.id, session.memberId))
    .limit(1)

  return (
    <LocaleProvider initial="en">
      <PasswordChange hasPassword={rows[0]?.passwordHash != null} />
    </LocaleProvider>
  )
}
