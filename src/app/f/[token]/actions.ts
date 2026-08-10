'use server'

import { db } from '@/db/client'
import { resolveFillToken } from '@/access/tokens'
import { saveFieldValue, saveServiceValue } from '@/submissions/values'
import { submitSubmission } from '@/submissions/transitions'
import type { Localized, ServiceValueInput } from '@/form-schema'

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
export type ActionResult = { ok: true } | { ok: false; error: Localized }

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

  const result = await saveFieldValue(db(), {
    submissionId: resolved.submissionId,
    fieldKey,
    value,
  })
  return result.ok ? { ok: true } : { ok: false, error: result.error }
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
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

export async function submitAction(token: string): Promise<ActionResult> {
  const resolved = await resolveFillToken(db(), token)
  if (!resolved) return DENIED

  const result = await submitSubmission(db(), {
    submissionId: resolved.submissionId,
    actor: 'filler',
  })
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}
