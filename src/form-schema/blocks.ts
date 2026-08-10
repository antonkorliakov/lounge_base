import type { Localized } from './types'
import { FIELDS } from './fields'
import { SERVICE_GROUPS, SERVICE_ITEMS } from './services'
import { PHOTO_SLOTS } from './photos'

export type BlockKind = 'fields' | 'services' | 'photos'

export type Block = {
  key: string
  kind: BlockKind
  label: Localized
}

const fields = (key: string, en: string, ru: string): Block => ({
  key, kind: 'fields', label: { en, ru },
})

const services = (key: string, en: string, ru: string): Block => ({
  key, kind: 'services', label: { en, ru },
})

export const BLOCKS: Block[] = [
  fields('I', 'Lounge Profile & Commercial Details', 'Профиль и коммерческие детали'),
  fields('II.1', 'Primary Operational Contact', 'Основной операционный контакт'),
  fields('II.2', 'Shift / Duty Contact', 'Сменный контакт'),
  fields('II.3', 'Finance Contact', 'Финансовый контакт'),
  fields('II.4', 'Lounge Direct Contacts', 'Прямые контакты лаунжа'),
  fields('III.1', 'Operating Schedule', 'График работы'),
  fields('III.2', 'Access Rules & Restrictions', 'Правила доступа'),
  fields('III.3', 'Children Policy', 'Дети'),
  fields('III.4', 'Passenger & Entry Restrictions', 'Ограничения на вход'),
  fields('III.5', 'Lounge Location', 'Расположение'),
  fields('III.6', 'Terminal & Zone Information', 'Терминал и зона'),
  fields('III.7', 'Multi-Terminal Access', 'Доступ из других терминалов'),
  fields('III.8', 'Capacity Information', 'Вместимость'),
  fields('IV', 'Lounge Signage', 'Размещение логотипа'),
  fields('V', 'Lounge Validity', 'Срок действия соглашения'),
  services('svc.a1', 'Comfort & Environment', 'Комфорт и обстановка'),
  services('svc.a2', 'Connectivity & Business', 'Связь и работа'),
  services('svc.a3', 'Information & Announcements', 'Информация и объявления'),
  services('svc.a4', 'Special Assistance', 'Особые потребности'),
  services('svc.a5', 'Rest & Relaxation / Spa', 'Отдых и спа'),
  services('svc.a6', 'Family & Children Facilities', 'Семья и дети'),
  services('svc.a7', 'Hygiene & Sanitary', 'Гигиена'),
  services('svc.a8', 'Additional Facilities', 'Дополнительно'),
  services('svc.f1', 'Meal Types', 'Виды питания'),
  services('svc.f2', 'Special Meal Options', 'Специальное питание'),
  services('svc.f3', 'Beverages', 'Напитки'),
  { key: 'photos', kind: 'photos', label: { en: 'Photos', ru: 'Фотографии' } },
]

export function blockOf(key: string): Block | undefined {
  return BLOCKS.find((b) => b.key === key)
}

/**
 * Block membership: which leaf keys (flat fields, service items, photo
 * slots) belong to each block, in both directions — `keysOfBlock` (block →
 * its keys) and `blockKeyOf` (a key → its block). Built once, in one pass
 * over `FIELDS` / `SERVICE_GROUPS`+`SERVICE_ITEMS` / `PHOTO_SLOTS`, into two
 * maps that are simply each other's index. This is deliberate: an earlier
 * version of this codebase had `blockKeyOf` (key → block) hand-written in
 * `src/review/flags.ts` as its own independent scan over these same three
 * arrays. That was a reasonable call when only one direction existed — see
 * that task's own report, which explicitly considered and declined moving
 * it here, since nothing else needed the reverse direction yet. Task 3
 * (`src/review/blocks.ts`) needs `keysOfBlock`, the *inverse* of that
 * mapping, over the exact same three arrays. Two independently-maintained
 * scans that must agree forever is exactly the defect class this codebase
 * has hit three times already (a validator rule the renderer couldn't see,
 * a duplicated result type, a hand-typed reason-code list beside its own
 * union) — the fix each time was the same: one construction, not two kept
 * in sync by review discipline. `register` below is that one construction;
 * `keysOfBlock` and `blockKeyOf` are two read-only views over its output, so
 * a key can never appear in one map's answer without appearing in the
 * other's — there is no code path that could update one without the other,
 * because there is only one update. This lives in `form-schema`, not
 * `src/review`, because block↔key membership is questionnaire structure —
 * the same reason `Field.block` and `ServiceGroup.block` (which this
 * construction reads) already live here rather than in the review layer.
 * `src/review/flags.ts` now imports and re-exports `blockKeyOf` from here
 * instead of computing its own.
 */
const KEYS_BY_BLOCK = new Map<string, string[]>()
const BLOCK_BY_KEY = new Map<string, string>()

function register(blockKey: string, key: string): void {
  BLOCK_BY_KEY.set(key, blockKey)
  const existing = KEYS_BY_BLOCK.get(blockKey)
  if (existing) existing.push(key)
  else KEYS_BY_BLOCK.set(blockKey, [key])
}

for (const field of FIELDS) register(field.block, field.key)
for (const item of SERVICE_ITEMS) {
  const group = SERVICE_GROUPS.find((g) => g.key === item.group)
  if (group) register(group.block, item.key)
}
for (const slot of PHOTO_SLOTS) register('photos', slot.key)

/** Ключи (полей / позиций услуг / слотов фото), за которые отвечает блок. */
export function keysOfBlock(blockKey: string): string[] {
  return KEYS_BY_BLOCK.get(blockKey) ?? []
}

/** Блок, за который отвечает отмеченный ключ, или `null` для незнакомого ключа. */
export function blockKeyOf(key: string): string | null {
  return BLOCK_BY_KEY.get(key) ?? null
}
