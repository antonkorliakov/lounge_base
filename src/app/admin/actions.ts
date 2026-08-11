'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { requireSession } from '@/access/session'
import { setOperationalStatus } from '@/registry/status'
import type { OperationalStatus } from '@/db/schema'
import type { ActionResult } from './s/[submissionId]/actions'

/**
 * Сменить эксплуатационный статус лаунжа из реестра.
 *
 * Возвращает общий `ActionResult` (импортирован из действий экрана проверки,
 * а не объявлен заново): `error` несёт весь `Localized`, выбирает из него
 * клиент через `pick()`. Образец плана заводил здесь СВОЮ форму результата
 * (`{ ok, error?: string }`) и заранее выбирал `result.error.ru` — русскую
 * строку на экране, который сегодня захардкожен английским; это ровно тот
 * контракт, который финальная волна правок плана 1 уже чинила по всей ветке.
 *
 * `requireSession()` — первым оператором, как у всех семи действий экрана
 * проверки: единственный вход, оператор лаунжа со своим fill-токеном сюда
 * не попадает.
 *
 * `status` типизирован как `OperationalStatus`, но приходит по сети и типом
 * не гарантирован — `setOperationalStatus` сам отвергает неизвестный статус
 * значением, а не падением (см. его проверку `STATUS_META`).
 *
 * `revalidatePath` — только ПОСЛЕ успешной смены, а не безусловно, как в
 * образце (тот вызывал его до чтения `result.ok`): отказанная смена не
 * записала ничего, реестр не изменился, и сбрасывать его кэш — работа без
 * причины. Вреда от лишнего сброса не было бы (следующий показ прочитал бы
 * те же данные), так что это решение об экономии, а не о корректности.
 */
export async function setStatusAction(
  loungeId: string,
  status: OperationalStatus,
  until: string | null,
  comment: string | null,
): Promise<ActionResult> {
  const session = await requireSession()

  const result = await setOperationalStatus(db(), {
    loungeId, status, until, comment, actor: session.email,
  })
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/admin')
  return { ok: true }
}
