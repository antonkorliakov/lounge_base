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
  // Подпись к контролу наличия внутри карточки позиции. На первом проходе
  // такой подписи нет и не нужно — там сам вопрос это название позиции в
  // строке. На экране правок название позиции — заголовок карточки, так что
  // контролу наличия нужна своя подпись (см. `ServiceItemCard`).
  'services.available': { en: 'Available in the lounge', ru: 'Есть в лаунже' },
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
  // Заполняющему РАЗРЕШЕНО отправить анкету повторно, не тронув замечание, с
  // которым он не согласен (решение пользователя — см. отчёт задачи), поэтому
  // здесь не запрет, а различение: какие карточки он уже правил, а какие нет.
  // Без этого все карточки выглядят одинаково и «отправил, ничего не изменив»
  // становится случайностью, а не выбором.
  'fixes.stillOpen': {
    en: 'Not changed yet — the flag stays open',
    ru: 'Пока не изменено — замечание останется открытым',
  },
  'fixes.changed': { en: 'Changed', ru: 'Изменено' },
  'fixes.stillOpenCount': {
    en: 'Flagged answers you have not changed yet',
    ru: 'Отмеченных ответов ещё не изменено',
  },
  // Не должно появляться никогда: после этой задачи каждый ключ, который
  // принимает `isFlaggableKey`, имеет свой контрол на экране правок, и это
  // закреплено тестом (`src/web/__tests__/fixesOnly.test.tsx`). Если текст
  // всё же виден — это дефект (ключ разошёлся со схемой, или добавлена новая
  // категория отмечаемых ключей без пути на экран правок), и он должен быть
  // виден как дефект, а не как пустая карточка: именно пустая карточка
  // (`{field && …}`) скрывала этот дефект для 62 из 129 ключей.
  'fixes.noControl': {
    en: 'This flagged answer cannot be edited on this screen. That is a bug on our side — please tell us, and mention the code below.',
    ru: 'Этот отмеченный ответ нельзя исправить на этом экране. Это ошибка на нашей стороне — сообщите нам и назовите код ниже.',
  },
} as const satisfies Record<string, Localized>

export type UiKey = keyof typeof UI
