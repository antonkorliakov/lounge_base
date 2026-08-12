'use client'

import { useState } from 'react'
import type { Localized } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { createLoungeAction } from '@/app/admin/actions'
import { FillLinkReveal } from './FillLinkReveal'

const OPEN: Localized = { en: 'Add lounge', ru: 'Добавить лаунж' }
const TITLE: Localized = { en: 'New lounge', ru: 'Новый лаунж' }
const CREATE: Localized = { en: 'Create', ru: 'Создать' }
const CANCEL: Localized = { en: 'Cancel', ru: 'Отмена' }
const DONE: Localized = { en: 'Done', ru: 'Готово' }
const CREATED: Localized = {
  en: 'Lounge created. Fill link for the operator:',
  ru: 'Лаунж заведён. Ссылка заполнения для оператора:',
}

/** Поля формы = обязательные колонки `lounges` + provider. Страна/город/
 *  аэропорт обязательны, в отличие от консольного ops.ts, — см. `createLounge`
 *  (пустые строки всплывали бы пустыми пунктами в фильтрах реестра). */
const FIELDS: { key: FieldKey; label: Localized; required: boolean }[] = [
  { key: 'name', label: { en: 'Name*', ru: 'Название*' }, required: true },
  { key: 'iataCode', label: { en: 'IATA code*', ru: 'Код IATA*' }, required: true },
  { key: 'provider', label: { en: 'Provider', ru: 'Провайдер' }, required: false },
  { key: 'country', label: { en: 'Country*', ru: 'Страна*' }, required: true },
  { key: 'city', label: { en: 'City*', ru: 'Город*' }, required: true },
  { key: 'airport', label: { en: 'Airport*', ru: 'Аэропорт*' }, required: true },
]
type FieldKey = 'name' | 'iataCode' | 'provider' | 'country' | 'city' | 'airport'

const EMPTY: Record<FieldKey, string> = {
  name: '', iataCode: '', provider: '', country: '', city: '', airport: '',
}

/**
 * «Добавить лаунж» на экране реестра: форма из шести полей, создающая лаунж +
 * пустую анкету + первый fill-токен одним действием (`createLoungeAction`),
 * и показ ссылки заполнения для ручного копирования — общим `FillLinkReveal`
 * (копирование, план Б при отказе буфера и предупреждение об одноразовости —
 * его правила, одни на оба места показа ссылки; см. его комментарий).
 *
 * `error` — весь `Localized`, выбор через `pick()` в момент показа
 * (соглашение ветки). Появление нового лаунжа в таблице за спиной формы —
 * `revalidatePath` внутри действия, тот же механизм, что у смены статуса.
 */
export function AddLounge(): React.JSX.Element {
  const { pick } = useLocale()
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<FieldKey, string>>(EMPTY)
  const [error, setError] = useState<Localized | null>(null)
  const [busy, setBusy] = useState(false)
  const [fillUrl, setFillUrl] = useState<string | null>(null)

  function close(): void {
    setOpen(false)
    setValues(EMPTY)
    setError(null)
    setFillUrl(null)
  }

  async function create(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result = await createLoungeAction({
        name: values.name,
        iataCode: values.iataCode,
        provider: values.provider === '' ? null : values.provider,
        country: values.country,
        city: values.city,
        airport: values.airport,
      })
      if (result.ok) setFillUrl(result.fillUrl)
      else setError(result.error)
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button type="button" className="al-open" onClick={() => setOpen(true)}>
        {pick(OPEN)}
      </button>
    )
  }

  return (
    <div className="al-panel">
      {fillUrl === null ? (
        <>
          <p className="al-title">{pick(TITLE)}</p>
          {FIELDS.map((field) => (
            <label key={field.key} className="al-field">
              {pick(field.label)}
              <input
                value={values[field.key]}
                onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
              />
            </label>
          ))}
          {error && <p className="se-error">{pick(error)}</p>}
          <div className="se-actions">
            <button type="button" disabled={busy} onClick={() => void create()}>
              {pick(CREATE)}
            </button>
            <button type="button" disabled={busy} onClick={close}>
              {pick(CANCEL)}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="al-title">{pick(CREATED)}</p>
          {/* `key` не нужен: панель показывает не больше одной ссылки за
              открытие (`close()` сбрасывает `fillUrl`, компонент
              размонтируется вместе со своим «Скопировано»). */}
          <FillLinkReveal url={fillUrl}>
            <button type="button" onClick={close}>
              {pick(DONE)}
            </button>
          </FillLinkReveal>
        </>
      )}
    </div>
  )
}
