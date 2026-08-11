import {
  FIELDS,
  PHOTO_SLOTS,
  SERVICE_ATTRIBUTES,
  SERVICE_ITEMS,
  type ServiceAttribute,
} from '@/form-schema'

export type ColumnGroup = 'identity' | 'fields' | 'services' | 'photos'

export type Column = { key: string; header: string; group: ColumnGroup }

const identity = (key: string, header: string): Column => ({ key, header, group: 'identity' })

/**
 * Колонки, которых нет в анкете: они описывают сам лаунж и состояние сбора
 * данных по нему. Список рукописный — выводить его не из чего, — и порядок в
 * нём такой, каким его читает человек, открывший файл: чем лаунж является,
 * потом где он, потом что с ним и что с его анкетой.
 *
 * ДВА СТАТУСА, ДВЕ КОЛОНКИ, РАЗНЫЕ ЗАГОЛОВКИ. `operational_status` — факт о
 * лаунже (работает / временно закрыт / на ремонте / закрыт),
 * `submission_status` — где находится сбор данных (draft / submitted /
 * changes_requested / approved). Первое ограничение плана 3 требует их не
 * смешивать, и в файл уезжают только ЗАГОЛОВКИ (`csv.ts`/`workbook.ts` пишут
 * первой строкой `column.header`, ключи остаются внутри), поэтому неразличимы
 * они были бы именно там, где на них смотрит человек. На этой же ветке уже
 * приходилось переименовывать `daysInStatus` → `daysInSubmissionStatus` по
 * ровно этой причине.
 *
 * `approved_at` — из `submissions.decided_at`, и это честное имя: `decided_at`
 * пишется единственным местом (`review/decide.ts`, ветка approve); отказ с
 * просьбой правок трогает только `status_changed_at`. То есть непустой
 * `approved_at` действительно означает «анкета принята в этот день».
 *
 * Чего здесь сознательно нет: `status_comment` (комментарий к
 * эксплуатационному статусу — текст для человека, а не данные для смежной
 * системы), `submitted_at`/`status_changed_at` (нужны экрану реестра, не
 * выгрузке) и копии классифицирующих полей из `lounges` (терминал, зона и
 * прочее) — они уже уезжают в группе `fields` как ответы анкеты `III.6.*`, и
 * вторая колонка с тем же смыслом только заставила бы получателя выбирать,
 * какой верить.
 */
export const IDENTITY_COLUMNS: readonly Column[] = [
  identity('lounge_id', 'Lounge ID'),
  identity('name', 'Lounge Name'),
  identity('provider', 'Provider'),
  identity('country', 'Country'),
  identity('city', 'City'),
  identity('airport', 'Airport'),
  identity('iata_code', 'IATA Code'),
  identity('operational_status', 'Lounge Operational Status'),
  identity('status_until', 'Expected Reopening Date'),
  identity('submission_status', 'Form Submission Status'),
  identity('approved_at', 'Approved At'),
]

/**
 * Подписи атрибутов услуги. `Record<ServiceAttribute, string>` (то есть
 * `Record<keyof ServiceValueInput, string>`) — полная запись, а не частичная:
 * новый атрибут не соберётся, пока ему не дадут подпись, вместо того чтобы
 * уехать в файл с пустым заголовком.
 */
const ATTRIBUTE_HEADERS: Record<ServiceAttribute, string> = {
  available: 'Available',
  chargeType: 'Charge Type',
  price: 'Price',
  currency: 'Currency',
  slotMinutes: 'Slot, min',
  bookingRequired: 'Booking Required',
  details: 'Details',
}

/**
 * Ключи, встретившиеся больше одного раза, — по одному разу каждый.
 *
 * Отдельная экспортируемая функция, а не проверка внутри `flatColumns`, чтобы у
 * неё был свой тест на синтетических списках: в настоящем наборе дублей нет, и
 * сработавшую ветку иначе никогда не проверить (тот же приём, которым покрыт
 * `forbiddenImportsIn` в `form-schema/__tests__/import-guard.ts`).
 */
export function duplicateKeysIn(columns: Column[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const column of columns) {
    if (seen.has(column.key)) duplicates.add(column.key)
    seen.add(column.key)
  }
  return [...duplicates]
}

/**
 * Все колонки плоской выгрузки, слева направо.
 *
 * ПОРЯДОК — ЧАСТЬ ОТВЕТА, а не деталь реализации: принимающая система читает
 * файл по позициям колонок, и «те же данные, но столбцы переставились»
 * ломает её так же, как пропавшая колонка. Поэтому порядок задан целиком
 * схемой и здесь не сортируется:
 *
 *  - группы — в порядке склейки ниже: identity, fields, services, photos;
 *  - внутри `fields` — порядок массива `FIELDS`, то есть порядок вопросов
 *    исходной анкеты (I.1, I.2, …), а не алфавит ключей: «V» и «III.6.10» по
 *    алфавиту встали бы не туда, где их ищет человек, знающий форму;
 *  - внутри `services` — порядок `SERVICE_ITEMS` (порядок строк листа
 *    `Services & Amenities`), и семь колонок одной позиции идут подряд в
 *    порядке `SERVICE_ATTRIBUTES`, а не по атрибуту через все позиции: рядом
 *    оказывается всё про одну услугу;
 *  - внутри `photos` — порядок `PHOTO_SLOTS`.
 *
 * Оба порядка (fields, services) закреплены тестами против golden fixtures,
 * снятых с исходного xlsx, а не против самих массивов — иначе тест повторял бы
 * реализацию и молчал бы при любой её ошибке.
 *
 * Новое поле добавляет колонку в конец своей группы; удалённое поле колонку
 * убирает — то есть правка анкеты сдвигает позиции. Это неизбежно (позиции
 * задаются составом), и именно поэтому заголовок каждой колонки несёт её
 * номер: получатель, привязавшийся к заголовку, переживёт добавление вопроса.
 *
 * КЛЮЧИ. `key` наружу не уезжает — он нужен `rows.ts`, который строит по нему
 * индекс `key → позиция` и раскладывает значения; в файл идёт `header`.
 * Ключи повторяют нумерацию исходной формы (`I.2`, `2.1.price`,
 * `photo.entrance`) — тот же язык, на котором о вопросах говорят оператор,
 * ревьюер и лист одной анкеты (`single.ts` печатает «I.2» в первой колонке).
 * Уникальность ключей не подарок: у ключей полей и позиций точки внутри, так
 * что `${item.key}.${attribute}` в принципе может совпасть с чужим ключом.
 * Сегодня не совпадает (поля — с римской секции, позиции — с цифры или `fb.`,
 * фото — с `photo.`, идентификация — snake_case без точек), но это свойство
 * данных, а не конструкции, поэтому проверяется явно и роняет сборку списка:
 * молча перезаписанная колонка — это строка файла, в которой одно значение
 * подменило другое, и в самом файле такое не видно.
 *
 * Каждый вызов возвращает свой массив: `rows.ts` вправе работать с ним как со
 * своим, не задевая следующую выгрузку и `IDENTITY_COLUMNS`.
 */
export function flatColumns(): Column[] {
  const fields: Column[] = FIELDS.map((field) => ({
    key: field.key,
    header: `${field.key} ${field.label.en}`,
    group: 'fields',
  }))

  const services: Column[] = SERVICE_ITEMS.flatMap((item) =>
    SERVICE_ATTRIBUTES.map((attribute) => ({
      key: `${item.key}.${attribute}`,
      header: `${item.key} ${item.label.en} — ${ATTRIBUTE_HEADERS[attribute]}`,
      group: 'services' as const,
    })),
  )

  const photos: Column[] = PHOTO_SLOTS.map((slot) => ({
    key: `photo.${slot.key}`,
    header: `Photo — ${slot.label.en}`,
    group: 'photos',
  }))

  const columns = [...IDENTITY_COLUMNS, ...fields, ...services, ...photos]

  const duplicates = duplicateKeysIn(columns)
  if (duplicates.length > 0) {
    throw new Error(
      `Плоская выгрузка: ключи колонок повторяются (${duplicates.join(', ')}). ` +
        'Одна из этих колонок молча перезаписала бы другую при сборке строк.',
    )
  }

  return columns
}
