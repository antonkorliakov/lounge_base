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

export function PhotoSlots(props: {
  token: string
  uploaded: Record<string, string[]>
  onUploaded: (slot: string, url: string) => void
}): React.JSX.Element {
  const { pick, t } = useLocale()
  // Per-slot, not a single form-wide error: a rejection on one slot must
  // not blank out or get confused with whatever another slot is showing.
  const [errors, setErrors] = useState<Record<string, Localized>>({})

  async function upload(slot: string, file: File): Promise<void> {
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
  }

  return (
    <section className="photos">
      {PHOTO_SLOTS.map((slot) => (
        <div key={slot.key} className="photo-slot">
          <h3>{pick(slot.label)}</h3>
          {(props.uploaded[slot.key] ?? []).map((url) => (
            <img key={url} src={url} alt={pick(slot.label)} />
          ))}
          {slot.required && !props.uploaded[slot.key]?.length && (
            <p className="field-hint">{t('photos.missing')}</p>
          )}
          {errors[slot.key] && <p className="field-hint">{pick(errors[slot.key]!)}</p>}
          <label className="photo-upload">
            {props.uploaded[slot.key]?.length ? t('photos.replace') : t('photos.upload')}
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
