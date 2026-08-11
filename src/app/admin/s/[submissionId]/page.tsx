import { eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { db } from '@/db/client'
import { requireSession } from '@/access/session'
import { loadSubmissionValues } from '@/submissions/values'
import { listPhotos } from '@/photos/store'
import { openFlags } from '@/review/flags'
import { blockProgress } from '@/review/blocks'
import { submissions, lounges } from '@/db/schema'
import { LocaleProvider } from '@/i18n/context'
import { ReviewScreen } from '@/web/ReviewScreen'
import { renderValues } from '@/web/renderValues'
import { reviewStateFor } from './gates'

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
  // Заодно этим же запросом читается всё, чем экран подписывает САМ СЕБЯ:
  // статус и лаунж.
  //
  // Статус: от него зависит, какие шаги на этой анкете вообще применимы, и
  // какие поэтому показаны выключенными с причиной (`reviewStateFor` в
  // `./gates.ts`). Раньше он читался здесь же, но тратился ровно на одну
  // кнопку — «переслать ссылку», — а остальные четыре решения экран предлагал
  // на любой анкете: проверяющий отмечал ответы на уже принятой анкете
  // (каждый вызов отвечал `{ok: true}`, потому что `raiseFlag` намеренно слеп
  // к статусу), а потом получал отказ «анкета сейчас не на проверке» — в
  // конце работы, которую уже сделал.
  //
  // Лаунж: `innerJoin`, а не второй запрос, и не поле `I.2` из ответов
  // анкеты. Во-первых, это ровно та же строка, по которой проверяющий сюда
  // пришёл из списка `/admin` («<название> — <IATA>»), и то же название, что
  // уходит оператору в письмах (`loungeName` в `./actions.ts`), — одна
  // личность анкеты во всех трёх местах, а не три. Во-вторых, ответ оператора
  // на «Lounge Full Name*» — это предмет проверки: он может быть пустым, может
  // быть отмечен замечанием, и подписывать им экран значит терять подпись
  // именно тогда, когда с ответом что-то не так.
  //
  // `innerJoin` не может потерять существующую анкету: `submissions.loungeId`
  // — `notNull` с внешним ключом `on delete cascade`, поэтому анкеты без
  // лаунжа не бывает (удаление лаунжа удаляет и анкету). Так что `notFound()`
  // ниже по-прежнему значит ровно «такой анкеты нет».
  const found = await db()
    .select({
      id: submissions.id,
      status: submissions.status,
      loungeName: lounges.name,
      iata: lounges.iataCode,
    })
    .from(submissions)
    .innerJoin(lounges, eq(submissions.loungeId, lounges.id))
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
        lounge={{ name: row.loungeName, iata: row.iata }}
        state={reviewStateFor(row.status)}
        progress={await blockProgress(db(), submissionId)}
        flags={await openFlags(db(), submissionId)}
        rendered={rendered}
        photos={photos}
      />
    </LocaleProvider>
  )
}
