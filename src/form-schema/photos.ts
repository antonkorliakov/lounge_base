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

/**
 * Тот же поиск по ключу, что `fieldByKey` (`./fields.ts`) и
 * `serviceItemByKey` (`./services.ts`) — три категории вопросов анкеты
 * ищутся по ключу одинаково. Нужен `FixesOnly` (`src/web/FixesOnly.tsx`),
 * который по одному ключу замечания решает, какой из трёх контролов
 * показать, и должен делать это одним и тем же способом для всех трёх, а не
 * своим локальным `PHOTO_SLOTS.find` для одной из них.
 */
export function photoSlotByKey(key: string): PhotoSlot | undefined {
  return PHOTO_SLOTS.find((s) => s.key === key)
}
