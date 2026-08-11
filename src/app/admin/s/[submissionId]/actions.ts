'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import type { Localized } from '@/form-schema'
import { db } from '@/db/client'
import { requireSession } from '@/access/session'
import { raiseFlag, resolveFlag, openFlags, type FlagReason } from '@/review/flags'
import { confirmBlock } from '@/review/blocks'
import { requestChanges, approveSubmission } from '@/review/decide'
import { submissions, lounges, fieldValues } from '@/db/schema'
import type { SubmissionStatus } from '@/db/schema'
import { createMailer } from '@/notify/mailer'
import { changesRequestedMail, fillLinkMail, approvedMail } from '@/notify/messages'
import { issueFillToken, FILL_TOKEN_TTL_DAYS } from '@/access/tokens'
import { resendGateFor } from './resend-gate'

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

const NO_CONTACT_EMAIL_NOTICE: Localized = {
  en: 'Saved. No contact email on file (II.1.3) — the operator was not notified.',
  ru: 'Сохранено. Нет контактной почты (II.1.3) — оператор не уведомлён.',
}

const MAIL_FAILED_NOTICE: Localized = {
  en: 'Saved, but the notification email failed to send. Use "Resend link" to try again.',
  ru: 'Сохранено, но письмо с уведомлением не отправилось. Нажмите «Переслать ссылку», чтобы попробовать снова.',
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
 * Возвращает `requestChanges`/`approveSubmission`. Обе транзакции уже
 * закоммичены к этому моменту (вызывающие уже вернулись из `db.transaction`)
 * — письмо отправляется здесь, СНАРУЖИ той транзакции, а не внутри неё:
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

  try {
    await send(to)
    return undefined
  } catch (err) {
    console.error(`[admin/s/${submissionId}] failed to send notification mail`, err)
    return MAIL_FAILED_NOTICE
  }
}

/**
 * Единственное место, откуда наружу уходит ссылка заполнения, — и там же
 * выбирается текст письма. Оба вызывающих (`requestChangesAction` и
 * `resendFillLinkAction`) ходят через него, потому что правило у них одно:
 * ПИСЬМО ОПИСЫВАЕТ ТОТ ЭКРАН, КОТОРЫЙ ОТКРОЕТ ССЫЛКА (см.
 * `resendFillLinkAction`'s комментарий — там разбор всех трёх состояний).
 * Пока выбор письма стоял в двух местах, одно из них было безусловным, и
 * ровно это было дефектом; теперь «какое письмо» решается один раз, из
 * данных, прочитанных здесь же.
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
 * уходит наружу и вне транзакции — см. `notifyOrNotice`), а правдивее: цифра
 * и формулировка берутся из ОДНОГО чтения, поэтому текст письма не может
 * противоречить числу в нём. Остаточное: между этим чтением и доставкой
 * замечание могут снять — тогда письмо называет число, которое было верным в
 * момент отправки. Закрыть это нечем в принципе, и это не то же самое, что
 * назвать число, которое не было верным никогда.
 */
async function sendFillLink(input: {
  submissionId: string
  to: string
  status: SubmissionStatus
}): Promise<void> {
  const flagCount = (await openFlags(db(), input.submissionId)).length
  const { token } = await issueFillToken(db(), {
    submissionId: input.submissionId,
    ttlDays: FILL_TOKEN_TTL_DAYS,
  })
  const base = process.env.APP_URL ?? 'http://localhost:3000'
  const common = {
    to: input.to,
    loungeName: await loungeName(input.submissionId),
    fillUrl: `${base}/f/${token}`,
  }

  await createMailer().send(
    input.status === 'changes_requested' && flagCount > 0
      ? changesRequestedMail({ ...common, flagCount })
      : fillLinkMail(common),
  )
}

export async function requestChangesAction(
  submissionId: string,
): Promise<ActionResult> {
  const session = await requireSession()
  const result = await requestChanges(db(), { submissionId, reviewer: session.email })
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/admin/s/${submissionId}`)

  // Статус берётся из результата самого перехода, а не перечитывается: это то
  // состояние, в которое анкету перевела уже закоммиченная транзакция.
  const notice = await notifyOrNotice(submissionId, (to) =>
    sendFillLink({ submissionId, to, status: result.status }),
  )

  return notice ? { ok: true, notice } : { ok: true }
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
 * в `./resend-gate.ts` — одно определение и правила, и текста, вызываемое из
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
 * Порядок проверок: статус — первым, до контактной почты. Обе дают `ok: false`,
 * но «анкета на проверке» говорит проверяющему, что делать дальше (вернуть на
 * правку), а «нет почты (II.1.3)» на анкете, которую всё равно нельзя открыть,
 * послало бы его исправлять не то.
 *
 * В отличие от `requestChangesAction`/`approveAction`, отсутствие контактной
 * почты здесь — настоящий отказ (`ok: false`), а не мягкое уведомление: у
 * этого действия нет другого эффекта, кроме отправки письма, так что
 * "решение состоялось, уведомление не ушло" неприменимо — если письмо
 * некому отправлять, действие целиком ничего не сделало.
 */
export async function resendFillLinkAction(
  submissionId: string,
): Promise<ActionResult> {
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
  // `./resend-gate.ts`. Клиентский компонент гейтом быть не может, поэтому
  // отказ здесь обязателен, а не дублирует UI.
  const gate = resendGateFor(status)
  if (!gate.allowed) return { ok: false, error: gate.reason }

  const to = await contactEmail(submissionId)
  if (!to) {
    return {
      ok: false,
      error: {
        en: 'This submission has no contact email (II.1.3)',
        ru: 'У анкеты нет контактной почты (II.1.3)',
      },
    }
  }

  try {
    await sendFillLink({ submissionId, to, status })
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

  // Раньше здесь было тихое `{ ok: true }` — ревьюер нажимал «Переслать
  // ссылку», действие срабатывало, и экран не менялся вообще: с точки зрения
  // ревьюера "ничего не произошло" и "письмо ушло" выглядели одинаково.
  // В отличие от `requestChangesAction`/`approveAction`, у этого действия нет
  // отдельного видимого эффекта (не появляется новый флаг, блок не меняет
  // цвет) — единственное свидетельство успеха для ревьюера это `notice`.
  return {
    ok: true,
    notice: {
      en: `Link sent to ${to}.`,
      ru: `Ссылка отправлена на ${to}.`,
    },
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
