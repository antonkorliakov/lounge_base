import { eq } from 'drizzle-orm'
import type { Localized } from '@/form-schema'
import type { Db } from '@/db/types'
import { lounges, submissions, photos } from '@/db/schema'
import { issueFillToken, FILL_TOKEN_TTL_DAYS } from '@/access/tokens'
import { saveFieldValue } from '@/submissions/values'

export type CreateLoungeInput = {
  name: string
  iataCode: string
  provider: string | null
  country: string
  city: string
  airport: string
}

export type CreateLoungeResult =
  | { ok: true; loungeId: string; submissionId: string; token: string; expiresAt: Date }
  | { ok: false; error: Localized }

export type DeleteLoungeResult =
  /** `photoUrls` — снимки УЖЕ удалённой анкеты: их блобы чистит вызывающий,
   *  ПОСЛЕ коммита (см. `deleteLounge`, почему не внутри транзакции). */
  | { ok: true; photoUrls: string[] }
  | { ok: false; error: Localized }

const fail = (en: string, ru: string): { ok: false; error: Localized } => ({
  ok: false,
  error: { en, ru },
})

/**
 * Три латинские буквы, после trim/uppercase. Правила «как выглядит IATA-код»
 * до этого модуля в системе НЕ БЫЛО нигде (проверено: `db/schema.ts` даёт
 * только `text` c индексом, анкетное поле I.10 — свободный текст, поиск
 * реестра — `ilike` без нормализации), так что это не вторая запись чужого
 * правила, а первая запись своего: сиды и боевые данные трёхбуквенные
 * (IST, DXB), и код аэропорта по стандарту IATA — ровно три буквы.
 * Нормализация до валидации: `ist` — опечатка регистра, а не другой код.
 */
const IATA_RE = /^[A-Z]{3}$/

/**
 * Паспорт лаунжа ↔ анкетные поля блока I: то, что администратор уже набрал в
 * «Add lounge», оператор не должен набирать второй раз. ОДНА запись
 * соответствия на оба его употребления — предзаполнение при создании
 * (`createLounge` ниже) и серверный расчёт «что показать под замком» на
 * форме заполнения (`lockedIdentityKeys`); рукописная копия списка на
 * клиенте — ровно тот класс расползания, который эта ветка ловит не первый
 * раз (`EDITABLE_STATUSES`, `FLAG_REASONS`, …).
 *
 * `lockable: false` у названия — решение пользователя: название лаунжа
 * остаётся редактируемым оператором ВСЕГДА. Отсюда осознанная асимметрия:
 * принятие анкеты копирует в реестр только классифицирующие поля (III.6.*,
 * см. `approveSubmission`), так что правка I.2 оператором НЕ меняет
 * `lounges.name` — строка реестра держит имя администратора, а экран
 * проверки показывает оба (заголовок — имя реестра, строка I.2 — ответ
 * оператора), и расхождение видно ревьюеру. Это существующее и принятое
 * поведение, не побочный эффект предзаполнения.
 */
export const IDENTITY_PREFILL = [
  { column: 'name', fieldKey: 'I.2', lockable: false },
  { column: 'provider', fieldKey: 'I.3', lockable: true },
  { column: 'country', fieldKey: 'I.7', lockable: true },
  { column: 'city', fieldKey: 'I.8', lockable: true },
  { column: 'airport', fieldKey: 'I.9', lockable: true },
  { column: 'iataCode', fieldKey: 'I.10', lockable: true },
] as const satisfies readonly {
  column: keyof IdentityColumns
  fieldKey: string
  lockable: boolean
}[]

/** Колонки паспорта лаунжа, которые участвуют в предзаполнении, — ровно те,
 *  что принимает `createLounge` (плюс их nullability по `db/schema.ts`). */
export type IdentityColumns = {
  name: string
  provider: string | null
  country: string
  city: string
  airport: string
  iataCode: string
}

/**
 * Какие поля блока I показывать оператору под замком (только чтение) в
 * ОСНОВНОМ проходе формы. Правило по каждому полю: колонка паспорта непуста
 * И сохранённый ответ анкеты дословно (после trim) совпадает с ней. Обе
 * половины обязательны, и это не перестраховка:
 *
 *  - «Колонка непуста» одна НЕ годится: лаунжи, заведённые до этой фичи
 *    (или ops-скриптом с пустой страной), имеют непустые колонки и НИ ОДНОГО
 *    предзаполненного ответа — замок на пустом обязательном поле сделал бы
 *    анкету незаполнимой и неотправляемой (тот самый класс «нужный человек
 *    не может дотянуться», за который проект уже платил Critical'ом).
 *  - «Ответ есть» одно не годится тоже: после того как ревьюер отметил
 *    поле, а оператор на экране правок исправил его (экран правок замки не
 *    рисует — это его контракт, см. `FixesOnly`), ответ расходится с
 *    колонкой, и подпись «заполнено вашей командой» стала бы ложью. Совпало
 *    — замок стоит; разошлось — замок растворяется НАВСЕГДА, и основной
 *    проход тоже отдаёт поле в правку. Схождение цикла правок гарантировано
 *    конструкцией, а не запретом.
 *
 * Считается НА СЕРВЕРЕ (страница заполнения знает и лаунж, и ответы) и
 * передаётся клиенту готовым списком ключей.
 */
export function lockedIdentityKeys(
  lounge: IdentityColumns,
  fields: Record<string, unknown>,
): string[] {
  const locked: string[] = []
  for (const entry of IDENTITY_PREFILL) {
    if (!entry.lockable) continue
    const column = lounge[entry.column]
    if (column === null || column.trim() === '') continue
    const answer = fields[entry.fieldKey]
    if (typeof answer !== 'string') continue
    if (answer.trim() !== column.trim()) continue
    locked.push(entry.fieldKey)
  }
  return locked
}

/**
 * Завести лаунж из кабинета: строка `lounges` + анкета с предзаполненным
 * паспортом (см. `IDENTITY_PREFILL`) + первый fill-токен. Единственная
 * санкционированная композиция создания: `scripts/ops.ts lounge` теперь
 * ходит СЮДА, а не повторяет вставки сырыми insert'ами — одна композиция,
 * одни правила (обязательность страны/города/аэропорта, нормализация IATA,
 * предзаполнение). Всё в ОДНОЙ транзакции: insert'ы, упавшие посередине,
 * оставили бы лаунж без анкеты — строку реестра, которую нельзя ни открыть,
 * ни заполнить. Страна/город/аэропорт обязательны: колонки notNull, а
 * пустые строки прежнего ops.ts всплывали пустыми опциями в фильтрах
 * реестра (`filterOptions` отдаёт значения как есть, `''` рисуется пустым
 * пунктом селекта — выбором, который ничего не значит).
 *
 * Записи в `events` нет — как нет её и у ops.ts: рождение лаунжа видно самой
 * строкой (`createdAt`), историю здесь заводит первая смена статуса.
 *
 * Собственных блокировок нет, и это не пропуск: все записи здесь — вставки
 * свежих строк, ничьего прежнего значения они не читают и не переписывают
 * (guard семьи 2 — `loungeLockViolationsIn` — требует лок только от
 * read-then-write формы). Один лок в транзакции всё же появляется — внутри
 * `saveFieldValue` (`assertEditable`, FOR UPDATE на `submissions`), но на
 * строку, вставленную этой же транзакцией: ждать на ней некому.
 *
 * TTL токена — `FILL_TOKEN_TTL_DAYS`, тот же, каким письма выдают ссылки
 * (`sendFillLink`): одна политика, записанная один раз.
 */
export async function createLounge(
  db: Db,
  input: CreateLoungeInput,
): Promise<CreateLoungeResult> {
  const name = input.name.trim()
  const iataCode = input.iataCode.trim().toUpperCase()
  const country = input.country.trim()
  const city = input.city.trim()
  const airport = input.airport.trim()
  // Пустой provider — это «не указан» (колонка nullable), а не пустая строка,
  // которая в строке реестра рисовалась бы лишним разделителем row-sub.
  const provider = input.provider?.trim() || null

  if (name === '') return fail('Name is required', 'Название обязательно')
  if (!IATA_RE.test(iataCode)) {
    return fail('IATA code must be 3 letters', 'Код IATA — три латинские буквы')
  }
  if (country === '') return fail('Country is required', 'Страна обязательна')
  if (city === '') return fail('City is required', 'Город обязателен')
  if (airport === '') return fail('Airport is required', 'Аэропорт обязателен')

  return db.transaction(async (tx) => {
    const [lounge] = await tx
      .insert(lounges)
      .values({ name, iataCode, provider, country, city, airport })
      .returning({ id: lounges.id })
    const [submission] = await tx
      .insert(submissions)
      .values({ loungeId: lounge!.id })
      .returning({ id: submissions.id })
    const { token, expiresAt } = await issueFillToken(tx, {
      submissionId: submission!.id,
      ttlDays: FILL_TOKEN_TTL_DAYS,
    })

    // Предзаполнение блока I тем, что администратор уже набрал, — через
    // НАСТОЯЩИЙ `saveFieldValue`, не сырыми insert'ами: валидация и полнота
    // обязаны видеть эти ответы тем же путём, что и набранные оператором.
    // Вызов с `tx` — тот же приём, что у `issueFillToken` строкой выше
    // (тип `Tx` структурно удовлетворяет `Db`); внутренний
    // `db.transaction` `saveFieldValue` на транзакции даёт SAVEPOINT, а не
    // вторую транзакцию, так что всё создание остаётся АТОМАРНЫМ: строка
    // лаунжа существует ⟺ предзаполненные ответы существуют. На этой
    // эквивалентности стоит `lockedIdentityKeys` — замок без ответа был бы
    // пустым нередактируемым обязательным полем. Блокировка `submissions`
    // внутри `assertEditable` берётся на строку, вставленную этой же
    // транзакцией, — ждать на ней некому.
    //
    // Отказ `saveFieldValue` здесь недостижим через валидные входы
    // (все значения — непустые строки текстовых полей, уже прошедшие
    // проверки выше), поэтому он не превращается в `fail(...)`, а роняет
    // транзакцию: вернуть `ok: false` из колбэка — значит ЗАКОММИТИТЬ
    // наполовину созданный лаунж.
    const identity: IdentityColumns = { name, provider, country, city, airport, iataCode }
    for (const entry of IDENTITY_PREFILL) {
      const value = identity[entry.column]
      if (value === null || value === '') continue
      const saved = await saveFieldValue(tx, {
        submissionId: submission!.id,
        fieldKey: entry.fieldKey,
        value,
      })
      if (!saved.ok) {
        throw new Error(`createLounge: prefill ${entry.fieldKey} refused — ${saved.error.en}`)
      }
    }

    return {
      ok: true,
      loungeId: lounge!.id,
      submissionId: submission!.id,
      token,
      expiresAt,
    }
  })
}

/**
 * Удалить лаунж целиком — с анкетами, ответами, снимками, замечаниями,
 * подтверждениями, токенами и историей событий. Решение пользователя: удалить
 * можно ЛЮБОЙ лаунж, с подтверждением; ворота — набранное руками название,
 * и сверяется оно ЗДЕСЬ, а не только в диалоге: клиентская проверка — это
 * подсказка, серверное действие достижимо по сети напрямую (правило ветки).
 * Сравнение точное после trim: название человек копирует из строки реестра,
 * и «почти совпало» здесь означало бы «удалил не то».
 *
 * Каскад проверен по `db/schema.ts` целиком, а не на веру: на `lounges.id`
 * ссылаются `submissions.loungeId` и `events.loungeId` (обе `onDelete:
 * cascade`), а все дети `submissions` — `field_values`, `service_values`,
 * `photos`, `block_reviews`, `field_flags`, `fill_tokens`, `events.
 * submissionId` — каскадные тоже, так что один DELETE сносит весь граф.
 * Отдельного события «лаунж удалён» не пишется: `events.loungeId` каскадом
 * уходит вместе с лаунжем, а запись с `loungeId: null` была бы историей,
 * у которой нет ни одного читателя, — write-only класс дефекта I2.
 *
 * `FOR UPDATE` на строке `lounges` — ПЕРВЫМ оператором, до сверки имени:
 * DELETE и сам возьмёт эксклюзивный лок строки, но сверка имени — чтение,
 * из которого удаление ВЫВОДИТСЯ (read-then-write форма, guard семьи 2), и
 * без лока она не сериализована против конкурентной записи той же строки.
 * Честно о цене вопроса: переименования лаунжей сегодня нет, так что гонка,
 * которую лок закрывает, — теоретическая; но правило guard'а — про форму, а
 * не про сегодняшний список писателей, и его цена — одна строка SQL.
 *
 * URL-ы снимков собираются ДО удаления (после — читать нечего) и
 * возвращаются вызывающему, а не чистятся здесь: удаление блобов — внешний
 * побочный эффект, и внутри транзакции он был бы необратим при её откате —
 * файлы живого лаунжа исчезли бы из хранилища. Окно «снимок закачали между
 * чтением списка и каскадом» существует (загрузка держит лок `submissions`,
 * не `lounges`) и оставляет блоб-орфан — та же цена и тот же выбор, что у
 * best-effort-очистки в `/api/photos`.
 */
export async function deleteLounge(
  db: Db,
  input: { loungeId: string; confirmName: string },
): Promise<DeleteLoungeResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ name: lounges.name })
      .from(lounges)
      .where(eq(lounges.id, input.loungeId))
      .for('update')
      .limit(1)

    const stored = rows[0]?.name
    if (stored === undefined) return fail('Lounge not found', 'Лаунж не найден')
    if (stored !== input.confirmName.trim()) {
      return fail(
        'The typed name does not match the lounge name',
        'Набранное название не совпадает с названием лаунжа',
      )
    }

    const photoRows = await tx
      .select({ url: photos.url })
      .from(photos)
      .innerJoin(submissions, eq(photos.submissionId, submissions.id))
      .where(eq(submissions.loungeId, input.loungeId))

    await tx.delete(lounges).where(eq(lounges.id, input.loungeId))

    return { ok: true, photoUrls: photoRows.map((row) => row.url) }
  })
}
