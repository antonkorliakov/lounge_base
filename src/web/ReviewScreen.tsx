'use client'

import { useState } from 'react'
import {
  BLOCKS, FIELDS, SERVICE_ITEMS, PHOTO_SLOTS,
  type Localized, type ServiceValueInput,
} from '@/form-schema'
import type { BlockState } from '@/review/blocks'
import type { FlagRow, FlagReason } from '@/review/flags'
import { useLocale } from '@/i18n/context'
import { keysOfBlock } from '@/review/blocks'
import { BlockNav } from './BlockNav'
import { FieldRow } from './FieldRow'
import {
  flagAction, unflagAction, confirmBlockAction,
  requestChangesAction, approveAction, resendFillLinkAction,
  type ActionResult,
} from '@/app/admin/s/[submissionId]/actions'

export function ReviewScreen(props: {
  submissionId: string
  progress: BlockState[]
  flags: FlagRow[]
  rendered: Record<string, { label: string; value: string }>
}): React.JSX.Element {
  const { locale, pick } = useLocale()
  const [current, setCurrent] = useState(BLOCKS[0]!.key)
  const [error, setError] = useState<Localized | null>(null)
  const [notice, setNotice] = useState<Localized | null>(null)

  const flagByKey = new Map(props.flags.map((flag) => [flag.fieldKey, flag]))
  const block = BLOCKS.find((b) => b.key === current)!
  const keys = keysOfBlock(current)
  const openInBlock = keys.filter((key) => flagByKey.has(key)).length

  // Тот же приём, что и в `FillForm` (план 1): `error` несёт `Localized`
  // целиком, а не заранее выбранную строку — `pick()` внизу выбирает нужный
  // язык тем же способом, что и подписи блоков. Этот экран сейчас не имеет
  // своего переключателя языка (в отличие от `FillForm`), но тип держит то
  // же соглашение, что и весь остальной код, а не собственный.
  //
  // `notice` — отдельная от `error` дорожка: `ActionResult`'s `ok: true`
  // ветка может нести `notice` (решение состоялось, но письмо не ушло или
  // некому было его отправить — см. `actions.ts`'s собственный комментарий).
  // Смешивать это с `error` означало бы показать успешное действие как
  // отказ, хотя решение уже закоммичено и откатывать его нечем.
  async function run(action: () => Promise<ActionResult>): Promise<void> {
    const result = await action()
    if (result.ok) {
      setError(null)
      setNotice(result.notice ?? null)
    } else {
      setNotice(null)
      setError(result.error)
    }
  }

  return (
    <div className="review-screen">
      <BlockNav progress={props.progress} current={current} onSelect={setCurrent} />

      <section className="review-pane">
        <h2>{pick(block.label)}</h2>
        {keys.map((key) => {
          const cell = props.rendered[key]
          return (
            <FieldRow
              key={key}
              label={cell?.label ?? key}
              value={cell?.value ?? '—'}
              flag={flagByKey.get(key) ?? null}
              onRaise={(reason: FlagReason | null, comment: string) =>
                void run(() => flagAction(props.submissionId, key, reason, comment))
              }
              onResolve={(flagId) =>
                void run(() => unflagAction(props.submissionId, flagId))
              }
            />
          )
        })}

        {error && <p className="review-error">{pick(error)}</p>}
        {notice && <p className="review-notice">{pick(notice)}</p>}

        <div className="review-foot">
          <button
            type="button"
            onClick={() => void run(() => requestChangesAction(props.submissionId))}
          >
            {locale === 'ru' ? 'Вернуть на правку' : 'Request changes'} · {props.flags.length}
          </button>
          <button
            type="button"
            onClick={() => void run(() => resendFillLinkAction(props.submissionId))}
          >
            {locale === 'ru' ? 'Переслать ссылку' : 'Resend link'}
          </button>
          <button
            type="button"
            disabled={openInBlock > 0}
            onClick={() => void run(() => confirmBlockAction(props.submissionId, current))}
          >
            {locale === 'ru' ? 'Подтвердить блок' : 'Confirm block'}
          </button>
          <button
            type="button"
            onClick={() => void run(() => approveAction(props.submissionId))}
          >
            {locale === 'ru' ? 'Принять анкету' : 'Approve'}
          </button>
        </div>
      </section>
    </div>
  )
}

/**
 * Плоское представление одной позиции услуг для показа ревьюеру.
 *
 * Черновик этой функции показывал только `available`/`chargeType`/`price`+
 * `currency` — и тем самым прятал `details`, `slotMinutes` и
 * `bookingRequired` целиком. Это не косметика: у нескольких позиций
 * (`Conference Room`, `VIP / Private Meeting Room`, `Sleeping Area / Pods`
 * — все несут `hint: specifyCapacity`, "If yes, please specify the
 * capacity"; `Premium Alcohol` — "please specify drinks"; `Alcohol Service
 * Hours` — "please specify hours", см. `form-schema/services.ts`) сам ответ
 * на подсказку пишется именно в `details`, а не в одно из трёх показанных
 * полей. Ревьюер, глядящий только на старую тройку, увидел бы "yes ·
 * chargeable · 50 USD" и не смог бы проверить, действительно ли оператор
 * указал вместимость/напитки/часы — то есть ту самую вещь, которую вопрос
 * и просит уточнить. `slotMinutes`/`bookingRequired` — тот же случай для
 * позиций с записью на слот (массаж, спа). Все шесть атрибутов показаны
 * здесь ради этого — не ради полноты как таковой.
 */
function formatServiceValue(
  value: ServiceValueInput | undefined,
  locale: 'en' | 'ru',
): string {
  const parts = [
    value?.available ?? '—',
    value?.chargeType ?? null,
    value?.price !== null && value?.price !== undefined
      ? `${value.price} ${value.currency ?? ''}`.trim()
      : null,
    value?.slotMinutes !== null && value?.slotMinutes !== undefined
      ? `${value.slotMinutes} ${locale === 'ru' ? 'мин' : 'min'}`
      : null,
    value?.bookingRequired === true
      ? (locale === 'ru' ? 'нужна запись' : 'booking required')
      : null,
    value?.details ? value.details : null,
  ]
  return parts.filter(Boolean).join(' · ')
}

/** Плоское представление значений для показа ревьюеру. */
export function renderValues(input: {
  fields: Record<string, unknown>
  services: Record<string, ServiceValueInput>
  photos: Record<string, string[]>
  locale: 'en' | 'ru'
}): Record<string, { label: string; value: string }> {
  const out: Record<string, { label: string; value: string }> = {}

  for (const field of FIELDS) {
    const raw = input.fields[field.key]
    out[field.key] = {
      label: field.label[input.locale],
      value: formatValue(raw),
    }
  }

  for (const item of SERVICE_ITEMS) {
    out[item.key] = {
      label: item.label[input.locale],
      value: formatServiceValue(input.services[item.key], input.locale),
    }
  }

  for (const slot of PHOTO_SLOTS) {
    const urls = input.photos[slot.key] ?? []
    out[slot.key] = {
      label: slot.label[input.locale],
      value: urls.length === 0 ? '—' : `${urls.length}`,
    }
  }

  return out
}

/**
 * `III.3.2` (Unaccompanied Children Policy) — единственное поле анкеты, чей
 * ответ несёт составной `slots` наравне с `option`/`detail` (см.
 * `form-schema/validation.ts`'s `SelectValue.slots` и
 * `TEMPLATE_REQUIRED_BY_OPTION`): выбор "allowed" обязан нести минимальный
 * возраст в `slots.age`. Черновик этой функции проверял только `'option'
 * in raw` и читал `option`/`detail` — `slots` у него не было в типе
 * вообще, так что для этого единственного поля во всей анкете сам возраст,
 * то есть содержательный ответ на вопрос, тихо пропадал из показа
 * ревьюеру: он видел "allowed" и ничего больше, хотя вопрос "с какого
 * возраста" остаётся без ответа на экране независимо от того, был ли он
 * дан оператором. Ревьюер не может подтвердить блок, не видя того, что
 * подтверждает.
 */
function formatValue(raw: unknown): string {
  if (raw === null || raw === undefined || raw === '') return '—'
  if (Array.isArray(raw)) return raw.join(', ')
  if (typeof raw === 'object' && 'option' in raw) {
    const value = raw as { option: string; detail: string | null; slots?: Record<string, number | null> }
    const parts = [value.option]
    if (value.detail) parts.push(value.detail)
    if (value.slots) {
      const slotText = Object.entries(value.slots)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([slotKey, v]) => `${slotKey}: ${v}`)
        .join(', ')
      if (slotText) parts.push(slotText)
    }
    return parts.join(' — ')
  }
  if (typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>)
      .map(([key, val]) => `${key}: ${String(val)}`)
      .join(', ')
  }
  return String(raw)
}
