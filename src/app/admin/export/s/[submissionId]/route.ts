import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireSession } from '@/access/session'
import { submissions, lounges } from '@/db/schema'
import { singleSubmissionWorkbook } from '@/export/single'

/**
 * Выгрузка ОДНОЙ анкеты — xlsx в структуре исходного файла
 * (`singleSubmissionWorkbook`, `src/export/single.ts`). Второй формат
 * выгрузки из спецификации; собран и покрыт тестами он был в Task 5, но не
 * имел ни маршрута, ни ссылки — построен, заперт и недостижим (дефект I1
 * ревью ветки). Ссылка сюда стоит в шапке экрана проверки
 * (`src/web/ReviewScreen.tsx`).
 *
 * Имя файла — НАЗВАНИЕ ЛАУНЖА с IATA, не uuid анкеты: человек, сохранивший
 * пять таких файлов подряд, различает их по имени, а uuid не говорит ничего.
 * Название приходит из `lounges` тем же правилом, каким подписан сам экран
 * проверки (см. `page.tsx` анкеты: НЕ из ответа `I.2`, который сам предмет
 * проверки). Заголовок `content-disposition` несёт обе формы: `filename` —
 * ASCII-запасной вариант для старых клиентов (не-ASCII и запрещённые в именах
 * файлов символы заменены), `filename*` — полное название в UTF-8 (RFC 5987),
 * его берёт любой современный браузер.
 *
 * Неизвестная анкета — 404, не 500: `singleSubmissionWorkbook` на чужой id
 * бросает (см. его комментарий, почему не пустая книга), но выяснять
 * существование по исключению не нужно — анкета и так читается здесь ради
 * имени файла, и её отсутствие — обычный ответ маршрута, а не поломка.
 *
 * `maxDuration` здесь НЕ выставлен намеренно: в отличие от `/admin/export`
 * (2N+1 запросов по всему реестру), эта выгрузка — константные четыре чтения
 * одной анкеты, и умолчание платформы ей заведомо достаточно.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ submissionId: string }> },
): Promise<Response> {
  await requireSession()

  const { submissionId } = await context.params
  const [found] = await db()
    .select({ name: lounges.name, iata: lounges.iataCode })
    .from(submissions)
    .innerJoin(lounges, eq(submissions.loungeId, lounges.id))
    .where(eq(submissions.id, submissionId))
    .limit(1)
  if (!found) return new Response('submission not found', { status: 404 })

  const buffer = await singleSubmissionWorkbook(db(), submissionId)
  const filename = `${found.name} (${found.iata}).xlsx`

  return new Response(new Uint8Array(buffer), {
    headers: {
      'content-type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': contentDisposition(filename),
    },
  })
}

/**
 * `attachment; filename="…"; filename*=UTF-8''…` — ASCII-вариант и полный.
 *
 * В ASCII-варианте вычищаются не только не-ASCII, но и `"` с `\` (ломают
 * quoted-string самого заголовка) и символы, запрещённые в именах файлов
 * (`/ \ : * ? < > |`, управляющие); в `filename*` достаточно
 * `encodeURIComponent` — он кодирует и кавычки, и всё не-ASCII.
 */
function contentDisposition(filename: string): string {
  const ascii = filename
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e]|["\\/:*?<>|]/g, '_')
    .replace(/_{2,}/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
