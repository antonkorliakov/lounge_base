'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import type { Localized } from '@/form-schema'
import { db } from '@/db/client'
import { requireSession } from '@/access/session'
import { raiseFlag, resolveFlag, openFlags, type FlagReason } from '@/review/flags'
import { confirmBlock, unconfirmBlock } from '@/review/blocks'
import { requestChanges, approveSubmission } from '@/review/decide'
import { submissions, lounges, fieldValues } from '@/db/schema'
import type { SubmissionStatus } from '@/db/schema'
import { createMailer, mailDelivers } from '@/notify/mailer'
import { changesRequestedMail, fillLinkMail, approvedMail } from '@/notify/messages'
import { issueFillToken, FILL_TOKEN_TTL_DAYS } from '@/access/tokens'
import { resendGateFor, reviewStateFor } from './gates'

/**
 * `error` несёт весь `Localized`, а не заранее выбранную строку — то же
 * решение, что и в `src/app/f/[token]/actions.ts` (см. его собственный
 * комментарий): у серверного действия нет надёжного понятия «локаль
 * вызывающего», а клиент уже умеет выбирать через `pick()`.
 *
 * `notice` — не признак отказа. Он появляется только рядом с `ok: true`
 * и сообщает о том, что решение по анкете уже состоялось (транзакция
 * `requestChanges`/`approveSubmission` уже закоммичена), но что-то в шаге
 * "уведомить оператора" пошло не так или вовсе не могло произойти
 * (нет контактной почты). Экран проверки обязан различать это от `error`:
 * решение нельзя откатить из-за упавшего письма (см. `createMailer`'s
 * собственный комментарий в `notify/mailer.ts` — сбой доставки это не
 * повод объявить решение неверным), но ревьюер должен узнать, что письмо
 * не ушло, а не увидеть тихий успех, будто оператор уже уведомлён.
 * `ActionResult` экспортируется (а не дублируется в `ReviewScreen.tsx`),
 * чтобы у этого союза было одно определение, а не два, которые нужно
 * помнить синхронизировать вручную — тот самый класс дефекта, который эта
 * ветка уже несколько раз находила и чинила (см. `FlagResult`/`ConfirmResult`
 * в `review/blocks.ts`/`review/flags.ts`, переиспользующие `SaveResult`, и
 * `blockKeyOf`/`keysOfBlock`, построенные одним проходом в `form-schema`).
 */
export type ActionResult =
  | { ok: true; notice?: Localized }
  | { ok: false; error: Localized }

/**
 * Результат двух действий, из которых наружу уходит ссылка заполнения
 * (`resendFillLinkAction`, `requestChangesAction`): тот же `ActionResult`,
 * но успех МОЖЕТ нести готовый URL. Половина с `fillUrl` — сознательное
 * зеркало `CreateLoungeActionResult` (`src/app/admin/actions.ts`), а не
 * третья форма «успеха с данными»: то же решение «сервер отдаёт готовый URL
 * (`APP_URL` — знание сервера), а не сырой токен», см. комментарий там.
 * Не сам `CreateLoungeActionResult`, по двум различиям по существу: здесь
 * успех БЕЗ URL — норма, а не вырожденный случай (почта настроена, письмо
 * ушло — ссылка на экране ревьюера была бы лишней экспозицией живого
 * доступа, который оператор уже получил в почту), и здесь есть `notice`.
 *
 * `fillUrl` появляется в ОДНОМ случае: почта не может доставить письмо
 * (`mailDelivers()` в `notify/mailer.ts` — false), и вручить ссылку больше
 * некому, кроме экрана. Рядом с ним всегда стоит `notice`, говорящий, что
 * письма НЕ БЫЛО, — сам URL этого не говорит.
 */
export type FillLinkActionResult =
  | { ok: true; notice?: Localized; fillUrl?: string }
  | { ok: false; error: Localized }

const NO_CONTACT_EMAIL_NOTICE: Localized = {
  en: 'Saved. No contact email on file (II.1.3) — the operator was not notified.',
  ru: 'Сохранено. Нет контактной почты (II.1.3) — оператор не уведомлён.',
}

const MAIL_FAILED_NOTICE: Localized = {
  en: 'Saved, but the notification email failed to send. Use "Resend link" to try again.',
  ru: 'Сохранено, но письмо с уведомлением не отправилось. Нажмите «Переслать ссылку», чтобы попробовать снова.',
}

/**
 * Три текста об одном и том же состоянии среды (SMTP не настроен), потому что
 * у трёх действий разные последствия и разный следующий шаг ревьюера:
 * возврат на правку состоялся и ссылку надо вручить самому; пересылка без
 * письма — это только показ ссылки; у принятия ссылки нет вовсе, есть лишь
 * неушедшее уведомление. «Сохранено.» стоит там же, где у соседних notice, —
 * у действий, чья транзакция уже закоммичена.
 */
const RETURNED_LINK_NOT_MAILED_NOTICE: Localized = {
  en: 'Saved. Email is not configured on this server, so the operator was NOT emailed — hand them this link yourself:',
  ru: 'Сохранено. Почта на этом сервере не настроена, письмо оператору НЕ ушло — передайте ему эту ссылку сами:',
}

const LINK_NOT_MAILED_NOTICE: Localized = {
  en: 'Email is not configured on this server, so nothing was sent — hand the operator this link yourself:',
  ru: 'Почта на этом сервере не настроена, письмо не отправлялось — передайте оператору эту ссылку сами:',
}

const MAIL_NOT_CONFIGURED_NOTICE: Localized = {
  en: 'Saved. Email is not configured on this server (SMTP_URL) — the operator was not notified.',
  ru: 'Сохранено. Почта на этом сервере не настроена (SMTP_URL) — оператор не уведомлён.',
}

export async function flagAction(
  submissionId: string,
  fieldKey: string,
  reason: FlagReason | null,
  comment: string,
): Promise<ActionResult> {
  const session = await requireSession()
  const result = await raiseFlag(db(), {
    submissionId, fieldKey, reason, comment, reviewer: session.email,
  })
  revalidatePath(`/admin/s/${submissionId}`)
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

export async function unflagAction(
  submissionId: string,
  flagId: string,
): Promise<ActionResult> {
  await requireSession()
  await resolveFlag(db(), flagId)
  revalidatePath(`/admin/s/${submissionId}`)
  return { ok: true }
}

export async function confirmBlockAction(
  submissionId: string,
  blockKey: string,
): Promise<ActionResult> {
  const session = await requireSession()
  const result = await confirmBlock(db(), {
    submissionId, blockKey, reviewer: session.email,
  })
  revalidatePath(`/admin/s/${submissionId}`)
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

/**
 * Снять подтверждение блока — единственный способ отменить нажатие «Подтвердить
 * блок», и до этого действия его не существовало нигде в продукте:
 * `unconfirmBlock` (`src/review/blocks.ts`) был написан, заблокирован, покрыт
 * тестами и указан в плане — и не имел ни одного вызывающего в приложении. Один
 * промах мыши (диалога нет, отменить нечем) навсегда шёл в счёт 27/27, которые
 * проверяет `approveSubmission`, а обойти это можно было только отметив в блоке
 * какое-нибудь поле, чтобы принятие отказало по замечаниям, а не по
 * подтверждениям. Ровно та же форма, что и `removePhoto` без вызывающих, —
 * дефект, который эта ветка уже находила один раз.
 *
 * Гейт по статусу стоит ЗДЕСЬ, а не в `unconfirmBlock`: тот намеренно без
 * гейта и с сигнатурой `Promise<void>`, в которой отказ невозможно сообщить
 * даже при желании (см. его собственный комментарий и `REVIEW_STATUSES` там
 * же) — гейт внутри него мог бы только молча ничего не сделать. Здесь же
 * канал для отказа есть (`ActionResult`), и правило с текстом берутся из
 * `reviewStateFor(...).decisions` — того же единственного ответа, которым
 * экран проверки выключает эту кнопку и подписывает состояние анкеты. Один
 * источник на обе половины: настоящий отказ на сервере и подсказку в
 * интерфейсе.
 *
 * Чего этот гейт НЕ делает: он не защищает инвариант. Снятие подтверждения
 * безопасно в любом статусе — оно делает анкету МЕНЕЕ подтверждённой, а не
 * более (это и есть довод, по которому `unconfirmBlock` без гейта), так что
 * чтение статуса отдельным незаблокированным `SELECT` перед вызовом — не
 * гонка с последствиями: проскочившее снятие подтверждения на анкете, статус
 * которой сменился в этот момент, ничего не портит. Гейт нужен затем, чтобы
 * экран не предлагал шаг, которого в этом состоянии не бывает, и не отказывал
 * задним числом.
 */
export async function unconfirmBlockAction(
  submissionId: string,
  blockKey: string,
): Promise<ActionResult> {
  await requireSession()

  const status = await submissionStatusOf(submissionId)
  if (!status) {
    return { ok: false, error: { en: 'Submission not found', ru: 'Анкета не найдена' } }
  }

  const gate = reviewStateFor(status).decisions
  if (!gate.allowed) return { ok: false, error: gate.reason }

  await unconfirmBlock(db(), { submissionId, blockKey })
  revalidatePath(`/admin/s/${submissionId}`)
  return { ok: true }
}

async function contactEmail(submissionId: string): Promise<string | null> {
  // II.1.3 — Email Address - Lounge Operations Manager
  const rows = await db()
    .select({ value: fieldValues.value })
    .from(fieldValues)
    .where(
      and(
        eq(fieldValues.submissionId, submissionId),
        eq(fieldValues.fieldKey, 'II.1.3'),
      ),
    )
    .limit(1)

  const value = rows[0]?.value
  return typeof value === 'string' && value.includes('@') ? value : null
}

/**
 * Статус анкеты для решения «что вообще откроет эта ссылка». Читается ОДНИМ
 * обычным `SELECT`, без транзакции и без `FOR UPDATE` — в отличие от
 * `assertEditable`, `lockSubmission` и `confirmBlock`, которые блокируют строку
 * первым же оператором. Разница не в аккуратности, а в том, что здесь нет
 * записи, которую нужно сериализовать против смены статуса: единственное
 * следствие этого действия уходит из базы наружу, письмом. Блокировка строки не
 * дала бы ничего и после коммита: анкету могут отправить (или принять) через
 * секунду после того, как письмо ушло, — то же самое окно, что у любой ссылки,
 * уже лежащей у оператора в почте. Закрыть его может только проверка статуса на
 * стороне заполняющего, и она там есть (`assertEditable` для записи, экран
 * `form.closed` для показа).
 *
 * Чего требует сам гейт (`src/review/__tests__/lock-order-guard.ts`), а не
 * аналогия с ним: блокировки он требует от функции, которая ПИШЕТ в одну из
 * пяти таблиц, от которых зависит правильность решения по анкете
 * (`GUARDED_TABLES`: `field_flags`, `block_reviews`, `field_values`,
 * `service_values`, `photos`). Здесь пишется `fill_tokens` — таблица не из
 * этого списка, и не по недосмотру: ни одно решение (`requestChanges`,
 * `approveSubmission`, `confirmBlock`) её не читает, а токен по устройству
 * ПЕРЕЖИВАЕТ смену статуса — `resolveFillToken` статус не проверяет вовсе, так
 * что «живой токен на анкете, закрытой для правки» это не рассогласование, а
 * нормальное состояние КАЖДОГО токена после отправки анкеты. Инварианта,
 * который блокировка могла бы защитить, тут нет.
 *
 * Направление гонки, раз уж она не закрыта: статус, ставший неподходящим между
 * чтением и письмом, даёт оператору ссылку на форму, которая только что
 * закрылась (он увидит `form.closed` — ровно то же, что при повторном открытии
 * своей прежней ссылки); статус, ставший подходящим, даёт отказ там, где можно
 * было отправить (проверяющий нажмёт ещё раз). Ни одно из двух не отправляет
 * письма, которое было бы неправдой в момент отправки, — а именно это и есть
 * починенный дефект. Гейт не ослаблен: список `GUARDED_TABLES` и правило для
 * `src/review`/`src/submissions`/`src/photos` не тронуты.
 */
async function submissionStatusOf(submissionId: string): Promise<SubmissionStatus | null> {
  const rows = await db()
    .select({ status: submissions.status })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1)
  return rows[0]?.status ?? null
}

async function loungeName(submissionId: string): Promise<string> {
  const rows = await db()
    .select({ name: lounges.name })
    .from(submissions)
    .innerJoin(lounges, eq(submissions.loungeId, lounges.id))
    .where(eq(submissions.id, submissionId))
    .limit(1)
  return rows[0]?.name ?? 'Lounge'
}

/**
 * Уведомление ПОСЛЕ уже состоявшегося решения — сегодня только для
 * `approveAction` (у `requestChangesAction` уведомление несёт ссылку
 * заполнения и потому ходит через `sendFillLink` — общий с пересылкой хвост,
 * см. там). Транзакция решения уже закоммичена к этому моменту (вызывающий
 * уже вернулся из `db.transaction`) — письмо отправляется здесь, СНАРУЖИ той
 * транзакции, а не внутри неё:
 * `createMailer()` может бросить синхронно (нет `MAIL_FROM` при заданном
 * `SMTP_URL`), а `send` не глушит собственный отказ (оба задокументированы
 * в `notify/mailer.ts`). Если бы это было внутри транзакции решения — или
 * между её коммитом и обработкой ошибки без `try`/`catch` — сбой почты
 * стал бы необработанным исключением server action и вернулся бы
 * ревьюеру как голая 500-ошибка Next.js, хотя решение по анкете уже
 * состоялось: экран не сказал бы, зашло оно или нет, и ревьюер не смог бы
 * отличить "ничего не случилось" от "случилось, но я не знаю об этом".
 * Поэтому здесь `try`/`catch`, а не пропуск ошибки наверх: решение остаётся
 * `ok: true`, а сбой уведомления превращается в `notice`, который экран
 * покажет отдельно от `error`.
 */
async function notifyOrNotice(
  submissionId: string,
  send: (to: string) => Promise<void>,
): Promise<Localized | undefined> {
  const to = await contactEmail(submissionId)
  if (!to) return NO_CONTACT_EMAIL_NOTICE

  // Ненастроенная почта — не «отправка удалась» (консольный почтальон пишет
  // в stdout, который никто не читает — см. `mailDelivers`), и не сбой
  // доставки: письмо не отправлялось вовсе. Раньше эта ветка молча проходила
  // через консольный почтальон и ревьюер видел чистый успех, будто оператор
  // уведомлён. Проверка стоит ПОСЛЕ контактной почты: отсутствующий `II.1.3`
  // — дефект данных, который переживёт настройку SMTP, и назвать его важнее.
  if (!mailDelivers()) return MAIL_NOT_CONFIGURED_NOTICE

  try {
    await send(to)
    return undefined
  } catch (err) {
    console.error(`[admin/s/${submissionId}] failed to send notification mail`, err)
    return MAIL_FAILED_NOTICE
  }
}

/**
 * Куда делась только что выписанная ссылка. Один из трёх исходов, и у двух
 * успешных РАЗНЫЕ носители данных не случайно: `mailed` несёт адрес (для
 * «Link sent to …»), но НЕ ссылку — оператор уже получил её письмом, и копия
 * на экране ревьюера была бы лишней экспозицией живого доступа; `shown`
 * несёт ссылку — письма не было, экран остался единственным местом, где она
 * вообще существует (хранится только хэш, см. `issueFillToken`).
 */
type FillLinkOutcome =
  | { outcome: 'mailed'; to: string }
  | { outcome: 'shown'; fillUrl: string }
  | { outcome: 'no_recipient' }

/**
 * Единственное место, откуда наружу уходит ссылка заполнения, — и там же
 * выбирается, КАК она уходит и каким текстом. Оба вызывающих
 * (`requestChangesAction` и `resendFillLinkAction`) ходят через него, потому
 * что правила у них общие, и пока любое из этих правил стояло в двух местах,
 * одно из двух было дефектом (см. историю ниже).
 *
 * ОДИН поток с двумя хвостами, а не два пути. Голова общая — выписать токен и
 * собрать URL; хвост зависит от того, может ли эта среда вообще доставить
 * письмо (`mailDelivers()` — ЕДИНСТВЕННОЕ определение «SMTP настроен», см.
 * `notify/mailer.ts`; читать `process.env.SMTP_URL` здесь значило бы завести
 * второй экземпляр этого правила):
 *
 *  - почта доставляет — письмо оператору, и ТОЛЬКО здесь действует правило
 *    выбора текста: ПИСЬМО ОПИСЫВАЕТ ТОТ ЭКРАН, КОТОРЫЙ ОТКРОЕТ ССЫЛКА (см.
 *    `resendFillLinkAction`'s комментарий — разбор всех трёх состояний).
 *    Выбор `changesRequestedMail`/`fillLinkMail` имеет смысл только для
 *    письма, которое действительно уходит, поэтому и `flagCount` читается
 *    только в этом хвосте.
 *  - почта не доставляет (`SMTP_URL` пуст — сегодняшний бой) — ссылка
 *    возвращается вызывающему и попадает на экран ревьюера (`shown`).
 *    Раньше этот случай молча шёл «почтовым» хвостом: консольный почтальон
 *    печатал письмо в stdout функции, ревьюер читал «Link sent to …», а
 *    ссылка, которой больше нигде нет, уходила в лог, который никто не
 *    смотрит. Найдено пользователем в бою.
 *
 * Контактная почта (`II.1.3`) читается ЗДЕСЬ и только для почтового хвоста:
 * это адресат письма, и больше ничего. Хвосту `shown` адресат не нужен —
 * ссылка вручается ревьюеру на экран, — поэтому анкета без `II.1.3` (обычное
 * дело у черновика, который оператор ещё не начал заполнять) в среде без
 * SMTP получает ссылку, а не отказ. Проверка стоит ДО выписки токена — за
 * несостоявшуюся отправку токен не выписывается (лишний живой доступ,
 * выданный молча, — не безобидный побочный эффект); по той же причине
 * выписка стоит в каждом хвосте своя, а не общим прологом.
 *
 * `flagCount` читается ЗДЕСЬ, а не передаётся вызывающим, и для
 * `requestChangesAction` это исправление той же ошибки с другой стороны: он
 * читал открытые замечания ДО `requestChanges`, отдельным незаблокированным
 * запросом, а в письмо ставил именно то, докоммитное число. Второй
 * проверяющий, снявший замечание в этом окне, делал письмо неверным в
 * безопасную сторону; поставивший — в опасную: при докоммитном нуле
 * (`requestChanges` под своей блокировкой видит уже поставленное замечание и
 * переход проходит) оператор получал «0 answer(s) need a correction» — та же
 * ложь, что и у пересылки, только через гонку. Чтение после коммита не
 * «правильнее по блокировке» (никакая блокировка тут не помогает, письмо
 * уходит наружу и вне транзакции решения), а правдивее: цифра и формулировка
 * берутся из ОДНОГО чтения, поэтому текст письма не может противоречить
 * числу в нём. Остаточное: между этим чтением и доставкой замечание могут
 * снять — тогда письмо называет число, которое было верным в момент
 * отправки. Закрыть это нечем в принципе, и это не то же самое, что назвать
 * число, которое не было верным никогда.
 */
async function sendFillLink(input: {
  submissionId: string
  status: SubmissionStatus
}): Promise<FillLinkOutcome> {
  const base = process.env.APP_URL ?? 'http://localhost:3000'

  if (!mailDelivers()) {
    const { token } = await issueFillToken(db(), {
      submissionId: input.submissionId,
      ttlDays: FILL_TOKEN_TTL_DAYS,
    })
    return { outcome: 'shown', fillUrl: `${base}/f/${token}` }
  }

  const to = await contactEmail(input.submissionId)
  if (to === null) return { outcome: 'no_recipient' }

  const flagCount = (await openFlags(db(), input.submissionId)).length
  const { token } = await issueFillToken(db(), {
    submissionId: input.submissionId,
    ttlDays: FILL_TOKEN_TTL_DAYS,
  })
  const common = {
    to,
    loungeName: await loungeName(input.submissionId),
    fillUrl: `${base}/f/${token}`,
  }

  await createMailer().send(
    input.status === 'changes_requested' && flagCount > 0
      ? changesRequestedMail({ ...common, flagCount })
      : fillLinkMail(common),
  )
  return { outcome: 'mailed', to }
}

export async function requestChangesAction(
  submissionId: string,
): Promise<FillLinkActionResult> {
  const session = await requireSession()
  const result = await requestChanges(db(), { submissionId, reviewer: session.email })
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/admin/s/${submissionId}`)

  // Дальше — только уведомление об УЖЕ состоявшемся решении, и любой его
  // исход это `ok: true` с `notice` (см. `ActionResult`'s комментарий:
  // транзакция закоммичена, откатывать её из-за письма нечем). Статус
  // берётся из результата самого перехода, а не перечитывается: это то
  // состояние, в которое анкету перевела уже закоммиченная транзакция.
  //
  // Хвост `shown` (почта не настроена) возвращает ссылку НА ЭКРАН вместе с
  // notice о том, что письма не было: переход состоялся, оператор должен
  // как-то узнать о нём и получить доступ к правкам, и кроме ревьюера
  // вручить ему ссылку некому. Раньше эта ветка тихо печатала письмо в
  // stdout и показывала чистый успех — ревьюер считал оператора
  // уведомлённым, а ссылки не существовало больше нигде.
  let sent: FillLinkOutcome
  try {
    sent = await sendFillLink({ submissionId, status: result.status })
  } catch (err) {
    console.error(`[admin/s/${submissionId}] failed to send notification mail`, err)
    return { ok: true, notice: MAIL_FAILED_NOTICE }
  }

  switch (sent.outcome) {
    case 'no_recipient':
      return { ok: true, notice: NO_CONTACT_EMAIL_NOTICE }
    case 'shown':
      return { ok: true, notice: RETURNED_LINK_NOT_MAILED_NOTICE, fillUrl: sent.fillUrl }
    case 'mailed':
      return { ok: true }
  }
}

/**
 * Переслать оператору свежую ссылку. Единственный способ восстановить доступ:
 * истёкшие ссылки не оживляются, а конкретную утёкшую отозвать нельзя, потому
 * что сырой токен не хранится.
 *
 * ПИСЬМО ОБЯЗАНО ОПИСЫВАТЬ ТОТ ЭКРАН, КОТОРЫЙ ОТКРОЕТ ЭТА ССЫЛКА. Это и есть
 * правило, по которому здесь всё разложено, и до него действие безусловно
 * отправляло `changesRequestedMail` — письмо «<Лаунж> — changes requested» с
 * телом «N answer(s) need a correction. Everything else is accepted». На анкете
 * в `submitted` каждое из этих утверждений было ложью: возврата на правку не
 * было, ничего не «accepted», а сама ссылка вела на экран `form.closed`
 * (`FillForm`'s `EDITABLE_STATUSES` — `draft`/`changes_requested`), то есть
 * оператор получал письмо с просьбой что-то исправить и ссылку, по которой
 * исправить нельзя ничего. При нуле открытых замечаний оно вдобавок писало
 * «0 answer(s) need a correction».
 *
 * `FillForm` знает три состояния, и разбор ниже — ровно они, один к одному:
 *
 *  1. Статуса нет в `EDITABLE_STATUSES` (`submitted`, `approved`) — ссылка
 *     откроет закрытый экран. Отказ (`ok: false`) с причиной и следующим шагом,
 *     а не письмо: отправить оператору рабочую-на-вид ссылку в мёртвую форму
 *     хуже, чем сказать проверяющему правду. Отказ происходит ДО
 *     `issueFillToken` — за отказанное действие токен не выписывается (лишний
 *     живой доступ, выданный молча, — это не безобидный побочный эффект).
 *  2. `changes_requested` и есть открытые замечания — ссылка откроет экран
 *     правок (`FixesOnly`), и `changesRequestedMail` здесь правдиво по каждому
 *     своему предложению. Это единственное состояние, в котором оно уходит.
 *  3. Иначе (черновик; либо `changes_requested`, где заполняющий уже снял все
 *     замечания, но ещё не отправил анкету заново — `FillForm` показывает ему
 *     полную форму) — `fillLinkMail`, которое не утверждает ничего про
 *     проверку и ничего не считает.
 *
 * Почему НЕ «разрешить пересылку только в `changes_requested`»: черновик — это
 * как раз тот случай, ради которого кнопка и появилась. «Если ссылка на
 * черновике истекла до отправки, восстановление — тоже выдача новой; кнопка
 * „переслать ссылку“ в кабинете нужна» — план проверки, раздел про доступ
 * (`docs/superpowers/plans/2026-08-06-review.md`). Гейт по одному статусу
 * закрыл бы дефект, отняв главное применение кнопки; правило «письмо описывает
 * экран» закрывает его, ничего не отнимая.
 *
 * Гейт стоит В ДВУХ местах, и это не дублирование: здесь — настоящий отказ,
 * а на экране проверки — выключенная кнопка с той же причиной (`resendGateFor`
 * в `./gates.ts` — одно определение и правила, и текста, вызываемое из
 * `./page.tsx` и отсюда). Одного мало ни в какую сторону: `ReviewScreen` —
 * клиентский компонент, серверное действие вызывается по сети напрямую, так
 * что кнопка защитой быть не может; а один серверный отказ означал бы, что
 * проверяющий узнаёт о невозможности шага уже после того, как его сделал.
 *
 * Выбор письма живёт не здесь, а в `sendFillLink` — общем с
 * `requestChangesAction`: у обоих правило одно, и пока оно стояло в двух
 * местах, одно из них было безусловным.
 *
 * Происхождение дефекта, чтобы следующий не искал: он пришёл из образца кода в
 * самом плане (`docs/superpowers/plans/2026-08-06-review.md`, Task 6 —
 * `resendFillLinkAction` там без проверки статуса, с безусловным
 * `changesRequestedMail` и с `ttlDays: 30` литералом в обоих действиях). Это
 * был не промах реализации, а точное исполнение плана, который в другом своём
 * разделе (строка 21, цитата выше — проверена по файлу) сам называет черновик
 * законным случаем пересылки.
 *
 * Порядок проверок: статус — первым, до всего остального. И статусный отказ,
 * и «нет почты (II.1.3)» дают `ok: false`, но «анкета на проверке» говорит
 * проверяющему, что делать дальше (вернуть на правку), а разговор об адресе
 * на анкете, которую всё равно нельзя открыть, послал бы его исправлять не то.
 *
 * В отличие от `requestChangesAction`/`approveAction`, отсутствие контактной
 * почты здесь — настоящий отказ (`ok: false`), а не мягкое уведомление: у
 * этого действия нет решения, которое «состоялось бы» отдельно от письма, —
 * если письмо некому отправлять, действие целиком ничего не сделало. Но отказ
 * этот существует ТОЛЬКО в среде, где письмо вообще отправляется: без SMTP
 * эффект действия — показать ссылку ревьюеру (`shown`), адресат в нём не
 * участвует, и анкета без `II.1.3` — не помеха, а обычный черновик, который
 * оператор ещё не начал заполнять (ровно тот случай, ради которого кнопка и
 * нужна: истёкшая ссылка на пустой анкете). Разница веток — внутри
 * `sendFillLink`, здесь только перевод её исходов в `FillLinkActionResult`.
 */
export async function resendFillLinkAction(
  submissionId: string,
): Promise<FillLinkActionResult> {
  await requireSession()

  const status = await submissionStatusOf(submissionId)
  if (!status) {
    return {
      ok: false,
      error: { en: 'Submission not found', ru: 'Анкета не найдена' },
    }
  }
  // Тот же гейт и тот же текст, что показывает выключенная кнопка на экране
  // проверки (`./page.tsx` -> `ReviewScreen`) — одно определение на оба, см.
  // `./gates.ts`. Клиентский компонент гейтом быть не может, поэтому
  // отказ здесь обязателен, а не дублирует UI.
  const gate = resendGateFor(status)
  if (!gate.allowed) return { ok: false, error: gate.reason }

  let sent: FillLinkOutcome
  try {
    sent = await sendFillLink({ submissionId, status })
  } catch (err) {
    console.error(`[admin/s/${submissionId}] failed to resend fill link mail`, err)
    // Было `ok: true` с уведомлением «A new link was created, but the email
    // failed to send». Изменено на отказ, по двум причинам, и обе — про то же
    // «не утверждать непроверенного».
    //
    // Во-первых, «ссылка создана» этот код проверить больше не может: в `try`
    // теперь и выдача токена, и отправка (см. `sendFillLink`), так что упасть
    // мог любой из шагов.
    //
    // Во-вторых, `notice` рядом с `ok: true` значит здесь ровно одно —
    // «решение по анкете состоялось, а уведомление о нём не ушло» (см.
    // комментарий к `ActionResult` выше). У пересылки решения нет: письмо и
    // есть всё её действие. Не ушло письмо — не произошло ничего, и это тот же
    // довод, по которому отсутствие `II.1.3` выше даёт отказ, а не мягкое
    // уведомление. Лишняя строка в `fill_tokens` (если письмо упало уже после
    // выдачи) проверяющему ничего не говорит и ничего от него не требует —
    // это просто ещё одна живая ссылка на ту же анкету, а они и так не
    // отзываются (см. `issueFillToken`).
    return {
      ok: false,
      error: {
        en: 'The email failed to send — the operator has no new link. Try again shortly.',
        ru: 'Письмо не отправилось — новой ссылки у оператора нет. Попробуйте снова через некоторое время.',
      },
    }
  }

  switch (sent.outcome) {
    case 'no_recipient':
      return {
        ok: false,
        error: {
          en: 'This submission has no contact email (II.1.3)',
          ru: 'У анкеты нет контактной почты (II.1.3)',
        },
      }
    // Почта не настроена: ссылка — на экран, с notice о том, что письма не
    // было. Показ здесь безопасен по той же причине, по какой он обязателен:
    // действие стоит за `requireSession()`, ссылку видит аутентифицированный
    // ревьюер — а письмом она не уходила, так что экран не вторая копия
    // доступа, а единственная (ср. `mailed` ниже, где всё наоборот).
    case 'shown':
      return { ok: true, notice: LINK_NOT_MAILED_NOTICE, fillUrl: sent.fillUrl }
    // Раньше здесь было тихое `{ ok: true }` — ревьюер нажимал «Переслать
    // ссылку», действие срабатывало, и экран не менялся вообще: с точки
    // зрения ревьюера "ничего не произошло" и "письмо ушло" выглядели
    // одинаково. У этого действия нет отдельного видимого эффекта (не
    // появляется новый флаг, блок не меняет цвет) — единственное
    // свидетельство успеха для ревьюера это `notice`. Ссылки в результате
    // НЕТ, и это по существу: оператор получил её письмом, копия на экране
    // ревьюера была бы лишней экспозицией живого доступа.
    case 'mailed':
      return {
        ok: true,
        notice: {
          en: `Link sent to ${sent.to}.`,
          ru: `Ссылка отправлена на ${sent.to}.`,
        },
      }
  }
}

export async function approveAction(submissionId: string): Promise<ActionResult> {
  const session = await requireSession()
  const result = await approveSubmission(db(), { submissionId, reviewer: session.email })
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/admin/s/${submissionId}`)

  const notice = await notifyOrNotice(submissionId, async (to) => {
    await createMailer().send(approvedMail({ to, loungeName: await loungeName(submissionId) }))
  })

  return notice ? { ok: true, notice } : { ok: true }
}
