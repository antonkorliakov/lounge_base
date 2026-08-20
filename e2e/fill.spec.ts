import { test, expect, type Locator, type Page } from '@playwright/test'
import { execSync } from 'node:child_process'

/**
 * Seeds a fresh lounge + submission via `scripts/seed-dev.ts` and returns the
 * `/f/<token>` fill link it prints. Every test calls this itself — never
 * shares another test's submission — so tests stay independent of run order
 * and of each other's leftover state (see the task's determinism
 * requirement). `--complete` seeds every required field/service/photo, the
 * only questionnaire shape `submitSubmission` actually accepts.
 */
function seed(options: { complete?: boolean; changesRequested?: boolean } = {}): string {
  const flag =
    options.changesRequested ? ' -- --changes-requested'
    : options.complete ? ' -- --complete'
    : ''
  return execSync(`npm run --silent seed${flag}`, { encoding: 'utf8' }).trim()
}

/**
 * `FormShell`'s Back/Next always re-render as the *same* accessible name
 * (`form.next`/`form.back` — English by default), regardless of which step
 * is showing, so a plain `getByRole` re-query on every iteration is safe:
 * unlike a cached element handle, this never goes stale across the step's
 * own re-render.
 */
async function clickNext(page: Page, times = 1): Promise<void> {
  // `exact: true` matters here: the Next.js dev-mode overlay injects its own
  // button labelled "Open Next.js Dev Tools", and Playwright's default
  // substring match on `name` treats "Next.js" as containing "Next" — so a
  // non-exact match resolves to *two* buttons and throws a strict-mode
  // violation.
  for (let i = 0; i < times; i += 1) {
    await page.getByRole('button', { name: 'Next', exact: true }).click()
  }
}

// Field screens before the two services passes — see buildSteps() and
// MERGED_FIELD_GROUPS in src/web/FormShell.tsx: the 15 `fields`-kind BLOCKS
// entries now render as 5 steps (I / Contacts / Operating Schedule /
// Access & Policies / Location & Facility) — merging is presentation only,
// each block keeps its own section heading inside its step.
const FIELD_STEP_COUNT = 5

/**
 * One button of a binary item's availability toggle pair, addressed the way
 * assistive tech addresses it: the pair is a `role="group"` named after the
 * item, holding a "Yes" and a "No" button (see `ServiceAvailabilityInput`).
 *
 * This control has been three shapes now. The checkbox could not express
 * "no" as distinct from "nothing said" (I2); the `<select>` that replaced it
 * could, so these tests said `selectOption('yes')` for a while; the toggle
 * pair keeps all three states visible and brings the answer back to one tap,
 * so they now say `click()` on the named button — and read the answer back
 * as `aria-pressed`, the same attribute the stylesheet keys the pressed
 * look on, rather than as a value. Non-binary items (8.3 Vaping) still
 * render the `<select>`; no test currently drives that one here (the render
 * side of it is pinned by `src/web/__tests__/fixesOnly.test.tsx`).
 */
function availability(page: Page, itemLabel: string, answer: 'Yes' | 'No'): Locator {
  return page
    .getByRole('group', { name: itemLabel })
    .getByRole('button', { name: answer, exact: true })
}

test('поле сохраняется автоматически, статус отражает это, переключатель языка меняет подписи и возвращается', async ({ page }) => {
  const url = seed()
  await page.goto(url)

  await expect(page.getByText('1 / 9')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Lounge Profile & Commercial Details' })).toBeVisible()

  // НЕ 'Primeclass Lounge': это дефолтное имя сида, и с тех пор как
  // `createLounge` предзаполняет I.2 названием лаунжа, поле уже держит ровно
  // эту строку — fill() тем же значением не даёт перехода value, React не
  // зовёт onChange, автосохранению нечего сохранять, и «Saved» не появился бы
  // по причине, никак не связанной с проверяемым.
  await page.getByLabel(/Lounge Full Name/).fill('Primeclass Lounge Renamed')
  await expect(page.getByText('Saved')).toBeVisible()

  // Переключатель языка меняет подписи и переключается обратно.
  await page.getByRole('button', { name: 'RU', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Профиль и коммерческие детали' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Далее' })).toBeVisible()

  await page.getByRole('button', { name: 'EN', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Lounge Profile & Commercial Details' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeVisible()
})

/**
 * Слитый шаг (MERGED_FIELD_GROUPS в FormShell.tsx): один экран несёт
 * несколько блоков схемы, и каждый блок остаётся виден под СВОИМ названием —
 * заголовком секции, дословно тем же текстом, которым ревьюер подтверждает
 * блок и ставит замечания. Проверяется на контактном шаге, всеми четырьмя
 * секциями и полем из КАЖДОГО блока: секция без своих полей была бы
 * декорацией. Плюс сам навигатор: 9 пунктов, слитые шаги — под своими
 * именами, и прыжок по имени открывает слитый шаг с его секциями.
 */
test('слитый шаг «Contacts»: секции всех четырёх блоков с их полями, навигатор перечисляет 9 шагов', async ({ page }) => {
  const url = seed()
  await page.goto(url)

  await clickNext(page) // I → Contacts
  await expect(page.getByText('2 / 9')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Contacts', level: 1 })).toBeVisible()

  // Секции — по одной на блок группы, в порядке BLOCKS, подписи блоков дословно.
  await expect(page.locator('.step-section-title')).toHaveText([
    'Primary Operational Contact',
    'Shift / Duty Contact',
    'Finance Contact',
    'Lounge Direct Contacts',
  ])

  // Поле из каждого из четырёх блоков — секции держат свои поля.
  await expect(page.getByLabel(/Lounge Operations Manager Name/)).toBeVisible()
  await expect(page.getByLabel(/Shift Mobile \/ Duty Phone Number/)).toBeVisible()
  await expect(page.getByLabel(/Finance SPOC- Name/)).toBeVisible()
  await expect(page.getByLabel(/Fax Number/)).toBeVisible()

  // Навигатор: ровно 9 шагов, слитые — под своими именами из словаря.
  await page.getByRole('button', { name: 'Contacts', exact: true }).click()
  const nav = page.getByRole('navigation', { name: 'Form steps' })
  await expect(nav.getByRole('listitem')).toHaveCount(9)
  await expect(nav.getByRole('button', { name: 'Access & Policies' })).toBeVisible()

  // Прыжок по имени из списка открывает слитый шаг с его секциями.
  await nav.getByRole('button', { name: 'Location & Facility' }).click()
  await expect(page.getByRole('heading', { name: 'Location & Facility', level: 1 })).toBeVisible()
  await expect(page.getByText('5 / 9')).toBeVisible()
  await expect(page.locator('.step-section-title')).toHaveText([
    'Lounge Location',
    'Terminal & Zone Information',
    'Multi-Terminal Access',
    'Capacity Information',
    'Lounge Signage',
    'Lounge Validity',
  ])
})

test('два прохода по услугам: детали спрашиваются только по отмеченной позиции', async ({ page }) => {
  const url = seed()
  await page.goto(url)

  await clickNext(page, FIELD_STEP_COUNT)
  await expect(page.getByRole('heading', { name: 'What does the lounge offer?' })).toBeVisible()

  // Отметить одну услугу — вторую (Runway View) оставить нетронутой.
  await availability(page, 'Wifi Access', 'Yes').click()
  await clickNext(page)

  await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Wifi Access' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Runway View' })).toHaveCount(0)
})

// R1, whole-branch review second round: checking a service in Pass 1 used
// to be refused outright (`validateServiceValue` required a `chargeType`
// that Pass 1 has no control to set), so the answer survived only in React
// state and a reload between passes lost every Pass-1 decision. This test
// is what that round exists to fix: it never reaches Pass 2 at all, and
// still expects the Pass-1 answer to be saved and to survive a reload.
test('выбор в первом проходе по услугам сохраняется и переживает перезагрузку (R1)', async ({ page }) => {
  const url = seed()
  await page.goto(url)

  await clickNext(page, FIELD_STEP_COUNT)
  await expect(page.getByRole('heading', { name: 'What does the lounge offer?' })).toBeVisible()

  await availability(page, 'Wifi Access', 'Yes').click()

  // Wait for the 600ms autosave debounce plus the round trip to actually
  // persist this — before the fix, `validateServiceValue` refused it, so
  // the header would have stuck on "Some answers were not accepted", never
  // "Saved".
  await expect(page.getByText('Saved')).toBeVisible()

  await page.reload()
  await clickNext(page, FIELD_STEP_COUNT)
  await expect(page.getByRole('heading', { name: 'What does the lounge offer?' })).toBeVisible()

  await expect(availability(page, 'Wifi Access', 'Yes')).toHaveAttribute('aria-pressed', 'true')

  // Тап по уже нажатой кнопке — это сознательная очистка: путь «передумал»,
  // который у дропдауна жил в `—`, у пары живёт во втором тапе (см.
  // `availabilityAfterTap`). Очистка — такое же сохраняемое изменение, как и
  // ответ: после перезагрузки позиция обязана быть НЕ отвеченной (обе кнопки
  // отжаты), а не тихо вернуться к «yes» из React-состояния.
  await availability(page, 'Wifi Access', 'Yes').click()
  await expect(availability(page, 'Wifi Access', 'Yes')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByText('Saved')).toBeVisible()

  await page.reload()
  await clickNext(page, FIELD_STEP_COUNT)
  await expect(availability(page, 'Wifi Access', 'Yes')).toHaveAttribute('aria-pressed', 'false')
  await expect(availability(page, 'Wifi Access', 'No')).toHaveAttribute('aria-pressed', 'false')
})

/**
 * Один чип multi_select-поля зон (III.6.6, секция «Terminal & Zone
 * Information» слитого шага «Location & Facility»), адресованный так же, как
 * кнопки пары наличия выше: группа
 * названа подписью поля (`role="group"` + `aria-label` в `FieldInput`), чип —
 * кнопка с вариантом списка `zone`. До чипов здесь стояли чекбоксы, и никакой
 * e2e их не трогал вовсе — поле жило только на юнит-стороне контракта; ответ
 * читается как `aria-pressed`, тот же атрибут, по которому красится нажатый
 * чип.
 */
function zoneChip(page: Page, option: string): Locator {
  return page
    .getByRole('group', { name: 'Arrival / Departure / Transit' })
    .getByRole('button', { name: option, exact: true })
}

test('чипы multi_select: членство переключается, сохраняется и переживает перезагрузку, клик по заголовку поля ничего не нажимает', async ({ page }) => {
  const url = seed()
  await page.goto(url)

  await clickNext(page, 4) // I, Contacts, III.1, Access & Policies → Location & Facility
  await expect(page.getByRole('heading', { name: 'Terminal & Zone Information' })).toBeVisible()

  // Ловушка b, применённая к этому полю: заголовок поля НЕ label (см.
  // `FieldInput`'s multi_select branch и инвариант в fixesOnly.test.tsx),
  // так что клик по нему не должен нажать первый чип.
  await page.locator('.field-label', { hasText: 'Arrival / Departure / Transit' }).click()
  await expect(zoneChip(page, 'Arrival')).toHaveAttribute('aria-pressed', 'false')
  await expect(zoneChip(page, 'Departure')).toHaveAttribute('aria-pressed', 'false')
  await expect(zoneChip(page, 'Transit')).toHaveAttribute('aria-pressed', 'false')

  // Членство, а не одиночный выбор: два нажатых чипа сосуществуют.
  await zoneChip(page, 'Departure').click()
  await zoneChip(page, 'Transit').click()
  await expect(zoneChip(page, 'Departure')).toHaveAttribute('aria-pressed', 'true')
  await expect(zoneChip(page, 'Transit')).toHaveAttribute('aria-pressed', 'true')
  await expect(zoneChip(page, 'Arrival')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByText('Saved')).toBeVisible()

  await page.reload()
  await clickNext(page, 4)
  await expect(zoneChip(page, 'Departure')).toHaveAttribute('aria-pressed', 'true')
  await expect(zoneChip(page, 'Transit')).toHaveAttribute('aria-pressed', 'true')
  await expect(zoneChip(page, 'Arrival')).toHaveAttribute('aria-pressed', 'false')

  // Второй тап по нажатому чипу — снятие ИМЕННО его: сосед остаётся нажат,
  // и снятие — такое же сохраняемое изменение, как и выбор.
  await zoneChip(page, 'Transit').click()
  await expect(zoneChip(page, 'Transit')).toHaveAttribute('aria-pressed', 'false')
  await expect(zoneChip(page, 'Departure')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Saved')).toBeVisible()

  await page.reload()
  await clickNext(page, 4)
  await expect(zoneChip(page, 'Transit')).toHaveAttribute('aria-pressed', 'false')
  await expect(zoneChip(page, 'Departure')).toHaveAttribute('aria-pressed', 'true')
})

test('отказ сервера показывает ошибку у позиции и НЕ отображается как "Saved" (Critical 2)', async ({ page }) => {
  const url = seed()
  await page.goto(url)

  await clickNext(page, FIELD_STEP_COUNT)
  await expect(page.getByRole('heading', { name: 'What does the lounge offer?' })).toBeVisible()

  // Checking a service in Pass 1 no longer causes a refusal by itself (R1
  // fixed that — see the persistence test above). The natural refusal
  // reachable through the real UI now lives in Pass 2: `validateServiceValue`
  // still enforces that a "chargeable" answer needs a price — R1 only
  // removed the "must have SOME chargeType at all" gate, not this
  // internal-consistency rule.
  await availability(page, 'Wifi Access', 'Yes').click()
  await clickNext(page)
  await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible()

  // Pass 2 renders no availability control (`withAvailability` is false
  // there — availability is Pass 1's question, one Back away), so the card's
  // only dropdown is still the charge type.
  const wifiCard = page.getByRole('heading', { name: 'Wifi Access' }).locator('..')
  await wifiCard.getByRole('combobox').selectOption('chargeable')

  // The 600ms autosave debounce (see useAutosave.ts) plus the round trip to
  // the server must run before the refusal comes back — `expect` here polls
  // until it does. Before Critical 2 was fixed, `useAutosave` cleared the
  // rejected key from its retry queue unconditionally and reported "Saved"
  // regardless: this refusal was invisible end-to-end.
  await expect(page.getByText('Some answers were not accepted')).toBeVisible()
  await expect(page.getByText('Saved')).toHaveCount(0)
  await expect(wifiCard.getByText('Price is required for a chargeable service')).toBeVisible()

  // Fixing the actual cause — entering a price AND a currency, both of
  // which `validateServiceValue` requires once `chargeType` is "chargeable"
  // — clears both the per-item error and the header status, confirming
  // this isn't a one-way "permanently stuck" state. The price input is the
  // first number input that appears once "chargeable" makes `needsPrice`
  // true (see ServicesPass2.tsx); the currency input is the only `<input>`
  // in this card with no `type` attribute (it sits right after price, and
  // is otherwise indistinguishable from the details/booking fields except
  // by that absence).
  const priceInput = wifiCard.locator('input[type="number"]').first()
  await priceInput.fill('10')
  const currencyInput = wifiCard.locator('input:not([type])')
  await currencyInput.fill('EUR')

  await expect(page.getByText('Saved')).toBeVisible()
  await expect(wifiCard.getByText('Price is required for a chargeable service')).toHaveCount(0)
})

test('перезагрузка сохраняет значение, введённое до срабатывания автосохранения', async ({ page }) => {
  const url = seed()
  await page.goto(url)

  // Debounce в useAutosave — 600ms. Заполняем и перезагружаем без ожидания
  // сохранения, чтобы упражнять именно ту часть очереди, которую не может
  // покрыть unit-тест (там нет DOM): дренаж очереди при монтировании.
  await page.getByLabel(/Lounge Full Name/).fill('Reload Survivor')
  await page.reload()

  await expect(page.getByLabel(/Lounge Full Name/)).toHaveValue('Reload Survivor')
})

test('неполная анкета не отправляется и сообщает, сколько осталось заполнить — на языке интерфейса', async ({ page }) => {
  const url = seed()
  await page.goto(url)

  await clickNext(page, FIELD_STEP_COUNT + 3) // 5 шагов полей + 2 прохода услуг + фото = экран отправки
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click()

  // Default locale is English — before this fix, `src/app/f/[token]/
  // actions.ts` hardcoded `result.error.ru` regardless of UI locale, so an
  // English-reading operator would see this Russian text. `ActionResult`
  // now carries the full `Localized` pair and the client picks with the
  // same `pick()` it already uses for every schema string.
  await expect(page.getByText(/item\(s\) still need an answer/)).toBeVisible()

  // Switching locale re-renders the *same* stored error through `pick()` —
  // no second submit, no second server round trip. That is the whole point:
  // the error is a `Localized` value now, not a string already committed to
  // one language.
  await page.getByRole('button', { name: 'RU', exact: true }).click()
  await expect(page.getByText(/Осталось заполнить/)).toBeVisible()
})

test('полностью заполненная анкета отправляется на проверку', async ({ page }) => {
  const url = seed({ complete: true })
  await page.goto(url)

  await clickNext(page, FIELD_STEP_COUNT + 3)
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click()

  await expect(page.getByText('Sent for review. We will get back to you.')).toBeVisible()
})

test('отказ при загрузке фото виден рядом со слотом и рендерится на языке интерфейса', async ({ page }) => {
  const url = seed()
  await page.goto(url)

  await clickNext(page, FIELD_STEP_COUNT + 2) // 5 шагов полей + 2 прохода услуг = экран фото
  await expect(page.getByRole('heading', { name: 'Photos', exact: true })).toBeVisible()

  // `/api/photos` checks token, size, MIME, and slot BEFORE it ever touches
  // Vercel Blob (see src/app/api/photos/route.ts) — CI has no blob token, so
  // a rejection reachable at that stage is the only one this test can drive
  // through the real route rather than a mock.
  //
  // An invalid-MIME file does NOT reach that check through the real UI: the
  // client (src/photos/resize.ts + PhotoSlots.tsx) unconditionally declares
  // the outgoing file as `image/jpeg` regardless of what was actually
  // attached — confirmed by hand in a real browser before writing this test
  // (a .txt file attached this way still arrives at the route typed as
  // `image/jpeg`, sails past the MIME check, and only fails later at
  // `put()`, as a 500, because there's no blob token — not the graceful
  // rejection this test needs). The size check runs *before* the MIME check
  // and *before* blob storage, and it's the file's actual byte length, not
  // its declared type — so an oversized file is the one validation-stage
  // rejection that is both real (hits the actual route) and reachable here.
  // `.first()` (Entrance, first in PHOTO_SLOTS) rather than filtering by its
  // heading text: a `has: getByRole('heading', { name: 'Entrance' })` filter
  // re-evaluates against the *current* DOM every time it's queried, and the
  // heading itself becomes "Вход" once the locale switch below happens — a
  // locale-text-based filter would then match zero slots and the assertion
  // after switching locale would fail for a reason that has nothing to do
  // with the fix being tested.
  const entranceSlot = page.locator('.photo-slot').first()
  await entranceSlot.locator('input[type="file"]').setInputFiles({
    name: 'too-big.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(16 * 1024 * 1024), // over MAX_PHOTO_BYTES (15MB)
  })

  await expect(entranceSlot.getByText('The file is too large')).toBeVisible()

  // Switching locale re-renders the same stored (Localized) error, exactly
  // like the submit-error assertion above — no second upload attempt.
  await page.getByRole('button', { name: 'RU', exact: true }).click()
  await expect(entranceSlot.getByText('Файл слишком велик')).toBeVisible()
})

/**
 * Экран правок со всеми категориями отмеченных ответов сразу — поле, позиция
 * услуг, именованный слот фото и накопительный слот (`--changes-requested` в
 * `scripts/seed-dev.ts` ставит по замечанию на каждую).
 *
 * До этого экран рисовал контрол только для полей: у 58 позиций услуг и 4
 * слотов фото — 48% всего, что можно отметить — заполняющий видел комментарий
 * ревьюера и НИЧЕГО, чем его исправить, а `submitSubmission` проверяет
 * полноту, а не замечания, так что он мог отправить анкету неизменной, и цикл
 * проверки не сходился. Этот дефект — четвёртый на этой ветке из класса
 * «нужный человек не может увидеть или дотянуться до нужного», и все четыре
 * нашлись чтением кода, ни один тестом. Поэтому проверка именно сквозная: не
 * «в разметке есть input», а «правка на этом экране снимает СВОЁ замечание и
 * не снимает чужие», что видно только после перезагрузки, то есть только
 * пройдя настоящий путь автосохранение → серверное действие → clearFlagsFor.
 *
 * Загрузка фото здесь не выполняется: `put()` требует
 * `BLOB_READ_WRITE_TOKEN`, которого в CI нет (см. тест про отказ загрузки
 * выше). Проверяется, что контрол загрузки и текущий снимок слота на экране
 * есть; снятие замечания при загрузке покрыто интеграционным тестом маршрута
 * (`src/app/api/photos/__tests__/upload-route.test.ts`). УДАЛЕНИЕ снимка, в
 * отличие от загрузки, блоб-токена не требует (удаление блоба — best-effort,
 * см. `DELETE /api/photos`), поэтому единственный правдивый ответ на замечание
 * по накопительному слоту проходится здесь целиком, до снятия замечания.
 */
test('экран правок: у каждой категории есть рабочий контрол, и правка снимает своё замечание', async ({ page }) => {
  const url = seed({ changesRequested: true })
  await page.goto(url)

  await expect(page.getByRole('heading', { name: 'Changes requested' })).toBeVisible()
  await expect(page.locator('.fix-card')).toHaveCount(4)
  // Ни одна карточка не должна остаться без контрола — а если осталась, она
  // теперь громкая, а не пустая (см. `FixesOnly`'s `fix-unmatched`).
  await expect(page.locator('.fix-unmatched')).toHaveCount(0)

  const fieldCard = page.locator('.fix-card').filter({ has: page.getByLabel(/Lounge Full Name/) })
  const serviceCard = page.locator('.fix-card').filter({
    has: page.getByRole('heading', { name: 'Wifi Access' }),
  })
  const photoCard = page.locator('.fix-card').filter({
    has: page.getByRole('heading', { name: 'Entrance' }),
  })
  const extraCard = page.locator('.fix-card').filter({
    has: page.getByRole('heading', { name: 'Additional Photos' }),
  })

  // Позиция услуг: наличие (то, что раньше жило только в первом проходе и на
  // этот экран не попадало вовсе) плюс весь набор атрибутов. Wifi — бинарная
  // позиция, так что наличие здесь — пара кнопок Да|Нет с нажатым «Yes»
  // (`aria-pressed` — тот же атрибут, по которому красится нажатая кнопка),
  // а единственный дропдаун карточки — «платно/бесплатно» (см.
  // `ServiceItemCard`). Нажатость читается как СОСТОЯНИЕ с тремя исходами:
  // именно этого чекбокс и не мог показать — «нет» у него выглядел так же,
  // как «ничего не сказано».
  await expect(availability(page, 'Wifi Access', 'Yes')).toHaveAttribute('aria-pressed', 'true')
  await expect(availability(page, 'Wifi Access', 'No')).toHaveAttribute('aria-pressed', 'false')
  await expect(serviceCard.getByRole('combobox')).toHaveCount(1)
  await expect(serviceCard.getByRole('combobox')).toHaveValue('complimentary')
  await expect(serviceCard.locator('input[type="number"]')).toHaveCount(1)
  await expect(serviceCard.locator('textarea')).toHaveCount(1)

  // Именованный слот фото: что лежит сейчас — и чем заменить.
  await expect(photoCard.locator('img')).toHaveCount(1)
  await expect(photoCard.locator('input[type="file"]')).toHaveCount(1)
  await expect(photoCard.getByText('Replace')).toBeVisible()
  // И убрать снимок у него нельзя: замена и есть ответ на замечание.
  await expect(photoCard.locator('.photo-remove')).toHaveCount(0)

  // Накопительный слот: подпись «Добавить», потому что загрузка ДОБАВЛЯЕТ
  // (`attachPhoto` не удаляет прежние строки у `extra`-слота) — раньше здесь
  // стояло «Заменить», и нажатие добавляло четвёртый снимок, оставляя
  // непригодный на месте. Плюс по кнопке «Убрать» на каждый снимок: без неё у
  // этого замечания не было правдивого ответа вовсе.
  await expect(extraCard.getByText('Add photo')).toBeVisible()
  await expect(extraCard.getByText('Replace')).toHaveCount(0)
  await expect(extraCard.locator('img')).toHaveCount(2)
  await expect(extraCard.locator('.photo-remove')).toHaveCount(2)

  await expect(page.getByText('Flagged answers you have not changed yet: 4 / 4')).toBeVisible()

  // ── Правка поля ───────────────────────────────────────────────────────────
  await page.getByLabel(/Lounge Full Name/).fill('Primeclass Lounge Istanbul Airport')
  await expect(page.getByText('Saved')).toBeVisible()
  await expect(fieldCard.getByText('Changed', { exact: true })).toBeVisible()
  await expect(page.getByText('Flagged answers you have not changed yet: 3 / 4')).toBeVisible()

  // Перезагрузка перечитывает открытые замечания с сервера — единственный
  // способ увидеть, что `clearFlagsFor` действительно сработал по этому ключу.
  await page.reload()
  await expect(page.locator('.fix-card')).toHaveCount(3)
  await expect(page.getByLabel(/Lounge Full Name/)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Wifi Access' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Entrance' })).toBeVisible()

  // ── Правка позиции услуг ──────────────────────────────────────────────────
  await serviceCard.locator('input[type="number"]').fill('120')
  await expect(page.getByText('Saved')).toBeVisible()

  await page.reload()
  await expect(page.locator('.fix-card')).toHaveCount(2)
  await expect(page.getByRole('heading', { name: 'Wifi Access' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Entrance' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Additional Photos' })).toBeVisible()
  await expect(page.getByText('Flagged answers you have not changed yet: 2 / 2')).toBeVisible()

  // ── Правка накопительного слота: убрать негодный снимок ───────────────────
  // Единственный правдивый ответ на это замечание, и он проходится здесь
  // целиком: удаление не требует блоб-токена, так что видно и снятие
  // замечания после перезагрузки, а не только исчезнувшую плитку.
  await extraCard.locator('.photo-remove').first().click()
  await expect(extraCard.locator('img')).toHaveCount(1)
  await expect(extraCard.getByText('Changed', { exact: true })).toBeVisible()

  await page.reload()
  await expect(page.locator('.fix-card')).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'Additional Photos' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Entrance' })).toBeVisible()
  // Снимок действительно ушёл с сервера, а не только из состояния страницы.
  await expect(page.locator('.photo-slot img')).toHaveCount(1)
})

test('III.3.2: повторный выбор «allowed» не стирает возраст', async ({ page }) => {
  const url = seed()
  await page.goto(url)

  // Блок III.3 «Children Policy» — секция слитого шага «Access & Policies»,
  // 4-го экрана (после I, Contacts, III.1); заголовок секции — подпись блока.
  await clickNext(page, 3)
  await expect(page.getByRole('heading', { name: 'Children Policy' })).toBeVisible()

  const select = page.getByLabel(/Unaccompanied Children Policy/)
  const age = page.locator('.field-compound input[type="number"]')

  await select.selectOption('allowed')
  await age.fill('10')
  await expect(age).toHaveValue('10')

  // Переключиться на другой вариант и обратно на «allowed» — тот самый путь,
  // на котором раньше терялся слот `age` (см. nextSelectValue в FieldInput.tsx).
  await select.selectOption('not_allowed')
  await select.selectOption('allowed')

  await expect(age).toHaveValue('10')
})
