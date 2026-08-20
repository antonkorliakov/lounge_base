import { test as base, expect, type Locator, type Page } from '@playwright/test'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { OPERATIONAL_STATUSES } from '../src/registry/status'
import { read } from '../src/export/__tests__/readWorkbook'
import { SEED_REVIEWER_EMAIL } from '../scripts/dev-support'

/**
 * Реестр лаунжей (`/admin`, план 3): оба статуса на одной строке, фильтры в
 * адресной строке, смена эксплуатационного статуса из таблицы и выгрузка по
 * текущему фильтру. Сторону проверки анкеты держит `e2e/review.spec.ts` (он
 * же ходит в реестр как в список), сторону заполнения — `e2e/fill.spec.ts`.
 *
 * Страж `pageerror`/`console.error` — тот же и по той же причине, что в
 * `review.spec.ts` (см. историю там: серверный компонент, молча отдающий 500,
 * не ловит ни один из четырёх гейтов). Реестр — второй серверный экран,
 * читающий базу, и разбор его фильтров уже один раз чуть не уехал в клиентский
 * модуль (`src/registry/filters-url.ts` рассказывает, чем бы это кончилось) —
 * «страница отрисовалась вообще» здесь такое же самостоятельное утверждение.
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

/**
 * Сеет флот: основной лаунж (Istanbul, `active`, пустой черновик анкеты) плюс
 * два лаунжа БЕЗ анкет — `<base> IGA Arrival` (Istanbul, зона «прилёт»,
 * `under_renovation` до 2026-09-15) и `<base> Marhaba` (Dubai, «вылет»,
 * `closed`). Имена уникальны на каждый вызов, и это условие существования
 * этого файла: у `lounges.name` нет уникального ограничения, реестр
 * показывает ВСЕ лаунжи всегда, и на машине, где сид гоняли много раз,
 * фиксированное имя из образца плана находило бы несколько строк сразу —
 * strict-mode падение до первой проверки по существу (см. `seedFleet` в
 * `scripts/seed-dev.ts`). Свои строки тест находит по полному имени.
 */
function seedFleet(label: string): { base: string; iga: string; marhaba: string } {
  const fleetBase = `Fleet-${label}-${Math.random().toString(36).slice(2, 10)}`
  execSync(`npm run --silent seed -- --fleet --lounge=${fleetBase}`, { encoding: 'utf8' })
  return { base: fleetBase, iga: `${fleetBase} IGA Arrival`, marhaba: `${fleetBase} Marhaba` }
}

/** Одиночный лаунж с черновиком — для сценария смены статуса флот не нужен. */
function seedLounge(label: string): string {
  const lounge = `Registry-${label}-${Math.random().toString(36).slice(2, 10)}`
  execSync(`npm run --silent seed -- --lounge=${lounge}`, { encoding: 'utf8' })
  return lounge
}

/** См. пояснение в `review.spec.ts`: письмо тела не печатает, ссылку выдаёт
 *  тот же `requestLogin`, каким пользуется настоящее действие входа. */
function loginLinkFor(email: string): string {
  return execSync(`npx tsx scripts/dev-login-link.ts ${email}`, { encoding: 'utf8' }).trim()
}

/** Гейт «страница отрисовалась вообще» — дословно тот же, что в review.spec:
 *  ошибка проверяется на каждой итерации, чтобы упавший рендер дал падение с
 *  ТЕКСТОМ ошибки, а не таймаут на отсутствующем маркере. */
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

/** Вход по одноразовой ссылке приводит прямо на `/admin` — реестр. */
async function openRegistry(page: Page, watched: Watched): Promise<void> {
  await page.goto(loginLinkFor(SEED_REVIEWER_EMAIL))
  await expectRendered(watched, page.getByRole('heading', { name: 'Lounges' }))
}

/**
 * Подпись эксплуатационного статуса — из `OPERATIONAL_STATUSES`, того же
 * источника, которым экран рисует пилюлю и радио-кнопки редактора, а не
 * строка, переписанная здесь руками: переформулировка подписи не должна
 * иметь возможности молча уронить (или, хуже, молча пропустить) эти тесты.
 */
function statusLabel(id: (typeof OPERATIONAL_STATUSES)[number]['id']): string {
  return OPERATIONAL_STATUSES.find((status) => status.id === id)!.label.en
}

/**
 * Селекты панели фильтров ищутся В ПАНЕЛИ, а не по всей странице: подпись
 * контрола в `getByLabel` сопоставляется подстрокой, а имена лаунжей — вольный
 * текст, попадающий в aria-label кнопок удаления («Delete lounge: <имя>»), и
 * лаунж с «airport»/«zone» в имени (флот этого файла!) делает страничный
 * `getByLabel('Airport')` strict-mode нарушением. `exact: true` не спасает:
 * доступное имя обёрнутого select'а склеивается из ВСЕГО текста label —
 * «Airportall Dubai International…». Та же ловушка подстрочного имени, что у
 * `flag`/`Flag` в review.spec (см. историю там).
 */
function filterBar(page: Page): Locator {
  return page.locator('.registry-filters')
}

/** Строка реестра по имени лаунжа. Имена уникальны на прогон (см. `seedFleet`),
 *  так что подстрочный `hasText` находит ровно одну строку. */
function rowFor(page: Page, name: string): Locator {
  return page.getByRole('row').filter({ hasText: name })
}

/**
 * Сужает реестр до лаунжей ЭТОГО прогона — через настоящее поле поиска
 * (Enter, как ходит человек), а не через `goto` с готовым URL: сборка строки
 * запроса из выбора в контролах — часть того, что файл проверяет.
 */
async function searchFor(page: Page, text: string): Promise<void> {
  const box = page.getByRole('searchbox', { name: /Name or IATA/ })
  await box.fill(text)
  await box.press('Enter')
  await expect(page).toHaveURL(new RegExp(`search=${text}`))
}

test('реестр показывает оба статуса, приглушает закрытый лаунж и сужается фильтром по зоне', async ({
  page,
  watched,
}) => {
  const fleet = seedFleet('zone')
  await openRegistry(page, watched)
  await searchFor(page, fleet.base)

  // Оба статуса — отдельными колонками. `exact` у «Form status» обязателен:
  // имя в `getByRole` сопоставляется подстрокой, и без него нашлась бы ещё
  // колонка «Days in form status».
  await expect(page.getByRole('columnheader', { name: 'Lounge status', exact: true })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Form status', exact: true })).toBeVisible()
  // Последняя колонка спецификации («…, ревьюер»). Никого из лаунжей прогона
  // не проверяли — колонка есть, значение честное «—», а не пустота.
  await expect(page.getByRole('columnheader', { name: 'Reviewer', exact: true })).toBeVisible()

  // Лаунжи БЕЗ единой анкеты в реестре есть (Global Constraints плана 3:
  // реестр не предрешает, до кого сбор данных дошёл) — у них видны статус и
  // дата ожидаемого открытия, засеянные настоящим `setOperationalStatus`.
  const iga = rowFor(page, fleet.iga)
  const marhaba = rowFor(page, fleet.marhaba)

  await expect(iga).toContainText(statusLabel('under_renovation'))
  await expect(iga).toContainText('→ 2026-09-15')
  await expect(marhaba).toContainText(statusLabel('closed'))
  // Ячейка ревьюера у непроверявшегося лаунжа — «—»; почта настоящего решения
  // закреплена в review.spec.ts после принятия. Была `.last()`, пока ревьюер
  // был последней колонкой; теперь за ним ячейка удаления, поэтому колонка
  // находится по индексу своего заголовка, а не по позиции «последняя».
  // `textContent`, не `innerText`: заголовки таблицы капитализирует CSS
  // (`text-transform: uppercase`), и innerText вернул бы 'REVIEWER'.
  const headers = page.getByRole('columnheader')
  const reviewerIndex = await headers.count().then(async (n) => {
    for (let i = 0; i < n; i++) {
      if ((await headers.nth(i).textContent()) === 'Reviewer') return i
    }
    throw new Error('колонка Reviewer не найдена')
  })
  await expect(iga.locator('td').nth(reviewerIndex)).toHaveText('—')

  // Закрытый приглушён; НЕзакрытый — нет: без второй половины тест не отличил
  // бы «класс вешается по статусу» от «класс вешается на все строки».
  await expect(marhaba).toHaveClass(/row-dim/)
  await expect(iga).not.toHaveClass(/row-dim/)

  // Фильтр по зоне СКЛАДЫВАЕТСЯ с поиском: строка запроса сохраняет оба.
  await filterBar(page).getByLabel('Zone').selectOption('arrival')
  await expect(page).toHaveURL(/zone=arrival/)
  await expect(page).toHaveURL(new RegExp(`search=${fleet.base}`))

  await expect(iga).toBeVisible()
  await expect(marhaba).toHaveCount(0)
  // Из трёх лаунжей прогона осталась одна строка: основной (зона не задана —
  // классифицирующие поля пишутся при принятии) отфильтрован вместе с Marhaba.
  await expect(rowFor(page, fleet.base)).toHaveCount(1)
})

test('фильтр по аэропорту живёт в адресной строке и переживает перезагрузку', async ({
  page,
  watched,
}) => {
  const fleet = seedFleet('airport')
  await openRegistry(page, watched)

  // `selectOption` — по value (название аэропорта и есть value опции,
  // `filterOptions` отдаёт строки из базы как есть).
  await filterBar(page).getByLabel('Airport').selectOption('Dubai International')
  await expect(page).toHaveURL(/airport=Dubai\+International/)

  await page.reload()
  await expect(rowFor(page, fleet.marhaba)).toBeVisible()
  await expect(rowFor(page, fleet.iga)).toHaveCount(0)
  // И контрол после перезагрузки показывает выбор из URL, а не «все»: фильтр
  // хранится в адресе, состояние страницы из него восстановимо целиком.
  await expect(filterBar(page).getByLabel('Airport')).toHaveValue('Dubai International')
})

test('статус лаунжа меняется из реестра, виден без перезагрузки, а правка одной даты не стирает комментарий', async ({
  page,
  watched,
}) => {
  const lounge = seedLounge('status')
  await openRegistry(page, watched)
  await searchFor(page, lounge)

  const row = rowFor(page, lounge)
  const pill = row.locator('.pill-btn')
  await expect(pill).toHaveText(statusLabel('active'))
  await pill.click()

  // Радио-кнопки редактора названы теми же подписями из OPERATIONAL_STATUSES.
  await row.getByRole('radio', { name: statusLabel('under_renovation') }).check()
  await row.getByLabel(/Expected reopening/).fill('2026-12-01')
  await row.getByLabel('Comment').fill('Food court rebuild')
  await row.getByRole('button', { name: 'Save', exact: true }).click()

  // Успех виден БЕЗ перезагрузки: редактор закрылся, а пилюля, дата и
  // комментарий пришли ответом действия (`revalidatePath` после `result.ok` —
  // см. `setStatusAction`); молча оставшийся «Active» значил бы, что смену
  // видно только следующему посетителю. Комментарий — видимым текстом строки,
  // не `title`: записанное поле обязано быть читаемым (дефект I2 ревью).
  await expect(row.locator('.status-editor')).toHaveCount(0)
  await expect(pill).toHaveText(statusLabel('under_renovation'))
  await expect(row).toContainText('→ 2026-12-01')
  await expect(row).toContainText('Food court rebuild')

  // ── Правка ОДНОЙ даты не трогает комментарий ────────────────────────────
  // Ровно сценарий потери данных из ревью: редактор открывают поправить дату,
  // комментарий не трогают. Поле обязано открыться с ХРАНИМЫМ текстом (а не
  // пустым — пустое поле молча сохранило бы statusComment = null), и после
  // сохранения комментарий обязан пережить правку.
  await pill.click()
  await expect(row.getByLabel('Comment')).toHaveValue('Food court rebuild')
  await row.getByLabel(/Expected reopening/).fill('2026-12-15')
  await row.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(row.locator('.status-editor')).toHaveCount(0)
  await expect(row).toContainText('→ 2026-12-15')
  await expect(row).toContainText('Food court rebuild')

  // И это сервер, а не состояние клиента: перечитанная страница говорит то же.
  await page.reload()
  await expect(rowFor(page, lounge)).toContainText(statusLabel('under_renovation'))
  await expect(rowFor(page, lounge)).toContainText('→ 2026-12-15')
  await expect(rowFor(page, lounge)).toContainText('Food court rebuild')

  // ЧЕГО ЗДЕСЬ НЕТ, И ПОЧЕМУ: отказа сервера на дате вида 2026-02-30
  // (`isCalendarDate` в `src/registry/status.ts`) из настоящего браузера не
  // достичь — `<input type="date">` такую дату молча превращает в пустую
  // строку, что Task 7 проверил руками (отказ показывается в `.se-error`, но
  // добраться до него удалось только подменой типа инпута через devtools, то
  // есть браузером, которого не бывает). Гонять здесь `page.evaluate` ради
  // обхода собственного контрола значило бы тестировать сломанный браузер, а
  // не экран; сам отказ сервера закреплён юнит-тестом
  // (`src/registry/__tests__/status.test.ts`, «дата правильной формы, но
  // несуществующая в календаре, отклоняется» — 2026-02-30, 2026-13-01,
  // 2026-00-10), а «отказ действия виден в .se-error» остаётся на совести
  // ручной проверки Task 7. Решение записано, а не забыто.
})

test('лаунж заводится из реестра, ссылка заполнения открывает форму, удаление — только после набора названия', async ({
  page,
  watched,
}) => {
  // Имя уникально на прогон — то же правило, что у seedFleet/seedLounge:
  // дев-база копит лаунжи, и фиксированное имя нашло бы несколько строк.
  const name = `Created-${Math.random().toString(36).slice(2, 10)}`
  await openRegistry(page, watched)

  // ── Создание: имя + код, тройку производных выводит справочник ───────────
  // Справочник аэропортов (см. e2e/directory.spec.ts — он же гоняет импорт)
  // знает IST: после полного кода аэропорт/город/страна заполняются сами и
  // закрываются на чтение — руками их больше не набирают. Provider пуст.
  await page.getByRole('button', { name: 'Add lounge' }).click()
  await page.getByLabel('Name*', { exact: true }).fill(name)
  await page.getByLabel('IATA code*', { exact: true }).fill('ist') // нормализуется в IST
  await expect(page.getByText('from directory: IST')).toBeVisible()
  await expect(page.getByLabel('Country*', { exact: true })).toHaveValue('Turkey')
  await expect(page.getByLabel('City*', { exact: true })).toHaveValue('Istanbul')
  await expect(page.getByLabel('Airport*', { exact: true })).toHaveValue('Istanbul Airport')
  await expect(page.getByLabel('City*', { exact: true })).not.toBeEditable()
  await page.getByRole('button', { name: 'Create', exact: true }).click()

  // Ссылка заполнения показана для ручного копирования (почта не отправляется
  // — SMTP нет), рядом кнопка копирования и предупреждение об одноразовости:
  // хранится только хэш токена, второй раз ссылку взять неоткуда.
  const url = page.locator('.al-url')
  await expect(url).toBeVisible()
  const fillUrl = await url.inputValue()
  expect(fillUrl).toMatch(/\/f\/.+/)
  await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toBeVisible()
  await expect(page.getByText('the link is not shown again', { exact: false })).toBeVisible()

  // Новый лаунж уже в реестре за спиной панели (revalidatePath из действия) —
  // и НАСТОЯЩИЙ признак успеха: ссылка открывает форму заполнения. Это тот
  // самый «человек может дойти» класс, который не ловит ни один юнит-тест.
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await searchFor(page, name)
  const row = rowFor(page, name)
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('IST')

  await page.goto(fillUrl)
  await expect(
    page.getByRole('heading', { name: 'Lounge Profile & Commercial Details' }),
  ).toBeVisible()

  // ── Паспорт предзаполнен и (кроме названия) под замком ────────────────────
  // То, что администратор набрал в форме, оператор видит уже отвеченным:
  // страна/город/аэропорт/IATA — readonly с микроподписью «заполнено вашей
  // командой» (список замков считает СЕРВЕР по колонкам лаунжа —
  // `lockedIdentityKeys`), название — обычное редактируемое поле (решение
  // пользователя), а provider, оставленный при создании пустым, — пустое
  // редактируемое поле: пустая колонка ничего не замыкает.
  const fullName = page.getByLabel(/Lounge Full Name/)
  await expect(fullName).toHaveValue(name)
  await expect(fullName).toBeEditable()

  const iataField = page.getByLabel(/IATA Code/)
  await expect(iataField).toHaveValue('IST') // нормализованный, не сырой `ist`
  await expect(iataField).not.toBeEditable()
  await expect(page.getByLabel(/Country/)).toHaveValue('Turkey')
  await expect(page.getByLabel(/Country/)).not.toBeEditable()
  await expect(page.getByLabel(/City/)).toHaveValue('Istanbul')
  await expect(page.getByLabel(/Airport\*/)).toHaveValue('Istanbul Airport')
  await expect(page.locator('.field-locked-note')).toHaveCount(4)

  const provider = page.getByLabel(/Provider/)
  await expect(provider).toHaveValue('')
  await expect(provider).toBeEditable()

  // Название действительно правится: автосохранение проходит и переживает
  // перезагрузку, замки после неё стоят, где стояли.
  await fullName.fill(`${name} Renamed`)
  await expect(page.getByText('Saved')).toBeVisible()
  await page.reload()
  await expect(page.getByLabel(/Lounge Full Name/)).toHaveValue(`${name} Renamed`)
  await expect(page.getByLabel(/IATA Code/)).not.toBeEditable()
  await expect(page.locator('.field-locked-note')).toHaveCount(4)

  // ── Удаление: кнопка неброская, ворота — набранное название ──────────────
  await page.goto('/admin')
  await searchFor(page, name)
  await rowFor(page, name).getByRole('button', { name: `Delete lounge: ${name}` }).click()

  // Диалог называет, что уничтожается, и предупреждает про ссылку оператора.
  await expect(page.locator('.dl-warning')).toContainText('permanently deletes')
  await expect(page.locator('.dl-warning')).toContainText('fill link, it will stop working')

  const confirm = page.getByLabel('Type the lounge name to confirm')
  const remove = page.getByRole('button', { name: 'Delete', exact: true })
  // Пустое и НЕВЕРНОЕ название не дают удалить (подсказка клиента; настоящая
  // сверка на сервере закреплена юнит-тестом manage-actions.test.ts).
  await expect(remove).toBeDisabled()
  await confirm.fill(`${name} wrong`)
  await expect(remove).toBeDisabled()

  await confirm.fill(name)
  await remove.click()

  // Строка исчезла без перезагрузки — и это сервер, а не состояние клиента:
  // перечитанная страница говорит то же.
  await expect(rowFor(page, name)).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Lounges' })).toBeVisible()
  await expect(rowFor(page, name)).toHaveCount(0)
})

test('паспорт лаунжа правится из реестра, непочатый замок формы показывает новое значение', async ({
  page,
  watched,
}) => {
  const name = `Passport-${Math.random().toString(36).slice(2, 10)}`
  await openRegistry(page, watched)

  // ── Лаунж настоящим путём «Add lounge»: предзаполнение + первая ссылка ────
  // Тройка производных — из справочника по коду (см. первый тест создания).
  await page.getByRole('button', { name: 'Add lounge' }).click()
  await page.getByLabel('Name*', { exact: true }).fill(name)
  await page.getByLabel('IATA code*', { exact: true }).fill('IST')
  await expect(page.getByText('from directory: IST')).toBeVisible()
  await expect(page.getByLabel('City*', { exact: true })).toHaveValue('Istanbul')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const fillUrl = await page.locator('.al-url').inputValue()
  expect(fillUrl).toMatch(/\/f\/.+/)
  await page.getByRole('button', { name: 'Done', exact: true }).click()

  await searchFor(page, name)
  const row = rowFor(page, name)
  await expect(row).toContainText('IST')

  // ── Правка: панель предзаполнена, производные правятся СМЕНОЙ КОДА ────────
  // Код лаунжа (IST) в справочнике, поэтому панель открывается с тройкой
  // read-only: город больше не правят руками — меняют код, и тройка выводится
  // из справочника заново (esb → Ankara / Esenboga International).
  await row.getByRole('button', { name: `Edit passport: ${name}` }).click()
  await expect(row.getByLabel('City*', { exact: true })).toHaveValue('Istanbul')
  await expect(row.getByLabel('City*', { exact: true })).not.toBeEditable()
  await row.getByLabel('IATA code*', { exact: true }).fill('esb') // нормализуется в ESB
  await expect(row.getByText('from directory: ESB')).toBeVisible()
  await expect(row.getByLabel('City*', { exact: true })).toHaveValue('Ankara')
  await row.getByRole('button', { name: 'Save', exact: true }).click()

  // Успех виден строкой БЕЗ перезагрузки (revalidatePath после result.ok) —
  // и это сервер, а не состояние клиента: перечитанная страница говорит то же.
  await expect(row.locator('.ep-panel')).toHaveCount(0)
  await expect(row).toContainText('ESB')
  await expect(row).toContainText('Ankara')
  await page.reload()
  await expect(rowFor(page, name)).toContainText('ESB')
  await expect(rowFor(page, name)).toContainText('Ankara')

  // ИНВЕРСИЯ прежнего пина «четырёхбуквенный код — Save проходит и сервер
  // отказывает словами»: Save теперь выключен, пока код не полон И не найден
  // справочником (клиентская половина ворот, `onResolved`), так что до
  // серверного отказа клик просто не доходит. Сам серверный отказ («IATA
  // code must be 3 letters», неизвестный код) по-прежнему закреплён юнитами
  // (edit-passport.test.ts, manage-actions.test.ts) — действие достижимо по
  // сети напрямую, и ворота там.
  const edited = rowFor(page, name)
  await edited.getByRole('button', { name: `Edit passport: ${name}` }).click()
  await edited.getByLabel('IATA code*', { exact: true }).fill('ESBX')
  await expect(edited.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  // Возврат кода из справочника снова включает Save — панель остаётся
  // открытой для раскрывашки истории ниже.
  await edited.getByLabel('IATA code*', { exact: true }).fill('ESB')
  await expect(edited.getByText('from directory: ESB')).toBeVisible()
  await expect(edited.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()

  // ── История правок — раскрывашка панели, запись old→new ──────────────────
  await edited.getByRole('button', { name: 'Edit history' }).click()
  await expect(edited.locator('.se-history-list')).toContainText('City: Istanbul → Ankara')
  await expect(edited.locator('.se-history-list')).toContainText('IATA code: IST → ESB')
  await expect(edited.locator('.se-history-actor').first()).toContainText(SEED_REVIEWER_EMAIL)

  // ── Форма заполнения: непочатый замок стоит С НОВЫМ значением ─────────────
  // Оператор ответы не трогал, поэтому синхронизация провела правку в анкету:
  // поле показывает Ankara/ESB и ОСТАЁТСЯ под замком (ответ снова дословно
  // равен колонке — правило `lockedIdentityKeys`, не назначенный флаг).
  await page.goto(fillUrl)
  await expect(
    page.getByRole('heading', { name: 'Lounge Profile & Commercial Details' }),
  ).toBeVisible()
  await expect(page.getByLabel(/City/)).toHaveValue('Ankara')
  await expect(page.getByLabel(/City/)).not.toBeEditable()
  await expect(page.getByLabel(/IATA Code/)).toHaveValue('ESB')
  await expect(page.getByLabel(/IATA Code/)).not.toBeEditable()
  // Все четыре замка на месте (provider пуст — колонка ничего не замыкает),
  // название — редактируемое, с именем из паспорта.
  await expect(page.locator('.field-locked-note')).toHaveCount(4)
  await expect(page.getByLabel(/Lounge Full Name/)).toHaveValue(name)
  await expect(page.getByLabel(/Lounge Full Name/)).toBeEditable()
})

test('выгрузка уходит с текущим фильтром: состав строк меняется вместе с ним, непринятые — только по явной ссылке', async ({
  page,
  watched,
}) => {
  const fleet = seedFleet('export')
  await openRegistry(page, watched)

  // Пока фильтра нет, ссылки «все лаунжи» нет: она отдала бы байт в байт тот
  // же файл, что «Excel, incl. unapproved», различаясь только подписью.
  await expect(
    page.getByRole('link', { name: 'Excel, all lounges incl. unapproved', exact: true }),
  ).toHaveCount(0)

  await searchFor(page, fleet.base)

  // Прогон засеял ровно три лаунжа со своим базовым именем: основной
  // (черновик анкеты) и два флотских (анкет нет вовсе).
  await expect(page.locator('tbody tr')).toHaveCount(3)

  /** Скачивает по ссылке и возвращает файл. Ссылки выгрузки несут ту же
   *  строку запроса, из которой построена страница, — это и проверяется. */
  const download = async (name: string) => {
    const [file] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name, exact: true }).click(),
    ])
    return file
  }

  // ── CSV (умолчание — только принятые): честный ноль ──────────────────────
  // Ни одна анкета прогона не принята, поэтому файл — ОДНА строка заголовков.
  // Это не вырожденный случай, а само правило умолчания: непринятые данные в
  // смежной системе неотличимы от проверенных (`buildFlatRows`), и лаунж без
  // принятой анкеты по умолчанию не уезжает вовсе. План проверял только имя
  // файла — файл с этими тремя лаунжами внутри прошёл бы так же.
  const csv = await download('CSV')
  expect(csv.suggestedFilename()).toBe('lounges.csv')
  const csvText = readFileSync(await csv.path(), 'utf8')
  expect(csvText.startsWith('\ufeff')).toBe(true) // BOM — решение Task 5
  const lines = csvText.trim().split('\r\n')
  expect(lines[0]).toContain('Lounge Name')
  expect(lines).toHaveLength(1)
  expect(csvText).not.toContain(fleet.base)

  // ── «Excel, incl. unapproved» — реестр как есть, тем же фильтром ──────────
  // Имена строк читаются из КОЛОНКИ, найденной по заголовку, а не по номеру:
  // сдвиг колонок — отдельный класс дефекта, закрытый в roundtrip.test.ts.
  const namesInXlsx = async (link = 'Excel, incl. unapproved'): Promise<string[]> => {
    const file = await download(link)
    expect(file.suggestedFilename()).toBe('lounges.xlsx')
    const book = await read(readFileSync(await file.path()))
    const sheet = book.worksheets[0]!
    let nameColumn = 0
    sheet.getRow(1).eachCell((cell, column) => {
      if (cell.value === 'Lounge Name') nameColumn = column
    })
    expect(nameColumn, 'колонка «Lounge Name» в заголовке').toBeGreaterThan(0)
    const names: string[] = []
    sheet.eachRow((row, index) => {
      if (index > 1) names.push(String(row.getCell(nameColumn).value ?? ''))
    })
    return names
  }

  // По поиску: все три лаунжа прогона, включая оба вовсе без анкет — те едут
  // «паспортом» (имя, аэропорт, статус) с пустыми ячейками анкеты.
  const searched = await namesInXlsx()
  expect(searched.sort()).toEqual([fleet.base, fleet.iga, fleet.marhaba])

  // Сузить фильтр — и СОСТАВ СТРОК файла меняется вместе со страницей, а не
  // только имя файла: та же ссылка после фильтра по зоне отдаёт один лаунж.
  await filterBar(page).getByLabel('Zone').selectOption('arrival')
  await expect(page).toHaveURL(/zone=arrival/)
  await expect(rowFor(page, fleet.base)).toHaveCount(1)

  const filtered = await namesInXlsx()
  expect(filtered).toEqual([fleet.iga])

  // ── «Все лаунжи целиком» — вторая половина строки спецификации ───────────
  // Страница сужена до одной строки, а файл по этой ссылке несёт все три
  // лаунжа прогона: фильтр ссылке не передаётся. Superset, не равенство —
  // дев-база копит лаунжи прошлых прогонов, и их состав тесту не принадлежит.
  const everything = await namesInXlsx('Excel, all lounges incl. unapproved')
  expect(everything).toEqual(
    expect.arrayContaining([fleet.base, fleet.iga, fleet.marhaba]),
  )
  expect(everything.length).toBeGreaterThan(filtered.length)
})
