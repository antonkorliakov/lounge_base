import { test as base, expect, type Locator, type Page } from '@playwright/test'
import { execSync } from 'node:child_process'
import { BLOCKS } from '../src/form-schema/blocks'
import { fieldByKey } from '../src/form-schema/fields'
import { SEED_REVIEWER_EMAIL, seedEmailFor } from '../scripts/dev-support'

/**
 * Сторона проверяющего и круг «отметили → вернули → поправили → отправили
 * снова». `e2e/fill.spec.ts` (план 1) держит сторону заполняющего, включая
 * экран правок по всем трём категориям отмеченных ответов — здесь это не
 * повторяется.
 *
 * ГЛАВНОЕ, ЧТО ЭТОТ ФАЙЛ ОБЯЗАН ЛОВИТЬ, — «страница вообще не открылась».
 * `/admin/s/[submissionId]` какое-то время отдавал 500 на ЛЮБОЙ анкете:
 * `renderValues` экспортировалась из модуля с `'use client'`, и серверный
 * компонент не мог её вызвать. Этого не увидел ни один из четырёх гейтов —
 * граница RSC это рантаймовая метка, а не тип (`tsc` молчит), `next build`
 * собирает динамический маршрут, не выполняя его, ни один юнит-тест не
 * рендерит асинхронный серверный компонент, читающий базу, а e2e плана 1 ни
 * разу не заходил на `/admin`. Экран проверки был построен, отревьюирован и
 * подтверждён без единого доказательства, что он открывается; нашлось руками,
 * случайно.
 *
 * Поэтому «страница отрисовалась» здесь — самостоятельное утверждение, а не
 * побочный эффект поиска заголовка: `watch` слушает `pageerror` и
 * `console.error` на КАЖДОЙ странице теста и роняет тест с текстом ошибки, а
 * не таймаутом на отсутствующем элементе (см. `expectRendered` и проверку в
 * конце фикстуры).
 */

/** Ошибки страницы, собранные по ходу теста, — см. фикстуру `watched`. */
type Watched = {
  errors: string[]
  /** Подключить наблюдение ко второй странице (например, стороне заполняющего). */
  watch: (page: Page, label: string) => void
}

function watch(errors: string[], page: Page, label: string): void {
  // `pageerror` — необработанное исключение в браузере; `console.error` — то,
  // чем сообщает о себе сбой рендера в React и оверлей `next dev`. Нужны оба:
  // сбой серверного компонента приходит не исключением на клиенте, а
  // отрисованной границей ошибки и сообщением в консоли.
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

      // Проверка в teardown, а не в теле теста: иначе её нужно помнить
      // дописывать в каждый сценарий, а забытая проверка выглядит как
      // пройденный тест. Сюда попадает и ошибка, случившаяся уже ПОСЛЕ
      // последнего утверждения.
      expect(errors, 'страница сообщила об ошибках в JS/консоли').toEqual([])
    },
    { auto: true },
  ],
})

type SeedMode = 'draft' | 'complete' | 'submitted' | 'changes-requested'

/**
 * Сеет лаунж с анкетой и возвращает ссылку заполнения — ЕДИНСТВЕННУЮ строку,
 * которую печатает `scripts/seed-dev.ts`. Формат вывода менять нельзя: его
 * целиком, как один URL, читает `e2e/fill.spec.ts` в девяти местах, поэтому id
 * анкеты никуда не печатается и до экрана проверки тест идёт тем же путём, что
 * настоящий проверяющий — через список `/admin` (см. `openSeededSubmission`).
 *
 * Имя лаунжа уникально на каждый вызов, и это не косметика: список `/admin`
 * показывает ВСЕ отправленные анкеты, а Playwright запускает файлы тестов
 * параллельно — `e2e/fill.spec.ts` в это же время отправляет свою анкету из
 * браузера. Выбор «самой свежей по `submittedAt`» открыл бы чужую анкету, и
 * тест падал бы (или, хуже, проходил) по причине, никак не связанной с тем,
 * что он проверяет.
 */
function seed(mode: SeedMode, label: string): { fillUrl: string; lounge: string } {
  const lounge = `Primeclass-${label}-${Math.random().toString(36).slice(2, 10)}`
  const flag = mode === 'draft' ? '' : ` --${mode}`
  const fillUrl = execSync(`npm run --silent seed --${flag} --lounge=${lounge}`, {
    encoding: 'utf8',
  }).trim()
  return { fillUrl, lounge }
}

/**
 * Ссылка входа для проверяющего. Письмо для этого не годится: консольный
 * почтальон по умолчанию НЕ печатает тело (в нём одноразовый пропуск), так что
 * ссылку тест получает тем же `requestLogin`, каким пользуется само действие
 * входа — см. `scripts/dev-login-link.ts`.
 */
function loginLinkFor(email: string): string {
  return execSync(`npx tsx scripts/dev-login-link.ts ${email}`, { encoding: 'utf8' }).trim()
}

/**
 * Гейт «страница отрисовалась вообще».
 *
 * Порядок внутри важен: сначала смотрим, не сообщила ли страница об ошибке, и
 * только потом ждём маркер. Ошибка проверяется на каждой итерации `toPass`,
 * поэтому упавший рендер даёт падение С ТЕКСТОМ ОШИБКИ, а не таймаут «не нашёл
 * заголовок» — разница между «понятно, что сломано» и «непонятно, почему тест
 * висит», ровно на том дефекте, из-за которого этот файл и существует.
 */
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

/** Открывает засеянную анкету так же, как проверяющий: из реестра лаунжей
 *  (`/admin`, план 3 — прежде здесь был список «Awaiting review»). Имя лаунжа
 *  в строке реестра — ссылка на последнюю анкету. Возвращает URL экрана
 *  проверки — по нему сценарии возвращаются на анкету после того, как она
 *  вышла из статуса `submitted`. */
async function openSeededSubmission(
  page: Page,
  watched: Watched,
  lounge: string,
): Promise<string> {
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Lounges' })).toBeVisible()

  await page.getByRole('link', { name: lounge }).click()

  await expectRendered(watched, page.locator('.review-screen'))
  // Экран проверки всегда открывается на первом блоке.
  await expect(page.getByRole('heading', { name: BLOCKS[0]!.label.en })).toBeVisible()

  // Экран называет анкету — тем же именем, по которому в него только что
  // перешли из списка. Раньше не называл ничем: по закладке или из второй
  // вкладки нельзя было понять, чью анкету открыли, а название лаунжа — один
  // из 129 проверяемых ответов, который сам может быть спорным.
  await expect(page.getByRole('heading', { name: lounge, level: 1 })).toBeVisible()
  // И называет состояние. Анкета только что засеяна в `submitted`.
  await expect(page.locator('.review-state b')).toHaveText('Under review')

  return page.url()
}

/**
 * Строка экрана проверки по её подписи.
 *
 * `exact` обязателен: подписи пересекаются как подстроки («Entrance» входит в
 * «Entrance Photo»-подобные, «Photos» — в «Additional Photos»), и неточное
 * совпадение выбрало бы несколько строк сразу.
 *
 * Поэтому же подпись поля берётся из схемы (`FULL_NAME`), а не пишется здесь
 * руками: экран рисует `field.label[locale]` целиком, вместе со звёздочкой
 * обязательности («Lounge Full Name*»), и написанная от руки подпись без
 * звёздочки не находит строку вовсе.
 */
function row(page: Page, label: string): Locator {
  return page.locator('.frow').filter({ has: page.getByText(label, { exact: true }) })
}

/** I.2 — плоское текстовое поле, которое отмечают все сценарии ниже. Подпись из
 *  схемы: экран проверки показывает именно её (см. `renderValues`). */
const FULL_NAME = fieldByKey('I.2')!.label.en

/** Отмечает строку замечанием ровно так, как это делает проверяющий: наведение
 *  → «отметить» → причина → комментарий → «Отметить». */
async function flag(target: Locator, reason: string, comment: string): Promise<void> {
  await target.hover()
  // Класс, а не роль с именем: у кнопки проявления («flag») и у кнопки
  // отправки замечания («Flag») имена различаются только регистром, а
  // `getByRole` сопоставляет имена без учёта регистра — по имени они
  // неразличимы.
  await target.locator('.frow-act').click()
  await target.getByRole('button', { name: reason }).click()
  await target.getByPlaceholder('What is wrong?').fill(comment)
  await target.locator('.bt-flag').click()

  await expect(target).toHaveClass(/frow-flagged/)
  await expect(target.locator('.frow-comment')).toContainText(comment)
}

/**
 * Нажимает кнопку решения и ждёт ответа серверного действия.
 *
 * Нужно там, где у успеха НЕТ видимого следа: `requestChangesAction` и
 * успешный `approveAction` возвращают `{ ok: true }` без `notice`, экран
 * перерисовывается тем же самым. Без ожидания ответа следующий шаг
 * (открыть ссылку заполнения, перечитать список) мог бы обогнать транзакцию, и
 * тест падал бы через раз — по расписанию, а не по существу.
 *
 * Серверное действие уходит POST-ом на адрес самой страницы, поэтому ждём
 * именно его и заодно проверяем, что ответ успешен: отказ действия — это
 * `{ ok: false }` внутри 200-го ответа, а 500 здесь означал бы сломанное
 * действие, и молча ждать «любого ответа» было бы неправдой.
 */
async function clickAndAwaitAction(page: Page, button: Locator): Promise<void> {
  const url = page.url()
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().startsWith(url) && res.request().method() === 'POST'),
    button.click(),
  ])
  expect(response.ok(), `серверное действие ответило ${response.status()}`).toBe(true)
}

const APPROVE = 'Approve'
const CONFIRM_BLOCK = 'Confirm block'
/**
 * Кнопка обратного хода. Стоит НА МЕСТЕ «Confirm block» на подтверждённом
 * блоке — одна кнопка на два направления, — поэтому по этому имени искать
 * можно, а по `CONFIRM_BLOCK` на подтверждённом блоке нельзя: там её нет.
 *
 * Подпись не «Unconfirm block» именно из-за этого теста: `name` в `getByRole`
 * сопоставляется по подстроке и без учёта регистра, так что «Unconfirm block»
 * находился бы и по запросу `CONFIRM_BLOCK` — тот же капкан, что у
 * `flag`/`Flag` (см. `flag()` выше).
 */
const RETRACT = 'Retract confirmation'

test('замечание, возврат на правку, исправление и повторная отправка — полный круг', async ({
  page,
  context,
  watched,
}) => {
  const { fillUrl, lounge } = seed('submitted', 'cycle')

  await page.goto(loginLinkFor(SEED_REVIEWER_EMAIL))
  const reviewUrl = await openSeededSubmission(page, watched, lounge)

  // ── Отметить одно поле ────────────────────────────────────────────────────
  const fullName = row(page, FULL_NAME)
  await flag(fullName, 'needs detail', 'Укажите полное юридическое название')

  // Блок с открытым замечанием подтвердить нельзя — кнопка выключена.
  await expect(page.getByRole('button', { name: CONFIRM_BLOCK })).toBeDisabled()

  // ── «Переслать ссылку» на анкете, которая ещё на проверке, — недоступно ───
  // Анкета в `submitted` закрыта заполняющему (`EDITABLE_STATUSES`), поэтому
  // пересылать нечего: ссылка открыла бы экран «форма закрыта», а письмо о
  // возврате на правку объявило бы возврат, которого не было. Проверяющий
  // узнаёт это ДО нажатия — кнопка выключена и несёт причину, — а не после.
  //
  // Проверяется здесь только эта, клиентская половина гейта: что серверное
  // действие отказывает само (и при отказе не шлёт письма и не выписывает
  // токен), проверяет
  // `src/app/admin/s/[submissionId]/__tests__/resend-fill-link.test.ts` — из
  // браузера письмо не видно вовсе (консольный почтальон не печатает тело, а
  // stdout сервера тесту недоступен, см. сценарий входа ниже).
  const resend = page.getByRole('button', { name: 'Resend link' })
  await expect(resend).toBeDisabled()
  await expect(resend).toHaveAttribute('title', /under review/)

  // ── Вернуть на правку ─────────────────────────────────────────────────────
  await clickAndAwaitAction(page, page.getByRole('button', { name: /Request changes/ }))

  // ── Экран сразу говорит, что анкеты на проверке больше нет ────────────────
  // До этого `revalidatePath` перерисовывал экран, который выглядел ТОЧНО так
  // же: те же четыре решения, ни слова о смене состояния, — и следующее
  // нажатие «Подтвердить блок» отказывало «анкета сейчас не на проверке», что
  // читается как поломка в конце уже сделанной работы. Проверяется без
  // перезагрузки: состояние приходит тем же ответом действия.
  await expect(page.locator('.review-state b')).toHaveText('Returned to the operator')
  await expect(page.locator('.review-state')).toContainText('The operator is correcting it')
  for (const name of [CONFIRM_BLOCK, APPROVE, 'Request changes']) {
    const button = page.getByRole('button', { name })
    await expect(button, name).toBeDisabled()
    await expect(button, name).toHaveAttribute('title', /operator is correcting it/)
  }
  // А отмечать ответы по-прежнему можно: замечание, поставленное сейчас,
  // появится у оператора на экране правок (см. `flagging` в `gates.ts`).
  await expect(page.locator('.frow-act').first()).toBeAttached()

  // ── А теперь «Переслать ссылку» показывает подтверждение с адресом ────────
  // Кнопка включается без перезагрузки: `requestChangesAction` вызывает
  // `revalidatePath` на этот же адрес, так что ответ действия несёт заново
  // отрисованную страницу — вместе с новым `resend` из `resendGateFor`.
  await expect(resend).toBeEnabled()
  // Единственное свидетельство успеха у этого действия: нового замечания не
  // появляется, цвет блока не меняется, и до появления `notice` «письмо ушло»
  // и «ничего не произошло» выглядели для проверяющего одинаково. Адрес —
  // тот, что лежит в анкете (`II.1.3`, его читает `contactEmail`), а не
  // придуманный тестом.
  await resend.click()
  await expect(page.locator('.review-notice')).toHaveText(
    `Link sent to ${seedEmailFor('II.1.3')}.`,
  )
  await expect(page.locator('.review-error')).toHaveCount(0)

  // ── Заполняющий видит только отмеченное ──────────────────────────────────
  const filler = await context.newPage()
  watched.watch(filler, 'filler')
  await filler.goto(fillUrl)

  await expect(filler.getByRole('heading', { name: 'Changes requested' })).toBeVisible()
  await expect(filler.locator('.fix-card')).toHaveCount(1)
  await expect(filler.getByText('Укажите полное юридическое название')).toBeVisible()

  await filler.getByLabel(/Lounge Full Name/).fill('Primeclass Lounge Istanbul Ltd')
  await expect(filler.getByText('Saved')).toBeVisible()
  await filler.getByRole('button', { name: 'Submit for review', exact: true }).click()
  await expect(filler.getByText('Sent for review. We will get back to you.')).toBeVisible()

  // ── Круг замкнулся: проверяющий видит исправленный ответ без замечания ────
  // Перечитываем с сервера, а не смотрим на состояние старой страницы: только
  // так видно, что `clearFlagAfterSave` снял замечание, а не что клиент
  // нарисовал «Изменено».
  await page.goto(reviewUrl)
  await expectRendered(watched, page.locator('.review-screen'))
  await expect(page.locator('.frow-flagged')).toHaveCount(0)
  await expect(row(page, FULL_NAME)).toContainText('Primeclass Lounge Istanbul Ltd')
  await expect(page.getByRole('button', { name: CONFIRM_BLOCK })).toBeEnabled()

  // И строка реестра снова называет анкету «Under review» — то есть статус
  // действительно вернулся в `submitted`, а не остался `changes_requested`.
  // Прежний список «Awaiting review» показывал ТОЛЬКО `submitted`, и
  // доказательством было само присутствие в нём; реестр показывает все лаунжи
  // всегда, так что присутствие строки больше ничего не доказывает —
  // доказательство теперь подпись статуса анкеты (та же формулировка, что у
  // пилюли состояния экрана проверки: один источник, `reviewStateFor`).
  await page.goto('/admin')
  await expect(page.getByRole('row').filter({ hasText: lounge })).toContainText('Under review')
})

test('принять анкету можно только когда снято последнее замечание и подтверждены все блоки', async ({
  page,
  watched,
}) => {
  const { lounge } = seed('submitted', 'approve')

  await page.goto(loginLinkFor(SEED_REVIEWER_EMAIL))
  await openSeededSubmission(page, watched, lounge)

  const approve = page.getByRole('button', { name: APPROVE })
  const confirm = page.getByRole('button', { name: CONFIRM_BLOCK })
  const navItems = page.locator('.nav-item')

  // Условия перепроверяются в момент решения, поэтому проверяем их через
  // настоящий отказ действия, а не через выключенную кнопку: по НИМ «Принять»
  // не выключается — отказ называет, сколько блоков осталось и сколько
  // замечаний открыто, чего выключенная кнопка сказать не может. Выключается
  // она только по статусу анкеты, где шага не бывает вовсе (проверяется ниже,
  // на принятой анкете).
  await expect(navItems).toHaveCount(BLOCKS.length)

  await approve.click()
  await expect(page.locator('.review-error')).toHaveText(
    `${BLOCKS.length} block(s) not confirmed`,
  )

  await confirm.click()
  await expect(navItems.first()).toHaveClass(/nav-confirmed/)
  await approve.click()
  await expect(page.locator('.review-error')).toHaveText(
    `${BLOCKS.length - 1} block(s) not confirmed`,
  )

  // ── Подтверждение можно отозвать ──────────────────────────────────────────
  // Обратного хода не было НИГДЕ в продукте: `unconfirmBlock` существовал без
  // единого вызывающего, а «Подтвердить блок» не выключалась и после нажатия —
  // один промах мыши шёл в счёт 27/27 навсегда, и обойти это можно было только
  // отметив в блоке любое поле, чтобы принятие отказало по замечаниям.
  //
  // На подтверждённом блоке «Confirm block» не просто выключена — её нет:
  // кнопка одна и отражает состояние блока. Поэтому сначала проверяется
  // именно это, иначе тест не отличил бы «есть обратный ход» от «появилась
  // вторая кнопка рядом».
  const retract = page.getByRole('button', { name: RETRACT })
  await expect(confirm).toHaveCount(0)
  await expect(retract).toBeEnabled()

  await retract.click()
  await expect(navItems.first()).not.toHaveClass(/nav-confirmed/)
  await expect(retract).toHaveCount(0)
  // И это не косметика: принятие снова считает блок неподтверждённым.
  await approve.click()
  await expect(page.locator('.review-error')).toHaveText(
    `${BLOCKS.length} block(s) not confirmed`,
  )
  await confirm.click()
  await expect(navItems.first()).toHaveClass(/nav-confirmed/)

  // Замечание в уже подтверждённом блоке: подтверждение не отзывается (это
  // осознанно, см. `blockProgress`), но принять анкету нельзя — открытые
  // замечания проверяются до подтверждений.
  const fullName = row(page, FULL_NAME)
  await flag(fullName, 'wrong format', 'Не сходится с юридическим названием')
  await expect(navItems.first()).toHaveClass(/nav-flagged/)

  await approve.click()
  await expect(page.locator('.review-error')).toHaveText('1 flag(s) still open')

  await fullName.locator('.frow-undo').click()
  await expect(page.locator('.frow-flagged')).toHaveCount(0)
  await expect(navItems.first()).toHaveClass(/nav-confirmed/)

  // Подтвердить все 27 блоков — по-настоящему, через навигацию и кнопку, а не
  // записью в базу: только так видно, что подтверждаемы ВСЕ блоки, включая
  // блок фото и оба прохода услуг. Без этого «принять нельзя» проходило бы
  // вакуумно: тест не отличил бы «условие работает» от «принять нельзя
  // никогда».
  for (let index = 0; index < BLOCKS.length; index += 1) {
    const item = navItems.nth(index)
    await item.click()
    // Первый блок к этому моменту уже подтверждён, и на подтверждённом блоке
    // кнопки «Confirm block» нет — на её месте «Retract confirmation». Ждём,
    // пока подвал покажет одну из двух (клик по блоку меняет состояние
    // клиента, а не грузит страницу, но ждать всё равно нужно чего-то
    // определённого, а не «успело перерисоваться»), и подтверждаем только то,
    // что не подтверждено.
    await expect(confirm.or(retract)).toBeVisible()
    if (await confirm.isVisible()) await confirm.click()
    await expect(item).toHaveClass(/nav-confirmed/)
  }

  await clickAndAwaitAction(page, approve)
  await expect(page.locator('.review-error')).toHaveCount(0)

  // ── Принятая анкета говорит об этом сама ──────────────────────────────────
  // Ровно то состояние, в котором экран был опаснее всего: он выглядел так же,
  // как открытый на проверку, и предлагал все решения. Проверяющий B принимал
  // анкету, пока у A открыта вкладка (или A приходил по закладке), A отмечал
  // ответы — каждый вызов отвечал `{ok: true}`, потому что `raiseFlag` слеп к
  // статусу, — замечания ложились на решённую анкету, отправить их было уже
  // нечем, и только потом «Подтвердить»/«Принять» отказывали.
  await expect(page.locator('.review-state b')).toHaveText('Approved')
  await expect(page.locator('.review-state')).toContainText('The decision is final')
  for (const name of [APPROVE, RETRACT, 'Request changes', 'Resend link']) {
    const button = page.getByRole('button', { name })
    await expect(button, name).toBeDisabled()
  }
  await expect(page.getByRole('button', { name: APPROVE })).toHaveAttribute(
    'title',
    /decision is final/,
  )
  // И отмечать больше нечего: на принятой анкете замечание сохранилось бы
  // (`raiseFlag` статус не проверяет — осознанно), но передать его оператору
  // нечем, поэтому кнопки «отметить» нет ни на одной строке блока.
  await expect(page.locator('.frow-act')).toHaveCount(0)

  // Строка реестра называет анкету принятой — видимый след успеха за
  // пределами самого экрана проверки: `approveAction` при удачном письме не
  // возвращает уведомления. Прежде здесь проверялось исчезновение из списка
  // «Awaiting review»; из реестра лаунж не исчезает никогда (Global
  // Constraints плана 3) — принятая анкета видна сменившейся подписью.
  await page.goto('/admin')
  await expect(page.getByRole('row').filter({ hasText: lounge })).toContainText('Approved')
})

test('блок «Фото»: галерея открывается, слот можно отметить, опустевший слот честно пуст', async ({
  page,
  context,
  watched,
}) => {
  const { fillUrl, lounge } = seed('submitted', 'photos')

  await page.goto(loginLinkFor(SEED_REVIEWER_EMAIL))
  const reviewUrl = await openSeededSubmission(page, watched, lounge)

  // Блок по умолчанию — первый (`I`), поэтому без этого клика ветка
  // `block.kind === 'photos'` не отрисовывается ни разу: ни проп `photos`, ни
  // обход `PHOTO_SLOTS`, ни фото-ветка `FieldRow`.
  await page.getByRole('button', { name: 'Photos', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Photos', exact: true })).toBeVisible()

  const entrance = row(page, 'Entrance')
  const reception = row(page, 'Reception Desk')
  const additional = row(page, 'Additional Photos')

  // Сид кладёт по снимку в три именованных слота и два — в накопительный.
  await expect(entrance.locator('.frow-photo img')).toHaveCount(1)
  await expect(reception.locator('.frow-photo img')).toHaveCount(1)
  await expect(additional.locator('.frow-photo img')).toHaveCount(2)

  // Плитка обёрнута ссылкой на сохранённый URL — открыть оригинал это то, ради
  // чего проверяющий вообще заходит в этот блок. Адрес — тот, что сид написал
  // в `photos.url` (`seedPhotoUrl`: файл в `public/seed/`, ссылка от корня).
  await expect(entrance.locator('a.frow-photo')).toHaveAttribute('href', '/seed/entrance.svg')

  // И миниатюры действительно ЗАГРУЗИЛИСЬ. Без этого проверка «в разметке есть
  // <img>» не отличает работающую галерею от галереи битых ссылок — а именно в
  // этом состоянии экран и жил, пока сид сеял `https://example.com/...`:
  // каждая плитка была «Фото не открывается». `naturalWidth === 0` — то же
  // самое, о чём сообщает `onError`, только не полагаясь на то, что событие
  // успело сработать до утверждения.
  await expect
    .poll(
      async () =>
        page.locator('.frow-photo img').evaluateAll((images) =>
          images
            .filter((image) => (image as HTMLImageElement).naturalWidth === 0)
            .map((image) => (image as HTMLImageElement).src),
        ),
      { message: 'миниатюры, которые не загрузились' },
    )
    .toEqual([])
  await expect(page.locator('.frow-photo-dead')).toHaveCount(0)

  // ── Отдельный слот можно отметить замечанием ─────────────────────────────
  // Дизайн это прямо разрешает, и покрытия у этого не было никакого.
  await flag(reception, 'wrong format', 'Стойку не видно — снимите ближе')
  // Отмеченная строка не теряет свой снимок: замечание к фото читается только
  // рядом с фото.
  await expect(reception.locator('.frow-photo img')).toHaveCount(1)

  // Накопительный слот отмечаем тоже — иначе заполняющему нечем ответить на
  // замечание, а именно его ответ (удалить негодный снимок) и опустошает слот.
  await flag(additional, 'wrong format', 'Оба дополнительных снимка непригодны')

  await clickAndAwaitAction(page, page.getByRole('button', { name: /Request changes/ }))

  // ── Заполняющий убирает оба дополнительных снимка ────────────────────────
  // Удаление, в отличие от загрузки, не требует `BLOB_READ_WRITE_TOKEN`
  // (удаление самого блоба — best-effort), поэтому это единственный путь,
  // которым слот может опустеть в тесте. Обе кнопки нажимаются без
  // перезагрузки: первое удаление снимает замечание по слоту, и после
  // перезагрузки карточки уже не будет.
  const filler = await context.newPage()
  watched.watch(filler, 'filler')
  await filler.goto(fillUrl)

  const extraCard = filler.locator('.fix-card').filter({
    has: filler.getByRole('heading', { name: 'Additional Photos' }),
  })
  await expect(extraCard.locator('.photo-remove')).toHaveCount(2)
  await extraCard.locator('.photo-remove').first().click()
  await expect(extraCard.locator('img')).toHaveCount(1)
  await extraCard.locator('.photo-remove').first().click()
  await expect(extraCard.locator('img')).toHaveCount(0)

  // ── Пустой слот на экране проверки ───────────────────────────────────────
  await page.goto(reviewUrl)
  await expectRendered(watched, page.locator('.review-screen'))
  await page.getByRole('button', { name: 'Photos', exact: true }).click()

  const emptyAdditional = row(page, 'Additional Photos')
  await expect(emptyAdditional.locator('.frow-photos')).toHaveCount(0)
  // Прочерк, а не «No photo»: слот необязательный, и «нет фото» на нём
  // читалось бы как претензия к оператору, который всё сделал правильно.
  // «No photo» показывается только на пустом ОБЯЗАТЕЛЬНОМ слоте, и на пути
  // проверяющего это состояние недостижимо: `missingItems` не пропускает
  // анкету с пустым обязательным слотом в `submitted`, а удалять снимок из
  // именованного слота интерфейс не даёт вовсе.
  await expect(emptyAdditional.locator('.field-hint')).toHaveText('—')

  // Замечание по именованному слоту переход не потерял — оно всё ещё открыто,
  // потому что заменить снимок в нём заполняющий не мог (загрузка требует
  // блоб-токена, которого здесь нет).
  await expect(row(page, 'Reception Desk')).toHaveClass(/frow-flagged/)
})

test('вход в кабинет: ответ формы не выдаёт состав команды, ссылка одноразовая', async ({
  page,
  context,
  watched,
}) => {
  // Сид нужен ради самого проверяющего (`ensureReviewer`) — без него ссылку
  // входа выдавать некому. Анкету он заводит черновиком: этот сценарий про
  // вход, а не про проверку.
  seed('draft', 'login')

  // Кабинет закрыт без сессии.
  await page.goto('/admin')
  await expectRendered(watched, page.getByRole('heading', { name: 'Lounge Onboarding' }))
  expect(new URL(page.url()).pathname).toBe('/admin/login')

  // Неизвестный адрес и адрес из команды дают ОДИН И ТОТ ЖЕ ответ: иначе форма
  // входа превращается в способ перечислить состав команды. Ответ сравнивается
  // как текст экрана — то единственное, что видит проверяющий.
  const sent = 'Check your inbox for the sign-in link.'

  await page.getByLabel('Work email').fill('definitely-not-on-the-team@example.com')
  await page.getByRole('button', { name: 'Send sign-in link' }).click()
  await expect(page.getByText(sent)).toBeVisible()

  await page.goto('/admin/login')
  await page.getByLabel('Work email').fill(SEED_REVIEWER_EMAIL)
  await page.getByRole('button', { name: 'Send sign-in link' }).click()
  await expect(page.getByText(sent)).toBeVisible()

  // Ссылка, выданная тем же `requestLogin`, что и в действии выше, открывает
  // кабинет. До сих пор у `requestLoginAction` не было ни одного теста вовсе.
  //
  // Чего этот сценарий НЕ доказывает, и это стоит знать следующему: что письмо
  // действительно уходит. `after()` (письмо отправляется после ответа, но
  // обязано отправиться) по-прежнему держится на ручном наблюдении — тело
  // письма консольный почтальон по умолчанию не печатает, а stdout сервера,
  // поднятого Playwright, тесту недоступен. Проверено здесь всё остальное:
  // форма отвечает одинаково на любой адрес, а выданный токен действительно
  // открывает кабинет и действительно одноразовый.
  const loginUrl = loginLinkFor(SEED_REVIEWER_EMAIL)
  await page.goto(loginUrl)
  await expectRendered(watched, page.getByRole('heading', { name: 'Lounges' }))
  expect(new URL(page.url()).pathname).toBe('/admin')

  // И она одноразовая: `consumeLoginToken` помечает токен использованным одним
  // атомарным UPDATE, так что второй переход по той же ссылке — уже не вход.
  await context.clearCookies()
  await page.goto(loginUrl)
  await expect(page.getByRole('heading', { name: 'Lounge Onboarding' })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/admin/login')
})
