import { eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { db } from '@/db/client'
import { lounges, submissions } from '@/db/schema'
import { resolveFillToken } from '@/access/tokens'
import { lockedIdentityKeys } from '@/registry/manage'
import { openFlags } from '@/review/flags'
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
  // Паспорт лаунжа читается тем же запросом: он нужен для расчёта замков
  // предзаполненных полей блока I — правило (совпадение ответа с непустой
  // колонкой) живёт в `lockedIdentityKeys` рядом с самим предзаполнением,
  // а не переписано здесь; клиент получает готовый список ключей и никакого
  // собственного списка не держит.
  const submissionRows = await db()
    .select({
      status: submissions.status,
      name: lounges.name,
      provider: lounges.provider,
      country: lounges.country,
      city: lounges.city,
      airport: lounges.airport,
      iataCode: lounges.iataCode,
    })
    .from(submissions)
    .innerJoin(lounges, eq(submissions.loungeId, lounges.id))
    .where(eq(submissions.id, resolved.submissionId))
    .limit(1)
  const submissionRow = submissionRows[0]
  const status = submissionRow?.status ?? 'draft'
  const lockedKeys = submissionRow ? lockedIdentityKeys(submissionRow, values.fields) : []

  // `openFlags`, а не своя копия того же запроса: копия читала `reason` как
  // сырой `text` из базы и отдавала его дальше строкой, минуя `toFlagReason` —
  // единственное место, где строка становится кодом из `FLAG_REASONS`. То есть
  // два читателя одних и тех же строк расходились в том, какой у них тип, и
  // сторона заполнения оказывалась той, что без сужения: значение вне союза
  // (правка руками в базе, миграция мимо этого списка) доехало бы до экрана как
  // код, которого нет, а не как «кода нет». Лишнее поле `id` в `FlagRow`
  // безвредно — `Flag` его просто не читает.
  const flags: Flag[] = await openFlags(db(), resolved.submissionId)

  return (
    <LocaleProvider initial="en">
      <FillForm
        token={token}
        submissionId={resolved.submissionId}
        status={status}
        flags={flags}
        lockedKeys={lockedKeys}
        initialFields={values.fields}
        initialServices={values.services}
        initialPhotos={uploaded}
      />
    </LocaleProvider>
  )
}
