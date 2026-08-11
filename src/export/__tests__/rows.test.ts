import { describe, it, expect } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions, fieldValues, serviceValues, photos } from '@/db/schema'
import { buildFlatRows } from '../rows'
import { flatColumns } from '../columns'

async function seed(db: Db): Promise<void> {
  const [approved] = await db.insert(lounges).values({
    name: 'Primeclass Lounge', provider: 'Çelebi', country: 'Turkey', city: 'Istanbul',
    airport: 'Istanbul Airport', iataCode: 'IST', terminal: 'main', zone: ['departure'],
  }).returning()

  const [draftOnly] = await db.insert(lounges).values({
    name: 'IGA Lounge', provider: 'IGA', country: 'Turkey', city: 'Istanbul',
    airport: 'Istanbul Airport', iataCode: 'IST', terminal: 't2', zone: ['departure'],
    // Не-active статус с датой открытия: строка обязана уехать целиком, а не
    // отсечься, и `status_until` — проверяемая колонка, а не довесок.
    operationalStatus: 'under_renovation', statusUntil: '2026-09-15',
  }).returning()

  const [s1] = await db.insert(submissions).values({
    loungeId: approved!.id, status: 'approved',
    createdAt: new Date('2026-02-01'), decidedAt: new Date('2026-02-10'),
  }).returning()

  await db.insert(submissions).values({
    loungeId: draftOnly!.id, status: 'draft', createdAt: new Date('2026-02-01'),
  })

  await db.insert(fieldValues).values([
    { submissionId: s1!.id, fieldKey: 'I.2', value: 'Primeclass Lounge' },
    { submissionId: s1!.id, fieldKey: 'III.2.2', value: 3 },
    { submissionId: s1!.id, fieldKey: 'III.6.6', value: ['departure', 'transit'] },
    { submissionId: s1!.id, fieldKey: 'III.2.4', value: { option: 'specific', detail: 'Turkish Airlines' } },
    { submissionId: s1!.id, fieldKey: 'III.2.1', value: { hours: 3 } },
    // Единственное составное поле анкеты: `slots.age` — содержательный ответ.
    { submissionId: s1!.id, fieldKey: 'III.3.2', value: { option: 'allowed', detail: null, slots: { age: 10 } } },
  ])

  await db.insert(serviceValues).values({
    submissionId: s1!.id, itemKey: '7.2', available: 'yes',
    chargeType: 'chargeable', price: '15.00', currency: 'EUR',
    slotMinutes: 30, bookingRequired: true,
    // Непустой `details`: седьмой атрибут, который образец плана (и два
    // черновика до него) терял, — обязан долететь до своей колонки.
    details: 'Towels and amenities provided',
  })

  await db.insert(photos).values([
    { submissionId: s1!.id, slot: 'entrance', blobKey: 'e.jpg', url: 'https://blob.test/e.jpg' },
    // Накопительный слот: единственный, где в одной ячейке несколько URL.
    { submissionId: s1!.id, slot: 'additional', blobKey: 'a1.jpg', url: 'https://blob.test/a1.jpg' },
    { submissionId: s1!.id, slot: 'additional', blobKey: 'a2.jpg', url: 'https://blob.test/a2.jpg' },
  ])
}

const at = (columns: { key: string }[], row: unknown[], key: string): unknown => {
  const position = columns.findIndex((c) => c.key === key)
  if (position === -1) throw new Error(`нет колонки ${key} — тест смотрит мимо файла`)
  return row[position]
}

describe('строки плоской выгрузки', () => {
  it('по умолчанию только принятые анкеты', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, {
      filters: {}, includeUnapproved: false,
    })

    expect(rows).toHaveLength(1)
    expect(at(columns, rows[0]!, 'name')).toBe('Primeclass Lounge')
  })

  it('с галочкой включаются непринятые, помеченные статусом', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, {
      filters: {}, includeUnapproved: true,
    })

    expect(rows).toHaveLength(2)
    const iga = rows.find((r) => at(columns, r, 'name') === 'IGA Lounge')
    expect(at(columns, iga!, 'submission_status')).toBe('draft')
  })

  it('ширина каждой строки равна числу колонок', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, {
      filters: {}, includeUnapproved: true,
    })

    expect(columns).toHaveLength(flatColumns().length)
    for (const row of rows) expect(row).toHaveLength(columns.length)
  })

  it('мультивыбор склеивается через запятую', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(at(columns, rows[0]!, 'III.6.6')).toBe('departure, transit')
  })

  it('выбор с уточнением показывает оба значения', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(at(columns, rows[0]!, 'III.2.4')).toBe('specific — Turkish Airlines')
  })

  it('числовой ответ остаётся числом, а не строкой', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(at(columns, rows[0]!, 'III.2.2')).toBe(3)
  })

  it('шаблон разворачивается в исходную фразу', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(at(columns, rows[0]!, 'III.2.1')).toBe(
      'Access is permitted 3 hours prior to scheduled flight departure.',
    )
  })

  /**
   * `III.3.2` — единственное поле, чей ответ несёт `slots` наравне с
   * `option`: минимальный возраст, записанный числом по явному решению
   * оператора. Образец Task 4 читал только `option`/`detail` — третий
   * независимый показ этих значений, третий раз теряющий возраст (два
   * предыдущих задокументированы в `web/renderValues.ts`). Ради этого показ
   * общий (`form-schema/render.ts`), а не написан здесь заново.
   */
  it('составное select-поле выгружает и вариант, и возраст', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(at(columns, rows[0]!, 'III.3.2')).toBe('allowed — 10 years old')
  })

  it('атрибуты услуги ложатся по своим колонкам, включая details', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(at(columns, rows[0]!, '7.2.available')).toBe('yes')
    // Postgres numeric приезжает строкой; числом его делает
    // `loadSubmissionValues` (`price: Number(row.price)`) — ячейка обязана
    // нести число, иначе принимающая сторона сортирует цены как текст.
    expect(at(columns, rows[0]!, '7.2.price')).toBe(15)
    expect(at(columns, rows[0]!, '7.2.currency')).toBe('EUR')
    expect(at(columns, rows[0]!, '7.2.slotMinutes')).toBe(30)
    expect(at(columns, rows[0]!, '7.2.bookingRequired')).toBe('yes')
    expect(at(columns, rows[0]!, '7.2.details')).toBe('Towels and amenities provided')
  })

  it('незаполненные значения дают null', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(at(columns, rows[0]!, '1.1.available')).toBeNull()
    expect(at(columns, rows[0]!, 'I.1')).toBeNull()
  })

  it('фото именованного слота выгружается ссылкой', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(at(columns, rows[0]!, 'photo.entrance')).toBe('https://blob.test/e.jpg')
  })

  it('накопительный слот кладёт все ссылки в одну ячейку через пробел', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(at(columns, rows[0]!, 'photo.additional')).toBe(
      'https://blob.test/a1.jpg https://blob.test/a2.jpg',
    )
  })

  it('пустой фото-слот — null', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(at(columns, rows[0]!, 'photo.reception')).toBeNull()
  })

  it('статус лаунжа выгружается наравне и не отсекает строку', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: true })
    const iga = rows.find((r) => at(columns, r, 'name') === 'IGA Lounge')
    expect(at(columns, iga!, 'operational_status')).toBe('under_renovation')
    // `date`-колонка приезжает строкой YYYY-MM-DD (RegistryRow.statusUntil:
    // string | null) — в ячейку она ложится как есть, без Date-объекта.
    expect(at(columns, iga!, 'status_until')).toBe('2026-09-15')
  })

  it('фильтр сужает выгрузку', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows } = await buildFlatRows(db, {
      filters: { terminal: 't2' }, includeUnapproved: true,
    })
    expect(rows).toHaveLength(1)
  })

  it('дата принятия выгружается днём в ISO', async () => {
    const db = await createTestDb()
    await seed(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(at(columns, rows[0]!, 'approved_at')).toBe('2026-02-10')
  })
})

/**
 * Лаунж, у которого ПОСЛЕ принятия открыли новую черновую анкету, — случай,
 * на котором семантика выгрузки видна целиком (предупреждение №2 из леджера
 * Task 3). Правило: строка выгрузки описывает ОДНУ анкету — значения,
 * `submission_status` и `approved_at` из неё же, без смешивания. Без галочки
 * это последняя ПРИНЯТАЯ анкета (проверенные данные не исчезают из выгрузки,
 * пока новая анкета не принята); с галочкой — последняя анкета как есть,
 * помеченная своим статусом. Образец плана вместо этого терял такой лаунж из
 * выгрузки по умолчанию вовсе.
 */
describe('черновик после принятия', () => {
  async function seedReopened(db: Db): Promise<void> {
    const [lounge] = await db.insert(lounges).values({
      name: 'Reopened', country: 'Turkey', city: 'Istanbul',
      airport: 'Istanbul Airport', iataCode: 'IST',
    }).returning()

    const [approved] = await db.insert(submissions).values({
      loungeId: lounge!.id, status: 'approved',
      createdAt: new Date('2026-01-10'), decidedAt: new Date('2026-01-20'),
    }).returning()
    const [draft] = await db.insert(submissions).values({
      loungeId: lounge!.id, status: 'draft', createdAt: new Date('2026-03-01'),
    }).returning()

    await db.insert(fieldValues).values([
      { submissionId: approved!.id, fieldKey: 'I.2', value: 'Verified Name' },
      { submissionId: draft!.id, fieldKey: 'I.2', value: 'Draft Name' },
    ])
  }

  it('без галочки уезжают принятые данные, а не пустота', async () => {
    const db = await createTestDb()
    await seedReopened(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: false })

    expect(rows).toHaveLength(1)
    expect(at(columns, rows[0]!, 'I.2')).toBe('Verified Name')
    expect(at(columns, rows[0]!, 'submission_status')).toBe('approved')
    expect(at(columns, rows[0]!, 'approved_at')).toBe('2026-01-20')
  })

  it('с галочкой уезжает черновик, помеченный статусом и без чужой даты принятия', async () => {
    const db = await createTestDb()
    await seedReopened(db)

    const { rows, columns } = await buildFlatRows(db, { filters: {}, includeUnapproved: true })

    expect(rows).toHaveLength(1)
    expect(at(columns, rows[0]!, 'I.2')).toBe('Draft Name')
    expect(at(columns, rows[0]!, 'submission_status')).toBe('draft')
    // Дата принятия ЯНВАРСКОЙ анкеты не подмешивается к мартовскому
    // черновику: она была бы датой принятия других значений.
    expect(at(columns, rows[0]!, 'approved_at')).toBeNull()
  })

  it('лаунж вовсе без анкет: без галочки его нет, с галочкой — паспорт и пустые ячейки', async () => {
    const db = await createTestDb()
    await db.insert(lounges).values({
      name: 'Never Filled', country: 'Turkey', city: 'Istanbul',
      airport: 'Istanbul Airport', iataCode: 'IST',
    })

    const closed = await buildFlatRows(db, { filters: {}, includeUnapproved: false })
    expect(closed.rows).toHaveLength(0)

    const open = await buildFlatRows(db, { filters: {}, includeUnapproved: true })
    expect(open.rows).toHaveLength(1)
    expect(at(open.columns, open.rows[0]!, 'name')).toBe('Never Filled')
    expect(at(open.columns, open.rows[0]!, 'submission_status')).toBeNull()
    expect(at(open.columns, open.rows[0]!, 'I.2')).toBeNull()
  })
})
