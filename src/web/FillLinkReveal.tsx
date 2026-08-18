'use client'

import { useState } from 'react'
import type { Localized } from '@/form-schema'
import { useLocale } from '@/i18n/context'

const COPY: Localized = { en: 'Copy link', ru: 'Скопировать ссылку' }
const COPIED: Localized = { en: 'Copied', ru: 'Скопировано' }
const COPY_FAILED: Localized = {
  en: 'Copying failed — select the link and copy it manually',
  ru: 'Скопировать не вышло — выделите ссылку и скопируйте вручную',
}
// Хранится только хэш токена (`issueFillToken`) — сырой ссылки после этого
// экрана не существует нигде, поэтому «один раз» сказано словами, а не
// оставлено выясняться потерей. Но «один раз» — про ЭТУ ссылку, не про
// доступ: свежую в любой момент выдаёт кнопка копирования на экране проверки
// (`copyFillLinkAction`), пока форма открыта оператору, — и предупреждение
// обязано говорить об этом, иначе оно врёт в тревожную сторону (прежний текст
// «скопируйте сейчас» читался как «упустите — потеряете навсегда», что
// перестало быть правдой в момент появления кнопки).
const ONE_TIME: Localized = {
  en: 'The link is not shown again — while the form is open to the operator, the copy button on the review screen issues a fresh one anytime.',
  ru: 'Повторно ссылка не показывается — пока форма открыта оператору, свежую в любой момент выдаёт кнопка копирования на экране проверки.',
}

/**
 * Показ одноразовой ссылки заполнения для ручной передачи оператору: URL в
 * readonly-инпуте, кнопка копирования и предупреждение об одноразовости.
 *
 * ОДНО представление на оба места, где ссылка вообще появляется на экране, —
 * `AddLounge` (первая ссылка нового лаунжа) и `ReviewScreen` (ссылка из
 * `fillUrl` результата действия, когда почта не доставляет — см.
 * `FillLinkActionResult`). Пока показ был только в `AddLounge`, его правила
 * жили там; второй показ скопировал бы их, и «как выглядит одноразовая
 * ссылка» стало бы двумя правилами, расходящимися молча, — класс дефекта,
 * который эта ветка чинила не раз.
 *
 * Общее здесь — ровно то, что обязано совпадать: `navigator.clipboard.writeText`
 * требует secure context (боевой https и localhost — да) и может отказать;
 * отказ показывается ВИДИМЫМ текстом с планом Б (выделить и скопировать
 * руками), а не глотается — ссылка в readonly-инпуте именно затем, чтобы
 * план Б работал. Вступительный текст НЕ здесь: он у каждого места свой по
 * существу («лаунж заведён» — заголовок `AddLounge`; «письма не было» —
 * `notice` серверного действия у `ReviewScreen`). `children` — место для
 * кнопок вызывающего в том же ряду (у `AddLounge` там «Done»).
 *
 * Вызывающий, способный показать НЕСКОЛЬКО ссылок подряд (у `ReviewScreen`
 * каждое следующее действие выписывает новый токен), обязан передать `key={url}`:
 * состояние «Скопировано» принадлежит одной конкретной ссылке, и пережить
 * её смену значило бы подтвердить копирование того, чего в буфере нет.
 */
export function FillLinkReveal(props: {
  url: string
  children?: React.ReactNode
}): React.JSX.Element {
  const { pick } = useLocale()
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null)

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.url)
      setCopied('ok')
    } catch {
      setCopied('failed')
    }
  }

  return (
    <div className="link-reveal">
      <input className="al-url" readOnly value={props.url} onFocus={(e) => e.target.select()} />
      <p className="al-once">{pick(ONE_TIME)}</p>
      {copied === 'failed' && <p className="se-error">{pick(COPY_FAILED)}</p>}
      <div className="se-actions">
        <button type="button" onClick={() => void copy()}>
          {copied === 'ok' ? pick(COPIED) : pick(COPY)}
        </button>
        {props.children}
      </div>
    </div>
  )
}
