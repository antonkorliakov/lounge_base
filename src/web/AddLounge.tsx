'use client'

import { useCallback, useState } from 'react'
import type { Localized } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { createLoungeAction } from '@/app/admin/actions'
import { FillLinkReveal } from './FillLinkReveal'
import { PassportFieldsEditor, type PassportFieldKey } from './PassportFieldsEditor'

const OPEN: Localized = { en: 'Add lounge', ru: 'Добавить лаунж' }
const TITLE: Localized = { en: 'New lounge', ru: 'Новый лаунж' }
const CREATE: Localized = { en: 'Create', ru: 'Создать' }
const CANCEL: Localized = { en: 'Cancel', ru: 'Отмена' }
const DONE: Localized = { en: 'Done', ru: 'Готово' }
const CREATED: Localized = {
  en: 'Lounge created. Fill link for the operator:',
  ru: 'Лаунж заведён. Ссылка заполнения для оператора:',
}

const EMPTY: Record<PassportFieldKey, string> = {
  name: '', iataCode: '', provider: '', country: '', city: '', airport: '',
}

/**
 * «Добавить лаунж» на экране реестра: форма из шести полей (общее тело —
 * `PassportFieldsEditor`: список полей, порядок «IATA перед производными» и
 * подсказка справочника живут ТАМ, одни на обе формы паспорта), создающая
 * лаунж + пустую анкету + первый fill-токен одним действием
 * (`createLoungeAction`), и показ ссылки заполнения для ручного копирования —
 * общим `FillLinkReveal` (копирование, план Б при отказе буфера и
 * предупреждение об одноразовости — его правила, одни на оба места показа
 * ссылки; см. его комментарий).
 *
 * `error` — весь `Localized`, выбор через `pick()` в момент показа
 * (соглашение ветки). Появление нового лаунжа в таблице за спиной формы —
 * `revalidatePath` внутри действия, тот же механизм, что у смены статуса.
 */
export function AddLounge(): React.JSX.Element {
  const { pick } = useLocale()
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<PassportFieldKey, string>>(EMPTY)
  const [error, setError] = useState<Localized | null>(null)
  const [busy, setBusy] = useState(false)
  const [fillUrl, setFillUrl] = useState<string | null>(null)
  // Код найден справочником — единственное состояние, в котором сервер
  // примет создание (`resolveIdentity`); до него Create выключен. Это
  // подсказка: ворота — серверный отказ, достижимый по сети напрямую.
  const [resolved, setResolved] = useState(false)

  // Стабильная ссылка обязательна: `PassportFieldsEditor` держит её в deps
  // эффекта справочника (см. его комментарий про устаревшие ответы).
  const patch = useCallback((partial: Partial<Record<PassportFieldKey, string>>): void => {
    setValues((prev) => ({ ...prev, ...partial }))
  }, [])

  function close(): void {
    setOpen(false)
    setValues(EMPTY)
    setError(null)
    setFillUrl(null)
    // Следующее открытие начинает с пустого кода — и с выключенного Create.
    setResolved(false)
  }

  async function create(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      // Аэропорт/город/страна НЕ отправляются: контракт действия их не
      // принимает (`CreateLoungeInput`) — сервер выводит их из кода сам.
      const result = await createLoungeAction({
        name: values.name,
        iataCode: values.iataCode,
        provider: values.provider === '' ? null : values.provider,
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
          <PassportFieldsEditor values={values} onPatch={patch} onResolved={setResolved} />
          {error && <p className="se-error">{pick(error)}</p>}
          <div className="se-actions">
            <button type="button" disabled={busy || !resolved} onClick={() => void create()}>
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
