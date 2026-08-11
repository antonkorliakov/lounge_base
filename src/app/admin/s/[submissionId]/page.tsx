import { eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { db } from '@/db/client'
import { requireSession } from '@/access/session'
import { loadSubmissionValues } from '@/submissions/values'
import { listPhotos } from '@/photos/store'
import { openFlags } from '@/review/flags'
import { blockProgress } from '@/review/blocks'
import { submissions } from '@/db/schema'
import { LocaleProvider } from '@/i18n/context'
import { ReviewScreen } from '@/web/ReviewScreen'
import { renderValues } from '@/web/renderValues'
import { resendGateFor } from './resend-gate'

export default async function ReviewPage(props: {
  params: Promise<{ submissionId: string }>
}): Promise<React.JSX.Element> {
  await requireSession()
  const { submissionId } = await props.params

  // Стоящая проверка: ни один из read-помощников ниже (loadSubmissionValues,
  // listPhotos, openFlags, blockProgress) не отказывает на неизвестном
  // submissionId — все они просто фильтруют по id и молча возвращают пустой
  // результат. Без этой проверки устаревшая закладка или опечатка в URL
  // отрисовала бы экран проверки с 27 пустыми блоками, а не понятным 404 —
  // ревьюер увидел бы анкету, которая выглядит пустой, а не анкету,
  // которой не существует.
  //
  // Заодно читается статус — тем же самым запросом, без второго обращения:
  // от него зависит, можно ли пересылать оператору ссылку заполнения (см.
  // `./resend-gate.ts`). Экран проверки сам по себе от статуса не зависит:
  // отмечать и подтверждать блоки имеет смысл на любой анкете, до которой
  // проверяющий дошёл, а `confirmBlock`/`requestChanges`/`approveSubmission`
  // проверяют свои условия сами, внутри транзакции.
  const found = await db()
    .select({ id: submissions.id, status: submissions.status })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1)
  const row = found[0]
  if (!row) notFound()

  const values = await loadSubmissionValues(db(), submissionId)
  const photoRows = await listPhotos(db(), submissionId)
  const photos: Record<string, string[]> = {}
  for (const photo of photoRows) {
    photos[photo.slot] = [...(photos[photo.slot] ?? []), photo.url]
  }

  // `photos` идёт только в `ReviewScreen` (и дальше в `FieldRow`), а не в
  // `renderValues`: текстового представления у снимка нет — см. `RenderedCell`.
  const rendered = renderValues({
    fields: values.fields,
    services: values.services,
    locale: 'en',
  })

  return (
    <LocaleProvider initial="en">
      <ReviewScreen
        submissionId={submissionId}
        progress={await blockProgress(db(), submissionId)}
        flags={await openFlags(db(), submissionId)}
        rendered={rendered}
        photos={photos}
        resend={resendGateFor(row.status)}
      />
    </LocaleProvider>
  )
}
