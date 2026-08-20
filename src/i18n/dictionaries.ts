import type { Localized } from '@/form-schema'
import type { FlagReason } from '@/review/flags'

export const LOCALES = ['en', 'ru'] as const
export type Locale = (typeof LOCALES)[number]

/**
 * Подписи к кодам замечаний — ОДИН экземпляр на обе стороны анкеты: ревьюер
 * выбирает код на экране проверки (`FieldRow`), заполняющий читает его на
 * экране правок (`FixesOnly`). Пока подписи жили только в `FieldRow`, вторая
 * половина этого пути была тупиком: код выбирался, писался в `field_flags`,
 * доезжал через два слоя до заполняющего и там пропадал — тот видел лишь
 * свободный текст комментария.
 *
 * Живут здесь, а не рядом с `FLAG_REASONS` в `src/review/flags.ts`, по
 * причине сборки: `flags.ts` тянет drizzle и `@/db/schema`, а оба читателя —
 * клиентские компоненты, так что импорт ЗНАЧЕНИЯ оттуда затащил бы слой БД в
 * клиентский бандл. Импорт `FlagReason` — только тип (`import type`), он
 * стирается компилятором. Это же и делает список неспособным разойтись с
 * источником: `satisfies Record<FlagReason, Localized>` требует ключ на каждый
 * код, а `FlagReason` выведен из самого `FLAG_REASONS` — пятый код, добавленный
 * там, ломает компиляцию здесь, а не тихо доезжает до человека без подписи.
 * Именно это разошлось в прошлый раз: `{ id: FlagReason }[]` отвергал неверный
 * код, но не ПРОПУЩЕННЫЙ.
 *
 * Формулировки — те же, что ревьюер видит на чипах, дословно: две стороны
 * должны называть одну претензию одним словом, иначе заполняющий читает не то
 * замечание, которое было поставлено.
 */
export const FLAG_REASON_LABELS = {
  empty: { en: 'not filled in', ru: 'не заполнено' },
  needs_detail: { en: 'needs detail', ru: 'нужна расшифровка' },
  contradicts: { en: 'contradicts another answer', ru: 'противоречит другому полю' },
  wrong_format: { en: 'wrong format', ru: 'неверный формат' },
} as const satisfies Record<FlagReason, Localized>

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
  // Имена слитых шагов (см. MERGED_FIELD_GROUPS в FormShell.tsx): шаг из
  // нескольких блоков схемы не может носить подпись одного из них — имя
  // обязано покрывать всё содержимое экрана. Блоки при этом остаются собой:
  // их подписи стоят заголовками секций ВНУТРИ шага, дословно теми же
  // словами, которыми ревьюер подтверждает блоки и ставит замечания.
  'form.stepContacts': { en: 'Contacts', ru: 'Контакты' },
  'form.stepAccess': { en: 'Access & Policies', ru: 'Доступ и правила' },
  'form.stepLocation': { en: 'Location & Facility', ru: 'Расположение и объект' },
  // Имя последнего шага для заголовка шелла и навигатора шагов. Раньше у
  // этого шага имени не было вовсе (заголовок рисовался только для шагов с
  // блоком схемы); навигатор перечисляет все 9 шагов, и безымянным быть не
  // может ни один. Сознательно НЕ дословно `form.submit`: это название
  // экрана, а не действия — кнопка «Отправить на проверку» стоит рядом в
  // нижней панели, и два одинаковых текста в паре сантиметров друг от друга
  // читались бы как дубль.
  'form.review': { en: 'Review & submit', ru: 'Проверка и отправка' },
  // Тело последнего шага. Раньше там жила только кнопка отправки; она ушла в
  // закреплённую нижнюю панель (одно место для главного действия на всех
  // шагах), и без этой строки экран остался бы пустым — как будто он не
  // загрузился.
  'form.reviewHint': {
    en: 'All answers are saved as you type. Open any step from the list above to double-check, then submit the questionnaire for review.',
    ru: 'Все ответы сохраняются по мере ввода. Откройте любой шаг из списка выше, чтобы перепроверить его, и отправьте анкету на проверку.',
  },
  // aria-label списка шагов (<nav>) — сам список состоит из названий шагов и
  // собственного имени иначе не имеет.
  'form.steps': { en: 'Form steps', ru: 'Шаги анкеты' },
  'form.submitted': {
    en: 'Sent for review. We will get back to you.',
    ru: 'Отправлено на проверку. Сообщим о результате.',
  },
  'form.incomplete': {
    en: 'Some answers are still missing',
    ru: 'Не все ответы заполнены',
  },
  'form.required': { en: 'Required', ru: 'Обязательно' },
  // Микроподпись под замкнутым (предзаполненным при заведении лаунжа) полем
  // блока I — см. `lockedIdentityKeys` и `FieldInput`'s `locked`.
  'form.prefilled': {
    en: 'Provided by your team earlier',
    ru: 'Заполнено вашей командой ранее',
  },
  'services.pass1Title': {
    en: 'What does the lounge offer?',
    ru: 'Что есть в лаунже?',
  },
  // «Отметьте всё, что есть» описывало галочку, которой больше нет: у каждой
  // позиции теперь ответ да/нет (см. `ServiceAvailabilityInput`), и «нет» —
  // такой же ответ, а не пропуск. Подсказка говорит об этом прямо, потому что
  // именно на этом шаге заполняющий решает, отвечать ли на позицию вообще, а
  // `submitSubmission` потом требует ответа по каждой.
  'services.pass1Hint': {
    en: 'Answer yes or no for each — "no" is an answer too. Details come next.',
    ru: 'Ответьте да или нет по каждой позиции — «нет» это тоже ответ. Детали спросим дальше.',
  },
  'services.pass2Title': { en: 'Details', ru: 'Детали' },
  // Второй проход, когда «есть» не отмечено ни у одной позиции. Раньше этот
  // экран был просто пустым под своим заголовком — а с навигатором шагов на
  // него можно прыгнуть, вовсе не проходя первый проход, и пустота читалась
  // бы как «не загрузилось», а не как «нечего детализировать».
  'services.pass2Empty': {
    en: 'No services marked as available yet — pick them on the previous step, and their details will be asked here.',
    ru: 'Пока ни одна услуга не отмечена как доступная — отметьте их на предыдущем шаге, и здесь появятся вопросы по деталям.',
  },
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
  // Слот `additional` (`extra: true`) НЕ заменяет — `attachPhoto` не удаляет
  // прежние строки, а добавляет ещё одну (см. `src/photos/store.ts`). Пока
  // подпись выбиралась только по «есть ли уже снимки», непустой слот
  // `additional` тоже читался как «Заменить», хотя нажатие добавляло четвёртый
  // снимок и оставляло тот, на который ревьюер жаловался.
  'photos.add': { en: 'Add photo', ru: 'Добавить фото' },
  'photos.missing': { en: 'No photo', ru: 'Нет фото' },
  'photos.uploadFailed': {
    en: 'Upload failed. Please try again.',
    ru: 'Не удалось загрузить. Попробуйте ещё раз.',
  },
  // Удаление снимка — только у накопительного слота и только на экране правок
  // (см. `PhotoSlots`): у именованного слота «замена» отвечает на замечание
  // целиком, а у `additional` — нет, там лишний снимок нужно именно убрать.
  'photos.remove': { en: 'Remove', ru: 'Убрать' },
  'photos.removeFailed': {
    en: 'Could not remove the photo. Please try again.',
    ru: 'Не удалось убрать снимок. Попробуйте ещё раз.',
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
