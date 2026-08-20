import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions, fieldValues, events } from '@/db/schema'
import type { SubmissionStatus } from '@/db/schema'
import { saveFieldValue, loadSubmissionValues } from '@/submissions/values'
import { importAirports } from '../directory'
import {
  createLounge,
  updateLoungePassport,
  passportHistory,
  lockedIdentityKeys,
  PASSPORT_EDIT_EVENT,
  type IdentityColumns,
} from '../manage'

/**
 * Правка паспорта лаунжа (`updateLoungePassport`) — вторая половина правила,
 * первая живёт в `prefill-lock.test.ts`: замок формы = «ответ дословно (после
 * trim) равен колонке». Здесь закрепляется, что правка паспорта это правило
 * НЕ ломает, а опирается на него: непочатый ответ следует за колонкой (и
 * замок стоит с новым значением), тронутый оператором — не трогается (и уже
 * отперт), отправленные/принятые анкеты не трогаются вовсе.
 *
 * Стенд — настоящий `createLounge` (лаунж + анкета с предзаполнением одной
 * транзакцией), а не рукописные insert'ы: синхронизация сравнивает ответы с
 * колонками, и ответы должны появиться тем же путём, каким появляются в
 * проде. Статусы анкеты для матрицы ставятся прямым UPDATE (как в
 * `flags.test.ts`): жизненный цикл целиком гоняет `resubmit.test.ts`, здесь
 * предмет — реакция синхронизации на СТАТУС, а не путь к нему.
 *
 * Справочник аэропортов сеется в каждый стенд (IST/ESB): тройка аэропорт/
 * город/страна выводится ТОЛЬКО из него (`resolveIdentity`), контракт ввода
 * её не содержит — «сменить город» в этих тестах значит «сменить код».
 */

const DIRECTORY = [
  { iata: 'IST', airport: 'Istanbul Airport', city: 'Istanbul', country: 'Turkey', prominent: true },
  { iata: 'ESB', airport: 'Esenboga International', city: 'Ankara', country: 'Turkey', prominent: false },
]

const INPUT = {
  name: 'Aurora Lounge',
  iataCode: 'IST',
  provider: 'dnata',
}

/** Тройка, которую справочник выводит из IST, — ожидание для сверок строк. */
const IST_DERIVED = {
  country: 'Turkey',
  city: 'Istanbul',
  airport: 'Istanbul Airport',
}

async function seededDb(): Promise<Db> {
  const db = await createTestDb()
  await importAirports(db, DIRECTORY)
  return db
}

async function seed(
  db: Db,
  status: SubmissionStatus = 'draft',
): Promise<{ loungeId: string; submissionId: string }> {
  const created = await createLounge(db, INPUT)
  if (!created.ok) throw new Error('seed: createLounge failed')
  if (status !== 'draft') {
    await db
      .update(submissions)
      .set({ status })
      .where(eq(submissions.id, created.submissionId))
  }
  return { loungeId: created.loungeId, submissionId: created.submissionId }
}

async function loungeRow(db: Db, loungeId: string): Promise<IdentityColumns> {
  const [row] = await db
    .select({
      name: lounges.name,
      provider: lounges.provider,
      country: lounges.country,
      city: lounges.city,
      airport: lounges.airport,
      iataCode: lounges.iataCode,
    })
    .from(lounges)
    .where(eq(lounges.id, loungeId))
  expect(row).toBeDefined()
  return row!
}

async function answersOf(db: Db, submissionId: string): Promise<Record<string, unknown>> {
  return (await loadSubmissionValues(db, submissionId)).fields
}

/** Замки формы ПОСЛЕ правки — тем же серверным правилом, каким их считает
 *  страница заполнения: не «должно быть заперто», а «заперто ли на самом
 *  деле» по колонкам и ответам из базы. */
async function lockedNow(db: Db, loungeId: string, submissionId: string): Promise<string[]> {
  return lockedIdentityKeys(await loungeRow(db, loungeId), await answersOf(db, submissionId))
}

async function passportEvents(db: Db) {
  return db
    .select({ actor: events.actor, payload: events.payload, loungeId: events.loungeId })
    .from(events)
    .where(eq(events.action, PASSPORT_EDIT_EVENT))
}

describe('updateLoungePassport: валидация — те же правила, что при создании', () => {
  it('каждый неверный ввод — отказ значением с обеими локалями, ничего не записано', async () => {
    const db = await seededDb()
    const { loungeId } = await seed(db)
    const before = await loungeRow(db, loungeId)

    // Негодный код, пустое имя — и код, которого нет в справочнике: прежние
    // отказы «страна/город/аэропорт обязательны» ушли вместе с полями
    // контракта, их место занял отказ ворот справочника.
    const refused = [
      await updateLoungePassport(db, { ...INPUT, loungeId, actor: 'r1', iataCode: 'ISTX' }),
      await updateLoungePassport(db, { ...INPUT, loungeId, actor: 'r1', name: '   ' }),
      await updateLoungePassport(db, { ...INPUT, loungeId, actor: 'r1', iataCode: 'QQQ' }),
    ]

    for (const result of refused) {
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.error.en).not.toBe('')
      expect(result.error.ru).not.toBe('')
    }
    expect(await loungeRow(db, loungeId)).toEqual(before)
    expect(await passportEvents(db)).toEqual([])
  })

  it('несуществующий лаунж — отказ значением, не падение', async () => {
    const db = await seededDb()
    const result = await updateLoungePassport(db, {
      ...INPUT,
      loungeId: '00000000-0000-0000-0000-000000000000',
      actor: 'r1',
      iataCode: 'ESB',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.en).toBe('Lounge not found')
    expect(await passportEvents(db)).toEqual([])
  })
})

describe('updateLoungePassport: колонки и событие', () => {
  it('меняет ровно изменённые колонки, IATA нормализуется, событие несёт old→new', async () => {
    const db = await seededDb()
    const { loungeId } = await seed(db)

    const result = await updateLoungePassport(db, {
      ...INPUT,
      loungeId,
      actor: 'reviewer@easyto.travel',
      iataCode: ' esb ', // нормализация — та же, что при создании
    })
    expect(result).toEqual({ ok: true })

    // Тройка последовала за кодом ЦЕЛИКОМ из справочника (страна совпала и
    // не изменилась) — руками её больше не задают.
    expect(await loungeRow(db, loungeId)).toEqual({
      ...INPUT,
      ...IST_DERIVED,
      city: 'Ankara',
      airport: 'Esenboga International',
      iataCode: 'ESB',
    })

    // Событие — одно, на лаунже, и payload перечисляет ТОЛЬКО изменённое:
    // журнал записывает, что правка внесла, а не весь паспорт целиком
    // (country в payload нет — Turkey совпала).
    const recorded = await passportEvents(db)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toEqual({
      actor: 'reviewer@easyto.travel',
      loungeId,
      payload: {
        changed: {
          city: { from: 'Istanbul', to: 'Ankara' },
          airport: { from: 'Istanbul Airport', to: 'Esenboga International' },
          iataCode: { from: 'IST', to: 'ESB' },
        },
      },
    })
  })

  it('правка без изменений — успех без записи и без события', async () => {
    const db = await seededDb()
    const { loungeId, submissionId } = await seed(db)
    const answersBefore = await answersOf(db, submissionId)

    const result = await updateLoungePassport(db, { ...INPUT, loungeId, actor: 'r1' })

    expect(result).toEqual({ ok: true })
    expect(await passportEvents(db)).toEqual([])
    expect(await answersOf(db, submissionId)).toEqual(answersBefore)
  })
})

describe('updateLoungePassport: синхронизация ответов редактируемых анкет', () => {
  it('черновик, ответ не тронут: ответ следует за колонкой, замок стоит с новым значением', async () => {
    const db = await seededDb()
    const { loungeId, submissionId } = await seed(db, 'draft')

    // Город меняется сменой кода: IST → ESB выводит Ankara из справочника.
    const result = await updateLoungePassport(db, {
      ...INPUT, loungeId, actor: 'r1', iataCode: 'ESB',
    })
    expect(result).toEqual({ ok: true })

    const answers = await answersOf(db, submissionId)
    expect(answers['I.8']).toBe('Ankara')
    // Замок ВЫВОДИТСЯ из совпадения, и с новым значением совпадение цело.
    expect(await lockedNow(db, loungeId, submissionId)).toContain('I.8')
  })

  it('changes_requested — тоже редактируемый статус: непочатый ответ следует за колонкой', async () => {
    const db = await seededDb()
    const { loungeId, submissionId } = await seed(db, 'changes_requested')

    await updateLoungePassport(db, { ...INPUT, loungeId, actor: 'r1', iataCode: 'ESB' })

    expect((await answersOf(db, submissionId))['I.9']).toBe('Esenboga International')
    expect(await lockedNow(db, loungeId, submissionId)).toContain('I.9')
  })

  it('ответ, разошедшийся лишь пробелами, — всё ещё непочатый (сравнение после trim)', async () => {
    const db = await seededDb()
    const { loungeId, submissionId } = await seed(db, 'draft')
    const saved = await saveFieldValue(db, {
      submissionId, fieldKey: 'I.8', value: '  Istanbul  ',
    })
    expect(saved.ok).toBe(true)

    await updateLoungePassport(db, { ...INPUT, loungeId, actor: 'r1', iataCode: 'ESB' })

    expect((await answersOf(db, submissionId))['I.8']).toBe('Ankara')
  })

  it('тронутый оператором ответ не переписывается — и остаётся отпертым', async () => {
    const db = await seededDb()
    const { loungeId, submissionId } = await seed(db, 'draft')
    // Оператор увёл ответ от колонки (экран правок замки не рисует).
    const saved = await saveFieldValue(db, {
      submissionId, fieldKey: 'I.8', value: 'Istanbul, Arnavutkoy',
    })
    expect(saved.ok).toBe(true)

    const result = await updateLoungePassport(db, {
      ...INPUT, loungeId, actor: 'r1', iataCode: 'ESB',
    })
    expect(result).toEqual({ ok: true })

    // Колонка новая, ответ оператора цел, замка нет (и не было).
    expect((await loungeRow(db, loungeId)).city).toBe('Ankara')
    expect((await answersOf(db, submissionId))['I.8']).toBe('Istanbul, Arnavutkoy')
    expect(await lockedNow(db, loungeId, submissionId)).not.toContain('I.8')
  })

  it.each(['submitted', 'approved'] as const)(
    '%s-анкета не трогается: колонка меняется, ответ остаётся прежним',
    async (status) => {
      const db = await seededDb()
      const { loungeId, submissionId } = await seed(db, status)

      const result = await updateLoungePassport(db, {
        ...INPUT, loungeId, actor: 'r1', iataCode: 'ESB',
      })
      expect(result).toEqual({ ok: true })

      expect((await loungeRow(db, loungeId)).city).toBe('Ankara')
      expect((await answersOf(db, submissionId))['I.8']).toBe('Istanbul')
    },
  )

  it('название (I.2) участвует наравне: непочатое следует, тронутое — нет', async () => {
    const db = await seededDb()
    const untouched = await seed(db, 'draft')
    await updateLoungePassport(db, {
      ...INPUT, loungeId: untouched.loungeId, actor: 'r1', name: 'Aurora Premium Lounge',
    })
    expect((await answersOf(db, untouched.submissionId))['I.2']).toBe('Aurora Premium Lounge')
    // I.2 не запирается никогда (`lockable: false`) — синхронизация имени
    // про данные, не про замок.
    expect(await lockedNow(db, untouched.loungeId, untouched.submissionId)).not.toContain('I.2')

    const diverged = await seed(db, 'draft')
    const saved = await saveFieldValue(db, {
      submissionId: diverged.submissionId, fieldKey: 'I.2', value: 'Aurora (operator name)',
    })
    expect(saved.ok).toBe(true)
    await updateLoungePassport(db, {
      ...INPUT, loungeId: diverged.loungeId, actor: 'r1', name: 'Aurora Premium Lounge',
    })
    expect((await answersOf(db, diverged.submissionId))['I.2']).toBe('Aurora (operator name)')
  })

  it('provider, очищенный до null: ответ I.3 остаётся и отпирается (пустая колонка не запирает)', async () => {
    const db = await seededDb()
    const { loungeId, submissionId } = await seed(db, 'draft')
    expect(await lockedNow(db, loungeId, submissionId)).toContain('I.3')

    const result = await updateLoungePassport(db, {
      ...INPUT, loungeId, actor: 'r1', provider: '',
    })
    expect(result).toEqual({ ok: true })

    expect((await loungeRow(db, loungeId)).provider).toBeNull()
    // Записать «ничего» в обязательное текстовое поле нельзя — ответ
    // остаётся у оператора, и поле снова его (замок растворился).
    expect((await answersOf(db, submissionId))['I.3']).toBe('dnata')
    expect(await lockedNow(db, loungeId, submissionId)).not.toContain('I.3')
  })

  it('отсутствующий ответ не выдумывается: provider null→значение не рождает I.3', async () => {
    const db = await seededDb()
    const created = await createLounge(db, { ...INPUT, provider: null })
    if (!created.ok) throw new Error('seed failed')

    const result = await updateLoungePassport(db, {
      ...INPUT, loungeId: created.loungeId, actor: 'r1', provider: 'dnata',
    })
    expect(result).toEqual({ ok: true })

    // Колонка появилась, но ответа, которого оператор не видел, нет — и
    // замка нет: `lockedIdentityKeys` требует совпадения с ответом.
    expect((await loungeRow(db, created.loungeId)).provider).toBe('dnata')
    expect((await answersOf(db, created.submissionId))['I.3']).toBeUndefined()
    expect(await lockedNow(db, created.loungeId, created.submissionId)).not.toContain('I.3')
  })

  it('лаунж без предзаполнения (старый): колонки правятся, ответы не появляются', async () => {
    const db = await seededDb()
    // Популяция 2 из prefill-lock.test.ts: строка реестра есть, ответов нет.
    const [lounge] = await db
      .insert(lounges)
      .values({ name: 'Legacy', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
      .returning({ id: lounges.id })
    const [submission] = await db
      .insert(submissions)
      .values({ loungeId: lounge!.id })
      .returning({ id: submissions.id })

    const result = await updateLoungePassport(db, {
      ...INPUT, name: 'Legacy', provider: null, loungeId: lounge!.id, actor: 'r1', iataCode: 'ESB',
    })
    expect(result).toEqual({ ok: true })

    expect((await loungeRow(db, lounge!.id)).city).toBe('Ankara')
    expect(await answersOf(db, submission!.id)).toEqual({})
    expect(await lockedNow(db, lounge!.id, submission!.id)).toEqual([])
  })
})

describe('passportHistory: читатель события passport_edited', () => {
  it('правки читаются старыми вперёд, каждая — со своим списком old→new', async () => {
    const db = await seededDb()
    const { loungeId } = await seed(db)

    // Тройка ходит только вместе с кодом, поэтому обе правки — смены кода:
    // туда (r1) и обратно (r2), каждая тянет город/аэропорт за собой.
    await updateLoungePassport(db, { ...INPUT, loungeId, actor: 'r1', iataCode: 'ESB' })
    await updateLoungePassport(db, { ...INPUT, loungeId, actor: 'r2', iataCode: 'IST' })

    const history = await passportHistory(db, loungeId)
    expect(history).toHaveLength(2)
    expect(history[0]?.actor).toBe('r1')
    expect(history[0]?.changes).toEqual([
      { column: 'city', from: 'Istanbul', to: 'Ankara' },
      { column: 'airport', from: 'Istanbul Airport', to: 'Esenboga International' },
      { column: 'iataCode', from: 'IST', to: 'ESB' },
    ])
    expect(history[1]?.actor).toBe('r2')
    expect(history[1]?.changes).toEqual([
      { column: 'city', from: 'Ankara', to: 'Istanbul' },
      { column: 'airport', from: 'Esenboga International', to: 'Istanbul Airport' },
      { column: 'iataCode', from: 'ESB', to: 'IST' },
    ])
  })

  it('чужие события лаунжа и записи с неразбираемым payload в историю не попадают', async () => {
    const db = await seededDb()
    const { loungeId } = await seed(db)

    // Чужое событие с payload, ПОХОЖИМ по-настоящему (см. довод в
    // status.test.ts: отбор обязан идти по action, а не по форме payload).
    await db.insert(events).values({
      loungeId,
      actor: 'r1',
      action: 'approved',
      payload: { changed: { city: { from: 'Istanbul', to: 'Ankara' } } },
    })
    // Своё action, но payload, записанный не нашей рукой, — выпадает разбором.
    await db.insert(events).values({
      loungeId,
      actor: 'r1',
      action: PASSPORT_EDIT_EVENT,
      payload: 'edited by migration',
    })
    await updateLoungePassport(db, { ...INPUT, loungeId, actor: 'r2', iataCode: 'ESB' })

    const history = await passportHistory(db, loungeId)
    expect(history).toHaveLength(1)
    expect(history[0]?.actor).toBe('r2')
  })
})

describe('updateLoungePassport: пересечение с принятием (passportFieldsFrom)', () => {
  it('после правки следующая синхронизация видит новые колонки как базу сравнения', async () => {
    // Правка паспорта и синхронизация на принятии не спорят: принятие пишет
    // колонки из ПРИНЯТЫХ ответов (слепая запись), правка — из ввода
    // администратора, и обе оставляют «ответ дословно равен колонке» там,
    // где не вмешивался оператор. Здесь закрепляется составная траектория:
    // правка → ответ последовал → правка ОБРАТНО → ответ последовал обратно
    // (сравнение шло уже с новым значением, а не с первоначальным).
    const db = await seededDb()
    const { loungeId, submissionId } = await seed(db, 'draft')

    await updateLoungePassport(db, { ...INPUT, loungeId, actor: 'r1', iataCode: 'ESB' })
    await updateLoungePassport(db, { ...INPUT, loungeId, actor: 'r1', iataCode: 'IST' })

    expect((await answersOf(db, submissionId))['I.8']).toBe('Istanbul')
    expect(await lockedNow(db, loungeId, submissionId)).toContain('I.8')
    expect(await passportEvents(db)).toHaveLength(2)
  })
})
