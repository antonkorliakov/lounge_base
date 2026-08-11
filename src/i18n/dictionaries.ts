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
  'form.rejected': {
    en: 'Some answers were not accepted',
    ru: 'Некоторые ответы не были приняты',
  },
  'form.closed': {
    en: 'This questionnaire has already been submitted and can no longer be edited.',
    ru: 'Анкета уже отправлена и больше не может быть изменена.',
  },
  'form.submit': { en: 'Submit for review', ru: 'Отправить на проверку' },
  'form.submitted': {
    en: 'Sent for review. We will get back to you.',
    ru: 'Отправлено на проверку. Сообщим о результате.',
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
  'services.charge': { en: 'Complimentary or chargeable', ru: 'Платно/бесплатно' },
  'services.price': { en: 'Price', ru: 'Цена' },
  'services.currency': { en: 'Currency', ru: 'Валюта' },
  'services.slot': { en: 'Time slot, minutes', ru: 'Длительность, минут' },
  'services.booking': { en: 'Booking required', ru: 'Нужна бронь' },
  'services.details': { en: 'Other details', ru: 'Прочее' },
  'services.backToPass1': {
    en: 'Back to service selection',
    ru: 'Назад к выбору услуг',
  },
  'photos.upload': { en: 'Upload photo', ru: 'Загрузить фото' },
  'photos.replace': { en: 'Replace', ru: 'Заменить' },
  'photos.missing': { en: 'No photo', ru: 'Нет фото' },
  'photos.uploadFailed': {
    en: 'Upload failed. Please try again.',
    ru: 'Не удалось загрузить. Попробуйте ещё раз.',
  },
  // Намеренно НЕ то же самое, что `photos.missing`: «нет фото» — про
  // оператора, который снимок не приложил, а это — про приложенный снимок,
  // который не открывается (мёртвая ссылка, удалённый файл). Ревьюер должен
  // различать их, потому что замечание оператору уместно только в первом
  // случае.
  'photos.loadFailed': {
    en: 'Photo will not open',
    ru: 'Фото не открывается',
  },
  'fixes.title': { en: 'Changes requested', ru: 'Требуются правки' },
  'fixes.intro': {
    en: 'The reviewer flagged these answers. Everything else is accepted.',
    ru: 'Проверяющий отметил эти ответы. Остальное принято.',
  },
} as const satisfies Record<string, Localized>

export type UiKey = keyof typeof UI
