'use client'

import { useState } from 'react'
import type { Localized } from '@/form-schema'
import type { OperationalStatus } from '@/db/schema'
import { useLocale } from '@/i18n/context'
import { setStatusAction } from '@/app/admin/actions'

/**
 * Метаданные статуса приходят ПРОПСОМ из `OPERATIONAL_STATUSES`
 * (`src/registry/status.ts`), а не импортом: тот модуль тянет `@/db/schema`
 * и drizzle значениями, которым в браузерном бандле делать нечего — то же
 * соглашение, по которому `gates.ts` отдаёт клиенту готовые ответы, а
 * `FillForm` держит типизированную копию `EDITABLE_STATUSES`.
 */
export type OperationalStatusMeta = {
  id: OperationalStatus
  label: Localized
  allowsDate: boolean
}

const UNTIL_LABEL: Localized = {
  en: 'Expected reopening — optional',
  ru: 'Ожидаемое открытие — необязательно',
}
const COMMENT_LABEL: Localized = { en: 'Comment', ru: 'Комментарий' }
const SAVE: Localized = { en: 'Save', ru: 'Сохранить' }
const CANCEL: Localized = { en: 'Cancel', ru: 'Отмена' }

/**
 * Редактор эксплуатационного статуса одной строки реестра.
 *
 * `error` хранит весь `Localized` и выбирается через `pick()` в момент
 * показа — соглашение `gates.ts`/`ReviewScreen`: у сервера нет понятия
 * «локаль вызывающего». Показывается именно отказ `setOperationalStatus`
 * (например, «Use the date picker» на дате, которой нет в календаре), а не
 * обобщённое «не сохранилось»: браузерный `type="date"` такую дату обычно
 * не даёт ввести, но серверное действие вызывается по сети напрямую, и отказ
 * обязан быть видим, а не проглочен.
 */
export function StatusEditor(props: {
  loungeId: string
  current: OperationalStatus
  until: string | null
  statuses: OperationalStatusMeta[]
  onClose: () => void
}): React.JSX.Element {
  const { pick } = useLocale()
  const [status, setStatus] = useState<OperationalStatus>(props.current)
  const [until, setUntil] = useState(props.until ?? '')
  const [comment, setComment] = useState('')
  const [error, setError] = useState<Localized | null>(null)
  const [busy, setBusy] = useState(false)

  const selected = props.statuses.find((item) => item.id === status)

  async function save(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result = await setStatusAction(
        props.loungeId,
        status,
        until === '' ? null : until,
        comment === '' ? null : comment,
      )
      if (result.ok) props.onClose()
      else setError(result.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="status-editor">
      {props.statuses.map((item) => (
        <label key={item.id} className="se-opt">
          <input
            type="radio"
            name={`status-${props.loungeId}`}
            checked={status === item.id}
            onChange={() => {
              setStatus(item.id)
              // Дата относится к конкретному временному состоянию; статус без
              // даты (`allowsDate: false`) её не несёт — иначе сервер честно
              // откажет («This status has no reopening date»).
              if (!item.allowsDate) setUntil('')
            }}
          />
          {pick(item.label)}
        </label>
      ))}

      {selected?.allowsDate && (
        <div className="se-sub">
          <label>
            {pick(UNTIL_LABEL)}
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
          <label>
            {pick(COMMENT_LABEL)}
            <input value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
        </div>
      )}

      {error && <p className="se-error">{pick(error)}</p>}

      <div className="se-actions">
        <button type="button" disabled={busy} onClick={() => void save()}>
          {pick(SAVE)}
        </button>
        <button type="button" disabled={busy} onClick={props.onClose}>
          {pick(CANCEL)}
        </button>
      </div>
    </div>
  )
}
