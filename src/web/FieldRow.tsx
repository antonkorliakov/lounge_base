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
  /**
   * Только для фото-слотов (см. `ReviewScreen.tsx`, блок `kind: 'photos'`).
   * `undefined` — обычное поле/позиция услуг, показывается `value` как текст,
   * как и раньше. Массив (пустой или нет) — фото-слот: показывается галерея
   * миниатюр или `photos.missing`, а `value` игнорируется.
   *
   * Раньше `renderValues` схлопывал URL до счётчика ("3"), и это была
   * единственная информация, которую получал ревьюер об одном из 27
   * подтверждаемых блоков — притом блоке, для которого дизайн явно разрешает
   * отмечать отдельный слот замечанием. Отметить снимок, не видя его,
   * невозможно: ревьюер должен убедиться, что вход на фото — действительно
   * вход, что стойка регистрации видна, что ориентиры совпадают с
   * письменными инструкциями (`III.5.1`/`III.5.5`) — a bare count answers
   * none of that.
   */
  photos?: string[]
  flag: ExistingFlag | null
  onRaise: (reason: FlagReason | null, comment: string) => void
  onResolve: (flagId: string) => void
}): React.JSX.Element {
  const { locale, t } = useLocale()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<FlagReason | null>(null)
  const [comment, setComment] = useState('')

  // Миниатюра, а не голая ссылка на каждое из пяти фото (утомительно
  // открывать по одной) и не голая ссылка без превью (недостаточно, чтобы
  // узнать вход по картинке размером 40 пикселей). ~120px даёт узнать сцену
  // на глаз; клик открывает оригинал в новой вкладке для полной проверки —
  // тот же компромисс, что и в галереях фотоприложений.
  const valueArea =
    props.photos === undefined ? (
      props.value
    ) : props.photos.length === 0 ? (
      <p className="field-hint">{t('photos.missing')}</p>
    ) : (
      <div className="frow-photos">
        {props.photos.map((url) => (
          <a key={url} href={url} target="_blank" rel="noreferrer" className="frow-photo">
            <img src={url} alt={props.label} loading="lazy" />
          </a>
        ))}
      </div>
    )

  if (props.flag) {
    return (
      <div className="frow frow-flagged">
        <div className="frow-key">{props.label}</div>
        <div className="frow-value">
          {valueArea}
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
        {valueArea}
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
