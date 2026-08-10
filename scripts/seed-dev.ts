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
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDb } from '../src/db/client'
import { lounges, submissions, photos } from '../src/db/schema'
import { issueFillToken } from '../src/access/tokens'
import { saveFieldValue, saveServiceValue } from '../src/submissions/values'
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
      blobKey: `seed/${slot.key}.jpg`,
      url: `https://example.com/seed/${slot.key}.jpg`,
    })
  }

  const extraSlot = PHOTO_SLOTS.find((slot) => slot.extra)
  const extraNeeded = Math.max(1, MIN_PHOTOS - namedSlots.length)
  if (extraSlot) {
    for (let i = 0; i < extraNeeded; i += 1) {
      await db.insert(photos).values({
        submissionId,
        slot: extraSlot.key,
        blobKey: `seed/${extraSlot.key}-${i}.jpg`,
        url: `https://example.com/seed/${extraSlot.key}-${i}.jpg`,
      })
    }
  }
}

async function main(): Promise<void> {
  loadEnvFile(resolve(process.cwd(), '.env.local'))

  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL не задан')
  const db = createDb(url)

  const complete = process.argv.includes('--complete')

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
