import { describe, it, expect } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions } from '@/db/schema'
import { fieldByKey } from '@/form-schema'
import { saveFieldValue } from '@/submissions/values'
import { raiseFlag, openFlags, clearFlagsFor } from '../flags'
import { confirmBlock, blockProgress } from '../blocks'
import { requestChanges } from '../decide'

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

/** Отмечаемое поле и блок, к которому оно относится. Блок берётся из самой
 *  схемы, а не пишется буквой рядом: если `I.2` когда-нибудь переедет в
 *  другой блок, тест продолжит проверять правильный блок, а не тихо
 *  превратится в проверку ни о чём. */
const FLAGGED_KEY = 'I.2'
const OTHER_BLOCK = 'III.5'
/** Неотмеченное поле, и намеренно — из ДРУГОГО, подтверждённого блока: так
 *  второй тест проверяет не только «`clearFlagsFor` вернул false», но и что
 *  правка неотмеченного ответа не сносит подтверждение своего блока. */
const UNFLAGGED_KEY = 'III.5.3'

const flaggedBlock = (): string => {
  const field = fieldByKey(FLAGGED_KEY)
  expect(field).toBeDefined()
  return field!.block
}

/**
 * Анкета, доведённая до состояния «возвращена на правку» тем же путём,
 * которым до него доходит настоящий ревьюер: подтвердить блоки (это
 * возможно только в `submitted`), отметить поле, вернуть анкету.
 * Подтверждение отмечаемого блока ставится ДО замечания — `confirmBlock`
 * отказывается подтверждать блок с открытым замечанием.
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

  expect(flaggedBlock()).not.toBe(OTHER_BLOCK) // предпосылка тестов ниже

  for (const blockKey of [flaggedBlock(), OTHER_BLOCK]) {
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

  it('снятие замечания по неотмеченному ключу ничего не делает', async () => {
    const db = await createTestDb()
    const submissionId = await seedInFixes(db)

    const saved = await saveFieldValue(db, {
      submissionId, fieldKey: UNFLAGGED_KEY, value: 'Concourse B',
    })
    expect(saved.ok).toBe(true)
    expect(await clearFlagsFor(db, submissionId, UNFLAGGED_KEY)).toBe(false)

    // Замечание по другому ключу осталось открытым, подтверждения — на месте.
    expect(await openFlags(db, submissionId)).toHaveLength(1)
    const progress = await blockProgress(db, submissionId)
    expect(progress.find((b) => b.blockKey === OTHER_BLOCK)?.confirmed).toBe(true)
  })

  it('снимает подтверждение блока, к которому относилось замечание', async () => {
    const db = await createTestDb()
    const submissionId = await seedInFixes(db)

    // Подтверждение действительно переживает возврат на правку — иначе
    // проверка ниже прошла бы вакуумно, ничего не сняв.
    const before = await blockProgress(db, submissionId)
    expect(before.find((b) => b.blockKey === flaggedBlock())?.confirmed).toBe(true)

    await saveFieldValue(db, { submissionId, fieldKey: FLAGGED_KEY, value: 'Primeclass Lounge' })
    await clearFlagsFor(db, submissionId, FLAGGED_KEY)

    const progress = await blockProgress(db, submissionId)
    expect(progress.find((b) => b.blockKey === flaggedBlock())?.confirmed).toBe(false)
  })

  it('не трогает подтверждение блока, не связанного с исправленным полем', async () => {
    const db = await createTestDb()
    const submissionId = await seedInFixes(db)

    await saveFieldValue(db, { submissionId, fieldKey: FLAGGED_KEY, value: 'Primeclass Lounge' })
    await clearFlagsFor(db, submissionId, FLAGGED_KEY)

    const progress = await blockProgress(db, submissionId)
    expect(progress.find((b) => b.blockKey === OTHER_BLOCK)?.confirmed).toBe(true)
  })
})
