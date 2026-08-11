import { del, put } from '@vercel/blob'
import { NextResponse } from 'next/server'
import type { Localized } from '@/form-schema'
import { photoSlotByKey } from '@/form-schema'
import { db } from '@/db/client'
import { resolveFillToken } from '@/access/tokens'
import { attachPhoto, removePhotoAt } from '@/photos/store'
import { clearFlagAfterSave } from '@/app/clear-flag-after-save'

/**
 * Every rejection below carries both locales, same shape as `ActionResult`
 * in `src/app/f/[token]/actions.ts` — the client (`PhotoSlots.tsx`) picks
 * with `pick()`, same as every other `Localized` value in this codebase.
 * Before this, every one of these was a bare Russian string, so an
 * English-locale operator got Russian text on any rejection here too.
 */
const NO_FILE: Localized = { en: 'No file was provided', ru: 'Файл не передан' }
const INVALID_TOKEN: Localized = {
  en: 'This link is invalid or has expired',
  ru: 'Ссылка недействительна',
}
const FILE_TOO_LARGE: Localized = { en: 'The file is too large', ru: 'Файл слишком велик' }
const UNSUPPORTED_FILE_TYPE: Localized = {
  en: 'This file type is not supported',
  ru: 'Недопустимый тип файла',
}
const UNKNOWN_SLOT: Localized = { en: 'Unknown photo slot', ru: 'Неизвестный слот фото' }
const NO_PHOTO_URL: Localized = { en: 'No photo was named', ru: 'Снимок не указан' }

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
    return NextResponse.json({ error: NO_FILE }, { status: 400 })
  }

  // Токен проверяется раньше остальной валидации: submissionId в маршруте
  // берётся только из resolveFillToken, а не от клиента — иначе можно было
  // бы писать фото в чужую анкету, просто подставив её id в форму.
  const resolved = await resolveFillToken(db(), token)
  if (!resolved) {
    return NextResponse.json({ error: INVALID_TOKEN }, { status: 403 })
  }

  if (file.size > MAX_PHOTO_BYTES) {
    return NextResponse.json({ error: FILE_TOO_LARGE }, { status: 413 })
  }
  const extension = EXTENSION_BY_TYPE[file.type]
  if (!extension) {
    return NextResponse.json({ error: UNSUPPORTED_FILE_TYPE }, { status: 400 })
  }
  // Слот проверяем здесь же, а не только внутри attachPhoto: иначе на
  // заведомо неверный слот мы сначала закачаем файл в blob и лишь потом
  // откажем — лишний трафик и висящий (orphaned) блоб на пустом месте.
  if (!photoSlotByKey(slot)) {
    return NextResponse.json({ error: UNKNOWN_SLOT }, { status: 400 })
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
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    // Перезалитый снимок снимает своё замечание и подтверждение своего блока,
    // ровно как исправленное поле или позиция услуг — замечание адресуется
    // ключом слота (`PHOTO_SLOTS` входит в `FLAGGABLE`, см. `src/review/
    // flags.ts`), так что снимается по `slot`. До этого маршрут не снимал
    // замечаний вообще: заполняющий мог перезагрузить именно тот снимок, на
    // который ему указали, и замечание оставалось открытым — цикл проверки
    // не сходился (см. Critical в конце P2 Task 7).
    //
    // Сбой этого шага НЕ превращается в отказ загрузки: снимок уже и в
    // blob-хранилище, и в `photos`, так что «не удалось загрузить» было бы
    // ложью, из-за которой заполняющий загрузил бы его второй раз. Тот же
    // выбор и по тем же причинам, что у двух серверных действий сохранения —
    // и та же самая функция, а не вторая её копия: см.
    // `clearFlagAfterSave`.
    await clearFlagAfterSave(resolved.submissionId, slot)

    return NextResponse.json({ url: blob.url })
  } catch (error) {
    await del(blob.url).catch(() => {})
    throw error
  }
}

/**
 * Убрать один снимок из накопительного слота.
 *
 * Существует ровно потому, что у слота `additional` (`extra: true`) загрузка
 * НЕ заменяет: `attachPhoto` не удаляет прежние строки, а добавляет ещё одну.
 * Пока удаления не было нигде, замечание по этому слоту («один из
 * дополнительных снимков непригоден») не имело правдивого ответа вообще —
 * четвёртый снимок не убирает тот, на который жаловался ревьюер, — то есть
 * цикл проверки по этому ключу не сходился ровно так же, как он не сходился
 * для 62 ключей до появления контролов на экране правок. UI предлагает это
 * только у `extra`-слота и только на экране правок (см. `PhotoSlots`);
 * маршрут шире не потому, что забыли, а потому, что запрет здесь ничего не
 * защищал бы: удалить снимок из СВОЕЙ анкеты и так может только владелец
 * валидного fill-токена, а удаление из обязательного слота честно
 * возвращается `missingItems` при отправке.
 *
 * Тот же порядок проверок, что у POST: токен — раньше всего, `submissionId`
 * берётся только из `resolveFillToken`, никогда от клиента.
 */
export async function DELETE(request: Request): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null)
  const token = String((body as { token?: unknown })?.token ?? '')
  const slot = String((body as { slot?: unknown })?.slot ?? '')
  const url = String((body as { url?: unknown })?.url ?? '')

  const resolved = await resolveFillToken(db(), token)
  if (!resolved) {
    return NextResponse.json({ error: INVALID_TOKEN }, { status: 403 })
  }
  if (!photoSlotByKey(slot)) {
    return NextResponse.json({ error: UNKNOWN_SLOT }, { status: 400 })
  }
  if (url === '') {
    return NextResponse.json({ error: NO_PHOTO_URL }, { status: 400 })
  }

  const result = await removePhotoAt(db(), {
    submissionId: resolved.submissionId,
    slot,
    url,
  })
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }

  // Убранный лишний снимок — это и есть исправление замечания по слоту, ровно
  // как перезалитый снимок выше, поэтому замечание снимается тем же способом и
  // с теми же гарантиями (сбой этого шага не превращает состоявшееся удаление
  // в отказ — см. `clearFlagAfterSave`).
  await clearFlagAfterSave(resolved.submissionId, slot)

  // Блоб удаляется ПОСЛЕ строки и только best-effort — тот же выбор и та же
  // цена, что у orphan-блоба в POST: если `del` не пройдёт (или, как у
  // засеянных снимков, URL вообще не блобовский), в хранилище останутся лишние
  // байты, но у заполняющего снимок убран, и говорить ему обратное было бы
  // ложью.
  await del(url).catch(() => {})

  return NextResponse.json({ ok: true })
}
