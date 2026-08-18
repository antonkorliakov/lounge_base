import { eq } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions, blockReviews, fieldFlags } from '@/db/schema'
import { FIELDS, SERVICE_ITEMS, SERVICE_GROUPS, BLOCKS } from '@/form-schema'
import {
  raiseFlag, resolveFlag, openFlags, isFlaggableKey, blockKeyOf, clearFlagsFor, FLAG_REASONS,
} from '../flags'

async function seedSubmitted(db: Db): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  const [submission] = await db
    .insert(submissions).values({ loungeId: lounge!.id, status: 'submitted' }).returning()
  return submission!.id
}

const flag = (submissionId: string, fieldKey: string) => ({
  submissionId,
  fieldKey,
  reason: 'needs_detail' as const,
  comment: 'Не перечислены авиакомпании',
  reviewer: 'reviewer-1',
})

describe('адресация замечаний', () => {
  it('плоское поле можно отметить', () => {
    expect(isFlaggableKey('III.2.4')).toBe(true)
  })

  it('позицию услуг можно отметить целиком', () => {
    expect(isFlaggableKey('2.1')).toBe(true)
  })

  it('отдельный атрибут позиции отметить нельзя', () => {
    expect(isFlaggableKey('2.1.price')).toBe(false)
  })

  it('слот фотографии можно отметить', () => {
    expect(isFlaggableKey('reception')).toBe(true)
  })

  it('выдуманный ключ отметить нельзя', () => {
    expect(isFlaggableKey('IX.99')).toBe(false)
  })
})

describe('замечания', () => {
  it('замечание попадает в список открытых', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const result = await raiseFlag(db, flag(submissionId, 'III.2.4'))

    expect(result.ok).toBe(true)
    const open = await openFlags(db, submissionId)
    expect(open).toHaveLength(1)
    expect(open[0]?.comment).toBe('Не перечислены авиакомпании')
  })

  it('замечание на неизвестный ключ отклоняется', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const result = await raiseFlag(db, flag(submissionId, 'IX.99'))
    expect(result.ok).toBe(false)
  })

  // Выбранная причина — САМА ПО СЕБЕ полное замечание: экран правок показывает
  // её код заметно (`FixesOnly`, `FLAG_REASON_LABELS`), так что «не заполнено»
  // без текста полностью понятно оператору. Раньше пустой комментарий
  // отклонялся всегда — и тест на этом месте пиннил именно это.
  it('одной причины достаточно — комментарий сохраняется пустым', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const result = await raiseFlag(db, {
      ...flag(submissionId, 'III.2.4'), comment: '   ',
    })

    expect(result.ok).toBe(true)
    const open = await openFlags(db, submissionId)
    expect(open).toHaveLength(1)
    expect(open[0]?.reason).toBe('needs_detail')
    expect(open[0]?.comment).toBe('')
  })

  // …но замечание БЕЗ причины и БЕЗ текста не несёт оператору никакой
  // информации — только оно и отклоняется.
  it('без причины и без комментария отклоняется', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const result = await raiseFlag(db, {
      ...flag(submissionId, 'III.2.4'), reason: null, comment: '   ',
    })
    expect(result.ok).toBe(false)
  })

  it('причина необязательна', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const result = await raiseFlag(db, {
      ...flag(submissionId, 'III.2.4'), reason: null,
    })
    expect(result.ok).toBe(true)
  })

  it('повторное замечание на то же поле заменяет прежнее', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    await raiseFlag(db, flag(submissionId, 'III.2.4'))
    await raiseFlag(db, {
      ...flag(submissionId, 'III.2.4'), comment: 'Уточнённая формулировка',
    })

    const open = await openFlags(db, submissionId)
    expect(open).toHaveLength(1)
    expect(open[0]?.comment).toBe('Уточнённая формулировка')
  })

  // Путь обновления апсерта (`ON CONFLICT ... DO UPDATE`) пишет и `comment`:
  // перезамечание одной причиной поверх прежнего с текстом не должно оставить
  // устаревший текст рядом с новой причиной — оператор прочёл бы претензию,
  // которой ревьюер больше не предъявляет.
  it('перезамечание одной причиной затирает прежний комментарий', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    await raiseFlag(db, flag(submissionId, 'III.2.4'))
    await raiseFlag(db, {
      ...flag(submissionId, 'III.2.4'), reason: 'empty', comment: '',
    })

    const open = await openFlags(db, submissionId)
    expect(open).toHaveLength(1)
    expect(open[0]?.reason).toBe('empty')
    expect(open[0]?.comment).toBe('')
  })

  it('снятое замечание уходит из открытых', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)
    await raiseFlag(db, flag(submissionId, 'III.2.4'))

    const [open] = await openFlags(db, submissionId)
    await resolveFlag(db, open!.id)

    expect(await openFlags(db, submissionId)).toHaveLength(0)
  })

  it('снятое замечание не мешает поставить новое', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)
    await raiseFlag(db, flag(submissionId, 'III.2.4'))
    const [first] = await openFlags(db, submissionId)
    await resolveFlag(db, first!.id)

    await raiseFlag(db, { ...flag(submissionId, 'III.2.4'), comment: 'Снова не то' })

    const open = await openFlags(db, submissionId)
    expect(open).toHaveLength(1)
    expect(open[0]?.comment).toBe('Снова не то')
  })

  it('гонка: две одновременные попытки замечания на одно поле дают одно открытое', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    // Не await по очереди — оба вызова запускаются, не дожидаясь друг
    // друга, чтобы проверить именно то, от чего защищает
    // `field_flags_open_unique`: два одновременных raiseFlag на тот же
    // ключ не должны привести к двум открытым строкам.
    const [a, b] = await Promise.all([
      raiseFlag(db, { ...flag(submissionId, 'III.2.4'), comment: 'Первое' }),
      raiseFlag(db, { ...flag(submissionId, 'III.2.4'), comment: 'Второе' }),
    ])

    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(await openFlags(db, submissionId)).toHaveLength(1)
  })

  it('строка с неизвестным reason читается как null, а не как невалидный FlagReason', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    // Вставлено напрямую, минуя raiseFlag, — `reason` в базе это простой
    // `text`, ничто на уровне БД не гарантирует членство в `FlagReason`.
    await db.insert(fieldFlags).values({
      submissionId,
      fieldKey: 'III.2.4',
      reason: 'bogus-value-not-in-union',
      comment: 'вставлено напрямую',
      createdBy: 'reviewer-1',
    })

    const open = await openFlags(db, submissionId)
    expect(open).toHaveLength(1)
    expect(open[0]?.reason).toBeNull()
  })

  it('каждый код из FLAG_REASONS проходит через raiseFlag/openFlags без потери', async () => {
    // Итерируется по самому `FLAG_REASONS`, а не по параллельно
    // напечатанному списку кодов — так тест пристёгнут к единственному
    // источнику правды. Если раскодирование причины (`isFlagReason`/
    // `toFlagReason`) когда-нибудь разойдётся с этим списком — например,
    // кто-то отдельно допишет причину в `FLAG_REASONS`, но не обновит
    // множество, по которому проверяется допустимость — ровно этот тест
    // получит `null` там, где ждёт код причины, и упадёт.
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    for (const reason of FLAG_REASONS) {
      const result = await raiseFlag(db, { ...flag(submissionId, 'III.2.4'), reason })
      expect(result.ok).toBe(true)

      const [open] = await openFlags(db, submissionId)
      expect(open?.reason).toBe(reason)
    }
  })
})

/** Подтверждает блок в базе — то же действие, что делает ревьюер task 3. */
async function confirmBlock(db: Db, submissionId: string, blockKey: string): Promise<void> {
  await db.insert(blockReviews).values({ submissionId, blockKey, confirmedBy: 'reviewer-1' })
}

async function confirmedBlocks(db: Db, submissionId: string): Promise<string[]> {
  const rows = await db
    .select({ blockKey: blockReviews.blockKey })
    .from(blockReviews)
    .where(eq(blockReviews.submissionId, submissionId))
  return rows.map((r) => r.blockKey)
}

describe('blockKeyOf', () => {
  it('плоское поле отображается на блок из его собственного описания', () => {
    const field = FIELDS.find((f) => f.key === 'III.2.4')
    expect(field).toBeDefined()
    expect(blockKeyOf('III.2.4')).toBe(field!.block)
  })

  it('позиция услуг отображается на блок её группы', () => {
    const item = SERVICE_ITEMS.find((i) => i.key === '2.1')
    expect(item).toBeDefined()
    const group = SERVICE_GROUPS.find((g) => g.key === item!.group)
    expect(group).toBeDefined()
    expect(blockKeyOf('2.1')).toBe(group!.block)
  })

  it('слот фотографии отображается на блок фотографий', () => {
    const photosBlock = BLOCKS.find((b) => b.kind === 'photos')
    expect(photosBlock).toBeDefined()
    expect(blockKeyOf('reception')).toBe(photosBlock!.key)
  })

  it('неотмечаемый ключ не отображается ни на один блок', () => {
    expect(blockKeyOf('IX.99')).toBeNull()
    expect(blockKeyOf('2.1.price')).toBeNull()
  })
})

describe('clearFlagsFor', () => {
  it('снимает замечание и инвалидирует подтверждение ЕГО блока, не трогая другой', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const flaggedField = FIELDS.find((f) => f.key === 'III.2.4')!
    const otherField = FIELDS.find((f) => f.key === 'I.1')!
    expect(flaggedField.block).not.toBe(otherField.block) // предпосылка теста

    await raiseFlag(db, flag(submissionId, 'III.2.4'))
    await confirmBlock(db, submissionId, flaggedField.block)
    await confirmBlock(db, submissionId, otherField.block)

    const result = await clearFlagsFor(db, submissionId, 'III.2.4')

    expect(result).toBe(true)
    expect(await openFlags(db, submissionId)).toHaveLength(0)
    const confirmed = await confirmedBlocks(db, submissionId)
    expect(confirmed).not.toContain(flaggedField.block)
    expect(confirmed).toContain(otherField.block)
  })

  /**
   * Этот тест раньше утверждал ОБРАТНОЕ («…и НЕ трогает подтверждение блока»)
   * и был зелёным — он пиннил как правильное поведение первый Important
   * обзора всей ветки: правка неотмеченного ответа оставляла блок
   * подтверждённым, и `approveSubmission` затем видел 27/27. Подтверждение
   * относится к данным, а не к замечанию, так что «замечания не было» — не
   * причина оставлять его в силе. Возвращаемое значение при этом не изменилось:
   * `false` по-прежнему значит «снимать было нечего», от него зависит только
   * логирование у вызывающих.
   */
  it('без открытого замечания возвращает false, но подтверждение блока всё равно снимает', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const field = FIELDS.find((f) => f.key === 'III.2.4')!
    const otherField = FIELDS.find((f) => f.key === 'I.1')!
    expect(field.block).not.toBe(otherField.block) // предпосылка теста
    await confirmBlock(db, submissionId, field.block)
    await confirmBlock(db, submissionId, otherField.block)

    const result = await clearFlagsFor(db, submissionId, 'III.2.4')

    expect(result).toBe(false)
    const confirmed = await confirmedBlocks(db, submissionId)
    expect(confirmed).not.toContain(field.block)
    // И по-прежнему только СВОЙ блок: снимать всё разом было бы не мягче, а
    // бессмысленнее — ревьюер перепроверял бы анкету целиком.
    expect(confirmed).toContain(otherField.block)
  })

  it('работает для слота фотографии', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const photosBlock = BLOCKS.find((b) => b.kind === 'photos')!

    await raiseFlag(db, { ...flag(submissionId, 'reception') })
    await confirmBlock(db, submissionId, photosBlock.key)

    const result = await clearFlagsFor(db, submissionId, 'reception')

    expect(result).toBe(true)
    expect(await confirmedBlocks(db, submissionId)).not.toContain(photosBlock.key)
  })

  it('работает для позиции услуг', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const item = SERVICE_ITEMS.find((i) => i.key === '2.1')!
    const group = SERVICE_GROUPS.find((g) => g.key === item.group)!

    await raiseFlag(db, { ...flag(submissionId, '2.1') })
    await confirmBlock(db, submissionId, group.block)

    const result = await clearFlagsFor(db, submissionId, '2.1')

    expect(result).toBe(true)
    expect(await confirmedBlocks(db, submissionId)).not.toContain(group.block)
  })
})

/**
 * `raiseFlag` locks the `submissions` row (`FOR UPDATE`) before its upsert on
 * `field_flags`, so it serializes against `confirmBlock`'s own lock+check
 * (`src/review/blocks.ts`) — see `raiseFlag`'s own doc comment for the full
 * reasoning. What this test does and does not prove:
 *
 * It does NOT prove the race is impossible by actually racing the two
 * functions against each other. PGlite — the driver `createTestDb` uses —
 * is explicitly single user/connection (its own README, "PGlite is single
 * user/connection"): there is exactly one session, so two `db.transaction`
 * calls issued "concurrently" from JS (e.g. via `Promise.all`) cannot
 * genuinely overlap in the first place — the underlying engine has no second
 * session for the other call to interleave with, so both run fully
 * sequentially regardless of whether the lock exists. A test built on
 * `Promise.all([raiseFlag(...), confirmBlock(...)])` here would pass
 * identically with or without the fix — it would prove nothing, while
 * looking like it proves the race is closed. That is worse than no test, so
 * it is not what this is.
 *
 * What it DOES prove: `raiseFlag`'s actual source, not a paraphrase of it,
 * both wraps its work in a transaction and issues `.for('update')` strictly
 * before `.insert(fieldFlags)` — the exact ordering (`submissions` lock,
 * then the child-table write) that would make two REAL, independently
 * connected Postgres sessions serialize correctly. It pins the mechanism,
 * not the outcome under concurrency — the same honest scope this codebase
 * already accepts for `unsafeDbUsagesIn`/`forbiddenImportsIn` (see their own
 * doc comments): a textual guard against reverting the fix, not a substitute
 * for a live concurrency test that this harness cannot run.
 */
describe('raiseFlag: механизм блокировки', () => {
  /**
   * Strips `/* ... *\/` and `// ...` comments before the caller scans for
   * `.for('update')`/`.insert(fieldFlags)`. Without this, a regression that
   * deletes the *code* but leaves the doc comment describing it intact (the
   * comment above `raiseFlag`'s lock literally contains the text
   * "`.for('update')`") would still make `indexOf` find a match — inside the
   * prose, not the statement — and the test would pass with the functional
   * lock gone. Verified this actually matters, not just in theory: see the
   * report's "partial deletion" verification for this exact scenario, run
   * and confirmed to fail before this stripping was added and pass — for
   * the wrong reason — without it.
   */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
  }

  /**
   * Extracts `raiseFlag`'s body by balancing delimiters rather than matching
   * a literal signature string — `): Promise<FlagResult> {` would break (and
   * throw, failing the whole file) on any reformatting that puts the return
   * type or brace on its own line. Depth-counts `(`/`)` from the name to find
   * the end of the parameter list (safe here because the parameter list
   * itself has no nested parens — only the `input: { ... }` object type,
   * whose braces this paren-count never looks at), then finds the function
   * body's own `{` right after that closing paren, then depth-counts braces
   * from there to the matching `}`.
   */
  function raiseFlagBody(): string {
    const file = readFileSync(join(process.cwd(), 'src/review/flags.ts'), 'utf8')
    const nameMatch = /export\s+async\s+function\s+raiseFlag\s*\(/.exec(file)
    if (!nameMatch) throw new Error('raiseFlag не найден в src/review/flags.ts')

    let parenDepth = 0
    let paramsEnd = -1
    for (let i = nameMatch.index + nameMatch[0].length - 1; i < file.length; i++) {
      if (file[i] === '(') parenDepth++
      else if (file[i] === ')') {
        parenDepth -= 1
        if (parenDepth === 0) { paramsEnd = i; break }
      }
    }
    if (paramsEnd === -1) throw new Error('не удалось найти конец параметров raiseFlag')

    const braceStart = file.indexOf('{', paramsEnd)
    if (braceStart === -1) throw new Error('не удалось найти начало тела raiseFlag')

    let braceDepth = 0
    for (let i = braceStart; i < file.length; i++) {
      if (file[i] === '{') braceDepth++
      else if (file[i] === '}') {
        braceDepth -= 1
        if (braceDepth === 0) return stripComments(file.slice(braceStart, i + 1))
      }
    }
    throw new Error('не удалось найти конец тела raiseFlag')
  }

  it('оборачивает работу в транзакцию', () => {
    expect(raiseFlagBody()).toContain('.transaction(')
  })

  it('берёт FOR UPDATE на submissions до записи в field_flags — по коду, а не по комментарию', () => {
    const body = raiseFlagBody()
    const lockIndex = body.indexOf(".for('update')")
    const insertIndex = body.indexOf('.insert(fieldFlags)')

    expect(lockIndex, 'ожидается вызов .for(\'update\')').toBeGreaterThan(-1)
    expect(insertIndex, 'ожидается .insert(fieldFlags)').toBeGreaterThan(-1)
    expect(lockIndex).toBeLessThan(insertIndex)
  })

  it('замечание всё ещё поднимается сквозным вызовом (транзакция не сломала обычную работу)', async () => {
    const db = await createTestDb()
    const submissionId = await seedSubmitted(db)

    const result = await raiseFlag(db, flag(submissionId, 'III.2.4'))
    expect(result.ok).toBe(true)

    const open = await openFlags(db, submissionId)
    expect(open.map((f) => f.fieldKey)).toContain('III.2.4')
  })
})
