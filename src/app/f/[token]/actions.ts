'use server'

import { db } from '@/db/client'
import { resolveFillToken } from '@/access/tokens'
import { saveServiceValue } from '@/submissions/values'
import { submitSubmission } from '@/submissions/transitions'
import { saveOperatorField } from '@/registry/manage'
import { searchAirports, type AirportSearchResult } from '@/registry/directory'
import { clearFlagAfterSave } from '@/app/clear-flag-after-save'
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

  // Не голый `saveFieldValue`, а дверь оператора (`saveOperatorField`,
  // `src/registry/manage.ts`): производные поля паспорта (I.7/I.8/I.9)
  // отказываются ЗДЕСЬ, на сервере, — прежний замок был только в UI, а
  // действие достижимо по сети напрямую; код IATA (I.10) пишется через
  // справочник и в одной транзакции переписывает выведенную тройку.
  const result = await saveOperatorField(db(), {
    submissionId: resolved.submissionId,
    fieldKey,
    value,
  })
  if (!result.ok) return { ok: false, error: result.error }

  // Исправленный ответ снимает своё замечание и подтверждение своего блока:
  // ревьюер посмотрит его заново, остальное останется подтверждённым. Сбой
  // этого шага не отменяет успех записи — см. `clearFlagAfterSave`.
  // По КАЖДОМУ записанному ключу (`savedKeys`): исправленный код IATA
  // переписал и тройку, значит отвечает и на замечание «не та страна» —
  // замечания по I.7–I.9 снимаются той же правкой кода.
  for (const savedKey of result.savedKeys) {
    await clearFlagAfterSave(resolved.submissionId, savedKey)
  }
  return { ok: true }
}

/**
 * Поиск по справочнику аэропортов для комбобокса исправления кода IATA на
 * стороне ЗАПОЛНЕНИЯ (экран правок и основной проход без замка). Свой,
 * токен-скоупный вход, а не `searchAirportsAction` кабинета: у оператора нет
 * сессии, а `requireSession` — первый оператор того действия. Ворота — тот же
 * fill-токен, что у всех действий этого файла: справочник — публичные данные
 * (те же строки видит любой админ), но анонимных входов у формы заполнения
 * нет ни одного, и посточка «кто может дёргать поиск» остаётся той же, что у
 * остальной поверхности заполнения — держатель живой ссылки. Невалидный
 * токен — пустой ответ, той же формы, что «ничего не найдено»: поиск ничего
 * не пишет, и различать «ссылка мертва» и «нет совпадений» здесь незачем
 * (сохранение по мёртвой ссылке откажет само). Вся семантика поиска — в
 * `searchAirports` (`registry/directory.ts`), как у кабинета: правило одно.
 */
export async function searchAirportsFillAction(
  token: string,
  query: string,
): Promise<AirportSearchResult> {
  const resolved = await resolveFillToken(db(), token)
  if (!resolved) return { rows: [], more: false }
  return searchAirports(db(), query)
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
