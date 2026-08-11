'use server'

import { db } from '@/db/client'
import { resolveFillToken } from '@/access/tokens'
import { saveFieldValue, saveServiceValue } from '@/submissions/values'
import { submitSubmission } from '@/submissions/transitions'
import { clearFlagsFor } from '@/review/flags'
import type { Localized, ServiceValueInput } from '@/form-schema'
import type { MissingItems } from '@/submissions/completeness'

/**
 * `error` carries the full `Localized` pair, not a pre-picked string — a
 * server action has no reliable notion of "the caller's locale" (nothing
 * threads one through here, by design: the client already knows its own
 * locale and already has `pick()`, the one convention this codebase uses
 * everywhere for schema strings; a `locale` parameter on every action would
 * just be a second, redundant way to do the same thing). Picking `.ru` here
 * unconditionally — the previous shape — meant every rejection was Russian
 * regardless of the UI's own locale, defeating the locale switcher for an
 * English-reading operator. The client picks now.
 */
export type ActionResult =
  | { ok: true }
  | {
      ok: false
      error: Localized
      /**
       * Only ever set by `submitAction`'s "still incomplete" refusal — the
       * actual missing field/service/photo keys behind the bare count in
       * `error`, so the client can render a readable list instead of just
       * "12 item(s) still need an answer" (see `submitSubmission` in
       * `src/submissions/transitions.ts`, and Important finding I7 in the
       * whole-branch review).
       */
      missing?: MissingItems
    }

const DENIED: ActionResult = {
  ok: false,
  error: { en: 'This link is invalid or has expired', ru: 'Ссылка недействительна' },
}

/**
 * Снимает замечание по только что исправленному ответу (и подтверждение его
 * блока — см. `clearFlagsFor`). Живёт здесь, а не в
 * `saveFieldValue`/`saveServiceValue`: иначе `submissions` начал бы зависеть
 * от `review`, что запрещено границей модулей. Слой серверных действий и так
 * знает про оба модуля — он и связывает их.
 *
 * **Почему провал этого шага НЕ превращается в отказ действия.** Значение уже
 * записано и закоммичено своей собственной транзакцией; снятие замечания —
 * вторая, отдельная транзакция (`saveFieldValue` и `clearFlagsFor` каждый
 * открывают свою). Транзакции, накрывающей оба вызова, здесь нет и быть не
 * может: обе функции открывают транзакцию внутри себя и не принимают чужой
 * `Tx`, а прокинуть один `Tx` через обе означало бы дать `submissions`
 * доступ к `review` (или наоборот) — ровно ту зависимость, из-за которой эта
 * связка вообще вынесена в слой действий. Так что выбор не между «атомарно»
 * и «нет», а только между двумя способами сообщить о сбое второго шага, и
 * выбран он осознанно:
 *
 *  - Вернуть `{ ok: false }` (или дать исключению уйти наверх) — значит
 *    показать заполняющему ошибку под ответом, который в базе уже лежит
 *    правильным. `queueDrain` (`src/web/useAutosave.ts`) трактует
 *    `{ ok: false }` как окончательный отказ: ключ удаляется из очереди
 *    (повтора не будет), попадает в `rejected`, статус формы становится
 *    `'rejected'` вместо `'saved'`, и `FixesOnly` рисует это сообщение
 *    прямо под полем через свой `errors`. Заполняющий читает «не
 *    сохранилось» про сохранённое и переписывает ответ заново. Исключение
 *    ведёт себя не лучше: `queueDrain` считает его сетевым, оставляет
 *    значение в очереди и показывает `'offline'` — сообщение, которое врёт
 *    о причине.
 *  - Вернуть `{ ok: true }` — значит принять единственное реальное
 *    последствие: на исправленном поле останется висеть замечание ревьюера
 *    (и его блок останется в том же состоянии, что и до правки). Экран
 *    правок продолжит показывать эту карточку — с уже исправленным
 *    значением внутри, — и повторная отправка этим не блокируется
 *    (`submitSubmission` проверяет полноту, а не замечания). Ревьюер увидит
 *    замечание открытым и блок неподтверждённым, то есть посмотрит ответ
 *    заново — консервативная сторона: ничего не теряется и ничто не
 *    выглядит проверенным, не будучи проверенным.
 *
 * Второй вариант и выбран: действие отвечает за ту запись, которую его
 * просили сделать, и она удалась. Сбой глушится здесь, а не уходит наверх,
 * иначе поведением по умолчанию стал бы третий, самый плохой вариант
 * (`'offline'`). `console.error` оставляет его видимым в логах сервера —
 * молчаливой потери нет, просто она не адресована заполняющему, который
 * ничего с ней сделать не может.
 */
async function clearFlagAfterSave(submissionId: string, key: string): Promise<void> {
  try {
    await clearFlagsFor(db(), submissionId, key)
  } catch (error) {
    console.error(
      `[fill] value for ${key} saved, but clearing its flag failed ` +
        `(submission ${submissionId}); the flag stays open for the reviewer`,
      error,
    )
  }
}

/**
 * Every action resolves the fill token itself and derives the submission id
 * from it — none of them accept a submission id from the caller. A client
 * only ever holds a token; trusting a client-supplied submission id would
 * let one filler's browser write into another submission just by editing
 * the request. Since `resolveFillToken` is the only lookup (there is no
 * token-extension function, by design — see `src/access/tokens.ts`), an
 * expired or unknown token uniformly denies here rather than distinguishing
 * "expired" from "never existed", which would leak which is which.
 */
export async function saveFieldAction(
  token: string,
  fieldKey: string,
  value: unknown,
): Promise<ActionResult> {
  const resolved = await resolveFillToken(db(), token)
  if (!resolved) return DENIED

  const result = await saveFieldValue(db(), {
    submissionId: resolved.submissionId,
    fieldKey,
    value,
  })
  if (!result.ok) return { ok: false, error: result.error }

  // Исправленный ответ снимает своё замечание и подтверждение своего блока:
  // ревьюер посмотрит его заново, остальное останется подтверждённым. Сбой
  // этого шага не отменяет успех записи — см. `clearFlagAfterSave`.
  await clearFlagAfterSave(resolved.submissionId, fieldKey)
  return { ok: true }
}

export async function saveServiceAction(
  token: string,
  itemKey: string,
  value: ServiceValueInput,
): Promise<ActionResult> {
  const resolved = await resolveFillToken(db(), token)
  if (!resolved) return DENIED

  const result = await saveServiceValue(db(), {
    submissionId: resolved.submissionId,
    itemKey,
    value,
  })
  if (!result.ok) return { ok: false, error: result.error }

  // Замечание к позиции услуг адресуется её ключом целиком (`FLAGGABLE` в
  // `src/review/flags.ts` не принимает ключи отдельных атрибутов), так что
  // здесь снимается то же самое, что и для поля, — по `itemKey`.
  await clearFlagAfterSave(resolved.submissionId, itemKey)
  return { ok: true }
}

export async function submitAction(token: string): Promise<ActionResult> {
  const resolved = await resolveFillToken(db(), token)
  if (!resolved) return DENIED

  const result = await submitSubmission(db(), {
    submissionId: resolved.submissionId,
    actor: 'filler',
  })
  return result.ok ? { ok: true } : { ok: false, error: result.error, missing: result.missing }
}
