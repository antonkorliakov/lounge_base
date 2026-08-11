'use client'

import { useState } from 'react'
import { useLocale } from '@/i18n/context'
import type { FlagReason } from '@/review/flags'

const REASONS: { id: FlagReason; en: string; ru: string }[] = [
  { id: 'empty', en: 'not filled in', ru: 'не заполнено' },
  { id: 'needs_detail', en: 'needs detail', ru: 'нужна расшифровка' },
  { id: 'contradicts', en: 'contradicts another answer', ru: 'противоречит другому полю' },
  { id: 'wrong_format', en: 'wrong format', ru: 'неверный формат' },
]

export type ExistingFlag = { id: string; reason: FlagReason | null; comment: string }

/**
 * Кнопка «отметить» проявляется по наведению на устройствах с мышью — в
 * покое она скрыта, иначе кнопки рябят на каждой из сотен строк. Наведения
 * не существует на touch-устройстве, поэтому видимость по `:hover`
 * ограничена в CSS медиа-запросом `(hover: hover) and (pointer: fine)`
 * (см. `globals.css`, `.frow-act`): на touch и при клавиатурной фокусировке
 * кнопка всегда видима — иначе на планшете у ревьюера не было бы способа
 * узнать, что кнопка существует, кроме случайного тапа мимо неё.
 */
export function FieldRow(props: {
  label: string
  value: string
  flag: ExistingFlag | null
  onRaise: (reason: FlagReason | null, comment: string) => void
  onResolve: (flagId: string) => void
}): React.JSX.Element {
  const { locale } = useLocale()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<FlagReason | null>(null)
  const [comment, setComment] = useState('')

  if (props.flag) {
    return (
      <div className="frow frow-flagged">
        <div className="frow-key">{props.label}</div>
        <div className="frow-value">
          {props.value}
          <div className="frow-comment">
            <b>
              {REASONS.find((r) => r.id === props.flag?.reason)?.[locale] ??
                (locale === 'ru' ? 'Замечание' : 'Flag')}
            </b>
            {props.flag.comment}
            <button
              type="button"
              className="frow-undo"
              onClick={() => props.onResolve(props.flag!.id)}
            >
              {locale === 'ru' ? 'снять замечание' : 'resolve'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="frow">
      <div className="frow-key">{props.label}</div>
      <div className="frow-value">
        {props.value}
        {open && (
          <div className="frow-editor">
            <div className="frow-chips">
              {REASONS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`chip ${reason === item.id ? 'chip-on' : ''}`}
                  onClick={() => setReason(reason === item.id ? null : item.id)}
                >
                  {item[locale]}
                </button>
              ))}
            </div>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={locale === 'ru' ? 'Что не так?' : 'What is wrong?'}
            />
            <div className="frow-actions">
              <button
                type="button"
                className="bt-flag"
                disabled={comment.trim() === ''}
                onClick={() => {
                  props.onRaise(reason, comment)
                  setOpen(false)
                  setComment('')
                  setReason(null)
                }}
              >
                {locale === 'ru' ? 'Отметить' : 'Flag'}
              </button>
              <button type="button" onClick={() => setOpen(false)}>
                {locale === 'ru' ? 'Отмена' : 'Cancel'}
              </button>
            </div>
          </div>
        )}
      </div>
      <button type="button" className="frow-act" onClick={() => setOpen(true)}>
        {locale === 'ru' ? 'отметить' : 'flag'}
      </button>
    </div>
  )
}
