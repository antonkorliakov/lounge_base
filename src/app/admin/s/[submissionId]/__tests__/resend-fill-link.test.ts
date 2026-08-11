import { eq } from 'drizzle-orm'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import type { SubmissionStatus } from '@/db/schema'
import { lounges, submissions, fieldValues, fillTokens } from '@/db/schema'
import { FIELDS } from '@/form-schema'
import { raiseFlag, resolveFlag, openFlags } from '@/review/flags'
import { resolveFillToken } from '@/access/tokens'
import type { OutgoingMail } from '@/notify/messages'

/**
 * «Переслать ссылку» отправляло `changesRequestedMail` безусловно, без всякой
 * оглядки на статус анкеты: на анкете в `submitted` оператор получал письмо
 * «<Лаунж> — changes requested» с телом «N answer(s) need a correction.
 * Everything else is accepted» — про возврат, которого не было, — и ссылку,
 * открывающую экран `form.closed` (`FillForm`'s `EDITABLE_STATUSES`), то есть
 * форму, в которой нечего исправлять. При нуле открытых замечаний письмо
 * вдобавок сообщало «0 answer(s) need a correction».
 *
 * Проверяется само действие, а не только построители писем. Утверждение,
 * которое здесь важно, — «какое письмо ушло и ушло ли вообще», и оно живёт
 * ровно в этом файле: `src/notify/__tests__/messages.test.ts` может доказать,
 * что `fillLinkMail` ничего не выдумывает, но не то, что действие выбирает
 * именно его. Ровно та же граница, из-за которой тест маршрута загрузки фото
 * (`src/app/api/photos/__tests__/upload-route.test.ts`) проверяет маршрут, а не
 * `clearFlagsFor`: не хватало не построителя, а того, кто его позовёт.
 *
 * Замокано четыре модуля и ни одного больше:
 *  - `@/db/client` — на PGlite-стенд с настоящими миграциями (тот же приём и
 *    тот же стенд, что у теста маршрута фото). `issueFillToken`, `openFlags`,
 *    `raiseFlag`, чтение статуса и `II.1.3` работают по-настоящему.
 *  - `@/access/session` — `requireSession` иначе полез бы в `next/headers` за
 *    cookie, которых вне запроса не существует; авторизация проверяющего к
 *    этому дефекту не относится.
 *  - `next/cache` — `revalidatePath` вне рантайма Next не имеет смысла (само
 *    `resendFillLinkAction` его и не вызывает, но модуль его импортирует).
 *  - `@/notify/mailer` — почтальон копит письма вместо отправки. Сами письма
 *    строят настоящие `changesRequestedMail`/`fillLinkMail`, поэтому тест
 *    видит именно тот текст, который получил бы оператор.
 */
const holder = vi.hoisted(() => ({
  db: undefined as Db | undefined,
  sent: [] as { to: string; subject: string; text: string }[],
  /** Отправка падает — единственный сбой, который этот код обязан отличать от
   *  «отправлять некому» (см. последний сценарий). */
  failSend: false,
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

const { resendFillLinkAction, requestChangesAction } = await import('../actions')

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
 *  ссылка» — прогоном токена из письма через `resolveFillToken`. */
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

/** Токен из ссылки письма — последний сегмент `/f/<token>`. */
function tokenFromMail(text: string): string {
  const match = /\/f\/([A-Za-z0-9_-]+)/.exec(text)
  expect(match, `в письме нет ссылки /f/<token>:\n${text}`).not.toBeNull()
  return match![1]!
}

describe('resendFillLinkAction: письмо описывает тот экран, который откроет ссылка', () => {
  beforeEach(async () => {
    holder.db = await createTestDb()
    holder.sent = []
    holder.failSend = false
  })

  it('анкета на проверке: отказ с объяснением, ни письма, ни нового токена', async () => {
    const db = holder.db!
    const submissionId = await seed(db, { status: 'submitted', flags: 1 })

    const result = await resendFillLinkAction(submissionId)

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

    const result = await resendFillLinkAction(submissionId)

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

  it('возвращённая анкета с открытыми замечаниями: письмо о правках, ссылка рабочая', async () => {
    const db = holder.db!
    const submissionId = await seed(db, { status: 'changes_requested', flags: 2 })

    const result = await resendFillLinkAction(submissionId)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.notice?.en).toContain(OPERATOR_EMAIL)

    // Единственное состояние, в котором `changesRequestedMail` правдиво: возврат
    // был, замечания открыты, и ссылка откроет экран правок.
    const mail = onlyMail()
    expect(mail.to).toBe(OPERATOR_EMAIL)
    expect(mail.subject).toMatch(/changes requested/i)
    expect(mail.text).toContain('2 answer(s) need a correction')

    // И ссылка в письме действительно открывает ЭТУ анкету, а не просто
    // выглядит как ссылка.
    expect(await tokenCount(db, submissionId)).toBe(1)
    expect(await resolveFillToken(db, tokenFromMail(mail.text))).toEqual({ submissionId })
  })

  it('черновик: письмо просто с ссылкой, без выдуманного возврата на правку', async () => {
    const db = holder.db!
    const submissionId = await seed(db, { status: 'draft' })

    const result = await resendFillLinkAction(submissionId)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    // Тот самый случай, ради которого кнопка и появилась: ссылка на черновике
    // истекла до отправки. Отказывать здесь (гейт «только changes_requested»)
    // означало бы закрыть дефект вместе с главным применением кнопки.
    const mail = onlyMail()
    expect(mail.subject).not.toMatch(/changes requested/i)
    expect(mail.text).not.toMatch(/correction|accepted/i)
    expect(await resolveFillToken(db, tokenFromMail(mail.text))).toEqual({ submissionId })
  })

  it('возвращённая анкета, где все замечания уже сняты: не «0 answer(s) need a correction»', async () => {
    const db = holder.db!
    const submissionId = await seed(db, {
      status: 'changes_requested',
      flags: 1,
      resolveAll: true,
    })

    const result = await resendFillLinkAction(submissionId)

    expect(result.ok).toBe(true)
    // Заполняющий уже исправил всё, но заново не отправил: `FillForm` покажет
    // ему полную форму (экран правок гейтится на `flags.length > 0`), так что
    // письмо про «что отмечено» было бы про пустое множество.
    const mail = onlyMail()
    expect(mail.text).not.toContain('0 answer(s)')
    expect(mail.subject).not.toMatch(/changes requested/i)
    expect(await resolveFillToken(db, tokenFromMail(mail.text))).toEqual({ submissionId })
  })

  it('порядок отказов: статус проверяется раньше контактной почты', async () => {
    const db = holder.db!
    const submissionId = await seed(db, { status: 'submitted', contact: null })

    const result = await resendFillLinkAction(submissionId)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    // Оба условия нарушены. Сказать про отсутствующий `II.1.3` на анкете,
    // которую оператор всё равно не может открыть, значит послать проверяющего
    // исправлять не то.
    expect(result.error.en).toMatch(/under review/i)
    expect(result.error.en).not.toMatch(/II\.1\.3/)
  })

  it('несуществующая анкета: отказ, а не письмо в никуда', async () => {
    const result = await resendFillLinkAction('00000000-0000-0000-0000-000000000000')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.en).toBe('Submission not found')
    expect(holder.sent).toEqual([])
  })

  it('анкета, которую можно править, но без контактной почты: отказ, и токен не выписан', async () => {
    const db = holder.db!
    const submissionId = await seed(db, { status: 'draft', contact: null })

    const result = await resendFillLinkAction(submissionId)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.en).toContain('II.1.3')
    expect(holder.sent).toEqual([])
    expect(await tokenCount(db, submissionId)).toBe(0)
  })

  /**
   * Упавшая отправка — ОТКАЗ, а не `ok: true` с уведомлением, и это единственное
   * место, где пересылка расходится с `requestChangesAction`/`approveAction`.
   * У тех `notice` рядом с `ok: true` значит ровно одно: «решение по анкете
   * состоялось (транзакция закоммичена), а уведомление о нём не ушло». У
   * пересылки решения нет — письмо и есть всё её действие, так что не ушедшее
   * письмо это «не произошло ничего», и показывать его как успех значило бы
   * сказать проверяющему, что у оператора появилась ссылка, которой у него нет.
   *
   * Проверяется здесь, потому что этот случай недостижим ни из браузера (e2e не
   * видит письма вовсе — консольный почтальон не печатает тело), ни из тестов
   * построителей: он про то, как действие поступает с исключением, а не про то,
   * какой текст сложился.
   */
  it('письмо не отправилось: отказ, а не успех с уведомлением', async () => {
    const db = holder.db!
    const submissionId = await seed(db, { status: 'changes_requested', flags: 1 })
    holder.failSend = true

    // Сбой попадает в лог (`console.error` в самом действии) — глушится, чтобы
    // ожидаемая ошибка не читалась в выводе теста как настоящая.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await resendFillLinkAction(submissionId)

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.error.en).toMatch(/no new link/i)
      expect(result.error.ru).toMatch(/новой ссылки у оператора нет/)
      expect(errors).toHaveBeenCalled()
    } finally {
      // Тест, который трогает общий `holder`, убирает за собой сам, а не
      // полагается на `beforeEach` соседа — тот же приём, что у `holder.broken`
      // в тесте маршрута фото.
      holder.failSend = false
      errors.mockRestore()
    }

    expect(holder.sent).toEqual([])
  })
})

/**
 * Тот же дефект с другой стороны. `requestChangesAction` слал
 * `changesRequestedMail` тоже безусловно — и это, в отличие от пересылки,
 * стоит за настоящим переходом, так что «возврат был» тут правда. Ложью могло
 * стать число: открытые замечания читались ДО `requestChanges`, отдельным
 * незаблокированным запросом, и в письмо ставилось именно то, докоммитное
 * число (см. `sendFillLink`). Теперь и выбор письма, и число берутся из одного
 * чтения после коммита, и оба действия ходят одним путём.
 *
 * Проверяется наблюдаемое следствие: письмо о возврате называет столько
 * замечаний, сколько их в анкете, и уходит именно оно.
 */
describe('requestChangesAction: письмо о возврате называет реальное число замечаний', () => {
  beforeEach(async () => {
    holder.db = await createTestDb()
    holder.sent = []
    holder.failSend = false
  })

  it('два открытых замечания — «2 answer(s)», и ссылка ведёт на эту анкету', async () => {
    const db = holder.db!
    const submissionId = await seed(db, { status: 'submitted', flags: 2 })

    const result = await requestChangesAction(submissionId)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // Уведомления быть не должно: оно означает «решение состоялось, а письмо
    // не ушло» (см. `ActionResult`).
    expect(result.notice).toBeUndefined()

    const mail = onlyMail()
    expect(mail.to).toBe(OPERATOR_EMAIL)
    expect(mail.subject).toMatch(/changes requested/i)
    expect(mail.text).toContain('2 answer(s) need a correction')
    expect(mail.text).not.toContain('0 answer(s)')
    expect(await resolveFillToken(db, tokenFromMail(mail.text))).toEqual({ submissionId })

    // И переход действительно состоялся — иначе утверждения выше говорили бы о
    // письме, отправленном ни по какому поводу.
    const [row] = await db
      .select({ status: submissions.status })
      .from(submissions)
      .where(eq(submissions.id, submissionId))
    expect(row?.status).toBe('changes_requested')
  })

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
