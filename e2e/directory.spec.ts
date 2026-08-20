import { test as base, expect, type Locator, type Page } from '@playwright/test'
import { execSync } from 'node:child_process'
import { SEED_REVIEWER_EMAIL } from '../scripts/dev-support'

/**
 * Справочник аэропортов IATA от края до края: настоящий импорт TSV в
 * локальную базу, автозаполнение производных полей в «Add lounge», честный
 * промах на неизвестном коде и порядок «IATA перед производными» в блоке I
 * формы заполнения.
 *
 * ОЖИДАНИЕ ОКРУЖЕНИЯ, записанное словами: локальная docker-база
 * (`.env.local`) должна быть МИГРИРОВАНА до `0005` (`npm run db:migrate`) —
 * таблицу `airport_directory` создаёт миграция, не скрипт. Сам же справочник
 * наполняет `beforeAll` ниже НАСТОЯЩИМ `npm run db:import-airports` — это и
 * есть e2e самого скрипта (идемпотентность позволяет гонять его на каждый
 * прогон; юнит-половина — `src/registry/__tests__/directory.test.ts`).
 * Остальные e2e-файлы на наполненный справочник ПОЛАГАЮТСЯ (registry.spec
 * ждёт автозаполнения по IST): порядок файлов Playwright не обещает, поэтому
 * импорт здесь — для чистой базы, а на живой машине справочник уже стоит.
 *
 * Страж `pageerror`/`console.error` — тот же и по той же причине, что в
 * `registry.spec.ts` (см. историю там).
 */

type Watched = {
  errors: string[]
  watch: (page: Page, label: string) => void
}

function watch(errors: string[], page: Page, label: string): void {
  page.on('pageerror', (error) => {
    errors.push(`[${label}] pageerror: ${error.message}`)
  })
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`[${label}] console.error: ${message.text()}`)
  })
}

const test = base.extend<{ watched: Watched }>({
  watched: [
    async ({ page }, use) => {
      const errors: string[] = []
      watch(errors, page, 'reviewer')
      await use({ errors, watch: (other, label) => watch(errors, other, label) })
      expect(errors, 'страница сообщила об ошибках в JS/консоли').toEqual([])
    },
    { auto: true },
  ],
})

test.beforeAll(() => {
  // Скрипт сам читает .env.local (НЕ .env.production.local — см. его
  // комментарий: умолчание локальное именно потому, что его гоняют тесты).
  // Заодно проверяется идемпотентность на живой базе: повторные прогоны
  // набора не множат и не ломают строки.
  execSync('npm run --silent db:import-airports', { encoding: 'utf8' })
  // Проверяющий нужен для входа; --fleet/--complete не нужны — сид самого
  // маленького лаунжа заводит его как побочный эффект любого режима, но
  // здесь лаунжи создаются из браузера, так что сид зовётся без флагов.
  execSync('npm run --silent seed', { encoding: 'utf8' })
})

function loginLinkFor(email: string): string {
  return execSync(`npx tsx scripts/dev-login-link.ts ${email}`, { encoding: 'utf8' }).trim()
}

async function expectRendered(watched: Watched, marker: Locator): Promise<void> {
  await expect(async () => {
    if (watched.errors.length > 0) {
      throw new Error(
        `страница сообщила об ошибке вместо отрисовки:\n${watched.errors.join('\n')}`,
      )
    }
    await expect(marker).toBeVisible({ timeout: 500 })
  }).toPass({ timeout: 20_000 })
}

async function openRegistry(page: Page, watched: Watched): Promise<void> {
  await page.goto(loginLinkFor(SEED_REVIEWER_EMAIL))
  await expectRendered(watched, page.getByRole('heading', { name: 'Lounges' }))
}

function rowFor(page: Page, name: string): Locator {
  return page.getByRole('row').filter({ hasText: name })
}

async function searchFor(page: Page, text: string): Promise<void> {
  const box = page.getByRole('searchbox', { name: /Name or IATA/ })
  await box.fill(text)
  await box.press('Enter')
  await expect(page).toHaveURL(new RegExp(`search=${text}`))
}

test('известный код: имя + IATA достаточно — тройка из справочника, форма заполнения кодом вперёд', async ({
  page,
  watched,
}) => {
  const name = `Directory-${Math.random().toString(36).slice(2, 10)}`
  await openRegistry(page, watched)

  // ── «Add lounge»: набраны ТОЛЬКО имя и код ────────────────────────────────
  await page.getByRole('button', { name: 'Add lounge' }).click()
  await page.getByLabel('Name*', { exact: true }).fill(name)
  await page.getByLabel('IATA code*', { exact: true }).fill('saw') // нормализуется в SAW

  // Полный код спрашивает справочник: тройка производных заполняется его
  // значениями и закрывается на чтение, с подписью происхождения.
  await expect(page.getByText('from directory: SAW')).toBeVisible()
  const airport = page.getByLabel('Airport*', { exact: true })
  const city = page.getByLabel('City*', { exact: true })
  const country = page.getByLabel('Country*', { exact: true })
  await expect(airport).toHaveValue('Sabiha Gokcen')
  await expect(city).toHaveValue('Istanbul')
  await expect(country).toHaveValue('Turkey')
  await expect(airport).not.toBeEditable()
  await expect(city).not.toBeEditable()
  await expect(country).not.toBeEditable()

  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const fillUrl = await page.locator('.al-url').inputValue()
  expect(fillUrl).toMatch(/\/f\/.+/)
  await page.getByRole('button', { name: 'Done', exact: true }).click()

  // Строка реестра несёт значения СПРАВОЧНИКА — их никто не набирал руками.
  await searchFor(page, name)
  const row = rowFor(page, name)
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('SAW')
  await expect(row).toContainText('Istanbul')
  await expect(row).toContainText('Turkey')

  // ── Форма заполнения: блок I кодом вперёд, значения под замком ───────────
  await page.goto(fillUrl)
  await expect(
    page.getByRole('heading', { name: 'Lounge Profile & Commercial Details' }),
  ).toBeVisible()

  // Порядок показа — I.10 → I.9 → I.8 → I.7 (только презентация: подписи и
  // нумерация исходной формы не тронуты — см. stepFields в FillForm.tsx).
  const labels = await page.locator('.field .field-label').allTextContents()
  const at = (re: RegExp): number => labels.findIndex((text) => re.test(text))
  expect(at(/IATA Code/), labels.join(' | ')).toBeGreaterThan(-1)
  expect(at(/IATA Code/)).toBeLessThan(at(/^Airport/))
  expect(at(/^Airport/)).toBeLessThan(at(/^City/))
  expect(at(/^City/)).toBeLessThan(at(/^Country/))

  // Значения — из справочника, под замком предзаполнения (provider пуст —
  // его колонка ничего не замыкает, поэтому замка четыре).
  await expect(page.getByLabel(/IATA Code/)).toHaveValue('SAW')
  await expect(page.getByLabel(/IATA Code/)).not.toBeEditable()
  await expect(page.getByLabel(/^Airport\*/)).toHaveValue('Sabiha Gokcen')
  await expect(page.getByLabel(/^Airport\*/)).not.toBeEditable()
  await expect(page.getByLabel(/City/)).toHaveValue('Istanbul')
  await expect(page.getByLabel(/Country/)).toHaveValue('Turkey')
  await expect(page.locator('.field-locked-note')).toHaveCount(4)
})

test('поиск аэропорта: istan — Стамбул впереди, выбор SAW клавиатурой заполняет и замыкает тройку', async ({
  page,
  watched,
}) => {
  const name = `Picked-${Math.random().toString(36).slice(2, 10)}`
  await openRegistry(page, watched)

  await page.getByRole('button', { name: 'Add lounge' }).click()
  await page.getByLabel('Name*', { exact: true }).fill(name)

  const search = page.getByRole('combobox', { name: 'Find airport' })

  // Пустой ответ от двух+ знаков — тихая строка, не молчание.
  await search.fill('zzxq')
  await expect(page.getByText('nothing found')).toBeVisible()

  // «istan»: у IST запрос — префикс ИМЕНИ аэропорта (Istanbul Airport, ярус
  // имени), у SAW — лишь префикс ГОРОДА Istanbul (ярус города ниже), поэтому
  // IST первым, SAW вторым — порядок закреплён и юнитом
  // (directory-search.test.ts). Дальше десятки стран на *istan (Pakistan,
  // Kazakhstan…) — их подстрочный ярус не влезает в 8 строк, и список честно
  // говорит «уточните».
  await search.fill('istan')
  const options = page.getByRole('option')
  await expect(options.first()).toHaveText('IST — Istanbul Airport · Istanbul, Turkey')
  await expect(options.nth(1)).toHaveText('SAW — Sabiha Gokcen · Istanbul, Turkey')
  await expect(page.getByText('refine your search')).toBeVisible()

  // Выбор ТОЛЬКО клавиатурой: активен первый (IST), ↓ — SAW, Enter — выбор.
  await search.press('ArrowDown')
  await search.press('Enter')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(search).toHaveValue('SAW — Sabiha Gokcen')

  // Код встал ЧЕРЕЗ то же поле IATA, тройка заполнена и замкнута тем же
  // механизмом полного кода, что при ручном наборе, — с той же подписью.
  await expect(page.getByLabel('IATA code*', { exact: true })).toHaveValue('SAW')
  await expect(page.getByText('from directory: SAW')).toBeVisible()
  const airport = page.getByLabel('Airport*', { exact: true })
  const city = page.getByLabel('City*', { exact: true })
  const country = page.getByLabel('Country*', { exact: true })
  await expect(airport).toHaveValue('Sabiha Gokcen')
  await expect(city).toHaveValue('Istanbul')
  await expect(country).toHaveValue('Turkey')
  await expect(airport).not.toBeEditable()
  await expect(city).not.toBeEditable()
  await expect(country).not.toBeEditable()

  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('button', { name: 'Done', exact: true }).click()

  // Строка реестра несёт значения выбранного ряда справочника.
  await searchFor(page, name)
  const row = rowFor(page, name)
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('SAW')
  await expect(row).toContainText('Istanbul')
  await expect(row).toContainText('Turkey')
})

test('неизвестный код: честный промах, тройка заполняется руками и сохраняется как есть', async ({
  page,
  watched,
}) => {
  const name = `Manual-${Math.random().toString(36).slice(2, 10)}`
  await openRegistry(page, watched)

  await page.getByRole('button', { name: 'Add lounge' }).click()
  await page.getByLabel('Name*', { exact: true }).fill(name)
  await page.getByLabel('IATA code*', { exact: true }).fill('QQQ') // кода нет в справочнике

  // Справочник — не истина в последней инстанции: промах говорит об этом
  // словами, а тройка остаётся редактируемой.
  await expect(page.getByText('code not found in the directory')).toBeVisible()
  const city = page.getByLabel('City*', { exact: true })
  await expect(city).toBeEditable()
  await page.getByLabel('Airport*', { exact: true }).fill('Private Terminal')
  await city.fill('Private City')
  await page.getByLabel('Country*', { exact: true }).fill('Nowheria')

  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('button', { name: 'Done', exact: true }).click()

  // Ручные значения пережили серверные ворота (directory miss — правило
  // закреплено и юнитом: src/registry/__tests__/directory-derive.test.ts).
  await searchFor(page, name)
  const row = rowFor(page, name)
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('QQQ')
  await expect(row).toContainText('Private City')
  await expect(row).toContainText('Nowheria')
})
