'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { Localized } from '@/form-schema'
import { OPTION_LISTS } from '@/form-schema'
import type { RegistryFilters } from '@/registry/query'
import type { OperationalStatus, SubmissionStatus } from '@/db/schema'
import { useLocale } from '@/i18n/context'
import { RegistryFiltersBar, type FilterOptions, type SubmissionStateOption } from './RegistryFilters'
import { StatusEditor, type OperationalStatusMeta } from './StatusEditor'
import { AddLounge } from './AddLounge'
import { DeleteLounge } from './DeleteLounge'

/**
 * Строка таблицы реестра — уже посчитанная сервером, а не сырой
 * `RegistryRow`: `daysInFormStatus` вычисляет страница
 * (`daysInSubmissionStatus` живёт в `src/registry/query.ts`, который тянет
 * drizzle значениями — образец плана импортировал его прямо в этот
 * клиентский модуль). Клиент получает готовые ответы, не правила — то же
 * соглашение, что у `gates.ts`.
 */
export type RegistryTableRow = {
  loungeId: string
  name: string
  provider: string | null
  country: string
  city: string
  airport: string
  iataCode: string
  terminal: string | null
  zone: string[] | null
  operationalStatus: OperationalStatus
  statusUntil: string | null
  statusComment: string | null
  submissionId: string | null
  submissionStatus: SubmissionStatus | null
  /** Полных суток в текущем статусе АНКЕТЫ; `null` — анкеты нет. */
  daysInFormStatus: number | null
  /** Почта ревьюера последнего решения по анкете; `null` — решений ещё не
   *  было (или анкеты нет вовсе): `reviewerId` пишут только
   *  `requestChanges`/`approveSubmission`. */
  reviewerId: string | null
}

const TITLE: Localized = { en: 'Lounges', ru: 'Лаунжи' }
const HEADERS: { key: string; label: Localized }[] = [
  { key: 'lounge', label: { en: 'Lounge', ru: 'Лаунж' } },
  { key: 'airport', label: { en: 'Airport', ru: 'Аэропорт' } },
  { key: 'terminal', label: { en: 'Terminal', ru: 'Терминал' } },
  { key: 'zone', label: { en: 'Zone', ru: 'Зона' } },
  { key: 'operational', label: { en: 'Lounge status', ru: 'Статус лаунжа' } },
  { key: 'submission', label: { en: 'Form status', ru: 'Статус анкеты' } },
  // Именно СТАТУСА АНКЕТЫ: у строки реестра два независимых статуса, а у
  // эксплуатационного времени смены не хранится вовсе — см.
  // `daysInSubmissionStatus` (`src/registry/query.ts`). Образец плана писал
  // «In status», не говоря какого.
  { key: 'days', label: { en: 'Days in form status', ru: 'Дней в статусе анкеты' } },
  // Последняя колонка списка из спецификации («…время в текущем статусе
  // анкеты, ревьюер»). Значение — почта: `requestChanges`/`approveSubmission`
  // пишут в `reviewerId` то, чем подписана сессия (`session.email`), другого
  // имени у ревьюера в системе нет.
  { key: 'reviewer', label: { en: 'Reviewer', ru: 'Ревьюер' } },
]
// Колонка удаления — без текстового заголовка (в ней один неброский контрол,
// см. `DeleteLounge`), но НЕ без имени: у скринридера пустой заголовок — это
// колонка-загадка. Подпись — visually-hidden текстом, не aria-label на th.
const DELETE_HEADER: Localized = { en: 'Delete', ru: 'Удаление' }
const UNAPPROVED_XLSX: Localized = {
  en: 'Excel, incl. unapproved',
  ru: 'Excel, включая непринятые',
}
const ALL_LOUNGES_XLSX: Localized = {
  en: 'Excel, all lounges incl. unapproved',
  ru: 'Excel, все лаунжи, включая непринятые',
}
const PASSWORD_LINK: Localized = { en: 'Password', ru: 'Пароль' }

export function Registry(props: {
  rows: RegistryTableRow[]
  total: number
  query: string
  filters: RegistryFilters
  options: FilterOptions
  statuses: OperationalStatusMeta[]
  submissionStates: SubmissionStateOption[]
}): React.JSX.Element {
  const { locale, pick } = useLocale()
  const [editing, setEditing] = useState<string | null>(null)

  const operationalLabel = (id: OperationalStatus): string => {
    const meta = props.statuses.find((status) => status.id === id)
    return meta ? pick(meta.label) : id
  }

  const submissionLabel = (id: SubmissionStatus): string => {
    const state = props.submissionStates.find((item) => item.id === id)
    return state ? pick(state.label) : id
  }

  // Зона хранится id-ами опций (`classifyingFieldsFrom` пишет ответ III.6.6
  // как есть); показываются подписи, как и в фильтре. Значение мимо списка
  // (запись миграцией/руками) показывается как есть, а не прячется.
  const zoneLabel = (id: string): string => {
    const option = OPTION_LISTS.zone.find((item) => item.id === id)
    return option ? pick(option.label) : id
  }

  const exportHref = (extra: string): string =>
    `/admin/export?${props.query === '' ? '' : `${props.query}&`}${extra}`

  return (
    <main className="registry">
      <header className="registry-top">
        <h1>{pick(TITLE)}</h1>
        <span className="registry-count">
          {locale === 'ru'
            ? `показано ${props.rows.length} из ${props.total}`
            : `${props.rows.length} of ${props.total}`}
        </span>
        {/* Выгрузка уходит с ТЕКУЩИМ фильтром: ссылки несут ту же строку
            запроса, из которой построена страница. */}
        <div className="registry-export">
          <a href={exportHref('format=xlsx')}>Excel</a>
          <a href={exportHref('format=csv')}>CSV</a>
          <a href={exportHref('format=xlsx&includeUnapproved=1')}>{pick(UNAPPROVED_XLSX)}</a>
          {/* «Выгрузить все лаунжи целиком» (спецификация) — БЕЗ фильтра
              страницы, поэтому ссылка не через `exportHref`. Показывается
              только когда фильтр сужает страницу: без фильтра она отдала бы
              байт в байт тот же файл, что соседняя, и различались бы они
              только подписью. `includeUnapproved=1` — часть смысла «все
              лаунжи»: умолчание «только принятые» молча выкинуло бы лаунж без
              единой принятой анкеты, и файл был бы не «все лаунжи», а «все
              проверенные»; подпись говорит об этом явно. */}
          {props.query !== '' && (
            <a href="/admin/export?format=xlsx&includeUnapproved=1">{pick(ALL_LOUNGES_XLSX)}</a>
          )}
        </div>
        {/* Единственный вход на /admin/password: страница без ссылки на неё —
            мёртвая. В той же строке шапки, но не среди выгрузок — это про
            аккаунт, не про данные. */}
        <a className="registry-password" href="/admin/password">
          {pick(PASSWORD_LINK)}
        </a>
      </header>

      {/* Завести лаунж и получить его первую ссылку заполнения — бывшая
          консольная операция `ops.ts lounge`, теперь с экрана. */}
      <AddLounge />

      <RegistryFiltersBar
        query={props.query}
        filters={props.filters}
        options={props.options}
        statuses={props.statuses}
        submissionStates={props.submissionStates}
      />

      <table className="registry-table">
        <thead>
          <tr>
            {HEADERS.map((header) => (
              <th key={header.key}>{pick(header.label)}</th>
            ))}
            <th>
              <span className="vh">{pick(DELETE_HEADER)}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr
              key={row.loungeId}
              className={row.operationalStatus === 'closed' ? 'row-dim' : undefined}
            >
              <td>
                {/* Ссылка на экран проверки — тот же путь, которым ходит
                    e2e/review.spec.ts (`openSeededSubmission`): имя лаунжа
                    открывает его последнюю анкету. Лаунж без анкет открыть
                    нечем — имя остаётся текстом. */}
                {row.submissionId ? (
                  <Link href={`/admin/s/${row.submissionId}`}>{row.name}</Link>
                ) : (
                  row.name
                )}
                <span className="row-sub">
                  {[row.provider, row.city, row.country].filter(Boolean).join(' · ')}
                </span>
              </td>
              <td>{row.iataCode}</td>
              <td>{row.terminal ?? '—'}</td>
              <td>{row.zone && row.zone.length > 0 ? row.zone.map(zoneLabel).join(', ') : '—'}</td>
              <td>
                <button
                  type="button"
                  className="pill-btn"
                  onClick={() => setEditing(editing === row.loungeId ? null : row.loungeId)}
                >
                  {operationalLabel(row.operationalStatus)}
                </button>
                {row.statusUntil && <span className="row-until">→ {row.statusUntil}</span>}
                {/* Комментарий к статусу — ВИДИМОЙ строкой, а не `title`:
                    `title` не существует ни на touch-устройстве, ни для
                    скринридера (то же правило, по которому `gates.ts` дублирует
                    причину отказа видимым текстом). Спрятанный комментарий был
                    бы тем же дефектом I2 на один слой выше — записан, показан,
                    но не каждому. */}
                {row.statusComment && (
                  <span className="row-comment">{row.statusComment}</span>
                )}
                {editing === row.loungeId && (
                  <StatusEditor
                    loungeId={row.loungeId}
                    current={row.operationalStatus}
                    until={row.statusUntil}
                    comment={row.statusComment}
                    statuses={props.statuses}
                    onClose={() => setEditing(null)}
                  />
                )}
              </td>
              <td>{row.submissionStatus ? submissionLabel(row.submissionStatus) : '—'}</td>
              <td>{row.daysInFormStatus === null ? '—' : `${row.daysInFormStatus}`}</td>
              {/* «—», как у остальных пустых ячеек этой таблицы: анкету ещё
                  никто не проверял — обычное состояние, а не ошибка. */}
              <td>{row.reviewerId ?? '—'}</td>
              {/* Удаление — в конце строки, неброско: операция редкая, и её
                  контрол не должен спорить за внимание с данными строки. */}
              <td className="dl-cell">
                <DeleteLounge loungeId={row.loungeId} name={row.name} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  )
}
