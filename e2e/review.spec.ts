import { test as base, expect, type Locator, type Page } from '@playwright/test'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { BLOCKS } from '../src/form-schema/blocks'
import { fieldByKey } from '../src/form-schema/fields'
import { serviceItemByKey } from '../src/form-schema/services'
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

/**
 * Гейт «страница не только отрисовалась, но и ОЖИЛА» — для форм, где кнопку
 * включает клиентское состояние React.
 *
 * Гонка, которую это закрывает: `fill()` может успеть ДО гидрации.
 * `expectRendered` (и любой видимый маркер вообще) доказывает только
 * серверную отрисовку: HTML со всеми полями приходит раньше, чем исполнится
 * JS и React навесит обработчики. `fill()` у Playwright ждёт видимости и
 * editable, но НЕ интерактивности — на загруженной машине (параллельные
 * воркеры плюс компиляция dev-сервера задерживают выдачу чанков) он вписывает
 * текст в DOM, пока состояние React ещё `''`. Контролируемый инпут при
 * гидрации чужой DOM-текст в состояние не подхватывает, задним числом события
 * не приходят — кнопка, включаемая этим состоянием, остаётся disabled
 * навсегда, и тест умирает 30-секундным таймаутом на клике (три прогона
 * подряд, всегда в одном месте — /admin/password).
 *
 * Закрывается гонка ПОВТОРОМ заполнения, а не расширенным таймаутом: правило
 * включения кнопки синхронно со state (`filled` в `PasswordChange.tsx`,
 * `!email || !password` в `LoginForm.tsx`), поэтому первый же ДОШЕДШИЙ fill
 * после гидрации включает кнопку на той же итерации — исход детерминирован,
 * а не «подождали подольше и повезло». Перезаполняются все поля разом:
 * проиграть гонку мог любой из них, не только последний.
 *
 * Каждая итерация СНАЧАЛА очищает поле и только потом пишет значение, и это
 * не перестраховка, а условие работоспособности повтора: value tracker
 * React'а инициализируется В МОМЕНТ гидрации текущим значением DOM — тем
 * самым текстом, который проигравший гонку fill уже оставил в поле. Повтор
 * тем же значением не меняет value, tracker не видит перехода, onChange не
 * зовётся — состояние так и остаётся `''` при живом клиенте (проверено
 * инструментированным прогоном: 18 повторов на гидрированной странице не
 * включили кнопку, пока очистки не было). `fill('')` даёт настоящий переход
 * значения, следующий `fill(value)` — второй; хотя бы один из них гидрация
 * уже видит.
 *
 * Сломанное правило включения это НЕ глотает: если кнопка не включается и при
 * живом клиенте, повторы исчерпываются и тест падает — `toPass` перебрасывает
 * последнюю внутреннюю ошибку, то есть `toBeEnabled` с локатором кнопки и
 * сообщением ниже, а не безымянный таймаут.
 *
 * Нужен только ПЕРВОМУ заполнению после загрузки документа: клиент,
 * сработавший хоть раз (кнопка включилась, пришёл клиентский отклик), — уже
 * доказательство гидрации, и дальнейшие `fill()` на той же странице безопасны.
 */
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

/**
 * Заполняет поле формы заполнения и ждёт, пока автосохранение скажет «Saved».
 *
 * Тот же повтор и по той же причине, что у `fillEnabling` (читайте довод там),
 * только признак «клиент жив» здесь другой: у формы заполнения нет кнопки,
 * включаемой состоянием, — есть подпись автосохранения, а она появляется
 * ровно тогда, когда изменение дошло до состояния React и через него до
 * сервера. `fill()` до гидрации не вызывает `onChange`, автосохранение не
 * запускается, и «Saved» не появится никогда — то есть без повтора тест
 * умирал бы таймаутом на ожидании подписи.
 *
 * Очистка перед записью — обязательна по той же причине, что в `fillEnabling`
 * (value tracker React'а инициализируется значением DOM в момент гидрации, и
 * повтор тем же значением перехода не даёт). Лишней записи пустого значения
 * на сервер она не устраивает: `useAutosave` держит по ключу ПОСЛЕДНЕЕ
 * значение и отправляет его через 600 мс тишины, а обе записи идут подряд.
 *
 * Годится только для ПЕРВОГО сохранения на странице: «Saved» остаётся на
 * экране, поэтому на втором вызове утверждение прошло бы вакуумно.
 */
async function fillAndAwaitSaved(page: Page, field: Locator, value: string): Promise<void> {
  await expect(page.getByText('Saved')).toHaveCount(0)
  await expect(async () => {
    await field.fill('')
    await field.fill(value)
    await expect(
      page.getByText('Saved'),
      'автосохранение не подтвердило запись — если это последняя итерация, дело не в гидрации',
    ).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await expect(field).toHaveValue(value)
}

/** Открывает засеянную анкету так же, как проверяющий: из реестра лаунжей
 *  (`/admin`, план 3 — прежде здесь был список «Awaiting review»). Имя лаунжа
 *  в строке реестра — ссылка на последнюю анкету. Возвращает URL экрана
 *  проверки — по нему сценарии возвращаются на анкету после того, как она
 *  вышла из статуса `submitted`.
 *
 *  `stateLabel` — подпись состояния, которую экран обязан показать сразу
 *  после открытия. Умолчание отвечает всем сценариям, сеющим `--submitted`;
 *  параметр нужен сценарию черновика, и он именно параметр, а не второй
 *  такой же открыватель рядом: путь до экрана (реестр → имя лаунжа → гейт
 *  «страница отрисовалась») от состояния анкеты не зависит. */
async function openSeededSubmission(
  page: Page,
  watched: Watched,
  lounge: string,
  stateLabel = 'Under review',
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
  // И называет состояние — то, в котором её только что засеяли.
  await expect(page.locator('.review-state b')).toHaveText(stateLabel)

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

/**
 * Кнопка проявления композера замечания («отметить») на строке.
 *
 * `:not(.frow-editbtn)` — не украшение, а единственное, что отличает её от
 * карандаша правки: `FieldRow` вешает `.frow-act` на ОБЕ кнопки строки
 * (правила проявления по наведению общие — см. `.frow-acts` в globals.css), и
 * по одному `.frow-act` локатор находит две кнопки. Строгий режим Playwright
 * это ловит, но падением «resolved to 2 elements» на клике, а не внятным
 * утверждением, поэтому обе кнопки адресуются здесь по одному разу и по
 * именам.
 *
 * Класс, а не роль с именем: у кнопки проявления («flag») и у кнопки отправки
 * замечания («Flag») имена различаются только регистром, а `getByRole`
 * сопоставляет имена без учёта регистра — по имени они неразличимы.
 */
function flagButton(target: Locator): Locator {
  return target.locator('.frow-act:not(.frow-editbtn)')
}

/** Карандаш правки на строке — свой класс у него как раз для адресации
 *  отсюда (см. `FieldRow`'s `pencil`): имя кнопки зависит от локали, класс —
 *  нет. */
function pencil(target: Locator): Locator {
  return target.locator('.frow-editbtn')
}

/**
 * Открывает инлайн-редактор строки карандашом и ждёт `marker` — то, что этот
 * ВИД правки должен показать (поле ввода, карточку позиции, записку).
 *
 * Клик повторяется, и это та же гонка, что описана у `fillEnabling`, только с
 * другой стороны: `click()` у Playwright ждёт видимости, а не
 * интерактивности, и до гидрации нажатие на карандаш не открывает ничего —
 * редактор открывает обработчик React, а не переход по ссылке. Здесь, в
 * отличие от заполнения поля, у успеха есть однозначный признак — редактор
 * появился, — поэтому повтор идёт до него, а не «ждём подольше».
 *
 * Заодно появившийся редактор — доказательство гидрации для всего дальнейшего
 * на этой странице: `fill()` в него уже точно доходит до состояния React, и
 * «Сохранить» отправляет набранное, а не прежнее значение.
 *
 * `marker`, а не `.frow-editor`: этот класс носит и композер замечания, так
 * что ожидание контейнера прошло бы и на открытом композере — то есть
 * ничего бы не доказало.
 */
async function openRowEditor(target: Locator, marker: Locator): Promise<Locator> {
  // Отдельным утверждением ДО повторов: пропавший карандаш иначе выглядит как
  // безымянный «таймаут на предикате» — сообщение, по которому нельзя
  // отличить «кнопки нет» от «редактор не открылся».
  await expect(pencil(target), 'на строке нет карандаша правки').toHaveCount(1)
  await expect(async () => {
    await target.hover()
    await pencil(target).click()
    await expect(marker).toBeVisible({ timeout: 500 })
  }).toPass({ timeout: 20_000 })
  return target.locator('.frow-editor')
}

/** Точка блока в навигаторе — по подписи блока, а не по номеру в `BLOCKS`:
 *  утверждения о конкретном блоке не должны переезжать вместе с порядком
 *  блоков в схеме. */
function navItem(page: Page, blockLabel: string): Locator {
  return page.locator('.nav-item').filter({ hasText: blockLabel })
}

/** Отмечает строку замечанием ровно так, как это делает проверяющий: наведение
 *  → «отметить» → причина → комментарий → «Отметить». */
async function flag(target: Locator, reason: string, comment: string): Promise<void> {
  await target.hover()
  await flagButton(target).click()
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
/**
 * Значок провенанса ответа. Текст ОДИН на обе стороны анкеты
 * (`answer.teamEdited`), поэтому и здесь он один: сценарий ниже утверждает
 * его и на строке экрана проверки, и на карточке правок оператора — если бы
 * тест держал две константы, он проходил бы и на двух РАЗОШЕДШИХСЯ
 * формулировках, то есть перестал бы проверять главное («один факт — одни
 * слова»).
 */
const TEAM_BADGE = 'Corrected by the team'

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
  await flagButton(fullName).click()
  const flagSubmit = fullName.locator('.bt-flag')
  await expect(flagSubmit).toBeDisabled()
  await expect(fullName.getByText('Pick a reason or write what is wrong')).toBeVisible()
  await fullName.getByRole('button', { name: 'not filled in' }).click()
  await expect(flagSubmit).toBeEnabled()
  await flagSubmit.click()
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

/**
 * Гарантия схождения для ЧЕТВЁРКИ ПАСПОРТА при воротах производных полей
 * (`saveOperatorField`): страна/город/аэропорт (I.7–I.9) выводятся из кода
 * IATA и оператором не пишутся никогда — ни в основном проходе, ни на экране
 * правок. Отмеченное ревьюером производное поле ОБЯЗАНО остаться исправимым
 * (иначе воспроизводится класс «отмечено, но неисправимо» — Critical, за
 * который ветка уже платила) — исправляется оно КОДОМ: карточка правок несёт
 * значение read-only, подпись «выводится из кода» и комбобокс справочника;
 * выбор аэропарта пишет код через серверные ворота, тройка следует за ним
 * одной транзакцией, и снимаются замечания всей четвёрки.
 *
 * Сид идёт через настоящий `createLounge` (см. seed-dev.ts), поэтому у
 * засеянной анкеты четвёрка предзаполнена значениями IST из справочника.
 * Выбирается Гатвик — код другой СТРАНЫ: замечание «не та страна» отвечается
 * видимой сменой всех трёх производных значений, не только кода.
 */
test('замечание на производном I.7: правится КОДОМ через поиск справочника, тройка следует, флаг снят', async ({
  page,
  context,
  watched,
}) => {
  const { fillUrl, lounge } = seed('submitted', 'derived')

  await page.goto(loginLinkFor(SEED_REVIEWER_EMAIL))
  const reviewUrl = await openSeededSubmission(page, watched, lounge)

  // Блок I открыт по умолчанию; строка I.7 несёт предзаполненный `Turkey`.
  const countryRow = row(page, fieldByKey('I.7')!.label.en)
  await expect(countryRow).toContainText('Turkey')
  await flag(countryRow, 'wrong format', 'Не та страна — лаунж в Великобритании')

  await clickAndAwaitAction(page, page.getByRole('button', { name: /Request changes/ }))

  // ── Экран правок: значение read-only + объяснение + поиск по справочнику ──
  const filler = await context.newPage()
  watched.watch(filler, 'filler')
  await filler.goto(fillUrl)

  await expect(filler.getByRole('heading', { name: 'Changes requested' })).toBeVisible()
  await expect(filler.locator('.fix-card')).toHaveCount(1)
  const countryInput = filler.getByLabel(/Country/)
  await expect(countryInput).toHaveValue('Turkey')
  // Прямой правки НЕТ — и это не тупик: тут же подпись, ПОЧЕМУ (выводится из
  // кода), и рабочая ручка карточки — исправление кода.
  await expect(countryInput).not.toBeEditable()
  await expect(
    filler.getByText(/derived from the IATA code/).first(),
  ).toBeVisible()
  const search = filler.getByRole('combobox', { name: 'Find airport' })
  await expect(search).toBeVisible()

  // Свободного ввода кода нет и здесь: текущий код read-only, новый —
  // только выбором из справочника (сервер иначе откажет — ворота).
  await expect(filler.getByLabel(/IATA Code/)).not.toBeEditable()

  await search.fill('gatwick')
  await filler
    .getByRole('option', { name: 'LGW — Gatwick · London, United Kingdom' })
    .click()
  await expect(filler.getByText('Saved')).toBeVisible()
  // Клиент показывает тройку ТЕМИ ЖЕ значениями справочника, что записал
  // сервер, — сразу, без перезагрузки.
  await expect(countryInput).toHaveValue('United Kingdom')

  // ── Флаг снят сервером; основной проход — тройка read-only, код с поиском ─
  // Перезагрузка перечитывает замечания с сервера: их больше нет → полная
  // форма. Тройка read-only ВСЕГДА (не расчёт замков, а ворота), с новыми
  // значениями; код разошёлся с колонкой лаунжа (`LGW` ≠ `IST`) → вместо
  // замка предзаполнения у I.10 стоит тот же контрол исправления кода.
  await filler.reload()
  await expect(
    filler.getByRole('heading', { name: 'Lounge Profile & Commercial Details' }),
  ).toBeVisible()
  await expect(filler.getByLabel(/Country/)).toHaveValue('United Kingdom')
  await expect(filler.getByLabel(/Country/)).not.toBeEditable()
  await expect(filler.getByLabel(/City/)).toHaveValue('London')
  await expect(filler.getByLabel(/Airport/)).toHaveValue('Gatwick')
  await expect(filler.getByLabel(/IATA Code/)).toHaveValue('LGW')
  await expect(filler.getByLabel(/IATA Code/)).not.toBeEditable()
  await expect(filler.getByRole('combobox', { name: 'Find airport' })).toBeVisible()
  // Микроподписей замка четыре: провайдер (I.3, предзаполнен и совпадает с
  // колонкой — «заполнено вашей командой») и производная тройка («выводится
  // из кода», у всех трёх).
  await expect(filler.locator('.field-locked-note')).toHaveCount(4)
  await expect(filler.getByText(/derived from the IATA code/)).toHaveCount(3)

  // ── Повторная отправка — с основного прохода, через навигатор шагов ───────
  await filler.locator('.shell-title-btn').click()
  await filler.getByRole('button', { name: 'Review & submit' }).click()
  await filler.getByRole('button', { name: 'Submit for review', exact: true }).click()
  await expect(filler.getByText('Sent for review. We will get back to you.')).toBeVisible()

  // ── И ревьюер видит обновлённую четвёрку без единого замечания ────────────
  await page.goto(reviewUrl)
  await expectRendered(watched, page.locator('.review-screen'))
  await expect(page.locator('.frow-flagged')).toHaveCount(0)
  await expect(row(page, fieldByKey('I.7')!.label.en)).toContainText('United Kingdom')
  await expect(row(page, fieldByKey('I.8')!.label.en)).toContainText('London')
  await expect(row(page, fieldByKey('I.9')!.label.en)).toContainText('Gatwick')
  await expect(row(page, fieldByKey('I.10')!.label.en)).toContainText('LGW')
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

  // Первое заполнение после загрузки документа — через fillEnabling: кнопку
  // включает состояние React, и до гидрации fill() уходит в пустоту (см. сам
  // хелпер).
  await fillEnabling(
    [[page.getByLabel('Work email'), 'definitely-not-on-the-team@example.com']],
    page.getByRole('button', { name: 'Send sign-in link' }),
  )
  await page.getByRole('button', { name: 'Send sign-in link' }).click()
  await expect(page.getByText(sent)).toBeVisible()

  await page.goto('/admin/login')
  await fillEnabling(
    [[page.getByLabel('Work email'), SEED_REVIEWER_EMAIL]],
    page.getByRole('button', { name: 'Send sign-in link' }),
  )
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

  // Первое заполнение после загрузки документа — через fillEnabling (см. сам
  // хелпер); дальнейшие fill() на этой же странице безопасны: включившаяся
  // кнопка уже доказала гидрацию.
  await fillEnabling(
    [
      [page.getByLabel('Work email'), member],
      [page.getByLabel('Password'), 'definitely not the password'],
    ],
    page.getByRole('button', { name: 'Sign in' }),
  )
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
  // Тот самый доказанный случай гонки (три падения полной параллельной сюиты
  // подряд): /admin/password открыт обычной ссылкой <a>, документ загружен
  // заново, и fill() до гидрации оставлял состояние React пустым — кнопка не
  // включалась все 30 секунд. Подробно — у fillEnabling.
  await fillEnabling(
    [
      [page.getByLabel('Current password'), password],
      [page.getByLabel('New password', { exact: true }), newPassword],
      [page.getByLabel('New password, again'), newPassword],
    ],
    page.getByRole('button', { name: 'Change password' }),
  )
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('Password updated', { exact: false })).toBeVisible()

  // Текущая сессия пережила смену — кабинет всё ещё открыт…
  await page.goto('/admin')
  await expectRendered(watched, page.getByRole('heading', { name: 'Lounges' }))

  // …а старый пароль больше не входит (в новом контексте без cookie).
  await page.context().clearCookies()
  await page.goto('/admin/login')
  // Снова свежая загрузка документа — снова первое заполнение через
  // fillEnabling.
  await fillEnabling(
    [
      [page.getByLabel('Work email'), member],
      [page.getByLabel('Password'), password],
    ],
    page.getByRole('button', { name: 'Sign in' }),
  )
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText(failed)).toBeVisible()

  await page.getByLabel('Password').fill(newPassword)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expectRendered(watched, page.getByRole('heading', { name: 'Lounges' }))
})

/**
 * Правка ответа КОМАНДОЙ в окне проверки — от карандаша на строке до того, что
 * значок провенанса не врёт о том, чьи слова стоят в ответе.
 *
 * Главное утверждение здесь последнее: после того как оператор перезаписал
 * ответ своей рукой, значок «исправлено командой» ДОЛЖЕН пропасть. Всё
 * остальное — путь к нему, и без него значок был бы просто наклейкой «этот
 * ответ когда-то трогали», а не ответом на вопрос «чьи это слова сейчас».
 * Именно этот шаг ни один юнит-тест не закрывает целиком: провенанс сбрасывает
 * операторская дверь (`OPERATOR_PROVENANCE` в `submissions/values.ts`), а
 * читает его страница проверки через `loadSubmissionValues` →
 * `renderValues` → `FieldRow`, то есть цепочка проходит через два экрана, две
 * двери записи и один переход состояния анкеты.
 *
 * Заодно проверяется, что значок ИЗБИРАТЕЛЕН: позицию услуг, которую оператор
 * не трогал, повторная отправка анкеты значка не лишает. Без этой пары
 * утверждений тест не отличил бы «провенанс следует за последней рукой» от
 * «отправка стирает провенанс всему подряд».
 */
test('правка ответа командой: карандаш, значок провенанса, снятый флаг — и операторская запись, снимающая значок', async ({
  page,
  context,
  watched,
}) => {
  const { fillUrl, lounge } = seed('submitted', 'teamedit')

  await page.goto(loginLinkFor(SEED_REVIEWER_EMAIL))
  const reviewUrl = await openSeededSubmission(page, watched, lounge)

  const navItems = page.locator('.nav-item')
  const fullName = row(page, FULL_NAME)

  // ── На строке ДВЕ кнопки действий, и это разные кнопки ────────────────────
  // Утверждается состав, а не «карандаш где-то есть»: обе несут `.frow-act`
  // (общие правила проявления по наведению), так что «карандаш появился»
  // ничем не отличалось бы от «кнопку замечания посчитали дважды».
  await expect(fullName.locator('.frow-acts').getByRole('button')).toHaveCount(2)
  await expect(flagButton(fullName)).toHaveCount(1)
  await expect(pencil(fullName)).toHaveCount(1)

  // ── Блок подтверждён ДО правки ───────────────────────────────────────────
  // Иначе «после правки блок не подтверждён» проходило бы вакуумно: он и не
  // был подтверждён. Подтверждаем именно сейчас, до замечания: блок с
  // открытым замечанием подтвердить нельзя (проверено выше, в сценарии
  // принятия).
  await page.getByRole('button', { name: CONFIRM_BLOCK }).click()
  await expect(navItems.first()).toHaveClass(/nav-confirmed/)

  // ── Отметили ответ… ──────────────────────────────────────────────────────
  await flag(fullName, 'needs detail', 'Название не совпадает с вывеской')
  await expect(navItems.first()).toHaveClass(/nav-flagged/)

  // ── …и тем же карандашом исправили сами ──────────────────────────────────
  // Обычный ход ревьюера: «отметил, подумал, исправил». Карандаш обязан быть и
  // на ОТМЕЧЕННОЙ строке — иначе исправить свой же вопрос было бы нечем
  // (`FieldRow` рисует его в отдельной ветке для отмеченной строки, и это
  // единственное место, где эта ветка проверяется вживую).
  const CORRECTED = 'Primeclass Lounge Istanbul — corrected by the reviewer'
  const nameInput = fullName.getByLabel(/Lounge Full Name/)
  const editor = await openRowEditor(fullName, nameInput)
  // Редактор открывается от ТЕКУЩЕГО значения строки, а не пустым: правка —
  // это правка, а не перенабор (см. `openEditor` в `FieldRow`).
  await expect(nameInput).not.toHaveValue('')
  await nameInput.fill(CORRECTED)
  await clickAndAwaitAction(page, editor.locator('.bt-save'))

  // ── Что после правки обязано быть видно на строке ────────────────────────
  await expect(fullName).toContainText(CORRECTED)
  await expect(fullName.locator('.team-badge')).toHaveText(TEAM_BADGE)
  // Замечание снято сервером той же транзакцией (`clearFlagsFor` с `tx`), а
  // не спрятано клиентом: строка перерисована ответом действия.
  await expect(fullName).not.toHaveClass(/frow-flagged/)
  await expect(page.locator('.frow-flagged')).toHaveCount(0)
  // Подтверждение блока обесценилось: точка не подтверждена и не отмечена.
  // КАКИМ из двух механизмов — производным правилом (`confirmedAt <
  // updatedAt`) или удалением подтверждения внутри `clearFlagsFor` — отсюда
  // не видно и видно быть не может: каждого хватает по отдельности (проверено
  // мутацией — выключение одного оставляет утверждение зелёным). Здесь
  // утверждается требуемый исход, а не механизм; разделение механизмов живёт
  // в юнит-тестах.
  await expect(navItems.first()).toHaveClass(/nav-untouched/)
  // …и в подвале снова «Подтвердить блок», а не «Снять подтверждение» —
  // ревьюеру предлагается перепроверить блок, в котором изменился ответ.
  await expect(page.getByRole('button', { name: RETRACT })).toHaveCount(0)
  await expect(page.getByRole('button', { name: CONFIRM_BLOCK })).toBeEnabled()

  // ── Производная тройка карандашом не правится нигде ──────────────────────
  // Дешёвая, но не декоративная проверка: экран обязан не предлагать того, в
  // чём сервер откажет (`editAnswerDuringReview` отказывает I.7–I.9 всегда).
  // Карандаш на I.7 есть — но открывает записку, а не редактор.
  const countryRow = row(page, fieldByKey('I.7')!.label.en)
  const derivedNote = countryRow.getByText(/derived from the IATA code/)
  await openRowEditor(countryRow, derivedNote)
  await expect(countryRow.locator('.bt-save')).toHaveCount(0)
  await expect(countryRow.locator('.frow-editor input')).toHaveCount(0)
  await countryRow.getByRole('button', { name: 'Cancel' }).click()
  await expect(derivedNote).toHaveCount(0)

  // ── Позиция услуг правится тем же карандашом ─────────────────────────────
  const wifi = serviceItemByKey('2.1')!
  const SERVICES_BLOCK = 'Connectivity & Business'
  await page.getByRole('button', { name: SERVICES_BLOCK }).click()
  const wifiRow = row(page, wifi.label.en)
  // Сид закрывает все 58 позиций ответом «нет» (`closingServiceValue`) —
  // отсюда и видно, что правка изменила именно её.
  await expect(wifiRow.locator('.frow-value')).toHaveText('no')

  // Подтверждаем блок услуг ДО правки — и здесь это утверждение сильнее, чем
  // на блоке I: позиция, которую сейчас поправят, НЕ отмечена, значит
  // подтверждение обесценивает сама правка данных, а не побочный эффект
  // снятого замечания. (Какой из двух механизмов сработал — производное
  // правило `confirmedAt < updatedAt` или удаление подтверждения в
  // `clearFlagsFor` — из браузера неразличимо: каждого хватает по
  // отдельности. Здесь утверждается требуемый ИСХОД.)
  await page.getByRole('button', { name: CONFIRM_BLOCK }).click()
  await expect(navItem(page, SERVICES_BLOCK)).toHaveClass(/nav-confirmed/)

  const WIFI_DETAILS = 'Free, no password — corrected by the reviewer'
  const wifiEditor = await openRowEditor(
    wifiRow,
    wifiRow.getByRole('heading', { name: wifi.label.en }),
  )
  // Карточка позиции целиком, с контролом наличия (`withAvailability`):
  // замечание адресует позицию целиком, и правка команды тоже. Атрибуты
  // (тип оплаты, «Details» и остальные) появляются только после «Yes» — их
  // показывает сама карточка, тем же правилом, что у оператора.
  await wifiEditor.getByRole('button', { name: 'Yes', exact: true }).click()
  // Тип оплаты выбирается НЕ для полноты картинки, и это выяснилось прогоном:
  // у ПРЕДЛОЖЕННОЙ позиции без него анкета неполна (`serviceItemAnswered`), и
  // повторная отправка ниже отказывала — «1 item(s) still need an answer: Wifi
  // Access». Ревьюер по-прежнему МОЖЕТ, оставив «yes» без типа оплаты,
  // вернуть анкету незаполненной — продукт этого не запрещает, — но тупика
  // это больше не создаёт: экран правок теперь показывает и правленные
  // командой ответы БЕЗ замечания, рабочей карточкой в группе «команда
  // исправила эти ответы» (`FixesOnly`'s `teamCorrected`), так что оператор
  // может дозаполнить позицию там же (проверено ниже: карточка группы есть и
  // несёт контрол). Сценарий всё же правит позицию ПОЛНОСТЬЮ — как это сделал
  // бы ревьюер, доводящий ответ до отправляемого.
  // Единственный `<select>` карточки — как раз тип оплаты (остальные контролы
  // «предложенной» позиции — числа, чекбокс и текст), поэтому локатор такой.
  await wifiEditor.locator('select').selectOption('complimentary')
  await wifiEditor.locator('textarea').fill(WIFI_DETAILS)
  await clickAndAwaitAction(page, wifiEditor.locator('.bt-save'))

  await expect(wifiRow).toContainText(WIFI_DETAILS)
  await expect(wifiRow).toContainText('yes · complimentary')
  await expect(wifiRow.locator('.team-badge')).toHaveText(TEAM_BADGE)
  // И подтверждение блока услуг обесценилось правкой, при которой снимать
  // было нечего.
  await expect(navItem(page, SERVICES_BLOCK)).toHaveClass(/nav-untouched/)
  await expect(page.getByRole('button', { name: RETRACT })).toHaveCount(0)

  // ── Возврат оператору: «мы поправили — проверьте» ────────────────────────
  // Отметить ответ заново нужно и по делу (ровно этот случай описан у
  // `FixesOnly`'s `teamEdited`: карточка показывает и замечание, и чьё
  // значение сейчас в поле), и по правилам: `requestChanges` отказывает без
  // хотя бы одного открытого замечания.
  await page.getByRole('button', { name: BLOCKS[0]!.label.en }).click()
  await flag(fullName, 'needs detail', 'Мы поправили название — подтвердите, что оно верное')
  await clickAndAwaitAction(page, page.getByRole('button', { name: /Request changes/ }))
  await expect(page.locator('.review-state b')).toHaveText('Returned to the operator')

  // ── Оператор видит В СВОЕЙ анкете чужие слова — и видит, что они чужие ───
  const filler = await context.newPage()
  watched.watch(filler, 'filler')
  await filler.goto(fillUrl)

  await expect(filler.getByRole('heading', { name: 'Changes requested' })).toBeVisible()
  // Карточек ДВЕ, и это разные карточки (перепинато сознательно: прежняя
  // версия утверждала count 1 — то есть закрепляла невидимость правки wifi):
  // отмеченная I.2 — и карточка группы «команда исправила эти ответы» для
  // wifi, чью правку команда внесла БЕЗ замечания. Вступление оговаривает
  // группу, а не утверждает «остальное принято» без оговорки.
  await expect(filler.locator('.fix-card:not(.fix-card-team)')).toHaveCount(1)
  await expect(filler.locator('.fix-card-team')).toHaveCount(1)
  await expect(
    filler.getByRole('heading', { name: 'The team corrected these answers' }),
  ).toBeVisible()
  await expect(filler.locator('.subtitle').first()).toContainText(
    'the team corrected some others',
  )
  // Карточка группы — РАБОЧАЯ: значение wifi, значок, и настоящий контрол
  // (несогласие или незаполненность исправимы здесь же).
  const teamCard = filler.locator('.fix-card-team')
  await expect(teamCard).toContainText(wifi.label.en)
  await expect(teamCard.locator('textarea')).toHaveValue(WIFI_DETAILS)
  await expect(teamCard.locator('.team-badge')).toHaveText(TEAM_BADGE)

  const operatorInput = filler.getByLabel(/Lounge Full Name/)
  await expect(operatorInput).toHaveValue(CORRECTED)
  await expect(
    filler.locator('.fix-card:not(.fix-card-team) .team-badge'),
  ).toHaveText(TEAM_BADGE)

  // ── Оператор перезаписывает ответ своей рукой ────────────────────────────
  const OPERATOR_VALUE = 'Primeclass Lounge Istanbul Ltd'
  await fillAndAwaitSaved(filler, operatorInput, OPERATOR_VALUE)
  // Значок снимается сразу, без перезагрузки: он следует за ПОСЛЕДНЕЙ рукой,
  // и ждать перезагрузки значило бы какое-то время показывать оператору
  // «исправлено командой» над его собственным, только что набранным ответом.
  // ИЗБИРАТЕЛЬНО: значок карточки wifi, которой оператор не касался, ОСТАЁТСЯ
  // (перепинато: прежний count 0 по всему экрану был верен только пока правка
  // wifi была невидима вовсе).
  await expect(filler.locator('.fix-card:not(.fix-card-team) .team-badge')).toHaveCount(0)
  await expect(teamCard.locator('.team-badge')).toHaveText(TEAM_BADGE)

  await filler.getByRole('button', { name: 'Submit for review', exact: true }).click()
  await expect(filler.getByText('Sent for review. We will get back to you.')).toBeVisible()

  // ── ГЛАВНОЕ: на экране проверки значка больше нет ────────────────────────
  // Перечитываем с сервера: значение и провенанс приходят одним
  // `loadSubmissionValues`, так что это утверждение про базу, а не про то,
  // что нарисовал клиент оператора.
  await page.goto(reviewUrl)
  await expectRendered(watched, page.locator('.review-screen'))
  await expect(page.locator('.review-state b')).toHaveText('Under review')

  const reread = row(page, FULL_NAME)
  await expect(reread).toContainText(OPERATOR_VALUE)
  await expect(reread).not.toContainText('corrected by the reviewer')
  await expect(reread.locator('.team-badge')).toHaveCount(0)
  // Замечание тоже снято — операторской записью (`clearFlagAfterSave`).
  await expect(page.locator('.frow-flagged')).toHaveCount(0)

  // …а позиция услуг, которой оператор не касался, значок СОХРАНИЛА: провенанс
  // следует за последней рукой по ответу, а не сбрасывается отправкой анкеты.
  await page.getByRole('button', { name: SERVICES_BLOCK }).click()
  const wifiAgain = row(page, wifi.label.en)
  await expect(wifiAgain).toContainText(WIFI_DETAILS)
  await expect(wifiAgain.locator('.team-badge')).toHaveText(TEAM_BADGE)
})

/**
 * Окно правки команды — ровно `submitted`, точное дополнение окна оператора.
 * На черновике карандаша нет НИ НА ОДНОЙ строке, и это проверяется вместе с
 * тем, что кнопка «отметить» на месте: иначе утверждение прошло бы вакуумно на
 * экране, где кнопок строки нет вовсе (например, если бы весь ряд действий
 * пропал по другой причине).
 *
 * Что этот сценарий НЕ доказывает: что серверная дверь откажет черновику.
 * Через браузер до неё на черновике не дотянуться — клиент карандаш не
 * показывает, а дёргать серверное действие в обход экрана значило бы
 * проверять не пользовательский путь. Отказ по статусу проверяется двумя
 * другими способами: юнит-тестами (`src/review/__tests__/edit.test.ts`) и
 * сценарием устаревшей вкладки ниже, где карандаш РЕАЛЬНО доступен человеку,
 * а анкета уже уехала из проверки.
 */
test('черновик: карандаша нет ни на одной строке — правка команды живёт только в окне проверки', async ({
  page,
  watched,
}) => {
  const { lounge } = seed('draft', 'nopencil')

  await page.goto(loginLinkFor(SEED_REVIEWER_EMAIL))
  await openSeededSubmission(page, watched, lounge, 'Draft')

  const rows = page.locator('.frow')
  const rowCount = await rows.count()
  expect(rowCount, 'блок I пуст — сравнивать число кнопок было бы не с чем').toBeGreaterThan(0)

  // Отмечать можно (замечание дойдёт до оператора, когда он отправит анкету и
  // её вернут — см. `flagging` в `gates.ts`), править нельзя.
  await expect(page.locator('.frow-act:not(.frow-editbtn)')).toHaveCount(rowCount)
  await expect(page.locator('.frow-editbtn')).toHaveCount(0)

  // Причина стоит одной строкой в подписи состояния — там же, где она стоит
  // для всех остальных недоступных решений, а не 30 одинаковых `title`.
  await expect(page.locator('.review-state')).toContainText(
    'has not submitted this questionnaire yet',
  )
  await expect(page.getByRole('button', { name: CONFIRM_BLOCK })).toBeDisabled()
})

/**
 * Устаревшая вкладка: карандаш на экране, а анкета уже не на проверке.
 *
 * Это единственный путь, которым человек может дойти до серверной двери
 * правки на анкете вне окна проверки, — и путь настоящий, тот же, из-за
 * которого экран вообще начал называть состояние анкеты (см. сценарий
 * принятия: «проверяющий B принимал анкету, пока у A открыта вкладка»).
 * Клиентская подсказка здесь бессильна по построению: страница отрисована ДО
 * перехода, и карандаш на ней настоящий, нажимаемый. Гейтом остаётся ровно
 * транзакция `editAnswerDuringReview`, и здесь проверяется, что она есть:
 * отказ виден человеку словами, а ответ в базе не изменился.
 */
test('правка из устаревшей вкладки: анкета уже не на проверке — сервер отказывает, и отказ виден', async ({
  page,
  context,
  watched,
}) => {
  const { lounge } = seed('submitted', 'stale')

  await page.goto(loginLinkFor(SEED_REVIEWER_EMAIL))
  const reviewUrl = await openSeededSubmission(page, watched, lounge)

  // Замечание нужно, чтобы возврат на правку был вообще возможен.
  await flag(row(page, FULL_NAME), 'not filled in', 'Название указано не полностью')

  // Вторая вкладка того же ревьюера на той же анкете — и в ней открытый
  // черновик правки.
  const stale = await context.newPage()
  watched.watch(stale, 'stale-tab')
  await stale.goto(reviewUrl)
  await expectRendered(watched, stale.locator('.review-screen'))

  const staleRow = row(stale, FULL_NAME)
  const staleInput = staleRow.getByLabel(/Lounge Full Name/)
  const staleEditor = await openRowEditor(staleRow, staleInput)
  const REFUSED = 'Written from a stale tab'
  await staleInput.fill(REFUSED)

  // Пока черновик стоит открытым, анкета уезжает из проверки.
  await clickAndAwaitAction(page, page.getByRole('button', { name: /Request changes/ }))
  await expect(page.locator('.review-state b')).toHaveText('Returned to the operator')

  // Нажатие «Сохранить» в устаревшей вкладке доходит до сервера и получает
  // отказ — тем же текстом, каким отказывает подтверждение блока (одно окно,
  // одни слова), и ВНУТРИ самого редактора, у значения: отказ правки несёт
  // ключ собой, а не строчкой в подвале, которую надо соотнести с одной из
  // 58 строк. Редактор при этом НЕ закрывается и черновик НЕ теряется —
  // прежнее поведение (закрыться до ответа, отказ в подвал) уносило целиком
  // перезаполненную карточку из-за одного отказа (аудит, must-fix 6).
  await clickAndAwaitAction(stale, staleEditor.locator('.bt-save'))
  await expect(staleEditor.locator('.fix-comment')).toHaveText(
    'This submission is not open for review',
  )
  await expect(staleInput).toHaveValue(REFUSED)

  // И ответ действительно не изменился: перечитываем с сервера, потому что
  // отказ строку и не перерисовывал — «на экране старое значение» само по
  // себе ничего не доказывало бы.
  await stale.reload()
  await expectRendered(watched, stale.locator('.review-screen'))
  const rereadRow = row(stale, FULL_NAME)
  await expect(rereadRow).not.toContainText(REFUSED)
  await expect(rereadRow.locator('.team-badge')).toHaveCount(0)
  // Замечание тоже на месте: отказавшая правка не сняла его (снятие живёт в
  // той же транзакции, что запись, — не отдельным best-effort шагом).
  await expect(rereadRow).toHaveClass(/frow-flagged/)
})
