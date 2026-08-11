import type { OperationalStatus, SubmissionStatus } from '@/db/schema'
import { operationalStatus, submissionStatus } from '@/db/schema'
import type { RegistryFilters } from './query'

/**
 * `RegistryFilters` ⇄ адресная строка. Фильтры живут в URL, чтобы ссылку на
 * выборку можно было переслать и перезагрузить; этот модуль — единственное
 * определение того, как они там записаны.
 *
 * НЕ в `RegistryFilters.tsx`, как в образце плана, — и это не вкусовое
 * решение. Образец экспортировал обе функции из модуля с `'use client'`, а
 * вызывают их серверный компонент (`src/app/admin/page.tsx`) и route handler
 * (`src/app/admin/export/route.ts`): экспорт клиентского модуля для сервера —
 * client reference, который сервер вызвать не может. Это байт в байт дефект,
 * из-за которого `/admin/s/[submissionId]` отдавал 500 на каждой анкете
 * (план 2, Task 6) — историю целиком рассказывает `src/web/renderValues.ts`;
 * ни один из четырёх гейтов его не ловит, только e2e-страж `pageerror`.
 * Здесь, в `src/registry`, разбор лежит рядом с самим типом `RegistryFilters`
 * (`./query.ts` владеет и формой фильтров, и правилами их применения), и его
 * могут импортировать обе серверные стороны и юнит-тесты. Клиентским
 * компонентам он не нужен вовсе: страница отдаёт им уже сериализованную
 * строку запроса пропсом — заодно `@/db/schema` (а с ним drizzle) не попадает
 * в браузерный бандл, по тому же соглашению, что у `gates.ts` (план 2).
 *
 * Списки допустимых статусов — из `enumValues` схемы, а не рукописные
 * массивы, как в образце: рукописный список рядом с настоящим источником —
 * повторяющийся класс дефекта этой ветки (см. `STATUS_META` в `./status.ts`
 * и `FLAG_REASONS`), новый статус в схеме молча не проходил бы фильтр.
 */
const OPERATIONAL_IDS: ReadonlySet<string> = new Set(operationalStatus.enumValues)
const SUBMISSION_IDS: ReadonlySet<string> = new Set(submissionStatus.enumValues)

type Params = Record<string, string | string[] | undefined>

/** Повторённый параметр (`?airport=IST&airport=DXB`) берёт первое значение:
 *  интерфейс пишет каждый ключ один раз, так что второй — это правка URL
 *  руками, и «первый выигрывает» хотя бы детерминирован. */
const single = (value: string | string[] | undefined): string | undefined => {
  const text = Array.isArray(value) ? value[0] : value
  const trimmed = text?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * Список статусов через запятую; неизвестные значения отбрасываются.
 * Пустой результат — `undefined`, а НЕ пустой массив: `listRegistry` строит
 * из списка `inArray`, и `inArray(..., [])` — это `WHERE false`, то есть URL
 * с опечаткой в статусе показывал бы пустой реестр вместо полного.
 */
const list = <T extends string>(
  value: string | string[] | undefined,
  allowed: ReadonlySet<string>,
): T[] | undefined => {
  const text = single(value)
  if (!text) return undefined
  const parsed = text.split(',').filter((item): item is T => allowed.has(item))
  return parsed.length > 0 ? parsed : undefined
}

export function filtersFromSearchParams(params: Params): RegistryFilters {
  const filters: RegistryFilters = {}

  const country = single(params['country'])
  const city = single(params['city'])
  const airport = single(params['airport'])
  const terminal = single(params['terminal'])
  const zone = single(params['zone'])
  const search = single(params['search'])
  const operational = list<OperationalStatus>(params['operationalStatus'], OPERATIONAL_IDS)
  const submission = list<SubmissionStatus>(params['submissionStatus'], SUBMISSION_IDS)

  if (country) filters.country = country
  if (city) filters.city = city
  if (airport) filters.airport = airport
  if (terminal) filters.terminal = terminal
  if (zone) filters.zone = zone
  if (search) filters.search = search
  if (operational) filters.operationalStatus = operational
  if (submission) filters.submissionStatus = submission

  return filters
}

export function searchParamsFromFilters(filters: RegistryFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.country) params.set('country', filters.country)
  if (filters.city) params.set('city', filters.city)
  if (filters.airport) params.set('airport', filters.airport)
  if (filters.terminal) params.set('terminal', filters.terminal)
  if (filters.zone) params.set('zone', filters.zone)
  if (filters.search) params.set('search', filters.search)
  if (filters.operationalStatus?.length) {
    params.set('operationalStatus', filters.operationalStatus.join(','))
  }
  if (filters.submissionStatus?.length) {
    params.set('submissionStatus', filters.submissionStatus.join(','))
  }
  return params
}
