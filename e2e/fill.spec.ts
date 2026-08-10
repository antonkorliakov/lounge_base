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

test('неполная анкета не отправляется и сообщает, сколько осталось заполнить', async ({ page }) => {
  const url = seed()
  await page.goto(url)

  await clickNext(page, FIELD_STEP_COUNT + 3) // 15 блоков полей + 2 прохода услуг + фото = экран отправки
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click()

  await expect(page.getByText(/Осталось заполнить/)).toBeVisible()
})

test('полностью заполненная анкета отправляется на проверку', async ({ page }) => {
  const url = seed({ complete: true })
  await page.goto(url)

  await clickNext(page, FIELD_STEP_COUNT + 3)
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click()

  await expect(page.getByText('Sent for review. We will get back to you.')).toBeVisible()
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
