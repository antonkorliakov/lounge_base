import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, events, operationalStatus } from '@/db/schema'
import { OPERATIONAL_STATUSES, setOperationalStatus, statusHistory } from '../status'

async function seedLounge(db: Db): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  return lounge!.id
}

describe('перечень статусов', () => {
  it('четыре значения', () => {
    expect(OPERATIONAL_STATUSES.map((s) => s.id)).toEqual([
      'active', 'temporarily_closed', 'under_renovation', 'closed',
    ])
  })

  /**
   * Тот же список, но сверенный с ЕДИНСТВЕННЫМ определением множества —
   * `operationalStatus` в `db/schema.ts`. Тест выше закрепляет порядок, в
   * котором статусы показываются человеку (его выбирает этот модуль, а не
   * база); этот — что множество не разошлось со схемой. Без него добавленный
   * в enum статус остался бы без подписи, и оба теста выше продолжали бы
   * проходить: первый сравнивает с таким же рукописным списком, второй
   * обходит только то, что в массиве есть.
   */
  it('множество совпадает со схемой, а не живёт рядом с ней', () => {
    expect([...OPERATIONAL_STATUSES.map((s) => s.id)].sort())
      .toEqual([...operationalStatus.enumValues].sort())
  })

  it('дата открытия предлагается у временных состояний', () => {
    const allows = OPERATIONAL_STATUSES.filter((s) => s.allowsDate).map((s) => s.id)
    expect(allows).toEqual(['temporarily_closed', 'under_renovation'])
  })

  it('у каждого статуса обе локали', () => {
    for (const status of OPERATIONAL_STATUSES) {
      expect(status.label.en.trim()).not.toBe('')
      expect(status.label.ru.trim()).not.toBe('')
    }
  })
})

describe('смена статуса лаунжа', () => {
  it('новый лаунж действующий', async () => {
    const db = await createTestDb()
    const loungeId = await seedLounge(db)
    const [row] = await db.select().from(lounges).where(eq(lounges.id, loungeId))
    expect(row?.operationalStatus).toBe('active')
  })

  it('перевод на ремонт с датой и комментарием', async () => {
    const db = await createTestDb()
    const loungeId = await seedLounge(db)

    const result = await setOperationalStatus(db, {
      loungeId, status: 'under_renovation',
      until: '2026-09-15', comment: 'Реконструкция зоны питания', actor: 'r1',
    })

    expect(result.ok).toBe(true)
    const [row] = await db.select().from(lounges).where(eq(lounges.id, loungeId))
    expect(row?.operationalStatus).toBe('under_renovation')
    expect(row?.statusUntil).toBe('2026-09-15')
    expect(row?.statusComment).toBe('Реконструкция зоны питания')
  })

  it('дата и комментарий необязательны', async () => {
    const db = await createTestDb()
    const loungeId = await seedLounge(db)

    const result = await setOperationalStatus(db, {
      loungeId, status: 'temporarily_closed', until: null, comment: null, actor: 'r1',
    })

    expect(result.ok).toBe(true)
    const [row] = await db.select().from(lounges).where(eq(lounges.id, loungeId))
    expect(row?.statusUntil).toBeNull()
  })

  it('возврат в «действующий» очищает дату и комментарий', async () => {
    const db = await createTestDb()
    const loungeId = await seedLounge(db)
    await setOperationalStatus(db, {
      loungeId, status: 'under_renovation', until: '2026-09-15', comment: 'ремонт', actor: 'r1',
    })

    await setOperationalStatus(db, {
      loungeId, status: 'active', until: null, comment: null, actor: 'r1',
    })

    const [row] = await db.select().from(lounges).where(eq(lounges.id, loungeId))
    expect(row?.statusUntil).toBeNull()
    expect(row?.statusComment).toBeNull()
  })

  it('из «закрыт» можно вернуться в «действующий»', async () => {
    const db = await createTestDb()
    const loungeId = await seedLounge(db)
    await setOperationalStatus(db, {
      loungeId, status: 'closed', until: null, comment: null, actor: 'r1',
    })

    const result = await setOperationalStatus(db, {
      loungeId, status: 'active', until: null, comment: null, actor: 'r1',
    })
    expect(result.ok).toBe(true)
  })

  it('дата у «действующего» отклоняется', async () => {
    const db = await createTestDb()
    const loungeId = await seedLounge(db)

    const result = await setOperationalStatus(db, {
      loungeId, status: 'active', until: '2026-09-15', comment: null, actor: 'r1',
    })
    expect(result.ok).toBe(false)
  })

  it('дата не в формате ISO отклоняется', async () => {
    const db = await createTestDb()
    const loungeId = await seedLounge(db)

    const result = await setOperationalStatus(db, {
      loungeId, status: 'under_renovation', until: '15.09.2026', comment: null, actor: 'r1',
    })
    expect(result.ok).toBe(false)
  })

  /**
   * Формы `\d{4}-\d{2}-\d{2}` недостаточно: `status_until` — настоящая колонка
   * `date`, и 30 февраля прошло бы проверку формата, а упало бы уже в
   * Postgres — то есть отказ, который этот модуль обещает возвращать как
   * `ok: false`, стал бы исключением и 500-й у вызывающего. Проверяется и то,
   * что после отказа статус не поехал: отказ должен быть отказом целиком, а
   * не «дату не записали, статус записали».
   */
  it('дата правильной формы, но несуществующая в календаре, отклоняется', async () => {
    const db = await createTestDb()
    const loungeId = await seedLounge(db)

    for (const until of ['2026-02-30', '2026-13-01', '2026-00-10']) {
      const result = await setOperationalStatus(db, {
        loungeId, status: 'under_renovation', until, comment: null, actor: 'r1',
      })
      expect(result.ok, `until=${until}`).toBe(false)
    }

    const [row] = await db.select().from(lounges).where(eq(lounges.id, loungeId))
    expect(row?.operationalStatus).toBe('active')
    expect(row?.statusUntil).toBeNull()
  })

  it('каждая смена попадает в историю', async () => {
    const db = await createTestDb()
    const loungeId = await seedLounge(db)
    await setOperationalStatus(db, {
      loungeId, status: 'under_renovation', until: '2026-09-15', comment: 'ремонт', actor: 'r1',
    })
    await setOperationalStatus(db, {
      loungeId, status: 'active', until: null, comment: null, actor: 'r2',
    })

    const history = await statusHistory(db, loungeId)
    expect(history).toHaveLength(2)
    expect(history[0]?.to).toBe('under_renovation')
    expect(history[0]?.from).toBe('active')
    expect(history[1]?.actor).toBe('r2')
  })

  /**
   * История — это события смены статуса, а не все события лаунжа, у которых
   * payload похож на смену статуса. На `loungeId` висит ещё как минимум
   * `approved` (`approveSubmission` пишет его с `payload.classifying`), а
   * дальше появятся другие: реестр и выгрузка плана 3 тоже будут писать
   * события. Отбор по `action` не зависит от того, что в чьём payload лежит;
   * отбор по форме payload (`'to' in payload`) отличает историю от чужой
   * записи только до первого чужого события с ключом `to` — а такое событие
   * никак нельзя запретить, потому что `payload` это `jsonb` без схемы.
   * Поэтому чужое событие здесь сделано похожим ПО-НАСТОЯЩЕМУ: payload у него
   * не просто содержит ключ `to`, а полностью проходит разбор
   * (`asStatusChange`) — валидный статус в `to`, валидные `until`/`comment`.
   * Иначе тест доказывал бы не то, что думает: первая его версия несла
   * `to: 'что угодно'`, и такую запись отсеивал защитный разбор, а не отбор по
   * `action`, — проверено снятием отбора, тест остался зелёным.
   */
  it('в историю не попадают чужие события того же лаунжа', async () => {
    const db = await createTestDb()
    const loungeId = await seedLounge(db)

    await db.insert(events).values({
      loungeId,
      actor: 'reviewer@easyto.travel',
      action: 'approved',
      payload: { from: 'active', to: 'closed', until: null, comment: null },
    })

    await setOperationalStatus(db, {
      loungeId, status: 'temporarily_closed', until: null, comment: null, actor: 'r1',
    })

    const history = await statusHistory(db, loungeId)
    expect(history).toHaveLength(1)
    expect(history[0]?.to).toBe('temporarily_closed')
  })

  it('несуществующий лаунж отклоняется', async () => {
    const db = await createTestDb()
    const result = await setOperationalStatus(db, {
      loungeId: '00000000-0000-0000-0000-000000000000',
      status: 'closed', until: null, comment: null, actor: 'r1',
    })
    expect(result.ok).toBe(false)
  })

  /**
   * Отказ ДО транзакции: дата у статуса, который даты не несёт, отклоняется
   * проверкой `!meta.allowsDate` раньше всякого обращения к базе (см.
   * комментарий «Валидация до всякого обращения к базе» в `setOperationalStatus`).
   * Здесь нечему откатываться — транзакция не открывалась; проверяется, что
   * и события такой отказ за собой не оставляет.
   */
  it('отказ до транзакции (дата у статуса без даты) не пишет события', async () => {
    const db = await createTestDb()
    const loungeId = await seedLounge(db)

    const result = await setOperationalStatus(db, {
      loungeId, status: 'active', until: '2026-09-15', comment: null, actor: 'r1',
    })

    expect(result.ok).toBe(false)
    expect(await db.select({ id: events.id }).from(events)).toEqual([])
  })

  /**
   * Отказ ВНУТРИ транзакции: «лаунж не найден» обнаруживается уже после
   * `BEGIN`, и выход из колбэка `db.transaction` через обычный `return` НЕ
   * откатывает транзакцию — drizzle коммитит всё, что колбэк успел записать,
   * а откат случается только на исключении (или явном `tx.rollback()`).
   * События здесь нет не благодаря откату, а потому, что до `return fail(...)`
   * функция ничего не пишет — ни `UPDATE`, ни `INSERT`. Тест закрепляет
   * именно это следствие: появись перед отказом хоть одна запись, коммит
   * вынес бы её наружу, и `events` перестал бы быть пустым.
   */
  it('отказ внутри транзакции (лаунж не найден) не пишет события', async () => {
    const db = await createTestDb()
    await seedLounge(db)

    const result = await setOperationalStatus(db, {
      loungeId: '00000000-0000-0000-0000-000000000000',
      status: 'closed', until: null, comment: null, actor: 'r1',
    })

    expect(result.ok).toBe(false)
    expect(await db.select({ id: events.id }).from(events)).toEqual([])
  })
})
