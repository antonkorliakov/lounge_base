import { test as base, expect, type Locator, type Page } from '@playwright/test'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { SEED_REVIEWER_EMAIL, loadEnvFile } from '../scripts/dev-support'

/**
 * Экран команды (`/admin/team`): приглашение через настоящую форму, пароль
 * коллеге и вход с ним, сброс пароля как отзыв доступа (открытая вкладка
 * участника теряет кабинет на следующем переходе), kill switch и удаление с
 * набором почты. Сторону входа держит `review.spec.ts` (сценарий «вход по
 * паролю»), реестр — `registry.spec.ts`.
 *
 * Участник на каждый прогон СВОЙ (`e2e-team-…`), не сидовый reviewer, — по
 * той же причине, что у парольного сценария review.spec: сброс пароля и
 * kill switch отзывают сессии, а у сидового «сессии» — это живые входы
 * параллельно идущих файлов. Сидовым здесь только СМОТРЯТ на экран (его
 * сессий никто не трогает: своя строка не предлагает ни удаления, ни
 * сброса — см. `TeamScreen`).
 *
 * Страж `pageerror`/`console.error` — тот же и по той же причине, что в
 * соседних файлах; вторая вкладка участника подключается к нему же
 * (`watched.watch`).
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
      watch(errors, page, 'admin')
      await use({ errors, watch: (other, label) => watch(errors, other, label) })
      expect(errors, 'страница сообщила об ошибках в JS/консоли').toEqual([])
    },
    { auto: true },
  ],
})

/** См. пояснение в `review.spec.ts`: ссылку выдаёт тот же `requestLogin`,
 *  каким пользуется настоящее действие входа. */
function loginLinkFor(email: string): string {
  return execSync(`npx tsx scripts/dev-login-link.ts ${email}`, { encoding: 'utf8' }).trim()
}

/** Тот же гарантированно-dev запуск `ops.ts`, что в review.spec.ts (см.
 *  доводы там: без явного `DATABASE_URL` из `.env.local` прод-инструмент на
 *  машине с `.env.production.local` писал бы в боевую базу). */
function opsAgainstDevDb(args: string): void {
  loadEnvFile(resolve(process.cwd(), '.env.local'))
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL не задан (нет .env.local?)')
  execSync(`npx tsx scripts/ops.ts ${args}`, {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url },
  })
}

/** Гейт «страница отрисовалась вообще» — дословно тот же, что в соседях. */
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

/** Fill-then-act с ожиданием живого клиента — тот же хелпер и та же гонка,
 *  что у review.spec.ts (`fillEnabling`): включившаяся кнопка доказывает
 *  гидрацию, до неё fill() уходит в несмонтированный React. */
async function fillEnabling(
  fields: ReadonlyArray<readonly [Locator, string]>,
  gated: Locator,
): Promise<void> {
  await expect(async () => {
    for (const [field, value] of fields) {
      await field.fill('')
      await field.fill(value)
    }
    await expect(
      gated,
      'кнопка не включилась после заполнения полей — если это последняя итерация, правило включения сломано',
    ).toBeEnabled({ timeout: 250 })
  }).toPass({ timeout: 20_000 })
}

/** Входит сидовым проверяющим и открывает экран команды через ссылку шапки. */
async function openTeam(page: Page, watched: Watched): Promise<void> {
  await page.goto(loginLinkFor(SEED_REVIEWER_EMAIL))
  await expectRendered(watched, page.getByRole('heading', { name: 'Lounges' }))
  await page.getByRole('link', { name: 'Team', exact: true }).click()
  await expectRendered(watched, page.getByRole('heading', { name: 'Team', exact: true }))
}

/** Строка участника по почте — адреса уникальны на прогон. */
function rowFor(page: Page, email: string): Locator {
  return page.getByRole('row').filter({ hasText: email })
}

/** Вход участника по паролю через настоящую форму — с новой загрузкой
 *  документа, поэтому первое заполнение через fillEnabling. */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/admin/login')
  await fillEnabling(
    [
      [page.getByLabel('Work email'), email],
      [page.getByLabel('Password'), password],
    ],
    page.getByRole('button', { name: 'Sign in' }),
  )
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Lounges' })).toBeVisible()
}

test('приглашение с экрана, пароль коллеге, сброс отзывает его сессию, kill switch гасит вход', async ({
  page,
  browser,
  watched,
}) => {
  const suffix = Math.random().toString(36).slice(2, 10)
  const member = `e2e-team-${suffix}@example.com`
  const memberName = `Team Member ${suffix}`
  const password = `e2e-team-pw-${suffix}`

  await openTeam(page, watched)

  // ── Приглашение через настоящую форму ────────────────────────────────────
  await page.getByRole('button', { name: 'Invite member' }).click()
  await fillEnabling(
    [
      [page.getByLabel('Work email'), member],
      [page.getByLabel('Name', { exact: true }), memberName],
    ],
    page.getByRole('button', { name: 'Add to team' }),
  )
  await page.getByRole('button', { name: 'Add to team' }).click()

  // Уведомление говорит правду про отсутствие почты, а строка появляется без
  // перезагрузки (revalidatePath из действия) — пароля у новичка нет.
  await expect(page.getByText('No email is sent yet', { exact: false })).toBeVisible()
  const row = rowFor(page, member)
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(memberName)
  await expect(row.locator('td').nth(3)).toHaveText('no')

  // Повторное приглашение того же адреса — локализованный отказ, не пятисотка
  // (страж ловит console.error, так что 500 здесь уронил бы тест сам по себе).
  await page.getByRole('button', { name: 'Invite member' }).click()
  await fillEnabling(
    [
      [page.getByLabel('Work email'), member],
      [page.getByLabel('Name', { exact: true }), 'Duplicate'],
    ],
    page.getByRole('button', { name: 'Add to team' }),
  )
  await page.getByRole('button', { name: 'Add to team' }).click()
  await expect(page.getByText('already on the team', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  // ── Пароль коллеге: набирает админ, микрокопия говорит про «из рук в руки» ─
  await row.getByRole('button', { name: 'Set password' }).click()
  await expect(page.getByText('tell the password to the colleague in person', { exact: false }))
    .toBeVisible()
  // Кнопка выключена, пока пароль короче правила (подсказка; само правило —
  // `MIN_PASSWORD_LENGTH` в setMemberPassword, закреплено юнит-тестами).
  const setButton = page.getByRole('button', { name: 'Set', exact: true })
  await page.getByLabel('Temporary password').fill('short')
  await expect(setButton).toBeDisabled()
  await page.getByLabel('Temporary password').fill(password)
  await setButton.click()
  await expect(page.getByText('Password set.', { exact: false })).toBeVisible()
  await expect(row.locator('td').nth(3)).toHaveText('yes')

  // ── Участник входит этим паролем во второй вкладке (другой контекст) ─────
  const memberContext = await browser.newContext()
  const memberPage = await memberContext.newPage()
  watched.watch(memberPage, 'member')
  await signIn(memberPage, member, password)

  // ── Сброс пароля из первой вкладки отзывает ВСЕ сессии участника ─────────
  // Клик — в СТРОКЕ участника: dev-база копит участников с паролями от
  // прошлых прогонов, и страничный локатор нашёл бы несколько кнопок.
  await row.getByRole('button', { name: 'Reset password' }).click()
  await page.getByLabel('Temporary password').fill(`${password}-rotated`)
  await setButton.click()
  await expect(page.getByText('All their sessions were signed out', { exact: false }))
    .toBeVisible()

  // Открытая вкладка участника теряет кабинет на следующем же переходе —
  // сессии нет, requireSession уводит на вход.
  await memberPage.goto('/admin')
  await expect(memberPage.getByRole('heading', { name: 'Lounge Onboarding' })).toBeVisible()
  expect(new URL(memberPage.url()).pathname).toBe('/admin/login')

  // Старый пароль больше не входит, новый — входит (настоящая форма).
  await fillEnabling(
    [
      [memberPage.getByLabel('Work email'), member],
      [memberPage.getByLabel('Password'), password],
    ],
    memberPage.getByRole('button', { name: 'Sign in' }),
  )
  await memberPage.getByRole('button', { name: 'Sign in' }).click()
  await expect(memberPage.getByText('Sign-in failed', { exact: false })).toBeVisible()
  await memberPage.getByLabel('Password').fill(`${password}-rotated`)
  await memberPage.getByRole('button', { name: 'Sign in' }).click()
  await expect(memberPage.getByRole('heading', { name: 'Lounges' })).toBeVisible()

  // ── Kill switch: «завершить все сессии» гасит вход участника ─────────────
  await row.getByRole('button', { name: 'Sign out everywhere' }).click()
  // Хвост про «вход продолжает работать» есть ТОЛЬКО у уведомления kill
  // switch'а — уведомление сброса пароля выше тоже говорит про завершённые
  // сессии, и проверка по общему префиксу прошла бы на устаревшем тексте.
  await expect(row.getByText('Sign-in (link or password) still works', { exact: false }))
    .toBeVisible()
  await memberPage.goto('/admin')
  await expect(memberPage.getByRole('heading', { name: 'Lounge Onboarding' })).toBeVisible()

  await memberContext.close()

  // ── Уборка: участник прогона удаляется тем же экраном ────────────────────
  await row.getByRole('button', { name: 'Remove from team' }).click()
  await page.getByLabel('Type the member’s email to confirm').fill(member)
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(rowFor(page, member)).toHaveCount(0)
})

test('своя строка помечена и не предлагает самоудаления; удаление — только после набора почты', async ({
  page,
  watched,
}) => {
  const suffix = Math.random().toString(36).slice(2, 10)
  const member = `e2e-team-rm-${suffix}@example.com`
  // Через ops (мост жив — см. его шапку): приглашение через форму уже держит
  // первый сценарий, здесь участник — реквизит удаления.
  opsAgainstDevDb(`invite ${member} Removee`)

  await openTeam(page, watched)

  // Своя строка: «(you)» и НИ удаления, ни «задать пароль» — свой пароль
  // меняется через /admin/password (ссылка), самоудаление сервер отказывает
  // (юнит-тест removeTeamMember), а кнопки-тупика экран не предлагает.
  const own = rowFor(page, SEED_REVIEWER_EMAIL)
  await expect(own).toContainText('(you)')
  await expect(own.getByRole('button', { name: 'Remove from team' })).toHaveCount(0)
  await expect(own.getByRole('button', { name: /password/i })).toHaveCount(0)
  await expect(own.getByRole('link', { name: 'Change password' })).toBeVisible()
  await expect(own.getByRole('button', { name: 'Sign out my other devices' })).toBeVisible()

  // Чужая строка: удаление раскрывает предупреждение — история переживает,
  // доступ гаснет сразу — и не работает без точной почты.
  const row = rowFor(page, member)
  await row.getByRole('button', { name: 'Remove from team' }).click()
  await expect(page.getByText('stay in the history', { exact: false })).toBeVisible()

  const confirm = page.getByLabel('Type the member’s email to confirm')
  const remove = page.getByRole('button', { name: 'Remove', exact: true })
  await expect(remove).toBeDisabled()
  await confirm.fill(`${member}-wrong`)
  await expect(remove).toBeDisabled()

  // Регистр и края — опечатки ввода, не другая почта (правило сервера).
  await confirm.fill(` ${member.toUpperCase()} `)
  await remove.click()

  // Строка исчезла без перезагрузки — и это сервер, а не состояние клиента.
  await expect(rowFor(page, member)).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Team', exact: true })).toBeVisible()
  await expect(rowFor(page, member)).toHaveCount(0)
})
