import { and, eq } from 'drizzle-orm'
import type { Localized } from '@/form-schema'
import { PHOTO_SLOTS } from '@/form-schema'
import { photos, submissions } from '@/db/schema'
import type { Db, Tx } from '@/db/types'

export type SaveResult = { ok: true } | { ok: false; error: Localized }

export type PhotoRow = {
  id: string
  slot: string
  blobKey: string
  url: string
  caption: string | null
}

const fail = (en: string, ru: string): SaveResult => ({ ok: false, error: { en, ru } })

/**
 * Правки принимаются только в состояниях, где форма открыта заполняющему —
 * то же множество, что в `submissions/values.ts`. Фотография — такой же
 * ответ анкеты, как текстовое поле, и должна подчиняться тому же правилу:
 * пока анкета на проверке (`submitted`/`approved`), заполняющий не должен
 * суметь подменить снимок из-под рецензента.
 */
const EDITABLE = new Set(['draft', 'changes_requested'])

async function assertEditable(tx: Tx, submissionId: string): Promise<SaveResult> {
  // FOR UPDATE по той же причине, что в values.ts: проверка статуса и запись
  // идут в разные таблицы (submissions vs photos), обычный SELECT под READ
  // COMMITTED не берёт блокировку и не сериализует конкурентную смену статуса.
  const rows = await tx
    .select({ status: submissions.status })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .for('update')
    .limit(1)

  const status = rows[0]?.status
  if (!status) return fail('Submission not found', 'Анкета не найдена')
  if (!EDITABLE.has(status)) {
    return fail('This submission is under review', 'Анкета сейчас на проверке')
  }
  return { ok: true }
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
  const slot = PHOTO_SLOTS.find((s) => s.key === input.slot)
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
