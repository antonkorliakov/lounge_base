'use client'

import { useState } from 'react'
import { BLOCKS, PHOTO_SLOTS, type Localized } from '@/form-schema'
import type { RenderedCell } from './renderValues'
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
// `import type` — стирается при компиляции, так что серверный модуль (а с ним
// `@/submissions/editable` и `drizzle-orm`) в браузерный бандл не попадает; то
// же соглашение, что у `SubmissionStatus` в `FillForm.tsx`.
import type { ResendGate } from '@/app/admin/s/[submissionId]/resend-gate'

/**
 * Обязательность слота — из схемы (`PHOTO_SLOTS`), тем же источником, каким
 * пользуется сторона заполнения (`PhotoSlots.tsx` показывает «нет фото»
 * только при `slot.required`). `FieldRow` сам о слотах ничего не знает и не
 * должен: он получает уже готовый ответ на вопрос «обязателен ли этот слот» —
 * шов узкий, одно поле в уже существующем фото-пропе.
 */
const PHOTO_SLOT_REQUIRED = new Map(PHOTO_SLOTS.map((slot) => [slot.key, slot.required]))

export function ReviewScreen(props: {
  submissionId: string
  progress: BlockState[]
  flags: FlagRow[]
  rendered: Record<string, RenderedCell>
  /**
   * URL-ы фото по слоту — отдельно от `rendered`, потому что `rendered`
   * плоский по конструкции (значение — строка, см. `RenderedCell` в
   * `./renderValues.ts`): показать снимок строкой значит показать его
   * счётчик, а не сам снимок (см. отчёт задачи, находка ревьюера "Photos are
   * unreviewable"). `FieldRow` получает эти URL-ы напрямую только для блока
   * `kind: 'photos'` — остальные 26 блоков продолжают идти через `rendered`,
   * как и раньше.
   */
  photos: Record<string, string[]>
  /**
   * Готовый ответ на «можно ли переслать оператору ссылку», посчитанный на
   * сервере (`resendGateFor` в `@/app/admin/s/[submissionId]/resend-gate`) —
   * не статус анкеты и не правило. Компонент получает решение, а не данные для
   * его принятия: тот же приём, что и `photos.required` выше, и по той же
   * причине здесь особенно — правило живёт в `EDITABLE_STATUSES`
   * (`src/submissions/editable.ts`), а его импорт затащил бы `drizzle-orm` в
   * браузерный бандл.
   *
   * Кнопка выключается, а не исчезает: пропавшая кнопка не объясняет ничего, а
   * выключенная несёт в `title` ту же причину, которую вернуло бы серверное
   * действие. Это подсказка, НЕ защита — гейт стоит в самом
   * `resendFillLinkAction`, потому что серверное действие вызывается по сети и
   * клиентский компонент ему не преграда.
   */
  resend: ResendGate
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
              photos={
                block.kind === 'photos'
                  ? {
                      urls: props.photos[key] ?? [],
                      // `?? true` — только на случай ключа, которого нет в
                      // `PHOTO_SLOTS` (то есть рассогласования схемы:
                      // `blocks.ts` наполняет блок `photos` именно из
                      // `PHOTO_SLOTS`). Тогда слот считается обязательным —
                      // прежнее поведение, и лучше лишний раз спросить про
                      // снимок, чем промолчать о пропущенном.
                      required: PHOTO_SLOT_REQUIRED.get(key) ?? true,
                    }
                  : undefined
              }
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
            disabled={!props.resend.allowed}
            title={props.resend.allowed ? undefined : pick(props.resend.reason)}
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
