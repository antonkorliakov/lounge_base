import type { Localized } from '@/form-schema'

export const LOCALES = ['en', 'ru'] as const
export type Locale = (typeof LOCALES)[number]

export const UI = {
  'form.next': { en: 'Next', ru: 'Далее' },
  'form.back': { en: 'Back', ru: 'Назад' },
  'form.saved': { en: 'Saved', ru: 'Сохранено' },
  'form.savingOffline': {
    en: 'No connection — saved on this device',
    ru: 'Нет связи — сохранено на устройстве',
  },
  'form.submit': { en: 'Submit for review', ru: 'Отправить на проверку' },
  'form.submitted': {
    en: 'Sent for review. We will get back to you.',
    ru: 'Отправлено на проверку. Мы вернёмся с ответом.',
  },
  'form.incomplete': {
    en: 'Some answers are still missing',
    ru: 'Не все ответы заполнены',
  },
  'form.required': { en: 'Required', ru: 'Обязательно' },
  'services.pass1Title': {
    en: 'What does the lounge offer?',
    ru: 'Что есть в лаунже?',
  },
  'services.pass1Hint': {
    en: 'Tick everything available. Details come next.',
    ru: 'Отметьте всё, что есть. Детали спросим дальше.',
  },
  'services.pass2Title': { en: 'Details', ru: 'Детали' },
  'services.charge': { en: 'Complimentary or chargeable', ru: 'Платность' },
  'services.price': { en: 'Price', ru: 'Цена' },
  'services.currency': { en: 'Currency', ru: 'Валюта' },
  'services.slot': { en: 'Time slot, minutes', ru: 'Длительность, минут' },
  'services.booking': { en: 'Booking required', ru: 'Нужна бронь' },
  'services.details': { en: 'Other details', ru: 'Детали' },
  'photos.upload': { en: 'Upload photo', ru: 'Загрузить фото' },
  'photos.replace': { en: 'Replace', ru: 'Заменить' },
  'fixes.title': { en: 'Changes requested', ru: 'Требуются правки' },
  'fixes.intro': {
    en: 'The reviewer flagged these answers. Everything else is accepted.',
    ru: 'Ревьюер отметил эти ответы. Остальное принято.',
  },
} as const satisfies Record<string, Localized>

export type UiKey = keyof typeof UI
