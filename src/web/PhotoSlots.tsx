'use client'

import { useState } from 'react'
import type { Localized } from '@/form-schema'
import { PHOTO_SLOTS } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { UI } from '@/i18n/dictionaries'
import { resizeToJpeg } from '@/photos/resize'

/**
 * Narrows an already-parsed JSON value's `error` field to `Localized` — the
 * shape every route rejection now sends (see `src/app/api/photos/route.ts`).
 * Anything else (a body that isn't JSON at all, or JSON without a matching
 * `error` shape) falls back to `UI['photos.uploadFailed']` at the call site
 * rather than being trusted here.
 */
function isLocalized(value: unknown): value is Localized {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { en?: unknown }).en === 'string' &&
    typeof (value as { ru?: unknown }).ru === 'string'
  )
}

/**
 * `slotKeys` narrows which of `PHOTO_SLOTS` this renders; omitted, it renders
 * all four, as the photos step of the main form does.
 *
 * This is how the fixes screen (`FixesOnly`) reuses the upload control for a
 * flagged slot instead of getting its own copy. Everything that makes an
 * upload work — `resizeToJpeg`, the `FormData` shape `/api/photos` expects,
 * the per-slot error state, the success path that calls `onUploaded` — is
 * already per-slot here and keyed by slot, so the only thing the fixes screen
 * actually needed was "render one of these, not all four". A second component
 * would have had to restate every one of those, and the failure mode of
 * restating them is silent (an upload that posts a slightly different body,
 * or swallows a rejection) — the defect class this branch keeps hitting.
 *
 * Filtering `PHOTO_SLOTS` by key rather than accepting `PhotoSlot[]` objects
 * keeps the schema the single source of a slot's `label`/`required`/`extra`:
 * a caller cannot hand in a fabricated slot whose `extra` disagrees with what
 * `attachPhoto` will actually do on the server.
 *
 * `onRemoved` is what makes the per-photo Remove button appear, and only for
 * an `extra` slot — the two halves of "who may remove a photo" deliberately
 * live in different places. WHICH slot can offer it is derived from the schema
 * here (`slot.extra`), because for a named slot a new upload replaces the old
 * one and therefore already answers the complaint in full, while for
 * `additional` it does not: `attachPhoto` adds a row and leaves the objected-to
 * photo where it was. WHICH SCREEN offers it is the caller's choice — only
 * `FixesOnly` passes `onRemoved`, so the photos step of the main form is
 * unchanged. Scoped there because that screen is the only one where a specific
 * existing photo has been objected to by name; on the photos step nobody has
 * complained about anything yet, and widening it is a separate decision about
 * the main form, not a consequence of this one.
 */
export function PhotoSlots(props: {
  token: string
  uploaded: Record<string, string[]>
  onUploaded: (slot: string, url: string) => void
  /** Убрать снимок (см. выше): передаётся только экраном правок, работает
   *  только у накопительного слота. */
  onRemoved?: (slot: string, url: string) => void
  slotKeys?: readonly string[]
}): React.JSX.Element {
  const { pick, t } = useLocale()
  const slots =
    props.slotKeys === undefined
      ? PHOTO_SLOTS
      : PHOTO_SLOTS.filter((slot) => props.slotKeys?.includes(slot.key))
  // Per-slot, not a single form-wide error: a rejection on one slot must
  // not blank out or get confused with whatever another slot is showing.
  const [errors, setErrors] = useState<Record<string, Localized>>({})
  /**
   * Снимки, удаление которых уже в пути. Нужно потому, что заявленная среда —
   * телефон на аэропортовом Wi-Fi: между тапом и ответом сервера проходит
   * заметное время, кнопка всё это время на экране, и второй тап отправил бы
   * второй DELETE того же снимка. Первый бы прошёл, второй вернул бы «Фото не
   * найдено» — то есть заполняющий увидел бы ошибку про снимок, который как раз
   * успешно убран. Гасим на время запроса, а не спрашиваем подтверждение:
   * случайное удаление здесь восстановимо (снимок остаётся в телефоне, кнопка
   * «Добавить» рядом), а лишний диалог на каждый тап — нет.
   */
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set())

  async function upload(slot: string, file: File): Promise<void> {
    // `resizeToJpeg` and `fetch` were previously called outside any `try`:
    // a dropped connection (or a resize failure) threw an unhandled
    // rejection instead of reaching either branch below, so the operator
    // tapped Upload and nothing happened at all — no error, no retry
    // prompt, silence. Photos gate submission and the stated environment is
    // airport Wi-Fi, so this is the ordinary case, not an edge case (see
    // Important finding I8 in the whole-branch review).
    try {
      const resized = await resizeToJpeg(file)
      const body = new FormData()
      body.set('token', props.token)
      body.set('slot', slot)
      body.set('file', new File([resized], `${slot}.jpg`, { type: 'image/jpeg' }))

      const response = await fetch('/api/photos', { method: 'POST', body })

      if (!response.ok) {
        let error: Localized = UI['photos.uploadFailed']
        try {
          const data: unknown = await response.json()
          const candidate = (data as { error?: unknown }).error
          if (isLocalized(candidate)) error = candidate
        } catch {
          // Тело не JSON (или пустое) — используем общее сообщение выше.
        }
        setErrors((prev) => ({ ...prev, [slot]: error }))
        return
      }

      // Успешная загрузка снимает прежний отказ по этому слоту — заполняющий
      // это увидит сам, повторно открыв слот, но чистим сразу, а не оставляем
      // старую ошибку висеть рядом с уже загруженным фото.
      setErrors((prev) => {
        if (!(slot in prev)) return prev
        const next = { ...prev }
        delete next[slot]
        return next
      })

      const data = (await response.json()) as { url: string }
      props.onUploaded(slot, data.url)
    } catch {
      // Network drop, a `resizeToJpeg` failure (corrupt image, decode
      // error), or anything else that throws before a response exists — all
      // the same to the operator: the upload didn't happen and needs a
      // visible, retryable error, not silence.
      setErrors((prev) => ({ ...prev, [slot]: UI['photos.uploadFailed'] }))
    }
  }

  async function remove(slot: string, url: string): Promise<void> {
    if (removing.has(url)) return
    setRemoving((prev) => new Set(prev).add(url))
    try {
      const response = await fetch('/api/photos', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: props.token, slot, url }),
      })

      if (!response.ok) {
        let error: Localized = UI['photos.removeFailed']
        try {
          const data: unknown = await response.json()
          const candidate = (data as { error?: unknown }).error
          if (isLocalized(candidate)) error = candidate
        } catch {
          // Тело не JSON — общее сообщение выше, как и у загрузки.
        }
        setErrors((prev) => ({ ...prev, [slot]: error }))
        return
      }

      setErrors((prev) => {
        if (!(slot in prev)) return prev
        const next = { ...prev }
        delete next[slot]
        return next
      })

      props.onRemoved?.(slot, url)
    } catch {
      // Ровно те же причины и та же цена, что у `upload`: без видимого отказа
      // заполняющий жмёт «Убрать» и не понимает, произошло ли что-нибудь.
      setErrors((prev) => ({ ...prev, [slot]: UI['photos.removeFailed'] }))
    } finally {
      // И после отказа тоже: иначе один сбой сети запирал бы этот снимок
      // навсегда — единственный правдивый ответ на замечание по слоту стал бы
      // недоступен до перезагрузки страницы.
      setRemoving((prev) => {
        if (!prev.has(url)) return prev
        const next = new Set(prev)
        next.delete(url)
        return next
      })
    }
  }

  return (
    <section className="photos">
      {slots.map((slot) => (
        <div key={slot.key} className="photo-slot">
          <h3>{pick(slot.label)}</h3>
          {(props.uploaded[slot.key] ?? []).map((url, index) => (
            // Номер снимка в подписях: у `additional` в слоте их несколько, и
            // без него пользователь скринридера слышит несколько одинаковых
            // «Additional Photos» и несколько одинаковых «Убрать» без способа
            // понять, какая кнопка убирает какой снимок — тот же довод, по
            // которому нумерация уже есть на экране проверки (`FieldRow`).
            <div key={url} className="photo-shot">
              <img src={url} alt={`${pick(slot.label)} ${index + 1}`} />
              {slot.extra && props.onRemoved && (
                <button
                  type="button"
                  className="photo-remove"
                  aria-label={`${t('photos.remove')}: ${pick(slot.label)} ${index + 1}`}
                  disabled={removing.has(url)}
                  onClick={() => void remove(slot.key, url)}
                >
                  {t('photos.remove')}
                </button>
              )}
            </div>
          ))}
          {slot.required && !props.uploaded[slot.key]?.length && (
            <p className="field-hint">{t('photos.missing')}</p>
          )}
          {errors[slot.key] && <p className="fix-comment">{pick(errors[slot.key]!)}</p>}
          <label className="photo-upload">
            {/* Подпись читается по тому же правилу, по которому сервер
                действительно поступает со слотом, а не по «есть ли уже
                снимки»: накопительный слот (`extra`) всегда ДОБАВЛЯЕТ (см.
                `attachPhoto` и `FillForm`'s `photoUploaded`), поэтому у
                непустого `additional` подпись была «Заменить», а нажатие
                добавляло четвёртый снимок и оставляло непригодный на месте.
                Убрать его — отдельная кнопка выше. */}
            {slot.extra
              ? t('photos.add')
              : props.uploaded[slot.key]?.length
                ? t('photos.replace')
                : t('photos.upload')}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void upload(slot.key, file)
              }}
            />
          </label>
        </div>
      ))}
    </section>
  )
}
