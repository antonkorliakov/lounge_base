import { and, eq, isNull } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { db } from '@/db/client'
import { submissions, fieldFlags } from '@/db/schema'
import { resolveFillToken } from '@/access/tokens'
import { loadSubmissionValues } from '@/submissions/values'
import { listPhotos } from '@/photos/store'
import { LocaleProvider } from '@/i18n/context'
import { FillForm } from '@/web/FillForm'
import type { Flag } from '@/web/FixesOnly'

export default async function FillPage(props: {
  params: Promise<{ token: string }>
}): Promise<React.JSX.Element> {
  const { token } = await props.params
  const resolved = await resolveFillToken(db(), token)
  if (!resolved) notFound()

  const values = await loadSubmissionValues(db(), resolved.submissionId)
  const photos = await listPhotos(db(), resolved.submissionId)

  const uploaded: Record<string, string[]> = {}
  for (const photo of photos) {
    uploaded[photo.slot] = [...(uploaded[photo.slot] ?? []), photo.url]
  }

  // Status and open flags decide whether the operator sees the full 19-step
  // form or the "changes requested" view for just the flagged answers (see
  // FixesOnly / FillForm). `resolveFillToken` deliberately only ever hands
  // back a submission id (see its own doc comment), so both are fetched
  // here rather than threaded through the token layer.
  const submissionRows = await db()
    .select({ status: submissions.status })
    .from(submissions)
    .where(eq(submissions.id, resolved.submissionId))
    .limit(1)
  const status = submissionRows[0]?.status ?? 'draft'

  const flagRows = await db()
    .select({
      fieldKey: fieldFlags.fieldKey,
      reason: fieldFlags.reason,
      comment: fieldFlags.comment,
    })
    .from(fieldFlags)
    .where(
      and(eq(fieldFlags.submissionId, resolved.submissionId), isNull(fieldFlags.resolvedAt)),
    )
  const flags: Flag[] = flagRows

  return (
    <LocaleProvider initial="en">
      <FillForm
        token={token}
        submissionId={resolved.submissionId}
        status={status}
        flags={flags}
        initialFields={values.fields}
        initialServices={values.services}
        initialPhotos={uploaded}
      />
    </LocaleProvider>
  )
}
