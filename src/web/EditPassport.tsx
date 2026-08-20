'use client'

import { useCallback, useState } from 'react'
import type { Localized } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import {
  updatePassportAction, passportHistoryAction, type PassportHistoryEntry,
} from '@/app/admin/actions'
import {
  PassportFieldsEditor, PASSPORT_FIELDS, type PassportFieldKey,
} from './PassportFieldsEditor'

const OPEN: Localized = { en: 'Edit passport', ru: 'Править паспорт' }
const TITLE: Localized = { en: 'Lounge passport', ru: 'Паспорт лаунжа' }
const SAVE: Localized = { en: 'Save', ru: 'Сохранить' }
const CANCEL: Localized = { en: 'Cancel', ru: 'Отмена' }
const HISTORY: Localized = { en: 'Edit history', ru: 'История правок' }
const HISTORY_EMPTY: Localized = { en: 'No passport edits yet', ru: 'Правок паспорта ещё не было' }
const HISTORY_LOADING: Localized = { en: 'Loading…', ru: 'Загрузка…' }
// Что случится с открытыми анкетами — СЛОВАМИ в панели, а не только в
// серверном комментарии: правило «непочатые ответы последуют, тронутые
// останутся» иначе существовало бы для администратора как сюрприз.
const SYNC_NOTE: Localized = {
  en: 'Untouched prefilled answers in open forms will follow; answers the operator edited stay theirs.',
  ru: 'Непочатые предзаполненные ответы в открытых анкетах последуют за правкой; правки оператора останутся его.',
}

/** Текущие значения паспорта строки реестра — то, чем предзаполняется форма. */
export type PassportValues = {
  name: string
  provider: string | null
  country: string
  city: string
  airport: string
  iataCode: string
}

const toFormValues = (current: PassportValues): Record<PassportFieldKey, string> => ({
  name: current.name,
  iataCode: current.iataCode,
  provider: current.provider ?? '',
  country: current.country,
  city: current.city,
  airport: current.airport,
})

/**
 * Правка паспорта лаунжа из строки реестра: неброский «✎» рядом с «×»
 * удаления (те же доводы — операция нечастая, контролы строки не должны
 * спорить с данными), раскрывающий панель с теми же шестью полями, что у
 * «Add lounge» (`PassportFieldsEditor` — одно тело на обе формы: список
 * полей, порядок «IATA перед производными» и подсказка справочника),
 * предзаполненную текущими значениями.
 *
 * Валидация — на сервере (`updateLoungePassport`), отказ показывается весь
 * (`Localized` через `pick()` в момент показа) — контракт ветки: серверное
 * действие достижимо по сети напрямую, и его отказ обязан быть видим.
 * Успех виден строкой без перезагрузки (`revalidatePath` внутри действия).
 *
 * История правок — раскрывашка по клику, как у `StatusEditor` (читается по
 * запросу, не в строках реестра); это ЧИТАТЕЛЬ события `passport_edited`
 * (событие без читателя — write-only класс дефекта I2). Колонки в записях
 * подписываются теми же подписями `PASSPORT_FIELDS`, звёздочка обязательности
 * в истории — шум, поэтому срезается.
 */
export function EditPassport(props: {
  loungeId: string
  current: PassportValues
}): React.JSX.Element {
  const { pick } = useLocale()
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<PassportFieldKey, string>>(
    () => toFormValues(props.current),
  )
  const [error, setError] = useState<Localized | null>(null)
  const [busy, setBusy] = useState(false)
  // `undefined` — ещё не запрашивали; `null` — запрос в пути (StatusEditor).
  const [history, setHistory] = useState<PassportHistoryEntry[] | null | undefined>(undefined)
  const [historyOpen, setHistoryOpen] = useState(false)

  // Стабильная ссылка обязательна: `PassportFieldsEditor` держит её в deps
  // эффекта справочника (см. его комментарий про устаревшие ответы).
  const patch = useCallback((partial: Partial<Record<PassportFieldKey, string>>): void => {
    setValues((prev) => ({ ...prev, ...partial }))
  }, [])

  const columnLabel = (column: string): string => {
    const field = PASSPORT_FIELDS.find((item) => item.key === column)
    return field ? pick(field.label).replace(/\*$/, '') : column
  }

  function openPanel(): void {
    // Значения — из ПРОПСОВ на момент открытия, а не из состояния прошлого
    // открытия: между ними паспорт могла изменить другая правка (или
    // принятие анкеты), и форма обязана начинать с того, что видно в строке.
    setValues(toFormValues(props.current))
    setError(null)
    setOpen(true)
  }

  function close(): void {
    setOpen(false)
    setError(null)
    setHistoryOpen(false)
  }

  async function toggleHistory(): Promise<void> {
    const next = !historyOpen
    setHistoryOpen(next)
    if (next && history === undefined) {
      setHistory(null)
      setHistory(await passportHistoryAction(props.loungeId))
    }
  }

  async function save(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result = await updatePassportAction(props.loungeId, {
        name: values.name,
        iataCode: values.iataCode,
        provider: values.provider === '' ? null : values.provider,
        country: values.country,
        city: values.city,
        airport: values.airport,
      })
      if (result.ok) {
        // Кэш истории сбрасывается: только что могла появиться новая запись,
        // и следующее открытие раскрывашки обязано её увидеть.
        setHistory(undefined)
        close()
      } else {
        setError(result.error)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="ep">
      <button
        type="button"
        className="ep-open"
        aria-label={`${pick(OPEN)}: ${props.current.name}`}
        title={pick(OPEN)}
        onClick={() => (open ? close() : openPanel())}
      >
        ✎
      </button>
      {open && (
        <div className="ep-panel">
          <p className="al-title">{pick(TITLE)}</p>
          <PassportFieldsEditor values={values} onPatch={patch} />
          <p className="ep-note">{pick(SYNC_NOTE)}</p>
          {error && <p className="se-error">{pick(error)}</p>}
          <div className="se-actions">
            <button type="button" disabled={busy} onClick={() => void save()}>
              {pick(SAVE)}
            </button>
            <button type="button" disabled={busy} onClick={close}>
              {pick(CANCEL)}
            </button>
          </div>

          <div className="se-history">
            <button
              type="button"
              className="se-history-toggle"
              onClick={() => void toggleHistory()}
            >
              {historyOpen ? '▾' : '▸'} {pick(HISTORY)}
            </button>
            {historyOpen &&
              (history === null || history === undefined ? (
                <p className="se-history-note">{pick(HISTORY_LOADING)}</p>
              ) : history.length === 0 ? (
                <p className="se-history-note">{pick(HISTORY_EMPTY)}</p>
              ) : (
                <ul className="se-history-list">
                  {history.map((entry, index) => (
                    <li key={index}>
                      <span className="se-history-when">{entry.at.slice(0, 10)}</span>{' '}
                      {entry.changes.map((change, i) => (
                        <span key={i}>
                          {i > 0 && ', '}
                          {columnLabel(change.column)}: {change.from ?? '—'} → {change.to ?? '—'}
                        </span>
                      ))}
                      <span className="se-history-actor">{entry.actor}</span>
                    </li>
                  ))}
                </ul>
              ))}
          </div>
        </div>
      )}
    </span>
  )
}
