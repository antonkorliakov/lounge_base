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
 * С флагом `--changes-requested` (включает `--complete`) анкета проходит весь
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
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDb } from '../src/db/client'
import { lounges, submissions, photos } from '../src/db/schema'
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
 * `drizzle-kit push`/Next dev load `.env.local` themselves; a plain `tsx`
 * script does not. Rather than requiring every caller (including
 * `e2e/fill.spec.ts`, which shells out to `npm run seed`) to remember to
 * export `DATABASE_URL` first, read it from `.env.local` here — but only to
 * fill in what the real environment doesn't already provide, so an explicit
 * `export DATABASE_URL=...` still wins.
 */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([\w.-]+)\s*=(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]!
    let value = (match[2] ?? '').trim()
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = value
  }
}

/** Возвращает валидное значение для плоского поля — с учётом составного III.3.2. */
function valueForField(field: Field): unknown {
  switch (field.type) {
    case 'text':
    case 'textarea':
      return `Test value ${field.key}`

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

/**
 * Настоящая (пусть и синтетическая) картинка для засеянного снимка, как
 * `data:`-URL.
 *
 * Раньше здесь стоял `https://example.com/seed/<slot>.jpg` — адрес, который
 * существует, но картинкой не отдаётся. Из-за этого КАЖДАЯ миниатюра на
 * экране проверки рисовалась как «Фото не открывается» (`FieldRow`'s
 * `failed`), то есть засеянная анкета выглядела ровно так, как выглядит
 * анкета с битыми ссылками, и отличить одно от другого глазами было нельзя —
 * ни при проверке фото-блока, ни при проверке правок по отмеченному слоту.
 * Проверять на такой анкете «виден ли текущий снимок в слоте» бессмысленно:
 * ответ «нет» ничего не значит.
 *
 * `data:`-URL, а не файл в `public/` и не настоящая загрузка в blob: сид
 * работает вообще без сети и без `BLOB_READ_WRITE_TOKEN` (в CI его нет — см.
 * комментарий в `e2e/fill.spec.ts`), а `<img src>` принимает `data:` наравне
 * с `http:`. SVG, а не JPEG: несколько сотен байт вместо бинарной строки на
 * пол-килобайта, и на плитке видно название слота — так на экране проверки
 * сразу понятно, какой снимок к какому слоту привязан, чего одноцветная
 * заливка не даёт. Ограничения `MAX_PHOTO_BYTES`/`EXTENSION_BY_TYPE`
 * (`src/app/api/photos/route.ts`) к этому пути не относятся: они проверяют
 * ЗАГРУЖАЕМЫЙ файл, а сид пишет строку в `photos` напрямую, как и раньше.
 */
function seedPhotoUrl(label: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">` +
    `<rect width="320" height="240" fill="#dbe6f4"/>` +
    `<text x="160" y="120" font-family="sans-serif" font-size="22" ` +
    `text-anchor="middle" fill="#1f3352">${label}</text></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
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
      url: seedPhotoUrl(slot.label.en),
    })
  }

  const extraSlot = PHOTO_SLOTS.find((slot) => slot.extra)
  const extraNeeded = Math.max(1, MIN_PHOTOS - namedSlots.length)
  if (extraSlot) {
    for (let i = 0; i < extraNeeded; i += 1) {
      await db.insert(photos).values({
        submissionId,
        slot: extraSlot.key,
        blobKey: `seed/${extraSlot.key}-${i}.svg`,
        url: seedPhotoUrl(`${extraSlot.label.en} ${i + 1}`),
      })
    }
  }
}

/**
 * Ключи для трёх засеянных замечаний — по одному на каждую категорию
 * отмечаемых ключей, чтобы экран правок открывался сразу со всеми тремя
 * контролами.
 *
 * `I.2` (Lounge Full Name) — плоское текстовое поле, самое простое для правки
 * руками; `2.1` (Wifi Access) — реальная позиция услуг из списка `yesNo`, та
 * же, на которой стоят e2e-тесты услуг; `entrance` — обязательный
 * именованный слот фото (не `additional`), то есть тот случай, где новая
 * загрузка ЗАМЕНЯЕТ снимок.
 */
const SERVICE_FLAG_KEY = '2.1'

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
]

/**
 * Прогоняет уже заполненную анкету по настоящему жизненному циклу до
 * `changes_requested`. Порядок обязателен и проверяется самими функциями:
 * `raiseFlag` и `requestChanges` работают по статусу `submitted`
 * (`REVIEW_STATUSES`), а `requestChanges` отказывается возвращать анкету, у
 * которой нет ни одного открытого замечания. Отказ любого шага — падение
 * сида, а не молчаливое «получилось что-то другое».
 */
async function returnForChanges(db: Db, submissionId: string): Promise<void> {
  // Отмечаемая позиция услуг должна быть ПРЕДЛАГАЕМОЙ, иначе на экране правок
  // у неё честно не будет ни цены, ни слота, ни деталей: `ServiceItemCard`
  // спрашивает их только у предлагаемой позиции — то же правило, по которому
  // `offeredKeys` не пускает закрытую позицию во второй проход. `fillComplete`
  // отвечает «нет» по всем позициям (этого достаточно для полноты), так что
  // одну из них здесь переспрашиваем как «есть». `chargeType` обязателен:
  // предлагаемая позиция без него — валидный, но НЕПОЛНЫЙ ответ, и
  // `submitSubmission` ниже её не пропустит. `complimentary` не требует цены.
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

  const submitted = await submitSubmission(db, { submissionId, actor: 'filler' })
  if (!submitted.ok) {
    throw new Error(`seed-dev: отправка не прошла — ${submitted.error.ru}`)
  }

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

async function main(): Promise<void> {
  loadEnvFile(resolve(process.cwd(), '.env.local'))

  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL не задан')
  const db = createDb(url)

  // `--changes-requested` включает `--complete`: возврат на правку возможен
  // только у отправленной анкеты, а `submitSubmission` принимает лишь полную.
  const changesRequested = process.argv.includes('--changes-requested')
  const complete = changesRequested || process.argv.includes('--complete')

  const [lounge] = await db
    .insert(lounges)
    .values({
      name: 'Primeclass Lounge',
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
    await returnForChanges(db, submission!.id)
  }

  const { token } = await issueFillToken(db, {
    submissionId: submission!.id,
    ttlDays: 90,
  })

  process.stdout.write(`http://localhost:3000/f/${token}\n`)

  // `createDb` opens a `postgres-js` connection with no idle timeout, so the
  // process never exits on its own once the last query resolves — it just
  // hangs forever holding the socket open. `e2e/fill.spec.ts` shells out to
  // `npm run seed` via `execSync`, which blocks until the child process
  // exits, so an un-closed connection here would hang every e2e test.
  // `Db`'s shared type (`src/db/types.ts`) is deliberately driver-agnostic
  // (borrowed from the `pglite` overload of `drizzle`, see its own comment),
  // so it doesn't expose a typed `.end()` — the underlying `postgres-js`
  // client reached via `$client` is cast locally, only here, to close it.
  const client = (db as unknown as { $client: { end: () => Promise<void> } }).$client
  await client.end()
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
