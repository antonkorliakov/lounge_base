import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { del, put } from '@vercel/blob'

/**
 * The ONE definition of "blob storage is configured", mirroring
 * `mailDelivers()` in `src/notify/mailer.ts` — the seam below branches on
 * exactly this predicate, never on a second reading of the variable that
 * could drift from it. Read at call time (not module load) for the same
 * reason as the mailer: tests and callers that flip the variable between
 * calls must see the effect immediately.
 *
 * `@vercel/blob` reads `BLOB_READ_WRITE_TOKEN` itself; this module never
 * passes it explicitly. An empty string (the shape `.env.example` ships)
 * counts as absent — `Boolean('')` is false, and an empty token could not
 * authenticate anyway.
 */
export function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN)
}

/**
 * Куда dev-fallback кладёт файлы: `public/dev-blob/` — рядом с `public/seed/`
 * и по тем же двум причинам (см. `seedPhotoUrl` в `scripts/seed-dev.ts`):
 * `next dev` отдаёт файлы из `public/` прямо с диска, так что файл, записанный
 * ПОСЛЕ старта сервера, доступен по ссылке сразу; и ссылка от корня
 * (`/dev-blob/…`) — тот же origin, что у страницы, без привязки к порту.
 * Каталог в `.gitignore`: это локальные артефакты, как и `public/seed/`.
 */
const DEV_BLOB_DIR = ['public', 'dev-blob'] as const
const DEV_BLOB_URL_PREFIX = '/dev-blob/'

/**
 * Ключ приходит из маршрута уже собранным из проверенных кусков (submissionId
 * — из токена, слот — по `photoSlotByKey`, расширение — из белого списка), но
 * шов не вправе полагаться на дисциплину единственного сегодняшнего вызова:
 * это функция, пишущая на диск по строке, и `../` в этой строке обязан быть
 * невозможным ЗДЕСЬ, а не только там, где строку сегодня собирают.
 */
function devBlobPath(key: string): string {
  const dir = resolve(process.cwd(), ...DEV_BLOB_DIR)
  const target = resolve(dir, key)
  if (!target.startsWith(dir + sep)) {
    throw new Error(`[photos] blob key escapes ${DEV_BLOB_DIR.join('/')}/: ${key}`)
  }
  return target
}

function warnDevFallback(action: string): void {
  console.warn(
    `[photos] BLOB_READ_WRITE_TOKEN is not set — ${action} under public/dev-blob/ ` +
      'on the local disk instead of Vercel Blob. This is expected in local ' +
      'development only; if this warning appears anywhere else, photo storage ' +
      'is silently broken there.',
  )
}

/**
 * Сохранить снимок и вернуть URL, по которому он открывается.
 *
 * С токеном — настоящий `put()` в Vercel Blob, как и раньше (ветвление — это
 * `blobConfigured()`, см. выше). Без токена — dev-fallback: файл под
 * `public/dev-blob/<key>` и локальный URL `/dev-blob/<key>`, с громким
 * предупреждением на каждой записи — по образцу `consoleMailer`
 * (`src/notify/mailer.ts`): молча проглотить было бы скрытой поломкой до
 * продакшена, а тихо работать без предупреждения — приглашением принять
 * dev-поведение за настоящее.
 *
 * До этого шва `put()` без токена бросал раньше всякой логики приложения, и
 * загрузка фото была единственным сценарием формы, который e2e не мог пройти
 * вовсе (замена, мультизагрузка, «снимок виден после перезагрузки» — всё
 * упиралось в него). Fallback существует ради этого: локальный прогон и CI
 * проходят настоящий маршрут (валидация, `attachPhoto`, снятие замечаний) с
 * настоящим файлом на диске — мокается только внешнее хранилище, и то лишь
 * когда его заведомо нет.
 */
export async function putPhoto(
  key: string,
  file: File,
  contentType: string,
): Promise<{ url: string }> {
  if (blobConfigured()) {
    const blob = await put(key, file, { access: 'public', contentType })
    return { url: blob.url }
  }

  warnDevFallback('writing this photo to a file')
  const target = devBlobPath(key)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, Buffer.from(await file.arrayBuffer()))
  return { url: `${DEV_BLOB_URL_PREFIX}${key}` }
}

/**
 * Удалить снимок по его URL. С токеном — настоящий `del()` (отказ
 * пробрасывается: оба вызова в маршруте и так best-effort — `.catch(() => {})`
 * стоит у вызывающего, где задокументирована цена орфана). Без токена —
 * unlink файла из `public/dev-blob/`, тоже best-effort: URL не из dev-blob
 * (настоящий блобовский из БД, засеянный `/seed/…`) молча пропускается —
 * ему на этом диске просто нечего удалять.
 */
export async function deletePhoto(url: string): Promise<void> {
  if (blobConfigured()) {
    await del(url)
    return
  }

  if (!url.startsWith(DEV_BLOB_URL_PREFIX)) return
  warnDevFallback('unlinking this photo file')
  await unlink(devBlobPath(url.slice(DEV_BLOB_URL_PREFIX.length))).catch(() => {})
}
