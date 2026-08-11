import { and, eq, sql } from 'drizzle-orm'
import { photoSlotByKey } from '@/form-schema'
import { photos } from '@/db/schema'
import type { Db } from '@/db/types'
import { assertEditable, fail, type SaveResult } from '@/submissions/editable'

export type { SaveResult }

export type PhotoRow = {
  id: string
  slot: string
  blobKey: string
  url: string
  caption: string | null
}

export async function attachPhoto(
  db: Db,
  input: {
    submissionId: string
    slot: string
    blobKey: string
    url: string
    caption: string | null
  },
): Promise<SaveResult> {
  const slot = photoSlotByKey(input.slot)
  if (!slot) {
    return fail('Unknown photo slot', 'Неизвестный слот фото')
  }

  // Блокировка строки submissions в начале транзакции — тот же порядок, что
  // у saveFieldValue/submitSubmission (родитель первым, дети — только потом).
  // Она нужна не только для проверки editable: таблица photos не имеет
  // unique-ограничения на (submissionId, slot), так что «именованный слот
  // держит один снимок» держится целиком на приложении. Без блокировки два
  // конкурентных запроса на один и тот же именованный слот оба могут увидеть
  // слот пустым между DELETE и INSERT и оба вставить свою строку — тогда в
  // слоте окажется два снимка, а completeness.ts тихо станет врать про
  // количество фото.
  return db.transaction(async (tx) => {
    const editable = await assertEditable(tx, input.submissionId)
    if (!editable.ok) return editable

    // Именованный слот отвечает на один конкретный вопрос («покажите вход»),
    // поэтому новая загрузка заменяет прежнюю, а не копится рядом.
    if (!slot.extra) {
      await tx
        .delete(photos)
        .where(and(eq(photos.submissionId, input.submissionId), eq(photos.slot, input.slot)))
    }

    await tx.insert(photos).values({
      submissionId: input.submissionId,
      slot: input.slot,
      blobKey: input.blobKey,
      url: input.url,
      caption: input.caption,
      // Не значение по умолчанию у столбца (`defaultNow()`), а `clock_timestamp()`
      // — по той же причине, что в `submissions/values.ts` и `review/blocks.ts`:
      // `now()` это время НАЧАЛА транзакции, взятое до того, как писатель взял
      // блокировку `submissions`. Загрузка, которая ждала на этой блокировке
      // подтверждения блока, получила бы штамп РАНЬШЕ того подтверждения,
      // которое она обесценивает, и `blockProgress` не увидел бы изменения —
      // ширина окна равна времени ожидания блокировки. Все три writer'а
      // сравниваемых величин обязаны штамповать одинаково, иначе сравнение
      // `confirmedAt` с временем записи ничего не значит.
      uploadedAt: sql`clock_timestamp()`,
    })

    return { ok: true }
  })
}

export async function listPhotos(db: Db, submissionId: string): Promise<PhotoRow[]> {
  const rows = await db
    .select({
      id: photos.id, slot: photos.slot, blobKey: photos.blobKey,
      url: photos.url, caption: photos.caption,
    })
    .from(photos)
    .where(eq(photos.submissionId, submissionId))

  return rows
}

/**
 * Убирает ОДИН снимок КОНКРЕТНОЙ анкеты, найденный по слоту и URL.
 *
 * Ищет по `(submissionId, slot, url)`, а не принимает `photoId` от клиента, и
 * это не про удобство: fill-токен удостоверяет анкету, а не снимок.
 * `removePhoto` ниже сам достаёт `submissionId` из найденной строки и ни с чем
 * его не сверяет — правильно для внутреннего вызова, но если бы маршрут
 * передавал туда id прямо от клиента, любой обладатель валидного токена мог бы
 * удалить снимок ЛЮБОЙ анкеты, узнав его id. Здесь выборка ограничена
 * анкетой токена, так что id, который ей не принадлежит, просто не может
 * получиться. Плюс у клиента на руках и так URL-ы (`Record<slot, string[]>` —
 * и с сервера, и после только что прошедшей загрузки), а id — нет.
 *
 * Две транзакции, а не одна: удаляет по-прежнему `removePhoto` — со своей
 * блокировкой, своей проверкой `editable` и своим тестом, — а здесь только
 * чтение перед ним. Промежуток безвреден: если строка за это время исчезла или
 * анкета перестала быть редактируемой, `removePhoto` откажет, а не удалит
 * что-то не то.
 */
export async function removePhotoAt(
  db: Db,
  input: { submissionId: string; slot: string; url: string },
): Promise<SaveResult> {
  const rows = await db
    .select({ id: photos.id })
    .from(photos)
    .where(
      and(
        eq(photos.submissionId, input.submissionId),
        eq(photos.slot, input.slot),
        eq(photos.url, input.url),
      ),
    )
    .limit(1)

  const photoId = rows[0]?.id
  if (!photoId) return fail('Photo not found', 'Фото не найдено')

  return removePhoto(db, photoId)
}

export async function removePhoto(db: Db, photoId: string): Promise<SaveResult> {
  // Удаление — такая же правка анкеты, как attachPhoto, и должна подчиняться
  // тому же правилу editable. photoId не несёт submissionId, поэтому сперва
  // читаем его из строки photos, а уже потом (в той же транзакции) берём
  // блокировку на submissions — родитель блокируется до того, как транзакция
  // пишет что-либо, порядок тот же, что в attachPhoto. Если строки с таким
  // id нет — отказ, а не тихий no-op: вызывающий не должен решить, что фото
  // удалено, когда на самом деле не было и что удалять.
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ submissionId: photos.submissionId })
      .from(photos)
      .where(eq(photos.id, photoId))
      .limit(1)

    const submissionId = rows[0]?.submissionId
    if (!submissionId) return fail('Photo not found', 'Фото не найдено')

    const editable = await assertEditable(tx, submissionId)
    if (!editable.ok) return editable

    await tx.delete(photos).where(eq(photos.id, photoId))
    return { ok: true }
  })
}
