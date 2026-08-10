'use client'

import { PHOTO_SLOTS } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { resizeToJpeg } from '@/photos/resize'

export function PhotoSlots(props: {
  token: string
  uploaded: Record<string, string[]>
  onUploaded: (slot: string, url: string) => void
}): React.JSX.Element {
  const { pick, t } = useLocale()

  async function upload(slot: string, file: File): Promise<void> {
    const resized = await resizeToJpeg(file)
    const body = new FormData()
    body.set('token', props.token)
    body.set('slot', slot)
    body.set('file', new File([resized], `${slot}.jpg`, { type: 'image/jpeg' }))

    const response = await fetch('/api/photos', { method: 'POST', body })
    if (!response.ok) return
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
