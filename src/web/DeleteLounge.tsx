'use client'

import { useState } from 'react'
import type { Localized } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { deleteLoungeAction } from '@/app/admin/actions'

const OPEN: Localized = { en: 'Delete lounge', ru: 'Удалить лаунж' }
const CONFIRM: Localized = { en: 'Delete', ru: 'Удалить' }
const CANCEL: Localized = { en: 'Cancel', ru: 'Отмена' }
// Диалог обязан назвать, ЧТО именно уничтожается, — пользователь выбирал
// «с подтверждением», зная цену: анкета со всеми ответами и снимками,
// замечания и подтверждения, история статусов. И одну строку про ссылку
// оператора: живой fill-токен умирает вместе с анкетой — это неотъемлемо
// (токены не отзываются и не переносятся), но человек должен узнать об этом
// ДО удаления, а не от оператора.
const WARNING: Localized = {
  en: 'This permanently deletes the questionnaire with its photos, the review comments and the full history. If an operator has a fill link, it will stop working.',
  ru: 'Будут безвозвратно удалены анкета со снимками, замечания проверки и вся история. Если у оператора есть ссылка на заполнение, она перестанет работать.',
}
const TYPE_NAME: Localized = {
  en: 'Type the lounge name to confirm',
  ru: 'Введите название лаунжа для подтверждения',
}

/**
 * Удаление лаунжа из строки реестра: неброский «×» в последней ячейке
 * (операция редкая — красная кнопка на каждой строке кричала бы попусту),
 * раскрывающий диалог с перечнем уничтожаемого и полем для названия.
 *
 * Кнопка «Удалить» выключена, пока набранное не совпало с названием, — но
 * это ПОДСКАЗКА: настоящая сверка в `deleteLounge` на сервере, потому что
 * действие достижимо по сети напрямую (правило ветки). Совпадение здесь —
 * то же, что там: точное, после trim.
 *
 * Успех виден исчезновением строки (`revalidatePath` внутри действия — тот
 * же механизм, что у смены статуса); отказ — весь `Localized` через `pick()`.
 */
export function DeleteLounge(props: {
  loungeId: string
  name: string
}): React.JSX.Element {
  const { pick } = useLocale()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<Localized | null>(null)
  const [busy, setBusy] = useState(false)

  function close(): void {
    setOpen(false)
    setTyped('')
    setError(null)
  }

  async function remove(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result = await deleteLoungeAction(props.loungeId, typed)
      if (result.ok) close()
      else setError(result.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dl">
      <button
        type="button"
        className="dl-open"
        aria-label={`${pick(OPEN)}: ${props.name}`}
        title={pick(OPEN)}
        onClick={() => (open ? close() : setOpen(true))}
      >
        ×
      </button>
      {open && (
        <div className="dl-panel">
          <p className="dl-warning">{pick(WARNING)}</p>
          <label className="dl-confirm">
            {pick(TYPE_NAME)}
            <input value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
          {error && <p className="se-error">{pick(error)}</p>}
          <div className="se-actions">
            <button
              type="button"
              className="dl-danger"
              disabled={busy || typed.trim() !== props.name}
              onClick={() => void remove()}
            >
              {pick(CONFIRM)}
            </button>
            <button type="button" disabled={busy} onClick={close}>
              {pick(CANCEL)}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
