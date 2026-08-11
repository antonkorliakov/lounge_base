'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { requireSession } from '@/access/session'
import { setOperationalStatus, statusHistory } from '@/registry/status'
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

/**
 * Запись истории смен статуса — в готовом для показа виде: статусы остаются
 * id (подписи у клиента уже есть пропсом `statuses`, см. `StatusEditor`), а
 * `at` отдаётся ISO-строкой, потому что клиенту от момента смены нужен только
 * день, а гонять `Date` через сериализацию действия — лишний договор.
 */
export type StatusHistoryEntry = {
  from: OperationalStatus | null
  to: OperationalStatus
  until: string | null
  comment: string | null
  actor: string
  at: string
}

/**
 * История смен эксплуатационного статуса лаунжа — для раскрывашки в редакторе
 * статуса. `statusHistory` (`src/registry/status.ts`) существовал и был
 * покрыт тестами, но не имел ни одного вызывающего в продукте (дефект I2
 * ревью): историю писали при каждой смене — и никто не мог её открыть.
 *
 * Читается ПО ЗАПРОСУ (клик по раскрывашке), а не в строках реестра: реестр
 * — сотни лаунжей, и грузить N историй ради страницы, где ни одна может не
 * понадобиться, — это N лишних запросов на показ.
 *
 * `requireSession()` — первым оператором, как у всех действий кабинета: это
 * чтение чужих решений и адресов почты (actor), fill-токену оно не положено.
 */
export async function statusHistoryAction(
  loungeId: string,
): Promise<StatusHistoryEntry[]> {
  await requireSession()

  const changes = await statusHistory(db(), loungeId)
  return changes.map((change) => ({
    from: change.from,
    to: change.to,
    until: change.until,
    comment: change.comment,
    actor: change.actor,
    at: change.at.toISOString(),
  }))
}
