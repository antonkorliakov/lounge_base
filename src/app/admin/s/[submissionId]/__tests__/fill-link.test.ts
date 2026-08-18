import { eq } from 'drizzle-orm'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import type { SubmissionStatus } from '@/db/schema'
import { lounges, submissions, fieldValues, fillTokens } from '@/db/schema'
import { FIELDS, BLOCKS } from '@/form-schema'
import { raiseFlag, resolveFlag, openFlags } from '@/review/flags'
import { confirmBlock } from '@/review/blocks'
import { resolveFillToken } from '@/access/tokens'
import type { OutgoingMail } from '@/notify/messages'

/**
 * Куда и как уходит ссылка заполнения — оба оставшихся пути:
 *
 *  - `copyFillLinkAction` — ручная выдача ревьюеру (кнопка копирования у
 *    названия лаунжа). Пришла на смену пересылке письмом
 *    (`resendFillLinkAction`), и главное её свойство — ПОЧТА НЕ УЧАСТВУЕТ НИ
 *    В ОДНОЙ ВЕТКЕ: «дай мне ссылку» не превращается в отправку письма и
 *    после настройки SMTP. Это свойство здесь закреплено нарочно в среде С
 *    настроенной почтой — иначе тест доказывал бы лишь «в среде без SMTP
 *    письма нет», что верно для чего угодно.
 *  - `requestChangesAction` — уведомление об уже состоявшемся решении, единый
 *    почтовый хвост (`sendFillLink`): письмо с реальным числом замечаний,
 *    а без SMTP или при упавшей отправке — ссылка на экран с честным notice.
 *
 * Проверяются сами действия, а не только построители писем. Утверждение,
 * которое здесь важно, — «какое письмо ушло и ушло ли вообще», и оно живёт
 * ровно в этом файле: `src/notify/__tests__/messages.test.ts` может доказать,
 * что `fillLinkMail` ничего не выдумывает, но не то, что действие выбирает
 * именно его (или не зовёт почту вовсе). Ровно та же граница, из-за которой
 * тест маршрута загрузки фото (`src/app/api/photos/__tests__/upload-route.test.ts`)
 * проверяет маршрут, а не `clearFlagsFor`: не хватало не построителя, а того,
 * кто его позовёт.
 *
 * Замокано четыре модуля и ни одного больше:
 *  - `@/db/client` — на PGlite-стенд с настоящими миграциями (тот же приём и
 *    тот же стенд, что у теста маршрута фото). `issueFillToken`, `openFlags`,
 *    `raiseFlag`, чтение статуса и `II.1.3` работают по-настоящему.
 *  - `@/access/session` — `requireSession` иначе полез бы в `next/headers` за
 *    cookie, которых вне запроса не существует; авторизация проверяющего к
 *    этому дефекту не относится.
 *  - `next/cache` — `revalidatePath` вне рантайма Next не имеет смысла (само
 *    `copyFillLinkAction` его и не вызывает, но модуль его импортирует).
 *  - `@/notify/mailer` — почтальон копит письма вместо отправки, а
 *    `mailDelivers` отвечает по `holder.smtpConfigured` (настоящий читает
 *    `SMTP_URL` процесса — состояние среды, а не теста). Сами письма строят
 *    настоящие `changesRequestedMail`/`fillLinkMail`, поэтому тест видит
 *    именно тот текст, который получил бы оператор.
 */
const holder = vi.hoisted(() => ({
  db: undefined as Db | undefined,
  sent: [] as { to: string; subject: string; text: string }[],
  /** Отправка падает при настроенном SMTP — жёсткий отказ провайдера в момент
   *  `send` (боевой случай: Resend в тестовом режиме доставляет только на
   *  адрес владельца аккаунта). Что обязано произойти — последний describe:
   *  выписанная ссылка возвращается на экран, а не объявляется потерянной. */
  failSend: false,
  /** Что отвечает `mailDelivers()`: true — среда с настоящим SMTP (письма
   *  доставляются), false — сегодняшний бой (`SMTP_URL` пуст, ссылка обязана
   *  вернуться на экран). Оба режима закреплены. */
  smtpConfigured: true,
}))

vi.mock('@/db/client', () => ({
  db: (): Db => {
    if (!holder.db) throw new Error('test db not ready')
    return holder.db
  },
  createDb: (): Db => {
    if (!holder.db) throw new Error('test db not ready')
    return holder.db
  },
}))

vi.mock('@/access/session', () => ({
  requireSession: async () => ({ memberId: 'member-1', email: 'reviewer@easyto.travel' }),
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('@/notify/mailer', () => ({
  mailDelivers: () => holder.smtpConfigured,
  createMailer: () => ({
    async send(message: OutgoingMail): Promise<void> {
      // Отказ ИМЕННО отправки, а не построения почтальона: `createMailer` может
      // бросить и сам (нет `MAIL_FROM` при заданном `SMTP_URL` — см.
      // `notify/mailer.ts`), но для вызывающего это один и тот же случай, он
      // ловит оба одним `try`.
      if (holder.failSend) throw new Error('smtp is down')
      holder.sent.push(message)
    },
  }),
}))

const { copyFillLinkAction, requestChangesAction, approveAction } = await import('../actions')

const OPERATOR_EMAIL = 'operations@primeclass.test'
/** II.1.3 — Email Address - Lounge Operations Manager, единственное поле,
 *  которое читает `contactEmail`. */
const CONTACT_FIELD = 'II.1.3'

async function seed(
  db: Db,
  options: {
    status: SubmissionStatus
    contact?: string | null
    /** Сколько замечаний открыть. Ключи берутся из схемы, а не пишутся руками:
     *  `raiseFlag` отказывает на неизвестном ключе. */
    flags?: number
    /** Снять все открытые замечания сразу после того, как их поставили —
     *  состояние «заполняющий всё исправил, но заново не отправил». */
    resolveAll?: boolean
  },
): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({
      name: 'Primeclass Lounge',
      country: 'Turkey',
      city: 'Istanbul',
      airport: 'Istanbul Airport',
      iataCode: 'IST',
    })
    .returning()
  const [submission] = await db
    .insert(submissions)
    .values({ loungeId: lounge!.id, status: options.status })
    .returning()
  const submissionId = submission!.id

  const contact = options.contact === undefined ? OPERATOR_EMAIL : options.contact
  if (contact !== null) {
    await db.insert(fieldValues).values({ submissionId, fieldKey: CONTACT_FIELD, value: contact })
  }

  for (const field of FIELDS.slice(0, options.flags ?? 0)) {
    const raised = await raiseFlag(db, {
      submissionId,
      fieldKey: field.key,
      reason: 'needs_detail',
      comment: `fix ${field.key}`,
      reviewer: 'reviewer@easyto.travel',
    })
    expect(raised.ok, `raiseFlag(${field.key})`).toBe(true)
  }

  if (options.resolveAll) {
    for (const flag of await openFlags(db, submissionId)) {
      await resolveFlag(db, flag.id)
    }
    expect(await openFlags(db, submissionId)).toEqual([])
  }

  return submissionId
}

/** Свежие ссылки анкеты. Сырой токен нигде не хранится (только его SHA-256),
 *  поэтому «выписан ли токен» проверяется по числу строк, а «рабочая ли
 *  ссылка» — прогоном токена из URL через `resolveFillToken`. */
async function tokenCount(db: Db, submissionId: string): Promise<number> {
  const rows = await db
    .select({ submissionId: fillTokens.submissionId })
    .from(fillTokens)
    .where(eq(fillTokens.submissionId, submissionId))
  return rows.length
}

function onlyMail(): { to: string; subject: string; text: string } {
  expect(holder.sent).toHaveLength(1)
  return holder.sent[0]!
}

/** Токен из ссылки (письма или результата) — последний сегмент `/f/<token>`. */
function tokenFromUrl(text: string): string {
  const match = /\/f\/([A-Za-z0-9_-]+)/.exec(text)
  expect(match, `нет ссылки /f/<token>:\n${text}`).not.toBeNull()
  return match![1]!
}

describe('copyFillLinkAction: ссылка выдаётся ревьюеру, почта не участвует вовсе', () => {
  beforeEach(async () => {
    holder.db = await createTestDb()
    holder.sent = []
    holder.failSend = false
    // Нарочно среда С НАСТРОЕННОЙ почтой: главное утверждение этого describe —
    // действие не шлёт письма не потому, что нечем или некому, а по
    // устройству («дай мне ссылку», не «отправь»). В среде без SMTP пустой
    // `sent` не доказывал бы ничего.
    holder.smtpConfigured = true
  })

  it('анкета на проверке: отказ с объяснением, ни письма, ни нового токена', async () => {
    const db = holder.db!
    const submissionId = await seed(db, { status: 'submitted', flags: 1 })

    const result = await copyFillLinkAction(submissionId)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    // Проверяющему говорится и почему нельзя, и что делать вместо этого:
    // вернуть на правку — единственный путь, которым ссылка снова начнёт
    // открывать форму.
    expect(result.error.en).toMatch(/under review/i)
    expect(result.error.en).toMatch(/Request changes/)
    expect(result.error.ru).toMatch(/на проверке/)

    // Ничего не произошло — ни письма, ни доступа. Токен, выписанный за
    // отказанное действие, был бы живой ссылкой, о которой никто не знает.
    expect(holder.sent).toEqual([])
    expect(await tokenCount(db, submissionId)).toBe(0)
  })

  it('принятая анкета: свой отказ, без совета вернуть её на правку', async () => {
    const db = holder.db!
    const submissionId = await seed(db, { status: 'approved' })

    const result = await copyFillLinkAction(submissionId)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.en).toMatch(/approved/i)
    // Из `approved` `requestChanges` не работает вовсе (`REVIEW_STATUSES` —
    // только `submitted`), так что предлагать это здесь означало бы послать
    // проверяющего в тупик.
    expect(result.error.en).not.toMatch(/Request changes/)

    expect(holder.sent).toEqual([])
    expect(await tokenCount(db, submissionId)).toBe(0)
  })

  it('возвращённая анкета: РАБОЧАЯ ссылка в результате, письма нет — хотя почта настроена и адресат есть', async () => {
    const db = holder.db!
    // Контактная почта на месте, SMTP настроен: у пересылки письмом здесь
    // ушло бы письмо. У копирования не должно — это и есть разница действий.
    const submissionId = await seed(db, { status: 'changes_requested', flags: 2 })

    const result = await copyFillLinkAction(submissionId)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    // Ссылка не «похожа на ссылку», а открывает ЭТУ анкету: токен из URL
    // проходит настоящий resolveFillToken по настоящей строке fill_tokens.
    expect(await resolveFillToken(db, tokenFromUrl(result.fillUrl))).toEqual({ submissionId })
    expect(await tokenCount(db, submissionId)).toBe(1)

    // ГЛАВНЫЙ пин файла: почтальон не звался ни в одной ветке.
    expect(holder.sent).toEqual([])
  })

  it('черновик без контактной почты: ссылка выдаётся — адресат действию не нужен', async () => {
    const db = holder.db!
    // Ровно боевой случай, ради которого ручная выдача и существует: лаунж
    // заведён, оператор ещё не открывал форму (II.1.3 пуст), ссылка истекла.
    // У пересылки письмом это был отказ «нет контактной почты»; у копирования
    // адресата нет по устройству, и отказ оставил бы анкету навсегда
    // недоступной — за ссылкой снова пришлось бы ходить скриптом.
    const submissionId = await seed(db, { status: 'draft', contact: null })

    const result = await copyFillLinkAction(submissionId)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(await resolveFillToken(db, tokenFromUrl(result.fillUrl))).toEqual({ submissionId })
    expect(holder.sent).toEqual([])
  })

  it('без SMTP поведение то же самое: у действия просто нет почтовой ветки', async () => {
    const db = holder.db!
    holder.smtpConfigured = false
    const submissionId = await seed(db, { status: 'draft' })

    const result = await copyFillLinkAction(submissionId)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(await resolveFillToken(db, tokenFromUrl(result.fillUrl))).toEqual({ submissionId })
    expect(holder.sent).toEqual([])
  })

  it('повторный вызов выписывает НОВУЮ ссылку, прежняя продолжает работать', async () => {
    const db = holder.db!
    const submissionId = await seed(db, { status: 'draft' })

    const first = await copyFillLinkAction(submissionId)
    const second = await copyFillLinkAction(submissionId)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error('unreachable')

    // Токены не отзываются (`issueFillToken` — хранится только хэш, отзывать
    // нечего): обе ссылки живут свой TTL, и интерфейс не вправе утверждать
    // обратного. Обе — разные и обе открывают эту анкету.
    expect(second.fillUrl).not.toBe(first.fillUrl)
    expect(await resolveFillToken(db, tokenFromUrl(first.fillUrl))).toEqual({ submissionId })
    expect(await resolveFillToken(db, tokenFromUrl(second.fillUrl))).toEqual({ submissionId })
    expect(await tokenCount(db, submissionId)).toBe(2)
  })

  it('несуществующая анкета: отказ, а не токен в никуда', async () => {
    const result = await copyFillLinkAction('00000000-0000-0000-0000-000000000000')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.en).toBe('Submission not found')
    expect(holder.sent).toEqual([])
  })
})

/**
 * `requestChangesAction` слал `changesRequestedMail` безусловно — и это, в
 * отличие от упразднённой пересылки, стоит за настоящим переходом, так что
 * «возврат был» тут правда. Ложью могло
 * стать число: открытые замечания читались ДО `requestChanges`, отдельным
 * незаблокированным запросом, и в письмо ставилось именно то, докоммитное
 * число (см. `sendFillLink`). Теперь и выбор письма, и число берутся из одного
 * чтения после коммита.
 *
 * Проверяется наблюдаемое следствие: письмо о возврате называет столько
 * замечаний, сколько их в анкете, и уходит именно оно.
 */
describe('requestChangesAction: письмо о возврате называет реальное число замечаний', () => {
  beforeEach(async () => {
    holder.db = await createTestDb()
    holder.sent = []
    holder.failSend = false
    holder.smtpConfigured = true
  })

  it('два открытых замечания — «2 answer(s)», и ссылка ведёт на эту анкету', async () => {
    const db = holder.db!
    const submissionId = await seed(db, { status: 'submitted', flags: 2 })

    const result = await requestChangesAction(submissionId)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // Уведомления быть не должно: оно означает «решение состоялось, а письмо
    // не ушло» (см. `ActionResult`). И ссылки быть не должно — она ушла
    // письмом, экрану ревьюера её не полагается (см. `FillLinkActionResult`).
    expect(result.notice).toBeUndefined()
    expect(result.fillUrl).toBeUndefined()

    const mail = onlyMail()
    expect(mail.to).toBe(OPERATOR_EMAIL)
    expect(mail.subject).toMatch(/changes requested/i)
    expect(mail.text).toContain('2 answer(s) need a correction')
    expect(mail.text).not.toContain('0 answer(s)')
    expect(await resolveFillToken(db, tokenFromUrl(mail.text))).toEqual({ submissionId })

    // И переход действительно состоялся — иначе утверждения выше говорили бы о
    // письме, отправленном ни по какому поводу.
    const [row] = await db
      .select({ status: submissions.status })
      .from(submissions)
      .where(eq(submissions.id, submissionId))
    expect(row?.status).toBe('changes_requested')
  })

  // Чего здесь НЕТ, и не по забывчивости: хвоста `fillLinkMail` при нуле
  // замечаний. После ухода пересылки письмом он достижим только гонкой —
  // второй проверяющий снимает последнее замечание в окне между коммитом
  // `requestChanges` и чтением `flagCount` (см. `sendFillLink`), — а гонку из
  // теста действия не поставить: `requestChanges` с нулём замечаний отказывает
  // до письма (закреплено ниже). Правило «письмо не говорит „0 answer(s)“»
  // держится на самом условии `flagCount > 0` и его комментарии.
  it('отказанный переход не шлёт письма и не выписывает токен', async () => {
    const db = holder.db!
    // Ни одного замечания — `requestChanges` откажет (`decide.ts`).
    const submissionId = await seed(db, { status: 'submitted' })

    const result = await requestChangesAction(submissionId)

    expect(result.ok).toBe(false)
    expect(holder.sent).toEqual([])
    expect(await tokenCount(db, submissionId)).toBe(0)
  })
})

/**
 * Среда, где почта НЕ доставляется (`SMTP_URL` пуст — сегодняшний бой), для
 * решений с почтовым хвостом. Найденный пользователем дефект: уведомление
 * печаталось консольным почтальоном в stdout, ревьюер видел чистый успех, а
 * единственный экземпляр ссылки (хранится только хэш) уходил в лог, который
 * никто не смотрит. Правило теперь такое: ссылка возвращается в результате
 * действия (`fillUrl`) и попадает на экран ревьюера, а notice говорит, что
 * письма НЕ БЫЛО.
 */
describe('без SMTP: решения кладут ссылку на экран, а не в stdout', () => {
  beforeEach(async () => {
    holder.db = await createTestDb()
    holder.sent = []
    holder.failSend = false
    holder.smtpConfigured = false
  })

  it('возврат на правку: переход состоялся, ссылка на экран, письмо не выдумано', async () => {
    const db = holder.db!
    const submissionId = await seed(db, { status: 'submitted', flags: 2 })

    const result = await requestChangesAction(submissionId)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    // Переход — настоящий и уже закоммичен: ссылка с экрана откроет оператору
    // именно экран правок, а не форму, которой «вернули» только на словах.
    const [row] = await db
      .select({ status: submissions.status })
      .from(submissions)
      .where(eq(submissions.id, submissionId))
    expect(row?.status).toBe('changes_requested')

    expect(await resolveFillToken(db, tokenFromUrl(result.fillUrl!))).toEqual({ submissionId })
    expect(holder.sent).toEqual([])
    // Раньше эта ветка показывала чистый успех — ревьюер считал оператора
    // уведомлённым. Теперь notice говорит, что письма НЕ ушло, и что ссылку
    // надо вручить самому.
    expect(result.notice?.en).toMatch(/NOT emailed/i)
    expect(result.notice?.ru).toMatch(/НЕ ушло/)
  })

  it('принятие: notice говорит, что оператор не уведомлён (ссылки у принятия нет)', async () => {
    const db = holder.db!
    const submissionId = await seed(db, { status: 'submitted' })
    // `approveSubmission` требует 27/27 подтверждённых блоков — подтверждаются
    // настоящим `confirmBlock`, тем же, каким пользуется экран.
    for (const block of BLOCKS) {
      const confirmed = await confirmBlock(db, {
        submissionId,
        blockKey: block.key,
        reviewer: 'reviewer@easyto.travel',
      })
      expect(confirmed.ok, `confirmBlock(${block.key})`).toBe(true)
    }

    const result = await approveAction(submissionId)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // У `approvedMail` нет ссылки, так что показывать нечего — но «письмо
    // ушло» больше не выдумывается: раньше `notifyOrNotice` молча пропускал
    // консольного почтальона и ревьюер видел чистый успех.
    expect(result.notice?.en).toMatch(/not configured/i)
    expect(result.notice?.ru).toMatch(/не настроена/)
    expect(holder.sent).toEqual([])
  })
})

/**
 * SMTP настроен, а отправка ПАДАЕТ. Боевой повод: Resend в тестовом режиме
 * (`MAIL_FROM=onboarding@resend.dev`, домен не подтверждён) доставляет только
 * на адрес владельца аккаунта — письмо оператору провайдер отклоняет в момент
 * отправки, и повтор падает вечно. Та же форма у любого жёсткого отказа:
 * опечатка в relay, домен получателя отвергнут на SMTP-времени.
 *
 * Прежнее поведение было тупиком: «письмо не отправилось, попробуйте снова» —
 * а токен к этому моменту уже выписан, хранится только его хэш, и ссылки не
 * существовало больше нигде. Правило теперь то же, что у среды без SMTP:
 * выписанная рабочая ссылка не объявляется потерянной, пока она в руках, — она
 * возвращается на экран (`shown`, причина `send_failed`), а notice говорит,
 * что письмо НЕ ушло, и ссылку надо вручить самому.
 *
 * Текст notice ОБЯЗАН отличаться от «почта не настроена»: ревьюер должен
 * видеть разницу между «эта среда не шлёт вообще» и «отправка только что
 * упала». Закреплено not-match'ами на текст соседней ветки.
 *
 * Проверяется здесь, а не в e2e: из браузера этот случай недостижим (e2e-среда
 * без SMTP идёт веткой `mail_not_configured`), а тесты построителей писем не
 * знают, как действие поступает с исключением.
 */
describe('SMTP настроен, но отправка упала: ссылка возвращается на экран', () => {
  beforeEach(async () => {
    holder.db = await createTestDb()
    holder.sent = []
    holder.failSend = true
    holder.smtpConfigured = true
  })

  it('возврат на правку: переход закоммичен, ссылка на экран, notice не притворяется, что возврат не удался', async () => {
    const db = holder.db!
    const submissionId = await seed(db, { status: 'submitted', flags: 2 })

    // Сбой попадает в лог (`console.error` в `sendFillLink`) — глушится, чтобы
    // ожидаемая ошибка не читалась в выводе теста как настоящая.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await requestChangesAction(submissionId)

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')

      // Переход состоялся ДО письма и не откатывается из-за него: упавшая
      // отправка — проблема доставки, а не свидетельство неверного решения
      // (см. `createMailer`'s комментарий в `notify/mailer.ts`).
      const [row] = await db
        .select({ status: submissions.status })
        .from(submissions)
        .where(eq(submissions.id, submissionId))
      expect(row?.status).toBe('changes_requested')

      expect(await resolveFillToken(db, tokenFromUrl(result.fillUrl!))).toEqual({ submissionId })

      // «Сохранено.» — тем же словом, что у соседних notice действий с уже
      // закоммиченной транзакцией; причина — упавшее письмо, не «не настроена».
      expect(result.notice?.en).toMatch(/^Saved\./)
      expect(result.notice?.en).toMatch(/failed to send/i)
      expect(result.notice?.ru).toMatch(/^Сохранено\./)
      expect(result.notice?.ru).toMatch(/не отправилось/)
      expect(result.notice?.ru).not.toMatch(/не настроена/)

      // Сбой не проглочен молча — он в логе сервера.
      expect(errors).toHaveBeenCalled()
    } finally {
      // Тест, который трогает общий `holder`, убирает за собой сам, а не
      // полагается на `beforeEach` соседа.
      holder.failSend = false
      errors.mockRestore()
    }

    expect(holder.sent).toEqual([])
  })
})
