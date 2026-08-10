import { del, put } from '@vercel/blob'
import { NextResponse } from 'next/server'
import { PHOTO_SLOTS } from '@/form-schema'
import { db } from '@/db/client'
import { resolveFillToken } from '@/access/tokens'
import { attachPhoto } from '@/photos/store'

// Клиент (resize.ts) уменьшает снимок и всегда шлёт JPEG, но этот маршрут
// принимает то, что ему пришлют напрямую — обращение к нему не ограничено
// браузером с нашим кодом. Без потолка размера и белого списка типов
// blob-хранилище превращается в бесплатный файловый хостинг на чужой счёт
// (Vercel Blob тарифицирует хранение и исходящий трафик), а любой обладатель
// валидного fill-токена может закачивать произвольные файлы. Полноценная
// проверка содержимого (антивирус, точная проверка магических байт) избыточна
// для этой задачи — этого достаточно, чтобы закрыть очевидный путь абьюза.
const MAX_PHOTO_BYTES = 15 * 1024 * 1024
// Тип файла определяет одновременно и то, разрешён ли он, и то, каким
// расширением заканчивается ключ в блоб-хранилище — один источник истины
// вместо белого списка типов и отдельного (и как оказалось, всегда
// неверного для PNG/WebP) хардкода расширения.
const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

export async function POST(request: Request): Promise<NextResponse> {
  const form = await request.formData()
  const token = String(form.get('token') ?? '')
  const slot = String(form.get('slot') ?? '')
  const file = form.get('file')

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'файл не передан' }, { status: 400 })
  }

  // Токен проверяется раньше остальной валидации: submissionId в маршруте
  // берётся только из resolveFillToken, а не от клиента — иначе можно было
  // бы писать фото в чужую анкету, просто подставив её id в форму.
  const resolved = await resolveFillToken(db(), token)
  if (!resolved) {
    return NextResponse.json({ error: 'ссылка недействительна' }, { status: 403 })
  }

  if (file.size > MAX_PHOTO_BYTES) {
    return NextResponse.json({ error: 'файл слишком велик' }, { status: 413 })
  }
  const extension = EXTENSION_BY_TYPE[file.type]
  if (!extension) {
    return NextResponse.json({ error: 'недопустимый тип файла' }, { status: 400 })
  }
  // Слот проверяем здесь же, а не только внутри attachPhoto: иначе на
  // заведомо неверный слот мы сначала закачаем файл в blob и лишь потом
  // откажем — лишний трафик и висящий (orphaned) блоб на пустом месте.
  if (!PHOTO_SLOTS.some((s) => s.key === slot)) {
    return NextResponse.json({ error: 'неизвестный слот' }, { status: 400 })
  }

  const key = `${resolved.submissionId}/${slot}-${Date.now()}.${extension}`
  const blob = await put(key, file, { access: 'public', contentType: file.type })

  // Блоб пишется раньше строки в БД, так что между ними есть окно, где
  // запись в БД может не пройти (ожидаемый отказ attachPhoto — например,
  // анкета уже не редактируется — или неожиданное исключение), а блоб
  // остаётся висеть в хранилище. Удаление здесь — best-effort: если сам del
  // тоже упадёт, блоб останется орфаном до ручной/фоновой чистки, которой в
  // этой задаче нет — на нынешнем масштабе это вопрос лишних байт в
  // хранилище, а не дыра в безопасности, так что фоновый сборщик мусора
  // сознательно не реализован здесь.
  try {
    const result = await attachPhoto(db(), {
      submissionId: resolved.submissionId,
      slot,
      blobKey: key,
      url: blob.url,
      caption: null,
    })

    if (!result.ok) {
      await del(blob.url).catch(() => {})
      return NextResponse.json({ error: result.error.ru }, { status: 400 })
    }

    return NextResponse.json({ url: blob.url })
  } catch (error) {
    await del(blob.url).catch(() => {})
    throw error
  }
}
