import { db } from '@/db/client'
import { requireSession } from '@/access/session'
import { listTeamMembers } from '@/access/team'
import { MIN_PASSWORD_LENGTH } from '@/access/password'
import { LocaleProvider } from '@/i18n/context'
import { TeamScreen, type TeamMemberView } from '@/web/TeamScreen'

/**
 * Экран команды: список участников, приглашение, пароль коллеге, отзыв
 * сессий, удаление. `requireSession()` — первым, как у каждого экрана и
 * действия кабинета.
 *
 * Клиент получает готовые ответы, а не данные для решений (соглашение
 * `gates.ts`): `isSelf` посчитан здесь — свой `memberId` клиенту не нужен;
 * дата вступления отдана строкой `YYYY-MM-DD` — клиенту от неё нужен только
 * день, гонять `Date` через сериализацию — лишний договор (тот же выбор,
 * что у `StatusHistoryEntry.at`). Хэша в данных нет вовсе — `listTeamMembers`
 * его не выбирает, только булево «есть ли» (см. её комментарий).
 *
 * `MIN_PASSWORD_LENGTH` — пропсом с сервера, а не импортом в клиентский
 * модуль: правило живёт в `access/password.ts` рядом с `node:crypto`,
 * которому в браузерном бандле не место — та же причина, по которой
 * `FillForm` держит копию `EDITABLE_STATUSES` вместо импорта серверного
 * модуля. Пропс не копия, а тот же самый экспорт.
 */
export default async function TeamPage(): Promise<React.JSX.Element> {
  const session = await requireSession()

  const members = await listTeamMembers(db())
  const rows: TeamMemberView[] = members.map((member) => ({
    id: member.id,
    email: member.email,
    name: member.name,
    joined: member.createdAt.toISOString().slice(0, 10),
    hasPassword: member.hasPassword,
    isSelf: member.id === session.memberId,
  }))

  return (
    <LocaleProvider initial="en">
      <TeamScreen members={rows} minPasswordLength={MIN_PASSWORD_LENGTH} />
    </LocaleProvider>
  )
}
