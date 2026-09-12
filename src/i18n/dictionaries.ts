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
  // aria-label сегмента полосы хода (теперь это кнопка прыжка на шаг — см.
  // .shell-bar в FormShell.tsx): у кнопки нет текста, и озвучиваться она
  // обязана полным адресом шага — номером, счётом и именем из stepTitle,
  // дословно тем же, что стоит в заголовке шелла и в списке шагов.
  // {n}/{total}/{title} подставляет FormShell.
  'form.stepSegment': {
    en: 'Step {n} of {total}: {title}',
    ru: 'Шаг {n} из {total}: {title}',
  },
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
  // Микроподпись под производными полями паспорта (I.7–I.9): они выводятся из
  // кода IATA справочником и не редактируются НИГДЕ — ни в основном проходе,
  // ни на экране правок (сервер откажет, см. `saveOperatorField`). Правда
  // всегда, в отличие от `form.prefilled`: у лаунжа старше предзаполнения
  // «заполнено вашей командой» было бы ложью, а «выводится из кода» — нет.
  'form.derivedFromCode': {
    en: 'Country, city and airport are derived from the IATA code — correct the code to change them',
    ru: 'Страна, город и аэропорт выводятся из кода IATA — чтобы изменить их, исправьте код',
  },
  // Подсказка у контрола исправления кода (`IataCorrection`): что произойдёт
  // при выборе — тройка следует за кодом, набирать её не нужно и негде.
  'form.iataPickNote': {
    en: 'Pick the airport from the directory — country, city and airport will follow the code',
    ru: 'Выберите аэропорт из справочника — страна, город и аэропорт заполнятся по коду',
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
  // Второй проход, когда «есть» отмечено, но у всего отмеченного профиль
  // `none` (`PROFILE_ATTRIBUTES` в `form-schema/services.ts`): уточнять
  // нечего, шаг пройден. Отдельная строка, а не `pass2Empty`: та отправляет
  // назад, а здесь назад не нужно — нужно дальше.
  'services.pass2NothingToDetail': {
    en: 'None of the services you marked as available need further details — continue to the next step.',
    ru: 'Все предложенные услуги не требуют уточнений — переходите к следующему шагу.',
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
  // Пофайловый прогресс пачки на шаге фото: «Uploading 2 / 3…» — счётчик
  // дописывается на месте (`PhotoSlots`), здесь только глагол.
  'photos.uploading': { en: 'Uploading', ru: 'Загрузка' },
  'photos.uploadFailed': {
    en: 'Upload failed. Please try again.',
    ru: 'Не удалось загрузить. Попробуйте ещё раз.',
  },
  // Удаление снимка — только у накопительного слота (на обоих экранах — и
  // правок, и основного шага фото, см. `PhotoSlots`): у именованного слота
  // «замена» покрывает всё, что заполняющему нужно, а у `additional`
  // загрузка ДОБАВЛЯЕТ — лишний снимок нужно именно убрать.
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
  // Вариант вступления для анкеты, где команда исправила ответы БЕЗ
  // замечания на них: «остальное принято» без оговорки было бы неправдой —
  // ниже стоят ответы, которых оператор не писал. Выбор между двумя
  // вступлениями делает `FixesOnly` по составу группы исправленного (та же
  // оговорка, тем же условием, стоит в `changesRequestedMail`).
  'fixes.introTeamEdited': {
    en: 'The reviewer flagged these answers, and the team corrected some others — both are below. Everything else is accepted.',
    ru: 'Проверяющий отметил эти ответы, а часть ответов команда исправила сама — и те и другие ниже. Остальное принято.',
  },
  // Группа ответов, исправленных командой без замечания (см. `FixesOnly`):
  // значение + значок + РАБОЧИЙ контрол — ответ принадлежит оператору, и
  // несогласие с правкой команды должно быть исправимо здесь же, а не
  // требовать пути в основную форму, которого с этого экрана нет.
  'fixes.teamCorrectedTitle': {
    en: 'The team corrected these answers',
    ru: 'Команда исправила эти ответы',
  },
  'fixes.teamCorrectedHint': {
    en: 'Review them — you can change any of them before resubmitting.',
    ru: 'Проверьте их — до повторной отправки любой из них можно изменить.',
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
  // Значок провенанса — ОДИН текст на обе стороны анкеты (строка экрана
  // проверки и поле/карточка стороны заполнения): обе показывают один факт —
  // последнюю правку этого ответа внесла команда во время проверки
  // (`edited_by`, см. `db/schema.ts`). Значок следует за последней рукой:
  // операторская запись сбрасывает провенанс, и значок исчезает.
  'answer.teamEdited': { en: 'Corrected by the team', ru: 'Исправлено командой' },
  // Записка карандаша на слоте фотографии: серверного пути правки фото у
  // команды НЕТ (`editAnswerDuringReview` отказывает ключам слотов — снимок
  // это свидетельство с места), и экран проверки обязан не предлагать того,
  // в чём сервер откажет, — вместо редактора стоит объяснение с настоящим
  // следующим шагом.
  'review.photoNotEditable': {
    en: 'Photos are evidence from the venue — the team cannot replace them. Flag the slot and return the questionnaire to the operator instead.',
    ru: 'Фотографии — свидетельство с места: команда их не заменяет. Отметьте слот замечанием и верните анкету оператору.',
  },
  'fixes.noControl': {
    en: 'This flagged answer cannot be edited on this screen. That is a bug on our side — please tell us, and mention the code below.',
    ru: 'Этот отмеченный ответ нельзя исправить на этом экране. Это ошибка на нашей стороне — сообщите нам и назовите код ниже.',
  },
  // «Убрать интервал» — aria-label «×» у одного окна графика уборки
  // (`CleaningScheduleEditor`, daily/monthly/quarterly): единственный
  // оставшийся читатель после Task 5 — старый редактор списка интервалов
  // удалён вместе с сеткой по дням, но кнопка удаления интервала нужна и
  // здесь, под тем же именем.
  'schedule.removeWindow': { en: 'Remove interval', ru: 'Убрать интервал' },
  'schedule.from': { en: 'From', ru: 'С' },
  'schedule.to': { en: 'To', ru: 'До' },
  // Подсказка формата в поле времени: текстовое поле с маской (Anton,
  // 2026-09-12: у <input type="time"> нельзя ни вставить, ни выделить всё).
  'schedule.clockPlaceholder': { en: 'HH:MM', ru: 'ЧЧ:ММ' },
  'schedule.cadence': { en: 'How often', ru: 'Как часто' },
  'schedule.nth': { en: 'Which one', ru: 'Какой по счёту' },
  'schedule.weekday': { en: 'Day of week', ru: 'День недели' },
  'schedule.day.mon': { en: 'Monday', ru: 'Понедельник' },
  'schedule.day.tue': { en: 'Tuesday', ru: 'Вторник' },
  'schedule.day.wed': { en: 'Wednesday', ru: 'Среда' },
  'schedule.day.thu': { en: 'Thursday', ru: 'Четверг' },
  'schedule.day.fri': { en: 'Friday', ru: 'Пятница' },
  'schedule.day.sat': { en: 'Saturday', ru: 'Суббота' },
  'schedule.day.sun': { en: 'Sunday', ru: 'Воскресенье' },
  'form.freeFormAnswer': {
    en: 'Free-form answer from an earlier version — fill the grid to replace it',
    ru: 'Ответ в свободной форме, из прежней версии — заполните сетку, чтобы заменить его',
  },
  // Экран проверки показывает тот же факт, что `form.freeFormAnswer`, но не
  // оператору, который может «заполнить сетку», а ревьюеру, который смотрит
  // на чужой ответ — своя, более короткая формулировка без обращения к
  // читателю на «вы, заполните» (Important 3, сквозное ревью).
  'review.freeFormAnswer': {
    en: 'Free-form answer from an earlier version',
    ru: 'Ответ в свободной форме, из прежней версии',
  },
  // Полоска дней редактора правил (Task 4) показывает короткую подпись на
  // каждом чипе. `schedule.day.*` (полные названия) для этого не годятся:
  // `.slice(0, 2)` от «Понедельник» даёт «По», а не «Пн» — первые две буквы
  // русского названия не совпадают с привычным сокращением. Короткие ключи
  // отдельные от полных: полное имя остаётся в `aria-label` чипа.
  'schedule.dayShort.mon': { en: 'Mon', ru: 'Пн' },
  'schedule.dayShort.tue': { en: 'Tue', ru: 'Вт' },
  'schedule.dayShort.wed': { en: 'Wed', ru: 'Ср' },
  'schedule.dayShort.thu': { en: 'Thu', ru: 'Чт' },
  'schedule.dayShort.fri': { en: 'Fri', ru: 'Пт' },
  'schedule.dayShort.sat': { en: 'Sat', ru: 'Сб' },
  'schedule.dayShort.sun': { en: 'Sun', ru: 'Вс' },
  'schedule.orFirstFlight': { en: 'or first flight', ru: 'или первый рейс' },
  'schedule.orLastFlight': { en: 'or last flight', ru: 'или последний рейс' },
  // Слово-маркер в рамке границы БЕЗ предлога: предлог («from»/«с») уже
  // стоит в строке перед рамкой, иначе читалось «from from first flight»
  // (Anton, 2026-09-13).
  'schedule.fromFirstFlight': { en: 'first flight', ru: 'первого рейса' },
  'schedule.toLastFlight': { en: 'last flight', ru: 'последнего рейса' },
  // Возврат к времени — ссылка на том же месте, где стояла «или первый рейс»:
  // строка не меняет ширину при переключении, ничего не прыгает.
  'schedule.useTime': { en: 'or a time', ru: 'или время' },
  'schedule.nextDay': { en: 'until {to} the next day', ru: 'до {to} следующего дня' },
  'schedule.endOfDay': { en: 'until the end of the day', ru: 'до конца дня' },
  'schedule.otherHours': { en: 'Other hours for some days', ru: 'Другие часы для части дней' },
  'schedule.ruleN': { en: 'Schedule {n}', ru: 'Режим {n}' },
  'schedule.weekSummary': { en: 'Week at a glance', ru: 'Итог на неделю' },
  'schedule.change': { en: 'change', ru: 'изменить' },
  'schedule.rulePickDays': { en: 'Schedule {n}: pick the days', ru: 'Режим {n}: выберите дни' },
  'schedule.ruleSetTime': { en: 'Schedule {n}: set the time', ru: 'Режим {n}: укажите время' },
  'schedule.allDayShort': { en: '24h', ru: '24ч' },
  'schedule.removeRule': { en: 'Remove this schedule', ru: 'Убрать режим' },
  'schedule.addRange': { en: 'Add an interval', ru: 'Добавить интервал' },
} as const satisfies Record<string, Localized>

export type UiKey = keyof typeof UI
