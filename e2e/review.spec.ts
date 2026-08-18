import { test as base, expect, type Locator, type Page } from '@playwright/test'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { BLOCKS } from '../src/form-schema/blocks'
import { fieldByKey } from '../src/form-schema/fields'
import { SEED_REVIEWER_EMAIL, loadEnvFile } from '../scripts/dev-support'

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
 * Запускает `ops.ts` — тем же путём, что и настоящая эксплуатация, — но
 * ГАРАНТИРОВАННО против dev-базы. `DATABASE_URL` передаётся явно, из
 * `.env.local`, и это не перестраховка: `ops.ts` — прод-инструмент, он
 * первым читает `.env.production.local`, и на машине разработчика с этим
 * файлом тест без явного URL тихо писал бы В БОЕВУЮ базу. Явная переменная
 * окружения побеждает оба файла (см. `loadEnvFile`), поэтому команда идёт в
 * ту же dev-базу, что и сид. `loadEnvFile` заполняет только отсутствующее —
 * экспортированный снаружи `DATABASE_URL` по-прежнему главнее, тем же
 * правилом, что и везде.
 *
 * `stdinLine` — для `set-password`: пароль приходит первой строкой stdin, а
 * не argv (в argv он остался бы в истории шелла и в `ps` — см. `ops.ts`).
 */
function opsAgainstDevDb(args: string, stdinLine?: string): void {
  loadEnvFile(resolve(process.cwd(), '.env.local'))
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL не задан (нет .env.local?)')
  execSync(`npx tsx scripts/ops.ts ${args}`, {
    input: stdinLine === undefined ? undefined : `${stdinLine}\n`,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url },
  })
}

/** Пароль участнику — через настоящий ops-путь (`set-password`, stdin). */
function setPasswordFor(email: string, password: string): void {
  opsAgainstDevDb(`set-password ${email}`, password)
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
/**
 * Кнопка-иконка копирования ссылки заполнения — у названия лаунжа в шапке.
 * Текста у неё нет (глиф-цепочка), имя ей даёт `aria-label`, и `getByRole`
 * находит её именно по нему.
 */
const COPY_FILL_LINK = 'Copy fill link'

test('замечание, возврат на правку, исправление и повторная отправка — полный круг', async ({
  page,
  context,
  watched,
}) => {
  const { fillUrl, lounge } = seed('submitted', 'cycle')

  await page.goto(loginLinkFor(SEED_REVIEWER_EMAIL))
  const reviewUrl = await openSeededSubmission(page, watched, lounge)

  // ── Выгрузка ЭТОЙ анкеты — из шапки экрана, файл назван лаунжем ──────────
  // Второй формат выгрузки спецификации (`singleSubmissionWorkbook`) был
  // собран и заперт без единой ссылки (дефект I1 ревью). Ссылка доступна в
  // любом состоянии анкеты — здесь она скачивает анкету прямо на проверке, и
  // имя файла — название лаунжа с IATA, не uuid (человеку, сохранившему пять
  // подряд, uuid не говорит ничего).
  const [single] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download xlsx' }).click(),
  ])
  expect(single.suggestedFilename()).toBe(`${lounge} (IST).xlsx`)

  // ── Кнопки разложены по области действия ──────────────────────────────────
  // Решения по ВСЕЙ анкете («Вернуть на правку», «Принять») — в шапке; в
  // подвале — только решение по открытому блоку. Раньше все они стояли одним
  // рядом в подвале, и «Принять анкету» выглядела кнопкой блока,
  // повторяющейся на каждой из 27 страниц (найдено пользователем).
  // Утверждается состав ОБОИХ мест, а не только наличие кнопок где-то на
  // странице: иначе тест не отличил бы переезд от второго ряда тех же кнопок.
  //
  // «Переслать ссылку» в ряду решений НЕТ, и счётчик это закрепляет: почтовая
  // пересылка убрана из интерфейса, её работу делает кнопка копирования у
  // самого названия лаунжа (жест Jira: цепочка у ключа задачи) — она не
  // решение по анкете, поэтому живёт в заголовке, а не в ряду решений.
  const head = page.locator('.review-head')
  const foot = page.locator('.review-foot')
  for (const name of [/Request changes/, APPROVE]) {
    await expect(head.getByRole('button', { name })).toBeVisible()
  }
  await expect(head.locator('.review-actions').getByRole('button')).toHaveCount(2)
  const copyLink = head.locator('h1').getByRole('button', { name: COPY_FILL_LINK })
  await expect(copyLink).toBeVisible()
  await expect(foot.getByRole('button')).toHaveCount(1)
  await expect(foot.getByRole('button', { name: CONFIRM_BLOCK })).toBeVisible()

  // ── Одной причины достаточно: чип без текста — полное замечание ──────────
  // Пока не выбрано и не написано ничего, «Flag» выключена и под кнопками
  // видна подсказка (раньше кнопка молча требовала комментарий, и клик по
  // чипу «ничего не делал»); клик по чипу включает кнопку без единого
  // символа текста, а отмеченная строка показывает код причины.
  const fullName = row(page, FULL_NAME)
  await fullName.hover()
  await fullName.locator('.frow-act').click()
  const flagButton = fullName.locator('.bt-flag')
  await expect(flagButton).toBeDisabled()
  await expect(fullName.getByText('Pick a reason or write what is wrong')).toBeVisible()
  await fullName.getByRole('button', { name: 'not filled in' }).click()
  await expect(flagButton).toBeEnabled()
  await flagButton.click()
  await expect(fullName).toHaveClass(/frow-flagged/)
  await expect(fullName.locator('.frow-comment b')).toHaveText('not filled in')
  // Дальше цикл идёт с настоящим замечанием с текстом — чип-замечание
  // снимается, и на его месте ставится то, которое поедет оператору.
  await fullName.locator('.frow-undo').click()
  await expect(fullName).not.toHaveClass(/frow-flagged/)

  // ── Отметить одно поле ────────────────────────────────────────────────────
  await flag(fullName, 'needs detail', 'Укажите полное юридическое название')

  // Блок с открытым замечанием подтвердить нельзя — кнопка выключена.
  await expect(page.getByRole('button', { name: CONFIRM_BLOCK })).toBeDisabled()

  // ── Копирование ссылки на анкете, которая ещё на проверке, — недоступно ───
  // Анкета в `submitted` закрыта заполняющему (`EDITABLE_STATUSES`), поэтому
  // копировать нечего: ссылка открыла бы экран «форма закрыта». Проверяющий
  // узнаёт это ДО нажатия — кнопка выключена и несёт причину, — а не после.
  //
  // Проверяется здесь только эта, клиентская половина гейта: что серверное
  // действие отказывает само (и при отказе не выписывает токен), проверяет
  // `src/app/admin/s/[submissionId]/__tests__/fill-link.test.ts`.
  await expect(copyLink).toBeDisabled()
  await expect(copyLink).toHaveAttribute('title', /under review/)

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

  // ── Возврат состоялся, а письма не было — ссылка вручается ревьюеру ───────
  // `next dev` под e2e работает без SMTP_URL — та же среда, что сегодняшний
  // бой: `mailDelivers()` false, письмо отправить некуда. Раньше эта ветка
  // печатала письмо в stdout сервера и показывала чистый успех — ревьюер
  // считал оператора уведомлённым, а единственный экземпляр ссылки (хранится
  // только хэш) уходил в лог, который никто не читает. Теперь notice говорит
  // правду, и ссылка стоит под ним. Ветку С настоящим SMTP (письмо уходит,
  // ссылки на экране НЕТ — лишняя экспозиция) браузером отсюда не проверить;
  // она закреплена юнит-тестами (`fill-link.test.ts`).
  // И notice, и ссылка стоят В ШАПКЕ, под кнопками, которые их вызвали:
  // нажать «Вернуть на правку» можно только когда шапка на экране, значит
  // отклик в этом месте виден сразу после нажатия, без прокрутки. Локатор
  // сужен до .review-head сознательно — он утверждает не только «отклик
  // есть», но и «отклик там, где ревьюер сейчас смотрит».
  await expect(head.locator('.review-notice')).toContainText('the operator was NOT emailed')
  const returnedReveal = head.locator('.al-url')
  await expect(returnedReveal).toBeVisible()
  const returnedUrl = await returnedReveal.inputValue()
  expect(returnedUrl).toMatch(/\/f\/[A-Za-z0-9_-]+/)
  // Показ — общий `FillLinkReveal` (тот же, что у панели «Добавить лаунж», см.
  // registry.spec.ts): видимый URL, копирование и предупреждение об
  // одноразовости, вторая половина которого честно называет кнопку
  // копирования источником свежей ссылки.
  await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toBeVisible()
  await expect(page.getByText('the link is not shown again', { exact: false })).toBeVisible()

  // ── Кнопка копирования кладёт СВЕЖУЮ ссылку в буфер одним нажатием ────────
  // Прежняя «Переслать ссылку» без SMTP была ритуалом из двух шагов (нажать →
  // прочитать «письма не было» → скопировать из показа); её работу делает
  // кнопка-иконка у названия лаунжа. Включается без перезагрузки:
  // `requestChangesAction` вызывает `revalidatePath` на этот же адрес, так что
  // ответ действия несёт заново отрисованную страницу — вместе с новым
  // `copyLink` из `copyLinkGateFor`.
  //
  // Буфер настоящий: Chromium (единственный браузер этого прогона) выдаёт
  // clipboard-read/clipboard-write через grantPermissions, и тест читает то,
  // что действительно легло в буфер, а не перехватывает вызов. Ветка отказа
  // буфера (показ ссылки тем же `FillLinkReveal` с notice «скопируйте сами»)
  // из headless-прогона надёжно не воспроизводится: после гранта запись не
  // падает, а подсовывать сломанный `navigator.clipboard` значило бы
  // проверять собственную подмену, — она остаётся на ручной проверке.
  await expect(copyLink).toBeEnabled()
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await copyLink.click()
  // «Скопировано» — у самой кнопки, а не notice под рядом решений; прежний
  // отклик (ссылка возврата на правку) снят: отклик на экране один —
  // последнего действия, и держать ссылку, которой нет в буфере, рядом со
  // свежим «Скопировано» значило бы предлагать скопировать не то.
  await expect(head.locator('.review-copied')).toBeVisible()
  await expect(head.locator('.al-url')).toHaveCount(0)
  await expect(page.locator('.review-error')).toHaveCount(0)
  const copiedUrl = await page.evaluate(() => navigator.clipboard.readText())
  expect(copiedUrl).toMatch(/\/f\/[A-Za-z0-9_-]+/)
  // Свежая ссылка, не прежняя и не сеяная: сырой токен не хранится, каждый
  // вызов выписывает следующий (прежние живут свой TTL — не отзываются).
  expect(copiedUrl).not.toBe(fillUrl)
  expect(copiedUrl).not.toBe(returnedUrl)

  // ── Заполняющий видит только отмеченное — по ссылке ИЗ БУФЕРА ─────────────
  // Заполняющий идёт по ссылке, которую ревьюер только что скопировал и
  // «вручил» ему, — весь новый путь доказан от кнопки до экрана правок, а не
  // до строки в базе.
  const filler = await context.newPage()
  watched.watch(filler, 'filler')
  await filler.goto(copiedUrl)

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
  // Отказ принятия — отклик уровня АНКЕТЫ, поэтому стоит в шапке, под самой
  // кнопкой «Approve» (см. `FeedbackScope` в `ReviewScreen`). Дальше по тесту
  // локатор не сужается: отклик на экране один — последнего действия.
  await expect(page.locator('.review-head .review-error')).toHaveText(
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
  // Принятие состоялось, но у `approvedMail` в среде без SMTP адресата нет —
  // notice говорит это, вместо прежнего чистого успеха (письмо в stdout).
  // Ссылки при принятии не показывается никакой: форма закрыта оператору,
  // вручать нечего.
  await expect(page.locator('.review-notice')).toContainText('the operator was not notified')
  await expect(page.locator('.al-url')).toHaveCount(0)

  // ── Принятая анкета говорит об этом сама ──────────────────────────────────
  // Ровно то состояние, в котором экран был опаснее всего: он выглядел так же,
  // как открытый на проверку, и предлагал все решения. Проверяющий B принимал
  // анкету, пока у A открыта вкладка (или A приходил по закладке), A отмечал
  // ответы — каждый вызов отвечал `{ok: true}`, потому что `raiseFlag` слеп к
  // статусу, — замечания ложились на решённую анкету, отправить их было уже
  // нечем, и только потом «Подтвердить»/«Принять» отказывали.
  await expect(page.locator('.review-state b')).toHaveText('Approved')
  await expect(page.locator('.review-state')).toContainText('The decision is final')
  for (const name of [APPROVE, RETRACT, 'Request changes']) {
    const button = page.getByRole('button', { name })
    await expect(button, name).toBeDisabled()
  }
  await expect(page.getByRole('button', { name: APPROVE })).toHaveAttribute(
    'title',
    /decision is final/,
  )
  // Кнопка копирования гаснет по СВОЕМУ гейту, не по статусному решений:
  // причина — «форма закрыта оператору», без совета вернуть на правку
  // (из `approved` возврата не существует — тупик, см. `copyLinkGateFor`).
  const copyLink = page.getByRole('button', { name: COPY_FILL_LINK })
  await expect(copyLink).toBeDisabled()
  await expect(copyLink).toHaveAttribute('title', /approved and closed/)
  // И отмечать больше нечего: на принятой анкете замечание сохранилось бы
  // (`raiseFlag` статус не проверяет — осознанно), но передать его оператору
  // нечем, поэтому кнопки «отметить» нет ни на одной строке блока.
  await expect(page.locator('.frow-act')).toHaveCount(0)

  // Строка реестра называет анкету принятой — видимый след успеха за
  // пределами самого экрана проверки (с настроенным SMTP `approveAction` при
  // удачном письме не возвращает и уведомления — экран не меняется ничем,
  // кроме состояния). Прежде здесь проверялось исчезновение из списка
  // «Awaiting review»; из реестра лаунж не исчезает никогда (Global
  // Constraints плана 3) — принятая анкета видна сменившейся подписью.
  await page.goto('/admin')
  const registryRow = page.getByRole('row').filter({ hasText: lounge })
  await expect(registryRow).toContainText('Approved')
  // …и колонка «Ревьюер» подписана почтой сессии, принявшей анкету:
  // `approveSubmission` пишет в `reviewerId` `session.email`, других имён у
  // ревьюера нет. До решения колонка показывает «—» (см. registry.spec.ts).
  await expect(registryRow).toContainText(SEED_REVIEWER_EMAIL)
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

test('вход по паролю: ops set-password → настоящая форма → кабинет; отказ один на любую причину', async ({
  page,
  watched,
}) => {
  // Свой участник на каждый прогон, НЕ общий `SEED_REVIEWER_EMAIL` — и не
  // ради чистоты: сценарий ниже меняет пароль, а смена отзывает остальные
  // сессии участника. У сидового проверяющего «остальные» — это живые сессии
  // параллельно идущих файлов (`registry.spec.ts` входит тем же адресом), и
  // тест ронял бы соседей посреди их работы. У свежего участника отзывать
  // нечего, кроме своего.
  const member = `e2e-pw-${Math.random().toString(36).slice(2, 10)}@example.com`
  opsAgainstDevDb(`invite ${member}`)
  const password = `e2e-password-${Math.random().toString(36).slice(2, 10)}`
  setPasswordFor(member, password)

  await page.goto('/admin/login')
  await expectRendered(watched, page.getByRole('heading', { name: 'Lounge Onboarding' }))

  // Неверный пароль, неизвестная почта — ОДИН И ТОТ ЖЕ текст отказа (это
  // сравнение экранов, как у `sent` в сценарии magic-ссылки: то единственное,
  // что видит перебирающий). Отдельное «вы заблокированы» или «нет такого
  // адреса» перечисляло бы состав команды.
  const failed = 'Sign-in failed. Check the email and password.'

  await page.getByLabel('Work email').fill(member)
  await page.getByLabel('Password').fill('definitely not the password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText(failed)).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/admin/login')

  await page.getByLabel('Work email').fill('definitely-not-on-the-team@example.com')
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText(failed)).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/admin/login')

  // Верная пара открывает кабинет: действие ставит ту же cookie, что маршрут
  // magic-ссылки (`sessionCookieOptions` — одно определение на оба входа).
  await page.getByLabel('Work email').fill(member)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expectRendered(watched, page.getByRole('heading', { name: 'Lounges' }))
  expect(new URL(page.url()).pathname).toBe('/admin')

  // Смена пароля со страницы кабинета: старые сессии — кроме этой — гаснут
  // (юнит-тесты держат «кроме этой», здесь важен сам путь с экрана), новый
  // пароль действует. Заодно это единственная проверка, что /admin/password
  // вообще отрисовывается (класс дефекта «страница не открылась», ради
  // которого существует expectRendered).
  await page.getByRole('link', { name: 'Password' }).click()
  await expectRendered(watched, page.getByRole('heading', { name: 'Change password' }))

  const newPassword = `${password}-rotated`
  await page.getByLabel('Current password').fill(password)
  await page.getByLabel('New password', { exact: true }).fill(newPassword)
  await page.getByLabel('New password, again').fill(newPassword)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('Password updated', { exact: false })).toBeVisible()

  // Текущая сессия пережила смену — кабинет всё ещё открыт…
  await page.goto('/admin')
  await expectRendered(watched, page.getByRole('heading', { name: 'Lounges' }))

  // …а старый пароль больше не входит (в новом контексте без cookie).
  await page.context().clearCookies()
  await page.goto('/admin/login')
  await page.getByLabel('Work email').fill(member)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText(failed)).toBeVisible()

  await page.getByLabel('Password').fill(newPassword)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expectRendered(watched, page.getByRole('heading', { name: 'Lounges' }))
})
