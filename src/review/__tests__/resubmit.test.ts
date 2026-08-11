import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { fieldValues, lounges, photos, submissions } from '@/db/schema'
import { BLOCKS, fieldByKey } from '@/form-schema'
import { saveFieldValue } from '@/submissions/values'
import { removePhotoAt } from '@/photos/store'
import { raiseFlag, openFlags, clearFlagsFor, blockKeyOf } from '../flags'
import { confirmBlock, blockProgress } from '../blocks'
import { requestChanges, approveSubmission } from '../decide'

/**
 * Композиция, на которую опирается `saveFieldAction`/`saveServiceAction`
 * в `src/app/f/[token]/actions.ts`: успешная запись значения, а затем
 * снятие замечания по тому же ключу. Само серверное действие unit-тестом
 * не проверяется — оно вызывает `db()` (реальное postgres-соединение, а не
 * `createTestDb()`/PGlite), так что сквозная проверка живёт в
 * `e2e/review.spec.ts`. Здесь пиннится то, что действие склеивает.
 *
 * Чем этот файл отличается от `clearFlagsFor`-тестов в `flags.test.ts`:
 * там анкета в статусе `submitted`, а подтверждения блоков вставляются
 * прямо в `block_reviews` локальным хелпером. Здесь анкета проходит
 * настоящий жизненный цикл — ревьюер подтверждает блоки, отмечает поле и
 * возвращает анкету через `requestChanges`, — так что тесты ниже
 * проверяют ещё две вещи, которых там нет: что подтверждения блоков
 * переживают переход в `changes_requested`, и что `saveFieldValue`
 * действительно принимает правку в этом статусе (`assertEditable`).
 */

/** Отмечаемое поле. Блок берётся из самой схемы, а не пишется буквой рядом:
 *  если `I.2` когда-нибудь переедет в другой блок, тест продолжит проверять
 *  правильный блок, а не тихо превратится в проверку ни о чём. */
const FLAGGED_KEY = 'I.2'
/** Неотмеченное поле — из ДРУГОГО блока, тоже подтверждённого. */
const UNFLAGGED_KEY = 'III.5.3'
/** Ответ в ТРЕТЬЕМ блоке: он подтверждён, и его никто не правит. Нужен, чтобы
 *  «не трогает чужие подтверждения» проверялось на блоке, которого правка
 *  действительно не касалась.
 *
 *  Раньше эту роль играл `III.5` — блок самого `UNFLAGGED_KEY`
 *  (`blockKeyOf('III.5.3') === 'III.5'`), — поэтому тест с названием «не
 *  трогает подтверждение блока, НЕ СВЯЗАННОГО с исправленным полем» писал
 *  ровно в тот блок, чьё подтверждение проверял, и был зелёным именно из-за
 *  дефекта. Предпосылка «три РАЗНЫХ блока» проверяется ниже
 *  (`expect(...).not.toBe(...)`), а не держится на том, что кто-то сверил
 *  ключи глазами. */
const UNTOUCHED_KEY = 'III.2.4'
/** Накопительный слот фотографий (`extra: true`), чтобы в нём могло лежать два
 *  снимка и один можно было убрать. */
const PHOTO_SLOT = 'additional'

const blockOf = (key: string): string => {
  const blockKey = blockKeyOf(key)
  expect(blockKey, key).not.toBeNull()
  return blockKey!
}

const flaggedBlock = (): string => {
  const field = fieldByKey(FLAGGED_KEY)
  expect(field).toBeDefined()
  return field!.block
}

const confirmedOf = async (db: Db, submissionId: string, blockKey: string): Promise<boolean> => {
  const progress = await blockProgress(db, submissionId)
  const block = progress.find((b) => b.blockKey === blockKey)
  expect(block, blockKey).toBeDefined()
  return block!.confirmed
}

/**
 * Анкета, доведённая до состояния «возвращена на правку» тем же путём,
 * которым до него доходит настоящий ревьюер: подтвердить блоки (это
 * возможно только в `submitted`), отметить поле, вернуть анкету.
 * Подтверждение отмечаемого блока ставится ДО замечания — `confirmBlock`
 * отказывается подтверждать блок с открытым замечанием.
 *
 * Значения трёх ключей записываются ДО подтверждений, прямо в таблицы: в
 * статусе `submitted` `saveFieldValue` правку не примет (`assertEditable`), а
 * без них проверки «подтверждение осталось в силе» были бы вакуумными —
 * `blockProgress` сравнивает `confirmedAt` со временем записи ответов, и блок
 * без единого ответа проходит это сравнение ни на что не глядя.
 */
async function seedInFixes(db: Db): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  const [submission] = await db
    .insert(submissions)
    .values({ loungeId: lounge!.id, status: 'submitted' })
    .returning()
  const submissionId = submission!.id

  // Предпосылка всех тестов ниже: три РАЗНЫХ блока.
  expect(flaggedBlock()).not.toBe(blockOf(UNFLAGGED_KEY))
  expect(flaggedBlock()).not.toBe(blockOf(UNTOUCHED_KEY))
  expect(blockOf(UNFLAGGED_KEY)).not.toBe(blockOf(UNTOUCHED_KEY))

  await db.insert(fieldValues).values([
    { submissionId, fieldKey: FLAGGED_KEY, value: 'Primeclass' },
    { submissionId, fieldKey: UNFLAGGED_KEY, value: 'Concourse A' },
    { submissionId, fieldKey: UNTOUCHED_KEY, value: 'Turkish Airlines' },
  ])
  // Два снимка в накопительном слоте — чтобы один можно было убрать, а слот
  // остался непустым. Как и значения, вставляются напрямую: `attachPhoto`
  // тоже подчиняется `assertEditable`.
  await db.insert(photos).values([
    { submissionId, slot: PHOTO_SLOT, blobKey: 'k1', url: 'https://blob.test/1.jpg' },
    { submissionId, slot: PHOTO_SLOT, blobKey: 'k2', url: 'https://blob.test/2.jpg' },
  ])

  for (const blockKey of [
    flaggedBlock(), blockOf(UNFLAGGED_KEY), blockOf(UNTOUCHED_KEY), blockOf(PHOTO_SLOT),
  ]) {
    const confirmed = await confirmBlock(db, { submissionId, blockKey, reviewer: 'r1' })
    expect(confirmed.ok).toBe(true)
  }

  const flagged = await raiseFlag(db, {
    submissionId, fieldKey: FLAGGED_KEY, reason: 'empty', comment: 'пусто', reviewer: 'r1',
  })
  expect(flagged.ok).toBe(true)

  const returned = await requestChanges(db, { submissionId, reviewer: 'r1' })
  expect(returned.ok).toBe(true)

  return submissionId
}

describe('правка отмеченного поля', () => {
  it('снимает своё замечание', async () => {
    const db = await createTestDb()
    const submissionId = await seedInFixes(db)

    const saved = await saveFieldValue(db, {
      submissionId, fieldKey: FLAGGED_KEY, value: 'Primeclass Lounge',
    })
    expect(saved.ok).toBe(true)
    expect(await clearFlagsFor(db, submissionId, FLAGGED_KEY)).toBe(true)

    expect(await openFlags(db, submissionId)).toHaveLength(0)
  })

  it('снимает подтверждение блока, к которому относилось замечание', async () => {
    const db = await createTestDb()
    const submissionId = await seedInFixes(db)

    // Подтверждение действительно переживает возврат на правку — иначе
    // проверка ниже прошла бы вакуумно, ничего не сняв.
    expect(await confirmedOf(db, submissionId, flaggedBlock())).toBe(true)

    await saveFieldValue(db, { submissionId, fieldKey: FLAGGED_KEY, value: 'Primeclass Lounge' })
    await clearFlagsFor(db, submissionId, FLAGGED_KEY)

    expect(await confirmedOf(db, submissionId, flaggedBlock())).toBe(false)
  })

  it('не трогает подтверждение блока, не связанного с исправленным полем', async () => {
    const db = await createTestDb()
    const submissionId = await seedInFixes(db)

    await saveFieldValue(db, { submissionId, fieldKey: FLAGGED_KEY, value: 'Primeclass Lounge' })
    await clearFlagsFor(db, submissionId, FLAGGED_KEY)

    expect(await confirmedOf(db, submissionId, blockOf(UNTOUCHED_KEY))).toBe(true)
  })
})

/**
 * Правка НЕотмеченного ответа — не экзотика, а обычный путь, и именно он был
 * первым Important обзора всей ветки. Анкета в `changes_requested`, последнее
 * замечание которой уже снято предыдущей правкой, проваливается сквозь ОБА
 * гейта `FillForm` (экран правок требует `flags.length > 0`) и показывает
 * заполняющему всю форму из 19 шагов. Дальше он правит что угодно, а не только
 * отмеченное: `assertEditable` пропускает `changes_requested`, а `clearFlagsFor`
 * не находит замечания.
 */
describe('правка неотмеченного ответа', () => {
  it('не находит замечания, но снимает подтверждение СВОЕГО блока', async () => {
    const db = await createTestDb()
    const submissionId = await seedInFixes(db)
    expect(await confirmedOf(db, submissionId, blockOf(UNFLAGGED_KEY))).toBe(true)

    const saved = await saveFieldValue(db, {
      submissionId, fieldKey: UNFLAGGED_KEY, value: 'Concourse B',
    })
    expect(saved.ok).toBe(true)
    // Снимать было нечего — и это по-прежнему `false`.
    expect(await clearFlagsFor(db, submissionId, UNFLAGGED_KEY)).toBe(false)

    // Замечание по другому ключу осталось открытым.
    expect(await openFlags(db, submissionId)).toHaveLength(1)
    // А подтверждение блока, данные в котором только что изменились, — нет.
    expect(await confirmedOf(db, submissionId, blockOf(UNFLAGGED_KEY))).toBe(false)
    // Блок, которого правка не касалась, остаётся подтверждённым.
    expect(await confirmedOf(db, submissionId, blockOf(UNTOUCHED_KEY))).toBe(true)
  })

  /**
   * То же самое, но БЕЗ вызова `clearFlagsFor` — то есть только тем признаком,
   * который `blockProgress` выводит сам (`confirmedAt` старше времени записи
   * ответа). Это и есть ответ на «а если следующий писатель забудет позвать
   * инвалидацию»: писателя, который забыл, всё равно видно. Тест намеренно
   * зовёт только `saveFieldValue`.
   */
  it('снимает подтверждение и без вызова clearFlagsFor — по времени записи', async () => {
    const db = await createTestDb()
    const submissionId = await seedInFixes(db)

    const saved = await saveFieldValue(db, {
      submissionId, fieldKey: UNFLAGGED_KEY, value: 'Concourse B',
    })
    expect(saved.ok).toBe(true)

    expect(await confirmedOf(db, submissionId, blockOf(UNFLAGGED_KEY))).toBe(false)
    expect(await confirmedOf(db, submissionId, blockOf(UNTOUCHED_KEY))).toBe(true)
  })

  /**
   * Удаление снимка — единственный случай, которого производный признак
   * увидеть НЕ может: удалённая строка не оставляет ни времени, ни себя, так
   * что самый свежий `uploadedAt` слота после удаления не новее, а СТАРШЕ.
   * Поэтому здесь работает вторая половина исправления — безусловный `DELETE`
   * в `clearFlagsFor`, который `DELETE /api/photos` зовёт (`clearFlagAfterSave`)
   * ровно так же, как это делает загрузка.
   */
  it('убранный снимок снимает подтверждение блока фотографий', async () => {
    const db = await createTestDb()
    const submissionId = await seedInFixes(db)
    const photosBlock = blockOf(PHOTO_SLOT)
    expect(await confirmedOf(db, submissionId, photosBlock)).toBe(true)

    const removed = await removePhotoAt(db, {
      submissionId, slot: PHOTO_SLOT, url: 'https://blob.test/2.jpg',
    })
    expect(removed.ok).toBe(true)
    expect(await clearFlagsFor(db, submissionId, PHOTO_SLOT)).toBe(false)

    expect(await confirmedOf(db, submissionId, photosBlock)).toBe(false)
  })
})

/**
 * Тот же дефект целиком, до самого конца: анкета, у которой правка
 * неотмеченного ответа осталась незамеченной, ДОЛЖНА быть отклонена
 * `approveSubmission`, а не принята с переносом классифицирующих полей в
 * `lounges`. Проверяется здесь, а не только на `blockProgress`, потому что
 * именно `approveSubmission` перезаписывает долговечный каталог — и потому что
 * он выводит «все 27 подтверждены» заново внутри своей блокировки: если бы
 * правило жило в двух местах, разошлись бы именно эти два.
 *
 * Возврат в `submitted` делается прямым `UPDATE`, а не `submitSubmission`:
 * тот проверяет ПОЛНОТУ анкеты (все обязательные ответы и фото), что к этому
 * тесту не относится и потребовало бы заполнить всю форму. Проверка полноты
 * при отправке покрыта своими тестами (`submissions/__tests__`).
 */
describe('принятие анкеты после незамеченной правки', () => {
  it('отказывает: блок, данные которого изменились, больше не подтверждён', async () => {
    const db = await createTestDb()
    const submissionId = await seedInFixes(db)

    // Заполняющий исправляет отмеченное — и заодно правит неотмеченный ответ
    // в другом, уже подтверждённом блоке.
    await saveFieldValue(db, { submissionId, fieldKey: FLAGGED_KEY, value: 'Primeclass Lounge' })
    expect(await clearFlagsFor(db, submissionId, FLAGGED_KEY)).toBe(true)
    await saveFieldValue(db, { submissionId, fieldKey: UNFLAGGED_KEY, value: 'Concourse B' })
    await clearFlagsFor(db, submissionId, UNFLAGGED_KEY)

    await db.update(submissions).set({ status: 'submitted' }).where(eq(submissions.id, submissionId))

    // Ревьюер видит и добивает то, что экран показывает как неподтверждённое.
    for (const block of BLOCKS) {
      if (block.key === blockOf(UNFLAGGED_KEY)) continue
      await confirmBlock(db, { submissionId, blockKey: block.key, reviewer: 'r1' })
    }
    expect(await openFlags(db, submissionId)).toHaveLength(0)

    const result = await approveSubmission(db, { submissionId, reviewer: 'r1' })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.en).toContain('1 block(s) not confirmed')

    // И анкета осталась на проверке, а каталог — нетронутым.
    const [row] = await db.select().from(submissions).where(eq(submissions.id, submissionId))
    expect(row?.status).toBe('submitted')
  })

  /**
   * Обратная сторона: пока ревьюер перепроверяет то, что изменилось, принятие
   * должно оставаться возможным. Иначе «блок неподтверждён» превратилось бы в
   * состояние, из которого нет выхода, и тест выше проходил бы по любой
   * причине, включая «принять нельзя никогда».
   */
  it('после перепроверки изменившегося блока анкета принимается', async () => {
    const db = await createTestDb()
    const submissionId = await seedInFixes(db)

    await saveFieldValue(db, { submissionId, fieldKey: FLAGGED_KEY, value: 'Primeclass Lounge' })
    await clearFlagsFor(db, submissionId, FLAGGED_KEY)
    await saveFieldValue(db, { submissionId, fieldKey: UNFLAGGED_KEY, value: 'Concourse B' })
    await clearFlagsFor(db, submissionId, UNFLAGGED_KEY)

    await db.update(submissions).set({ status: 'submitted' }).where(eq(submissions.id, submissionId))

    for (const block of BLOCKS) {
      const confirmed = await confirmBlock(db, {
        submissionId, blockKey: block.key, reviewer: 'r1',
      })
      expect(confirmed.ok, block.key).toBe(true)
    }

    const result = await approveSubmission(db, { submissionId, reviewer: 'r1' })
    expect(result).toEqual({ ok: true, status: 'approved' })
  })
})
