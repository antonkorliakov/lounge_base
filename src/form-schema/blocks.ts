import type { Localized } from './types'

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
