'use client'

import { useState } from 'react'
import type { Localized } from '@/form-schema'
import type { OperationalStatus } from '@/db/schema'
import { useLocale } from '@/i18n/context'
import {
  setStatusAction, statusHistoryAction, type StatusHistoryEntry,
} from '@/app/admin/actions'

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
const HISTORY: Localized = { en: 'History', ru: 'История' }
const HISTORY_EMPTY: Localized = { en: 'No status changes yet', ru: 'Смен статуса ещё не было' }
const HISTORY_LOADING: Localized = { en: 'Loading…', ru: 'Загрузка…' }

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
  comment: string | null
  statuses: OperationalStatusMeta[]
  onClose: () => void
}): React.JSX.Element {
  const { pick } = useLocale()
  const [status, setStatus] = useState<OperationalStatus>(props.current)
  const [until, setUntil] = useState(props.until ?? '')
  // Поле начинается с ХРАНИМОГО комментария, а не с пустой строки: редактор
  // открывают и ради одной даты, и «сохранить, ничего не тронув» обязано
  // сохранить комментарий, а не молча стереть его (дефект I2 ревью — поле
  // инициализировалось '' и каждая правка даты обнуляла statusComment).
  // Семантика очистки при этом остаётся намеренной, а не случайной: пустое
  // поле уходит на сервер как null (см. `save`), то есть стереть комментарий
  // можно — но только опустошив поле руками, видя его текущий текст.
  const [comment, setComment] = useState(props.comment ?? '')
  const [error, setError] = useState<Localized | null>(null)
  const [busy, setBusy] = useState(false)
  // История читается по клику, не при открытии редактора: тот открывают ради
  // смены статуса, а история — раскрывашка на случай «что тут происходило».
  // `undefined` — ещё не запрашивали; `null` — запрос в пути.
  const [history, setHistory] = useState<StatusHistoryEntry[] | null | undefined>(undefined)
  const [historyOpen, setHistoryOpen] = useState(false)

  const selected = props.statuses.find((item) => item.id === status)

  const statusLabel = (id: OperationalStatus | null): string => {
    if (id === null) return '—'
    const meta = props.statuses.find((item) => item.id === id)
    return meta ? pick(meta.label) : id
  }

  async function toggleHistory(): Promise<void> {
    const open = !historyOpen
    setHistoryOpen(open)
    if (open && history === undefined) {
      setHistory(null)
      setHistory(await statusHistoryAction(props.loungeId))
    }
  }

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
              // Комментарий тоже описывает конкретное состояние («Реконструкция
              // зоны питания» — про ремонт, не про открывшийся лаунж), поэтому
              // смена статуса очищает поле: возврат в `active` по умолчанию
              // сохранит null, а не устаревшее пояснение. Возврат к ТЕКУЩЕМУ
              // статусу восстанавливает хранимый текст — правка передумана,
              // ничего не потеряно.
              setComment(item.id === props.current ? (props.comment ?? '') : '')
            }}
          />
          {pick(item.label)}
        </label>
      ))}

      <div className="se-sub">
        {/* Дата — только у временных состояний (`allowsDate`), комментарий — у
            ЛЮБОГО статуса: сервер (`setOperationalStatus`) принимает его для
            всех, и пояснение к «closed» («заменён лаунжем в новом терминале»)
            ровно так же отвечает на вопрос «ждать ли обратно», как пояснение
            к ремонту. Раньше поле жило под `allowsDate`, и комментарий к
            закрытию было негде ни написать, ни увидеть перед затиранием. */}
        {selected?.allowsDate && (
          <label>
            {pick(UNTIL_LABEL)}
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
        )}
        <label>
          {pick(COMMENT_LABEL)}
          <input value={comment} onChange={(e) => setComment(e.target.value)} />
        </label>
      </div>

      {error && <p className="se-error">{pick(error)}</p>}

      <div className="se-actions">
        <button type="button" disabled={busy} onClick={() => void save()}>
          {pick(SAVE)}
        </button>
        <button type="button" disabled={busy} onClick={props.onClose}>
          {pick(CANCEL)}
        </button>
      </div>

      {/* История смен — раскрывашка при редакторе: `statusHistory` писалась
          при каждой смене и не имела ни одного читателя (дефект I2 ревью).
          Записи старые сверху — в порядке `statusHistory`, чтобы `to` одной
          строки читался как `from` следующей (история — цепочка). */}
      <div className="se-history">
        <button type="button" className="se-history-toggle" onClick={() => void toggleHistory()}>
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
                  {statusLabel(entry.from)} → {statusLabel(entry.to)}
                  {entry.until !== null && ` (→ ${entry.until})`}
                  {entry.comment !== null && ` — ${entry.comment}`}
                  <span className="se-history-actor">{entry.actor}</span>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </div>
  )
}
