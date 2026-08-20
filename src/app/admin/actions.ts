'use server'

import { revalidatePath } from 'next/cache'
import { del } from '@vercel/blob'
import { db } from '@/db/client'
import { requireSession } from '@/access/session'
import { setOperationalStatus, statusHistory } from '@/registry/status'
import {
  createLounge,
  deleteLounge,
  updateLoungePassport,
  passportHistory,
  type CreateLoungeInput,
} from '@/registry/manage'
import {
  lookupAirport,
  searchAirports,
  type DirectoryEntry,
  type AirportSearchResult,
} from '@/registry/directory'
import type { Localized } from '@/form-schema'
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

/**
 * Подсказка справочника аэропортов для форм паспорта (`PassportFieldsEditor`):
 * по полному коду IATA — аэропорт/город/страна или честное `found: null`.
 * Ровно ПОДСКАЗКА: серверные ворота — в `resolveIdentity`
 * (`registry/manage.ts`), которая при сохранении выводит тройку заново;
 * это действие ничего не пишет. `requireSession()` — первым оператором,
 * как у всех действий кабинета: справочник публичных тайн не хранит, но
 * анонимных входов у кабинета нет ни одного, и этот не станет первым.
 * Нормализация кода — внутри `lookupAirport` (единственный `normalizeIata`).
 */
export async function lookupIataAction(
  iata: string,
): Promise<{ found: DirectoryEntry | null }> {
  await requireSession()
  return { found: await lookupAirport(db(), iata) }
}

/**
 * Поиск по справочнику для комбобокса «Найти аэропорт» тех же форм паспорта.
 * Вся семантика (ярусы, ворота 2 знаков, limit+1) — в `searchAirports`
 * (`registry/directory.ts`): правило одно и живёт там, действие — только
 * сессионные ворота. `requireSession()` первым оператором — те же доводы,
 * что у `lookupIataAction` строкой выше. Ничего не пишет; выбор из списка
 * лишь ставит код в поле, а заполнение тройки идёт тем же `lookupIataAction`.
 */
export async function searchAirportsAction(
  query: string,
): Promise<AirportSearchResult> {
  await requireSession()
  return searchAirports(db(), query)
}

/**
 * Не общий `ActionResult`, потому что успех здесь НЕСЁТ ДАННЫЕ — готовую
 * ссылку заполнения. Ошибочная половина — тот же контракт (весь `Localized`,
 * клиент выбирает через `pick()`).
 */
export type CreateLoungeActionResult =
  | { ok: true; fillUrl: string }
  | { ok: false; error: Localized }

/**
 * Завести лаунж из реестра и получить его ПЕРВУЮ ссылку заполнения.
 *
 * Возвращает готовый URL, а не сырой токен: базовый адрес — знание сервера
 * (`APP_URL`, тот же откат на localhost, что у `sendFillLink` и действий
 * входа), и клиенту, которому нужно ровно «что вставить оператору в письмо»,
 * отдаётся ровно это. Показывается ссылка ОДИН раз: хранится только хэш
 * токена (`issueFillToken`), повторно показать её неоткуда — интерфейс
 * обязан сказать это словами (см. `AddLounge`).
 *
 * `requireSession()` — первым оператором, как у всех действий кабинета.
 * Валидация полей — внутри `createLounge`: правило одно и живёт там.
 * `revalidatePath` — после успеха: новый лаунж обязан появиться в реестре
 * тем же механизмом, каким `setStatusAction` показывает смену статуса.
 */
export async function createLoungeAction(
  input: CreateLoungeInput,
): Promise<CreateLoungeActionResult> {
  await requireSession()

  const result = await createLounge(db(), input)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/admin')
  const base = process.env.APP_URL ?? 'http://localhost:3000'
  return { ok: true, fillUrl: `${base}/f/${result.token}` }
}

/**
 * Править паспорт лаунжа из реестра. Общий `ActionResult` (успех данных не
 * несёт), `requireSession()` первым оператором, `revalidatePath` только после
 * успеха — все три решения и их доводы те же, что у `setStatusAction` выше.
 * Валидация и вся семантика (какие ответы анкет следуют за колонками) — внутри
 * `updateLoungePassport`: правило одно и живёт в `registry/manage.ts`.
 */
export async function updatePassportAction(
  loungeId: string,
  input: CreateLoungeInput,
): Promise<ActionResult> {
  const session = await requireSession()

  const result = await updateLoungePassport(db(), {
    ...input,
    loungeId,
    actor: session.email,
  })
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/admin')
  return { ok: true }
}

/**
 * Запись истории правок паспорта — в готовом для показа виде, тот же контракт,
 * что у `StatusHistoryEntry`: `at` — ISO-строкой (клиенту нужен день), колонки
 * остаются машинными именами, подписи к ним у клиента уже есть (те же шесть
 * полей, которыми рисуется форма правки, — см. `EditPassport`).
 */
export type PassportHistoryEntry = {
  actor: string
  at: string
  changes: { column: string; from: string | null; to: string | null }[]
}

/**
 * История правок паспорта — для раскрывашки в панели правки. Читается ПО
 * ЗАПРОСУ (клик), не в строках реестра, и требует сессии — те же доводы, что
 * у `statusHistoryAction` выше. Отдельное действие, а не расширение того:
 * события разной формы читаются разными читателями (см. `passportHistory`
 * в `registry/manage.ts` — почему правки паспорта не в `statusHistory`).
 */
export async function passportHistoryAction(
  loungeId: string,
): Promise<PassportHistoryEntry[]> {
  await requireSession()

  const edits = await passportHistory(db(), loungeId)
  return edits.map((edit) => ({
    actor: edit.actor,
    at: edit.at.toISOString(),
    changes: edit.changes,
  }))
}

/**
 * Удалить лаунж из реестра. Ворота — название, набранное руками, и сверяет
 * его СЕРВЕР (`deleteLounge`): выключенная кнопка диалога — подсказка, а не
 * защита (правило ветки — серверное действие достижимо по сети напрямую).
 *
 * Блобы снимков чистятся ПОСЛЕ коммита и best-effort — тот же выбор и та же
 * причина, что у `DELETE /api/photos`: строка (здесь — весь граф лаунжа) уже
 * удалена, и превращать сбой чистки хранилища в «удаление не удалось» было
 * бы ложью, из-за которой человек пытался бы удалить уже несуществующее.
 * Упавший `del` оставляет блобы-орфаны — лишние байты в хранилище, не дыра;
 * `del` принимает массив URL-ов (проверено по типам @vercel/blob), пустой
 * массив не отправляется — нечего.
 */
export async function deleteLoungeAction(
  loungeId: string,
  confirmName: string,
): Promise<ActionResult> {
  await requireSession()

  const result = await deleteLounge(db(), { loungeId, confirmName })
  if (!result.ok) return { ok: false, error: result.error }

  if (result.photoUrls.length > 0) {
    try {
      await del(result.photoUrls)
    } catch (err) {
      console.error(`[admin] lounge ${loungeId} deleted, blob cleanup failed`, err)
    }
  }

  revalidatePath('/admin')
  return { ok: true }
}
