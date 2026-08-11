'use client'

import { useRouter } from 'next/navigation'
import type { Localized } from '@/form-schema'
import { OPTION_LISTS } from '@/form-schema'
import type { RegistryFilters } from '@/registry/query'
import type { SubmissionStatus } from '@/db/schema'
import { useLocale } from '@/i18n/context'
import type { OperationalStatusMeta } from './StatusEditor'

/**
 * Панель фильтров реестра. Фильтры живут в адресной строке (ссылку на выборку
 * можно переслать), поэтому каждый выбор — это переход на новый URL, а не
 * состояние компонента.
 *
 * Разбор и сериализация URL живут НЕ здесь, а в `src/registry/filters-url.ts`
 * (см. его комментарий — образец плана положил их в этот клиентский модуль, и
 * сервер не смог бы их вызвать). Панель получает текущую строку запроса
 * пропсом `query` — уже канонически сериализованную сервером — и правит её
 * поключево; `useSearchParams` не нужен.
 */
export type FilterOptions = {
  countries: string[]
  cities: string[]
  airports: string[]
  terminals: string[]
}

export type SubmissionStateOption = { id: SubmissionStatus; label: Localized }

const ALL: Localized = { en: 'all', ru: 'все' }
const LABELS: Record<string, Localized> = {
  country: { en: 'Country', ru: 'Страна' },
  city: { en: 'City', ru: 'Город' },
  airport: { en: 'Airport', ru: 'Аэропорт' },
  terminal: { en: 'Terminal', ru: 'Терминал' },
  zone: { en: 'Zone', ru: 'Зона' },
  operationalStatus: { en: 'Lounge status', ru: 'Статус лаунжа' },
  submissionStatus: { en: 'Form status', ru: 'Статус анкеты' },
}
const SEARCH_PLACEHOLDER: Localized = { en: 'Name or IATA…', ru: 'Название или IATA…' }

export function RegistryFiltersBar(props: {
  query: string
  filters: RegistryFilters
  options: FilterOptions
  statuses: OperationalStatusMeta[]
  submissionStates: SubmissionStateOption[]
}): React.JSX.Element {
  const router = useRouter()
  const { pick } = useLocale()

  function apply(key: string, value: string): void {
    const next = new URLSearchParams(props.query)
    if (value === '') next.delete(key)
    else next.set(key, value)
    const text = next.toString()
    router.push(text === '' ? '/admin' : `/admin?${text}`)
  }

  const select = (
    key: 'country' | 'city' | 'airport' | 'terminal' | 'zone',
    values: { value: string; text: string }[],
  ): React.JSX.Element => (
    <label className="rf">
      <span>{pick(LABELS[key]!)}</span>
      <select value={props.filters[key] ?? ''} onChange={(e) => apply(key, e.target.value)}>
        <option value="">{pick(ALL)}</option>
        {values.map((item) => (
          <option key={item.value} value={item.value}>{item.text}</option>
        ))}
      </select>
    </label>
  )

  const plain = (values: string[]): { value: string; text: string }[] =>
    values.map((value) => ({ value, text: value }))

  return (
    <div className="registry-filters">
      {select('country', plain(props.options.countries))}
      {select('city', plain(props.options.cities))}
      {select('airport', plain(props.options.airports))}
      {select('terminal', plain(props.options.terminals))}
      {/* Зона — локализованные подписи опций, а не сырые id, как в образце:
          все остальные статусные селекты показывают подписи через pick(), и
          сырой `arrival` был бы единственным техническим словом на экране. */}
      {select(
        'zone',
        OPTION_LISTS.zone.map((option) => ({ value: option.id, text: pick(option.label) })),
      )}

      <label className="rf">
        <span>{pick(LABELS['operationalStatus']!)}</span>
        <select
          value={props.filters.operationalStatus?.[0] ?? ''}
          onChange={(e) => apply('operationalStatus', e.target.value)}
        >
          <option value="">{pick(ALL)}</option>
          {props.statuses.map((status) => (
            <option key={status.id} value={status.id}>{pick(status.label)}</option>
          ))}
        </select>
      </label>

      <label className="rf">
        <span>{pick(LABELS['submissionStatus']!)}</span>
        <select
          value={props.filters.submissionStatus?.[0] ?? ''}
          onChange={(e) => apply('submissionStatus', e.target.value)}
        >
          <option value="">{pick(ALL)}</option>
          {props.submissionStates.map((state) => (
            <option key={state.id} value={state.id}>{pick(state.label)}</option>
          ))}
        </select>
      </label>

      <input
        className="rf-search"
        type="search"
        defaultValue={props.filters.search ?? ''}
        placeholder={pick(SEARCH_PLACEHOLDER)}
        aria-label={pick(SEARCH_PLACEHOLDER)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') apply('search', e.currentTarget.value)
        }}
      />
    </div>
  )
}
