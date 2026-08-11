import { db } from '@/db/client'
import { requireSession } from '@/access/session'
import {
  listRegistry, filterOptions, countLounges, daysInSubmissionStatus,
} from '@/registry/query'
import { filtersFromSearchParams, searchParamsFromFilters } from '@/registry/filters-url'
import { OPERATIONAL_STATUSES } from '@/registry/status'
import { submissionStatus } from '@/db/schema'
import { LocaleProvider } from '@/i18n/context'
import { Registry, type RegistryTableRow } from '@/web/Registry'
import { reviewStateFor } from './s/[submissionId]/gates'

/**
 * Реестр лаунжей — вход в кабинет проверяющего. Заменяет временный список
 * «Awaiting review» плана 2: тот показывал только `submitted`-анкеты, а
 * реестр обязан показывать ВСЕ лаунжи, включая закрытые и те, до которых
 * сбор данных не дошёл (Global Constraints плана 3) — фильтры сужают, экран
 * не предрешает.
 *
 * Клиентские компоненты получают готовые ответы, а не правила (соглашение
 * `gates.ts`): дни в статусе анкеты посчитаны здесь (`daysInSubmissionStatus`
 * живёт в модуле, тянущем drizzle значениями), строка запроса для ссылок
 * выгрузки сериализована здесь (`searchParamsFromFilters` — см.
 * `src/registry/filters-url.ts`, почему разбор не может жить в клиентском
 * модуле), подписи статусов анкеты — те же, какими экран проверки называет
 * состояния (`reviewStateFor`, один источник: «Under review» в реестре и на
 * анкете — одна формулировка, не две).
 *
 * `LocaleProvider initial="en"` — записанное отложенное решение (план 2,
 * Task 6): английский захардкожен, RU-строки лежат на месте до задачи про
 * переключатель. Здесь не изобретается ничего нового.
 */
export default async function AdminHome(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}): Promise<React.JSX.Element> {
  await requireSession()

  const filters = filtersFromSearchParams(await props.searchParams)
  const rows = await listRegistry(db(), filters)
  const total = await countLounges(db())
  const options = await filterOptions(db())

  const now = new Date()
  const tableRows: RegistryTableRow[] = rows.map((row) => ({
    loungeId: row.loungeId,
    name: row.name,
    provider: row.provider,
    country: row.country,
    city: row.city,
    airport: row.airport,
    iataCode: row.iataCode,
    terminal: row.terminal,
    zone: row.zone,
    operationalStatus: row.operationalStatus,
    statusUntil: row.statusUntil,
    submissionId: row.submissionId,
    submissionStatus: row.submissionStatus,
    daysInFormStatus: daysInSubmissionStatus(row, now),
  }))

  return (
    <LocaleProvider initial="en">
      <Registry
        rows={tableRows}
        total={total}
        query={searchParamsFromFilters(filters).toString()}
        filters={filters}
        options={options}
        statuses={OPERATIONAL_STATUSES}
        submissionStates={submissionStatus.enumValues.map((id) => ({
          id,
          label: reviewStateFor(id).label,
        }))}
      />
    </LocaleProvider>
  )
}
