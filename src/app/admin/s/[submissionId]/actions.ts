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
import { copyLinkGateFor, reviewStateFor } from './gates'

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
 * Результат `requestChangesAction` — единственного действия, из которого
 * ссылка заполнения может уйти ПИСЬМОМ: тот же `ActionResult`, но успех МОЖЕТ
 * нести готовый URL. Половина с `fillUrl` — сознательное зеркало
 * `CreateLoungeActionResult` (`src/app/admin/actions.ts`), а не
 * третья форма «успеха с данными»: то же решение «сервер отдаёт готовый URL
 * (`APP_URL` — знание сервера), а не сырой токен», см. комментарий там.
 * Не сам `CreateLoungeActionResult`, по двум различиям по существу: здесь
 * успех БЕЗ URL — норма, а не вырожденный случай (почта настроена, письмо
 * ушло — ссылка на экране ревьюера была бы лишней экспозицией живого
 * доступа, который оператор уже получил в почту), и здесь есть `notice`.
 *
 * `fillUrl` появляется в одном РОДЕ случаев: письмо до оператора не дошло, а
 * ссылка уже выписана и существует только здесь (хранится лишь хэш, см.
 * `issueFillToken`) — вручить её больше некому, кроме экрана. Случая таких
 * два, и различает их notice, а не тип: почта не доставляет вовсе
 * (`mailDelivers()` — false) либо отправка упала при настроенном SMTP
 * (хвост `send_failed` в `sendFillLink`). Рядом с `fillUrl` всегда стоит
 * `notice`, говорящий, что письма НЕ БЫЛО и почему, — сам URL этого не
 * говорит.
 *
 * У `copyFillLinkAction` тип свой (`CopyFillLinkResult`, см. там): его успех
 * ВСЕГДА несёт URL и никогда — `notice`, и общий optional-тип на оба действия
 * заставил бы клиента обрабатывать состояния, которых у копирования не бывает.
 */
export type FillLinkActionResult =
  | { ok: true; notice?: Localized; fillUrl?: string }
  | { ok: false; error: Localized }

const NO_CONTACT_EMAIL_NOTICE: Localized = {
  en: 'Saved. No contact email on file (II.1.3) — the operator was not notified.',
  ru: 'Сохранено. Нет контактной почты (II.1.3) — оператор не уведомлён.',
}

/**
 * Уведомление не ушло, а следующего шага ПИСЬМОМ в интерфейсе больше нет:
 * кнопка «Переслать ссылку» убрана вместе со всей почтовой пересылкой (её
 * заменила кнопка копирования у названия лаунжа — `copyFillLinkAction`, см.
 * там же, почему это временно про UI, а не про почтовый хвост решений).
 * Поэтому у двух действий концовки разные: у принятия ссылки нет вовсе —
 * уведомление и было всем эффектом письма; у возврата на правку оператору
 * нужен ДОСТУП к правкам, и единственный оставшийся путь к нему — кнопка
 * копирования.
 */
const MAIL_FAILED_NOTICE: Localized = {
  en: 'Saved, but the notification email failed to send — the operator was not notified.',
  ru: 'Сохранено, но письмо с уведомлением не отправилось — оператор не уведомлён.',
}

const RETURNED_MAIL_FAILED_NOTICE: Localized = {
  en: 'Saved, but the notification email failed to send. Get a fresh link with the copy button next to the lounge name and hand it to the operator.',
  ru: 'Сохранено, но письмо с уведомлением не отправилось. Получите свежую ссылку кнопкой копирования у названия лаунжа и передайте её оператору.',
}

/**
 * Два текста об одном и том же состоянии среды (SMTP не настроен), потому что
 * у двух действий разные последствия и разный следующий шаг ревьюера:
 * возврат на правку состоялся и ссылку надо вручить самому; у принятия ссылки
 * нет вовсе, есть лишь неушедшее уведомление. «Сохранено.» стоит там же, где
 * у соседних notice, — у действий, чья транзакция уже закоммичена.
 */
const RETURNED_LINK_NOT_MAILED_NOTICE: Localized = {
  en: 'Saved. Email is not configured on this server, so the operator was NOT emailed — hand them this link yourself:',
  ru: 'Сохранено. Почта на этом сервере не настроена, письмо оператору НЕ ушло — передайте ему эту ссылку сами:',
}

const MAIL_NOT_CONFIGURED_NOTICE: Localized = {
  en: 'Saved. Email is not configured on this server (SMTP_URL) — the operator was not notified.',
  ru: 'Сохранено. Почта на этом сервере не настроена (SMTP_URL) — оператор не уведомлён.',
}

/**
 * Ещё один текст — тот же возврат на правку, но другая причина: SMTP настроен,
 * а отправка УПАЛА (провайдер отверг письмо; или сам `createMailer()` бросил на
 * недостающем `MAIL_FROM` — для ревьюера это одно и то же, см. хвост
 * `send_failed` в `sendFillLink`). Слова другие нарочно: «почта не настроена»
 * значит «эта среда не шлёт вообще» — чинится настройкой среды; «письмо не
 * отправилось» — «шлёт, но сейчас не вышло» — чинится у провайдера. Концовка
 * общая с текстом выше: письма нет, вручить ссылку оператору может только сам
 * ревьюер.
 */
const RETURNED_LINK_SEND_FAILED_NOTICE: Localized = {
  en: 'Saved. The email to the operator failed to send — hand them this link yourself:',
  ru: 'Сохранено. Письмо оператору не отправилось — передайте ему эту ссылку сами:',
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
 *
 * `reason` при `shown` — для текста notice, не для ветвления логики: письма
 * не было либо потому, что эта среда не шлёт вовсе (`mail_not_configured`),
 * либо потому, что отправка при настроенном SMTP упала (`send_failed`).
 * Механика у вызывающих одна (ссылка на экран), а сказать ревьюеру они
 * обязаны разное — «настройте среду» и «сейчас не вышло» требуют разных
 * следующих шагов от того, кто чинит.
 */
type FillLinkOutcome =
  | { outcome: 'mailed'; to: string }
  | { outcome: 'shown'; fillUrl: string; reason: 'mail_not_configured' | 'send_failed' }
  | { outcome: 'no_recipient' }

/**
 * Выписать свежую ссылку заполнения — общая голова обоих путей, которыми она
 * вообще уходит наружу (`sendFillLink` — письмом или показом после возврата
 * на правку; `copyFillLinkAction` — в буфер ревьюера). Сервер отдаёт готовый
 * URL, а не сырой токен: `APP_URL` — знание сервера (то же решение, что у
 * `CreateLoungeActionResult`). Вызывается строго ПОСЛЕ гейтов вызывающего —
 * токен, выписанный за отказанное действие, был бы живым доступом, о котором
 * никто не знает.
 */
async function mintFillUrl(submissionId: string): Promise<string> {
  const base = process.env.APP_URL ?? 'http://localhost:3000'
  const { token } = await issueFillToken(db(), { submissionId, ttlDays: FILL_TOKEN_TTL_DAYS })
  return `${base}/f/${token}`
}

/**
 * Единственное место, откуда ссылка заполнения уходит ПИСЬМОМ, — и там же
 * выбирается, КАК она уходит и каким текстом. Вызывающий остался один:
 * `requestChangesAction`, после уже закоммиченного возврата на правку.
 * (Второй — `resendFillLinkAction` — упразднён вместе с кнопкой «Переслать
 * ссылку»: ручную выдачу ссылки теперь несёт `copyFillLinkAction`, который
 * почту не трогает вовсе, см. его комментарий. Пока вызывающих было два,
 * общие правила жили здесь по одному разу — и это причина, по которой хвосты
 * ниже никуда не переехали: все они по-прежнему достижимы из возврата на
 * правку.)
 *
 * ОДИН поток с двумя хвостами, а не два пути. Голова общая — выписать токен и
 * собрать URL; хвост зависит от того, может ли эта среда вообще доставить
 * письмо (`mailDelivers()` — ЕДИНСТВЕННОЕ определение «SMTP настроен», см.
 * `notify/mailer.ts`; читать `process.env.SMTP_URL` здесь значило бы завести
 * второй экземпляр этого правила):
 *
 *  - почта доставляет — письмо оператору, и ТОЛЬКО здесь действует правило
 *    выбора текста: ПИСЬМО ОПИСЫВАЕТ ТОТ ЭКРАН, КОТОРЫЙ ОТКРОЕТ ССЫЛКА.
 *    Статус к этому моменту всегда `changes_requested` (единственный
 *    вызывающий стоит за состоявшимся переходом — поэтому статус больше не
 *    параметр), и экран различает только число открытых замечаний: есть —
 *    оператора ждёт экран правок (`FixesOnly`), и `changesRequestedMail`
 *    правдиво; нет (сняли между коммитом и этим чтением) — полная форма, и
 *    уходит `fillLinkMail`, которое не утверждает ничего про проверку.
 *    Если отправка ПАДАЕТ, хвост сходит в `shown` — см. комментарий у `try`
 *    ниже: ссылка к этому моменту уже выписана.
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
 * `flagCount` читается ЗДЕСЬ, а не передаётся вызывающим, и это исправление
 * прежней ошибки: `requestChangesAction` читал открытые замечания ДО
 * `requestChanges`, отдельным незаблокированным запросом, а в письмо ставил
 * именно то, докоммитное число. Второй
 * проверяющий, снявший замечание в этом окне, делал письмо неверным в
 * безопасную сторону; поставивший — в опасную: при докоммитном нуле
 * (`requestChanges` под своей блокировкой видит уже поставленное замечание и
 * переход проходит) оператор получал «0 answer(s) need a correction».
 * Чтение после коммита не
 * «правильнее по блокировке» (никакая блокировка тут не помогает, письмо
 * уходит наружу и вне транзакции решения), а правдивее: цифра и формулировка
 * берутся из ОДНОГО чтения, поэтому текст письма не может противоречить
 * числу в нём. Остаточное: между этим чтением и доставкой замечание могут
 * снять — тогда письмо называет число, которое было верным в момент
 * отправки. Закрыть это нечем в принципе, и это не то же самое, что назвать
 * число, которое не было верным никогда.
 */
async function sendFillLink(submissionId: string): Promise<FillLinkOutcome> {
  if (!mailDelivers()) {
    return {
      outcome: 'shown',
      fillUrl: await mintFillUrl(submissionId),
      reason: 'mail_not_configured',
    }
  }

  const to = await contactEmail(submissionId)
  if (to === null) return { outcome: 'no_recipient' }

  const flagCount = (await openFlags(db(), submissionId)).length
  const fillUrl = await mintFillUrl(submissionId)

  // Граница `try` — граница выписки: всё, что падает ПОСЛЕ `issueFillToken`,
  // падает с уже существующей ссылкой на руках, и с этого момента отказ
  // означал бы объявить её потерянной — хранится только хэш, восстановить
  // нечем, а «попробуйте снова» при жёстком отказе провайдера падает вечно
  // (боевой случай: Resend в тестовом режиме доставляет только на адрес
  // владельца аккаунта — письмо оператору отвергается при каждой отправке; та
  // же форма у опечатки в relay или домена, отвергнутого на SMTP-времени).
  // Поэтому упавшая отправка — не ошибка действия, а хвост `shown` с причиной
  // `send_failed`: то же правило честности, что и у ветки без SMTP, — notice
  // говорит, что письма НЕ БЫЛО, и ссылка вручается ревьюеру.
  //
  // Одним `try` ловится и построение почтальона, не только `send`:
  // `createMailer()` бросает синхронно на недостающем `MAIL_FROM`, а
  // `createTransport` может бросить на кривом `SMTP_URL` — ровно то, о чём
  // предупреждает `notify/mailer.ts` («treat construction failures the same
  // way as send failures»). Для ревьюера разницы нет: письма нет, env-переменные
  // с его экрана не чинятся, а ссылка в руках — единственный путь оператора к
  // форме. Громкий отказ здесь не сообщил бы ничего, что можно исправить, —
  // только потерял бы этот путь.
  try {
    const common = { to, loungeName: await loungeName(submissionId), fillUrl }
    await createMailer().send(
      flagCount > 0 ? changesRequestedMail({ ...common, flagCount }) : fillLinkMail(common),
    )
  } catch (err) {
    console.error(
      `[admin/s/${submissionId}] fill link mail failed to send — handing the link back to the reviewer`,
      err,
    )
    return { outcome: 'shown', fillUrl, reason: 'send_failed' }
  }
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
  // транзакция закоммичена, откатывать её из-за письма нечем).
  //
  // Хвост `shown` возвращает ссылку НА ЭКРАН вместе с notice о том, что
  // письма не было — что почта не настроена, что отправка упала: переход
  // состоялся, оператор должен как-то узнать о нём и получить доступ к
  // правкам, и кроме ревьюера вручить ему ссылку некому. Раньше первая из
  // причин тихо печатала письмо в stdout и показывала чистый успех — ревьюер
  // считал оператора уведомлённым, а ссылки не существовало больше нигде;
  // вторая давала notice «попробуйте снова» про уже выписанную ссылку,
  // которую повтор не вернул бы никогда.
  let sent: FillLinkOutcome
  try {
    sent = await sendFillLink(submissionId)
  } catch (err) {
    // Сюда доходят только сбои ДО выписки токена (чтение `II.1.3`,
    // `openFlags`, сама `issueFillToken`): всё после неё `sendFillLink` ловит
    // сам и возвращает ссылку хвостом `shown`/`send_failed`. Ссылки, которую
    // можно было бы вручить, здесь НЕТ — уведомление честно говорит, что
    // письмо не ушло, и называет верный следующий шаг: кнопка копирования
    // выпишет новую.
    console.error(`[admin/s/${submissionId}] failed to send notification mail`, err)
    return { ok: true, notice: RETURNED_MAIL_FAILED_NOTICE }
  }

  switch (sent.outcome) {
    case 'no_recipient':
      return { ok: true, notice: NO_CONTACT_EMAIL_NOTICE }
    case 'shown':
      // Переход уже закоммичен, и обе причины начинаются с «Сохранено.» —
      // упавшее письмо не делает возврат несостоявшимся (см. `ActionResult`).
      return {
        ok: true,
        notice:
          sent.reason === 'send_failed'
            ? RETURNED_LINK_SEND_FAILED_NOTICE
            : RETURNED_LINK_NOT_MAILED_NOTICE,
        fillUrl: sent.fillUrl,
      }
    case 'mailed':
      return { ok: true }
  }
}

/**
 * Результат «дай мне ссылку»: успех ВСЕГДА несёт URL — ссылка и есть всё
 * действие, успеха без неё не бывает (ср. `FillLinkActionResult`, где успех
 * без URL — норма почтового хвоста). `notice` здесь не бывает тоже: notice в
 * этом модуле значит «решение состоялось, а уведомление не ушло», а у этого
 * действия нет ни решения, ни уведомления.
 */
export type CopyFillLinkResult =
  | { ok: true; fillUrl: string }
  | { ok: false; error: Localized }

/**
 * Выписать свежую ссылку заполнения и отдать её ревьюеру — на кнопку
 * копирования у названия лаунжа (`ReviewScreen`). Единственный способ
 * восстановить доступ оператора: истёкшие ссылки не оживляются, а конкретную
 * утёкшую отозвать нельзя, потому что сырой токен не хранится. Прежние
 * ссылки при этом продолжают жить свой TTL — выдача новой ничего не отзывает
 * (`issueFillToken`), и интерфейс не обязан утверждать обратного.
 *
 * Это замена `resendFillLinkAction` — и замена ПО СУЩЕСТВУ, а не переименование:
 * почта из действия убрана совсем, в ЛЮБОЙ среде. Пересылка письмом убрана из
 * интерфейса временно (SMTP в бою так и не настроен, и «Переслать ссылку»
 * превращалась в ритуал из двух шагов: нажать → прочитать «письма не было» →
 * скопировать ссылку из показа), но у этого действия отказ от почты — не
 * следствие среды, а смысл: «дай мне ссылку» останется «дай мне ссылку» и
 * после настройки SMTP. Почтовый хвост при этом жив там, где он и есть
 * уведомление о решении, — в `sendFillLink` у `requestChangesAction` и в
 * `notifyOrNotice` у `approveAction`.
 *
 * Из упразднённой пересылки сюда переехало ровно то, что было правилом о
 * ССЫЛКЕ, а не о письме:
 *
 *  - Гейт по статусу (`copyLinkGateFor` — `EDITABLE_STATUSES`): ссылка обязана
 *    открывать форму, которую оператор может править. Скопировать ссылку на
 *    закрытую форму не полезнее, чем послать её письмом, — по ней открывается
 *    экран `form.closed`. Отказ стоит ДО `issueFillToken` — за отказанное
 *    действие токен не выписывается (лишний живой доступ, выданный молча, —
 *    это не безобидный побочный эффект).
 *  - Гейт В ДВУХ местах, и это не дублирование: здесь — настоящий отказ, на
 *    экране — выключенная кнопка с той же причиной (одно определение и
 *    правила, и текста — `./gates.ts`). `ReviewScreen` — клиентский
 *    компонент, серверное действие вызывается по сети напрямую, так что
 *    кнопка защитой быть не может; а один серверный отказ означал бы, что
 *    проверяющий узнаёт о невозможности шага уже после того, как его сделал.
 *
 * Чего здесь НЕТ, и не по забывчивости:
 *
 *  - Контактной почты (`II.1.3`): она была адресатом письма, а письма нет.
 *    Черновик без контакта — обычный лаунж, который оператор ещё не открывал,
 *    и ровно ему ссылка нужна чаще всего.
 *  - `revalidatePath`: выписанный токен не меняет ничего из того, что экран
 *    показывает (хранится только хэш, счётчиков ссылок на экране нет).
 *  - Показа безопасность не меняет: действие стоит за `requireSession()`,
 *    ссылку получает аутентифицированный ревьюер — тот же человек, которому
 *    её показывали хвосты `shown` пересылки.
 */
export async function copyFillLinkAction(submissionId: string): Promise<CopyFillLinkResult> {
  await requireSession()

  const status = await submissionStatusOf(submissionId)
  if (!status) {
    return {
      ok: false,
      error: { en: 'Submission not found', ru: 'Анкета не найдена' },
    }
  }

  const gate = copyLinkGateFor(status)
  if (!gate.allowed) return { ok: false, error: gate.reason }

  return { ok: true, fillUrl: await mintFillUrl(submissionId) }
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
