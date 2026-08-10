'use server'

import { db } from '@/db/client'
import { resolveFillToken } from '@/access/tokens'
import { saveFieldValue, saveServiceValue } from '@/submissions/values'
import { submitSubmission } from '@/submissions/transitions'
import type { ServiceValueInput } from '@/form-schema'

export type ActionResult = { ok: boolean; error?: string }

const DENIED: ActionResult = { ok: false, error: 'ссылка недействительна' }

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
  return result.ok ? { ok: true } : { ok: false, error: result.error.ru }
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
  return result.ok ? { ok: true } : { ok: false, error: result.error.ru }
}

export async function submitAction(token: string): Promise<ActionResult> {
  const resolved = await resolveFillToken(db(), token)
  if (!resolved) return DENIED

  const result = await submitSubmission(db(), {
    submissionId: resolved.submissionId,
    actor: 'filler',
  })
  return result.ok ? { ok: true } : { ok: false, error: result.error.ru }
}
