import type { Localized } from './types'

export type PhotoSlot = {
  key: string
  label: Localized
  required: boolean
  /** Слот принимает произвольное число дополнительных снимков. */
  extra: boolean
}

export const PHOTO_SLOTS: PhotoSlot[] = [
  { key: 'entrance', required: true, extra: false, label: { en: 'Entrance', ru: 'Вход' } },
  { key: 'reception', required: true, extra: false, label: { en: 'Reception Desk', ru: 'Стойка регистрации' } },
  { key: 'landmarks', required: true, extra: false, label: { en: 'Nearby Landmarks', ru: 'Ориентиры рядом' } },
  { key: 'additional', required: false, extra: true, label: { en: 'Additional Photos', ru: 'Дополнительные фото' } },
]

/** Исходная форма просит 4–5 снимков. */
export const MIN_PHOTOS = 4
