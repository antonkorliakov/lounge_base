import { test, expect, type Page } from '@playwright/test'
import { execSync } from 'node:child_process'

/**
 * Seeds a fresh lounge + submission via `scripts/seed-dev.ts` and returns the
 * `/f/<token>` fill link it prints. Every test calls this itself — never
 * shares another test's submission — so tests stay independent of run order
 * and of each other's leftover state (see the task's determinism
 * requirement). `--complete` seeds every required field/service/photo, the
 * only questionnaire shape `submitSubmission` actually accepts.
 */
function seed(options: { complete?: boolean } = {}): string {
  const command = options.complete ? 'npm run --silent seed -- --complete' : 'npm run --silent seed'
  return execSync(command, { encoding: 'utf8' }).trim()
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

// Field-block screens before the two services passes — see buildSteps() in
// src/web/FormShell.tsx: one screen per `fields`-kind entry in BLOCKS.
const FIELD_STEP_COUNT = 15

test('поле сохраняется автоматически, статус отражает это, переключатель языка меняет подписи и возвращается', async ({ page }) => {
  const url = seed()
  await page.goto(url)

  await expect(page.getByText('1 / 19')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Lounge Profile & Commercial Details' })).toBeVisible()

  await page.getByLabel(/Lounge Full Name/).fill('Primeclass Lounge')
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

test('два прохода по услугам: детали спрашиваются только по отмеченной позиции', async ({ page }) => {
  const url = seed()
  await page.goto(url)

  await clickNext(page, FIELD_STEP_COUNT)
  await expect(page.getByRole('heading', { name: 'What does the lounge offer?' })).toBeVisible()

  // Отметить одну услугу — вторую (Runway View) оставить нетронутой.
  await page.getByText('Wifi Access').locator('..').getByRole('checkbox').check()
  await clickNext(page)

  await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Wifi Access' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Runway View' })).toHaveCount(0)
})

test('отказ сервера показывает ошибку у позиции и НЕ отображается как "Saved" (Critical 2)', async ({ page }) => {
  const url = seed()
  await page.goto(url)

  await clickNext(page, FIELD_STEP_COUNT)
  await expect(page.getByRole('heading', { name: 'What does the lounge offer?' })).toBeVisible()

  // Checking a service without also setting its charge type is refused by
  // `validateServiceValue` (see src/form-schema/validation.ts: an "offered"
  // item needs `chargeType`, and Pass 1 never sets it — only Pass 2 does).
  // This is the easiest real refusal to trigger through the actual UI: no
  // mocking, no direct DB/API calls, just the ordinary two-pass flow with
  // the second pass not reached yet.
  await page.getByText('Wifi Access').locator('..').getByRole('checkbox').check()
  await clickNext(page)
  await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible()

  // The 600ms autosave debounce (see useAutosave.ts) plus the round trip to
  // the server must run before the refusal comes back — `expect` here polls
  // until it does. Before Critical 2 was fixed, `useAutosave` cleared the
  // rejected key from its retry queue unconditionally and reported "Saved"
  // regardless: this refusal was invisible end-to-end.
  await expect(page.getByText('Some answers were not accepted')).toBeVisible()
  await expect(page.getByText('Saved')).toHaveCount(0)

  const wifiCard = page.getByRole('heading', { name: 'Wifi Access' }).locator('..')
  await expect(
    wifiCard.getByText('Specify whether the service is complimentary or chargeable'),
  ).toBeVisible()

  // Fixing the actual cause — picking a charge type — clears both the
  // per-item error and the header status, confirming this isn't a one-way
  // "permanently stuck" state.
  await wifiCard.getByRole('combobox').selectOption('complimentary')
  await expect(page.getByText('Saved')).toBeVisible()
  await expect(
    wifiCard.getByText('Specify whether the service is complimentary or chargeable'),
  ).toHaveCount(0)
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

  await clickNext(page, FIELD_STEP_COUNT + 3) // 15 блоков полей + 2 прохода услуг + фото = экран отправки
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

  await clickNext(page, FIELD_STEP_COUNT + 2) // 15 блоков полей + 2 прохода услуг = экран фото
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

test('III.3.2: повторный выбор «allowed» не стирает возраст', async ({ page }) => {
  const url = seed()
  await page.goto(url)

  // Блок III.3 «Children Policy» — 8-й экран плоских полей (после I, II.1–4, III.1–2).
  await clickNext(page, 7)
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
