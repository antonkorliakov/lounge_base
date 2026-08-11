/**
 * Заводит лаунж и анкету для локальной проверки и печатает ссылку для
 * заполнения (`http://localhost:3000/f/<token>`).
 *
 * Без флагов сид создаёт пустой черновик — ровно то, что нужно, чтобы
 * проверить отказ при отправке неполной анкеты.
 *
 * С флагом `--complete` анкета дозаполняется полностью: все обязательные
 * плоские поля (`FIELDS`), ответ по каждой позиции услуг (`SERVICE_ITEMS`,
 * включая закрывающий ответ «нет» там, где позиция не предлагается — этого
 * достаточно для `missingItems`, см. `src/submissions/completeness.ts`) и
 * фотографии во все три именованных обязательных слота плюс одна
 * дополнительная, чтобы дотянуть общее количество до `MIN_PHOTOS`. Именно
 * такая анкета проходит `submitSubmission`.
 *
 * Значения полей и позиций сохраняются через `saveFieldValue`/
 * `saveServiceValue` — те же функции, что вызывает форма в браузере — а не
 * прямой вставкой в `field_values`/`service_values`. Так неверная форма
 * значения (например, placeholder вместо реального id варианта) не
 * проходит тихо: `save*Value` её отклонит, и сид упадёт с понятной
 * ошибкой вместо того, чтобы молча оставить анкету неполной.
 *
 * С флагом `--submitted` (включает `--complete`) анкета ещё и отправляется —
 * `submitSubmission`. Без этого шага полностью заполненная анкета остаётся в
 * `draft`, а список `/admin` показывает только `submitted` (см.
 * `src/app/admin/page.tsx`), то есть проверяющему нечего открыть. Отправка
 * НЕ делается самим `--complete`: черновик, который остаётся черновиком, —
 * это то, на чём проверяется отправка из браузера (`e2e/fill.spec.ts`,
 * «полностью заполненная анкета отправляется на проверку»), а у отправленной
 * анкеты форма закрыта заполняющему (`FillForm`'s `EDITABLE_STATUSES`), так
 * что тот тест увидел бы вместо формы экран «уже отправлено».
 *
 * С флагом `--changes-requested` (включает `--submitted`) анкета проходит весь
 * жизненный цикл до возврата на правку: отправка → по одному замечанию на
 * КАЖДУЮ из трёх категорий отмечаемых ключей (поле, позиция услуг, слот фото)
 * → `requestChanges`. Именно эта анкета открывает экран правок
 * (`FixesOnly`) — и именно все три категории сразу, потому что дефект,
 * который этот режим позволяет проверить руками, состоял в том, что две из
 * трёх категорий контрола не получали вовсе.
 *
 * Каждый шаг делается настоящей функцией домена, а не вставкой в таблицу:
 * порядок здесь не произволен и не восстанавливается по схеме БД
 * (`confirmBlock`/`requestChanges` требуют статус `submitted`, а
 * `requestChanges` отказывается возвращать анкету без единого открытого
 * замечания), так что сид, собранный «руками», молча разошёлся бы с тем, что
 * может произойти в реальности.
 *
 * `--lounge=<название>` задаёт имя лаунжа (по умолчанию `Primeclass Lounge`).
 * Нужно тому, кто потом ищет засеянную анкету в списке `/admin`: список
 * показывает ВСЕ отправленные анкеты, и на машине, где сид запускали много
 * раз, их десятки с одинаковым названием. Уникальное имя — единственный
 * способ для e2e-теста сказать «открой мою анкету», не полагаясь на то, что
 * самая свежая по `submittedAt` принадлежит ему (а она может и не
 * принадлежать: Playwright запускает файлы тестов параллельно, и соседний
 * тест отправляет анкету из браузера в то же самое время). Идентификатор
 * анкеты по-прежнему никуда не печатается — см. пояснение про stdout ниже.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  closeDbConnection,
  loadEnvFile,
  seedEmailFor,
  SEED_REVIEWER_EMAIL,
} from './dev-support'
import { createDb } from '../src/db/client'
import { lounges, submissions, photos } from '../src/db/schema'
import { addTeamMember } from '../src/access/team'
import { issueFillToken } from '../src/access/tokens'
import { saveFieldValue, saveServiceValue } from '../src/submissions/values'
import { submitSubmission } from '../src/submissions/transitions'
import { raiseFlag, type FlagReason } from '../src/review/flags'
import { requestChanges } from '../src/review/decide'
import {
  FIELDS,
  SERVICE_ITEMS,
  PHOTO_SLOTS,
  MIN_PHOTOS,
  OPTION_LISTS,
} from '../src/form-schema'
import type {
  Field,
  SelectValue,
  ServiceItem,
  ServiceValueInput,
} from '../src/form-schema'
import type { Db } from '../src/db/types'

/**
 * Поля, у которых ответом должна быть настоящая по форме почта, а не
 * `Test value <ключ>`. Решается по подписи поля, а не списком ключей: список
 * пришлось бы помнить править при появлении третьего адреса в анкете, а
 * подпись — то же самое условие, по которому это поле и опознаёт человек.
 *
 * Это не косметика. `II.1.3` (Email Address - Lounge Operations Manager) —
 * единственный адрес, куда система пишет оператору: `contactEmail`
 * (`src/app/admin/s/[submissionId]/actions.ts`) читает именно его и считает
 * почтой всё, что содержит `@`. Пока сид писал туда `Test value II.1.3`, на
 * засеянной анкете НЕ РАБОТАЛ ни один почтовый путь проверяющего: «Переслать
 * ссылку» отказывала целиком («У анкеты нет контактной почты»), а «Вернуть на
 * правку» всегда возвращала уведомление «оператор не уведомлён». То есть
 * успешную ветку этих двух действий нельзя было увидеть ни руками, ни тестом
 * — ровно тот же класс, что и «снимок не отдаётся картинкой» у `seedPhotoUrl`
 * выше. Проверяется это соответствие снаружи, `e2e/review.spec.ts`: он ждёт
 * в уведомлении «Ссылка отправлена на …» именно засеянный адрес, так что
 * подпись, перестань она попадать под условие ниже, уронит тест по имени, а
 * не тихо вернёт прежнюю дыру.
 */
const EMAIL_LABEL = /e-?mail/i

/** Возвращает валидное значение для плоского поля — с учётом составного III.3.2. */
function valueForField(field: Field): unknown {
  switch (field.type) {
    case 'text':
    case 'textarea':
      return EMAIL_LABEL.test(field.label.en)
        ? seedEmailFor(field.key)
        : `Test value ${field.key}`

    case 'date':
      return '2020-01-01'

    case 'number':
      return 1

    case 'template': {
      const slots: Record<string, number> = {}
      for (const slot of field.templateSlots) slots[slot.key] = 1
      return slots
    }

    case 'multi_select': {
      const options = field.optionList ? OPTION_LISTS[field.optionList] : []
      const first = options[0]
      return first ? [first.id] : []
    }

    case 'select':
    case 'select_with_detail': {
      const options = field.optionList ? OPTION_LISTS[field.optionList] : []
      const first = options[0]
      if (!first) return { option: '', detail: null }

      // Always fill `detail`, not only when `first.requiresDetail` is set:
      // a field can also require a detail for a specific option via its own
      // `detailRequiredFor` (see `III.2.4` — every `airlineAccess` option is
      // `plain()`, so `requiresDetail` alone would miss it; this used to be
      // a field-specific override private to `validation.ts` and invisible
      // here — see Critical 1 in the whole-branch review — now it lives on
      // `Field` itself). An unneeded detail string never fails validation —
      // `validateSelect` only *reads* `detail` when it decides one is
      // required — so filling it unconditionally is a safe superset.
      const value: SelectValue = {
        option: first.id,
        detail: 'Test detail',
      }

      // III.3.2 — единственное составное поле: первый вариант списка
      // `allowedNotAllowed` — это `allowed`, и именно он требует слот
      // `age`. Заполняем слоты всегда, когда они у поля есть: валидация
      // требует их только для варианта из TEMPLATE_REQUIRED_BY_OPTION, но
      // лишний заполненный слот у остальных вариантов не мешает.
      if (field.templateSlots.length > 0) {
        const slots: Record<string, number> = {}
        for (const slot of field.templateSlots) slots[slot.key] = 1
        value.slots = slots
      }

      return value
    }

    default:
      throw new Error(`seed-dev: неизвестный тип поля ${String(field.type)}`)
  }
}

/** Закрывающий («не предлагается») ответ по позиции услуг — этого достаточно
 *  для полноты, доп. атрибуты (цена, время слота и т.п.) не нужны. */
function closingServiceValue(item: ServiceItem): ServiceValueInput {
  const options = OPTION_LISTS[item.availabilityList]
  const closing = options.find((o) => o.id === 'no' || o.id === 'not_allowed') ?? options[0]!
  return {
    available: closing.id,
    chargeType: null,
    price: null,
    currency: null,
    slotMinutes: null,
    bookingRequired: null,
    details: null,
  }
}

/** Куда сид кладёт синтетические снимки. Не в репозитории (см. `.gitignore`):
 *  это локальные тестовые данные, как и сама засеянная анкета. */
const SEED_PHOTO_DIR = resolve(process.cwd(), 'public', 'seed')

/**
 * Настоящая (пусть и синтетическая) картинка для засеянного снимка: файл в
 * `public/seed/`, ссылка вида `/seed/<имя>.svg`.
 *
 * Дважды исправленное место, и оба раза по одной причине — «снимок на экране
 * виден» должно быть ПРОВЕРЯЕМЫМ утверждением:
 *  - `https://example.com/seed/<slot>.jpg` (изначально): адрес существует, но
 *    картинкой не отдаётся, поэтому КАЖДАЯ миниатюра на экране проверки
 *    рисовалась как «Фото не открывается» (`FieldRow`'s `failed`) — засеянная
 *    анкета выглядела точно как анкета с битыми ссылками.
 *  - `data:image/svg+xml;base64,…`: миниатюра рисовалась, но переход по клику
 *    — тот, ради которого ревьюер вообще открывает оригинал (`FieldRow`
 *    оборачивает плитку в `<a href={url} target="_blank">`) — молча не
 *    работал: Chrome и Firefox блокируют навигацию верхнего уровня на `data:`
 *    URL, а `onError` при этом не срабатывает, так что плитка даже не
 *    вырождалась в честную `frow-photo-dead`. Тихо не работающая ссылка на
 *    единственном экране, где открыть оригинал — вся задача, хуже битой:
 *    следующий проверяющий решит, что так и надо.
 *
 * Файл в `public/`, а не загрузка в blob: сид работает без сети и без
 * `BLOB_READ_WRITE_TOKEN` (в CI его нет — см. комментарий в `e2e/fill.spec.ts`),
 * а `public/` отдаётся `next dev` прямо с диска, так что файл, записанный
 * сидом уже после старта сервера, доступен сразу. Ссылка от корня (`/seed/…`),
 * а не абсолютная: тот же origin, что и у страницы, и никакой привязки к порту.
 * SVG, а не JPEG: несколько сотен байт, и на плитке видно название слота — так
 * сразу понятно, какой снимок к какому слоту привязан, чего одноцветная заливка
 * не даёт. Ограничения `MAX_PHOTO_BYTES`/`EXTENSION_BY_TYPE`
 * (`src/app/api/photos/route.ts`) к этому пути не относятся: они проверяют
 * ЗАГРУЖАЕМЫЙ файл, а сид пишет строку в `photos` напрямую, как и раньше.
 */
function seedPhotoUrl(name: string, label: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">` +
    `<rect width="320" height="240" fill="#dbe6f4"/>` +
    `<text x="160" y="120" font-family="sans-serif" font-size="22" ` +
    `text-anchor="middle" fill="#1f3352">${label}</text></svg>`

  mkdirSync(SEED_PHOTO_DIR, { recursive: true })
  writeFileSync(join(SEED_PHOTO_DIR, `${name}.svg`), svg, 'utf8')
  return `/seed/${name}.svg`
}

async function fillComplete(db: Db, submissionId: string): Promise<void> {
  for (const field of FIELDS) {
    const value = valueForField(field)
    const result = await saveFieldValue(db, { submissionId, fieldKey: field.key, value })
    if (!result.ok) {
      throw new Error(`seed-dev: поле ${field.key} отклонено — ${result.error.ru}`)
    }
  }

  for (const item of SERVICE_ITEMS) {
    const value = closingServiceValue(item)
    const result = await saveServiceValue(db, { submissionId, itemKey: item.key, value })
    if (!result.ok) {
      throw new Error(`seed-dev: позиция ${item.key} отклонена — ${result.error.ru}`)
    }
  }

  // Три именованных обязательных слота плюс дополнительные, чтобы дотянуть
  // общее число снимков до MIN_PHOTOS — см. комментарий в completeness.ts.
  const namedSlots = PHOTO_SLOTS.filter((slot) => !slot.extra)
  for (const slot of namedSlots) {
    await db.insert(photos).values({
      submissionId,
      slot: slot.key,
      blobKey: `seed/${slot.key}.svg`,
      url: seedPhotoUrl(slot.key, slot.label.en),
    })
  }

  // Не один дополнительный снимок, а два. Один — минимум, чтобы дотянуть до
  // MIN_PHOTOS; второй нужен, чтобы накопительный слот действительно СОДЕРЖАЛ
  // несколько снимков: именно про это замечание вида «один из дополнительных
  // снимков непригоден», и только на таком слоте видно, что «Убрать» относится
  // к конкретному снимку, а загрузка добавляет ещё один (см. `PhotoSlots`).
  // Заодно удаление одного из них оставляет анкету полной, так что проверять
  // удаление можно, не ломая отправку.
  const extraSlot = PHOTO_SLOTS.find((slot) => slot.extra)
  const extraNeeded = Math.max(2, MIN_PHOTOS - namedSlots.length)
  if (extraSlot) {
    for (let i = 0; i < extraNeeded; i += 1) {
      await db.insert(photos).values({
        submissionId,
        slot: extraSlot.key,
        blobKey: `seed/${extraSlot.key}-${i}.svg`,
        url: seedPhotoUrl(`${extraSlot.key}-${i}`, `${extraSlot.label.en} ${i + 1}`),
      })
    }
  }
}

/**
 * Ключи засеянных замечаний — по одному на каждую категорию отмечаемых ключей,
 * чтобы экран правок открывался сразу со всеми контролами.
 *
 * `I.2` (Lounge Full Name) — плоское текстовое поле, самое простое для правки
 * руками; `2.1` (Wifi Access) — реальная позиция услуг из списка `yesNo`, та
 * же, на которой стоят e2e-тесты услуг; `entrance` — обязательный
 * именованный слот фото, то есть тот случай, где новая загрузка ЗАМЕНЯЕТ
 * снимок; `additional` — накопительный слот, где она НЕ заменяет, а добавляет.
 *
 * Последний ключ здесь потому, что это отдельный контрол, а не тот же самый:
 * у накопительного слота подпись «Добавить», и единственный правдивый ответ на
 * замечание — убрать негодный снимок, чего у именованного слота нет и не нужно
 * (см. `PhotoSlots`). Пока замечания на нём не было, эту разницу нельзя было
 * увидеть на засеянной анкете вообще — а именно на ней её и проверяют руками.
 */
const SERVICE_FLAG_KEY = '2.1'
const EXTRA_PHOTO_FLAG_KEY = PHOTO_SLOTS.find((slot) => slot.extra)!.key

// `FlagReason` импортируется, а не переписывается здесь объединением строк:
// пятая причина в `FLAG_REASONS` (`src/review/flags.ts`) не должна требовать
// правки ещё и сида, а локальный union молча разошёлся бы с настоящим.
const SEEDED_FLAGS: { key: string; reason: FlagReason; comment: string }[] = [
  { key: 'I.2', reason: 'wrong_format', comment: 'Field flag: give the full legal name, not the short one.' },
  { key: SERVICE_FLAG_KEY, reason: 'needs_detail', comment: 'Service flag: Wifi is marked available — state the time limit and any details.' },
  // `wrong_format`, а не `empty`: снимок в слоте есть, претензия к тому, ЧТО на
  // нём видно. `empty` («не заполнено») противоречил бы и самому замечанию, и
  // тому, что сид кладёт в этот слот настоящую картинку.
  { key: 'entrance', reason: 'wrong_format', comment: 'Photo flag: the entrance shot is too dark to see the signage. Please retake it.' },
  { key: EXTRA_PHOTO_FLAG_KEY, reason: 'wrong_format', comment: 'Extra photo flag: one of the additional shots is unusable — please remove it.' },
]

/**
 * Переспрашивает отмечаемую позицию услуг как ПРЕДЛАГАЕМУЮ — иначе на экране
 * правок у неё честно не будет ни цены, ни слота, ни деталей:
 * `ServiceItemCard` спрашивает их только у предлагаемой позиции, то же
 * правило, по которому `offeredKeys` не пускает закрытую позицию во второй
 * проход. `fillComplete` отвечает «нет» по всем позициям (этого достаточно для
 * полноты), так что одну из них здесь переспрашиваем как «есть».
 *
 * Обязательно ДО отправки: `chargeType` у предлагаемой позиции — часть
 * полноты (`serviceItemAnswered`), а `saveServiceValue` после отправки уже
 * откажет (`assertEditable`). `complimentary` не требует цены.
 */
async function offerFlaggedServiceItem(db: Db, submissionId: string): Promise<void> {
  const offered = await saveServiceValue(db, {
    submissionId,
    itemKey: SERVICE_FLAG_KEY,
    value: {
      available: 'yes',
      chargeType: 'complimentary',
      price: null,
      currency: null,
      slotMinutes: null,
      bookingRequired: null,
      details: null,
    },
  })
  if (!offered.ok) {
    throw new Error(`seed-dev: позиция ${SERVICE_FLAG_KEY} отклонена — ${offered.error.ru}`)
  }
}

/**
 * Отправка на проверку. `fillComplete` уже прошла через настоящую валидацию
 * (`saveFieldValue`/`saveServiceValue`), поэтому отказ здесь означает прореху
 * в самом сиде, а не «анкета такая» — и падает он с текстом отказа, а не
 * оставляет анкету тихо в черновике.
 */
async function submit(db: Db, submissionId: string): Promise<void> {
  const submitted = await submitSubmission(db, { submissionId, actor: 'filler' })
  if (!submitted.ok) {
    throw new Error(`seed-dev: отправка не прошла — ${submitted.error.ru}`)
  }
}

/**
 * Отмечает по одному ответу в каждой категории и возвращает анкету на правку.
 * Порядок обязателен и проверяется самими функциями: `raiseFlag` и
 * `requestChanges` работают по статусу `submitted` (`REVIEW_STATUSES`), а
 * `requestChanges` отказывается возвращать анкету, у которой нет ни одного
 * открытого замечания. Отказ любого шага — падение сида, а не молчаливое
 * «получилось что-то другое».
 */
async function flagAndReturn(db: Db, submissionId: string): Promise<void> {
  for (const flag of SEEDED_FLAGS) {
    const result = await raiseFlag(db, {
      submissionId,
      fieldKey: flag.key,
      reason: flag.reason,
      comment: flag.comment,
      reviewer: 'seed-reviewer@example.com',
    })
    if (!result.ok) {
      throw new Error(`seed-dev: замечание по ${flag.key} отклонено — ${result.error.ru}`)
    }
  }

  const returned = await requestChanges(db, {
    submissionId,
    reviewer: 'seed-reviewer@example.com',
  })
  if (!returned.ok) {
    throw new Error(`seed-dev: возврат на правку не прошёл — ${returned.error.ru}`)
  }
}

const LOUNGE_OPTION = '--lounge='
const FLAGS = ['--complete', '--submitted', '--changes-requested']

/**
 * Разбирает аргументы и ОТКАЗЫВАЕТСЯ на незнакомом. Раньше лишний аргумент
 * молча игнорировался, а значит опечатка (`--submited`) сеяла пустой черновик
 * вместо отправленной анкеты — и тот, кто это запустил, узнавал об этом уже по
 * непонятному падению теста или по пустому списку `/admin`, без всякой связи с
 * настоящей причиной.
 */
function parseArgs(argv: string[]): { modes: Set<string>; loungeName: string } {
  const modes = new Set<string>()
  let loungeName = 'Primeclass Lounge'

  for (const arg of argv) {
    if (FLAGS.includes(arg)) {
      modes.add(arg)
    } else if (arg.startsWith(LOUNGE_OPTION)) {
      loungeName = arg.slice(LOUNGE_OPTION.length)
      if (loungeName.trim() === '') {
        throw new Error(`seed-dev: пустое значение ${LOUNGE_OPTION}`)
      }
    } else {
      throw new Error(
        `seed-dev: неизвестный аргумент ${arg} — допустимы ${FLAGS.join(', ')}, ` +
          `${LOUNGE_OPTION}<название>`,
      )
    }
  }

  return { modes, loungeName }
}

/**
 * Заводит проверяющего, чтобы вход по ссылке работал независимо от режима
 * (`scripts/dev-login-link.ts` печатает ссылку только для того, кто уже в
 * команде — он ничего не создаёт: скрипт, который заводит участника команды,
 * запущенный по ошибке не туда, выдаёт доступ, а не отказ).
 *
 * Через `addTeamMember`, а не своим `insert`: это единственная санкционированная
 * точка записи в `teamMembers` (см. её doc-комментарий), и именно она
 * нормализует адрес, от чего зависит уникальность.
 *
 * Дубликат — не ошибка. Своей `onConflictDoNothing` у `addTeamMember` нет, и
 * проверка «а есть ли уже» перед вставкой её не заменяет: сиды идут параллельно
 * (Playwright запускает файлы e2e в разных воркерах, и каждый тест сеет сам),
 * так что оба могут увидеть «участника нет» и оба вставить. Проигравший
 * получает `23505 unique_violation` на `teamMembers.email` — то есть ровно то
 * состояние, которое и требовалось: строка есть. Любая другая ошибка
 * пробрасывается.
 */
const UNIQUE_VIOLATION = '23505'

/** Код ошибки Postgres. Drizzle оборачивает отказ драйвера в
 *  `DrizzleQueryError`, у которой своего `code` нет — настоящий код лежит в
 *  `cause` (проверено на этом самом отказе), поэтому смотрим оба уровня, а не
 *  только верхний: проверка одного верхнего молча принимала бы любой отказ за
 *  «не дубликат» и роняла сид. */
function postgresErrorCode(error: unknown): unknown {
  const top = (error as { code?: unknown } | null)?.code
  if (top !== undefined) return top
  return ((error as { cause?: { code?: unknown } } | null)?.cause)?.code
}

async function ensureReviewer(db: Db): Promise<void> {
  try {
    await addTeamMember(db, { email: SEED_REVIEWER_EMAIL, name: 'Seed Reviewer' })
  } catch (error: unknown) {
    if (postgresErrorCode(error) !== UNIQUE_VIOLATION) throw error
  }
}

async function main(): Promise<void> {
  loadEnvFile(resolve(process.cwd(), '.env.local'))

  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL не задан')
  const db = createDb(url)

  // Каждый режим включает предыдущий: возврат на правку возможен только у
  // отправленной анкеты, а `submitSubmission` принимает лишь полную.
  const { modes, loungeName } = parseArgs(process.argv.slice(2))
  const changesRequested = modes.has('--changes-requested')
  const submitted = changesRequested || modes.has('--submitted')
  const complete = submitted || modes.has('--complete')

  await ensureReviewer(db)

  const [lounge] = await db
    .insert(lounges)
    .values({
      name: loungeName,
      provider: 'Çelebi',
      country: 'Turkey',
      city: 'Istanbul',
      airport: 'Istanbul Airport',
      iataCode: 'IST',
    })
    .returning()

  const [submission] = await db
    .insert(submissions)
    .values({ loungeId: lounge!.id })
    .returning()

  if (complete) {
    await fillComplete(db, submission!.id)
  }
  if (changesRequested) {
    await offerFlaggedServiceItem(db, submission!.id)
  }
  if (submitted) {
    await submit(db, submission!.id)
  }
  if (changesRequested) {
    await flagAndReturn(db, submission!.id)
  }

  const { token } = await issueFillToken(db, {
    submissionId: submission!.id,
    ttlDays: 90,
  })

  process.stdout.write(`http://localhost:3000/f/${token}\n`)

  // Иначе процесс не завершится и подвесит `execSync` в e2e — см.
  // `closeDbConnection`.
  await closeDbConnection(db)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
