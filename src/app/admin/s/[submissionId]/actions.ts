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
import { createMailer } from '@/notify/mailer'
import { changesRequestedMail, approvedMail } from '@/notify/messages'
import { issueFillToken } from '@/access/tokens'

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

export async function requestChangesAction(
  submissionId: string,
): Promise<ActionResult> {
  const session = await requireSession()
  const flags = await openFlags(db(), submissionId)
  const result = await requestChanges(db(), { submissionId, reviewer: session.email })
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/admin/s/${submissionId}`)

  const notice = await notifyOrNotice(submissionId, async (to) => {
    const { token } = await issueFillToken(db(), { submissionId, ttlDays: 30 })
    const base = process.env.APP_URL ?? 'http://localhost:3000'
    await createMailer().send(
      changesRequestedMail({
        to,
        loungeName: await loungeName(submissionId),
        fillUrl: `${base}/f/${token}`,
        flagCount: flags.length,
      }),
    )
  })

  return notice ? { ok: true, notice } : { ok: true }
}

/**
 * Переслать оператору свежую ссылку. Единственный способ восстановить доступ:
 * истёкшие ссылки не оживляются, а конкретную утёкшую отозвать нельзя, потому
 * что сырой токен не хранится.
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

  const { token } = await issueFillToken(db(), { submissionId, ttlDays: 30 })
  const base = process.env.APP_URL ?? 'http://localhost:3000'

  try {
    await createMailer().send(
      changesRequestedMail({
        to,
        loungeName: await loungeName(submissionId),
        fillUrl: `${base}/f/${token}`,
        flagCount: (await openFlags(db(), submissionId)).length,
      }),
    )
  } catch (err) {
    console.error(`[admin/s/${submissionId}] failed to resend fill link mail`, err)
    return {
      ok: true,
      notice: {
        en: 'A new link was created, but the email failed to send. Try again shortly.',
        ru: 'Новая ссылка создана, но письмо не отправилось. Попробуйте снова через некоторое время.',
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
