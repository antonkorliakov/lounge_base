import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Localized } from '@/form-schema'
import type { Db } from '@/db/types'
import { lounges, submissions, photos, fieldValues, events } from '@/db/schema'
import { issueFillToken, FILL_TOKEN_TTL_DAYS } from '@/access/tokens'
import { saveFieldValue } from '@/submissions/values'
import { EDITABLE_STATUSES } from '@/submissions/editable'
import { normalizeIata } from './iata'
import { lookupAirport } from './directory'

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

// Правило «как выглядит код IATA» жило здесь с рождения, а с появлением
// справочника аэропортов переехало в листовой `registry/iata.ts` (клиентские
// формы кабинета не могут импортировать этот модуль — см. довод там).
// Ре-экспорт сохраняет прежние серверные импорты правдой: правило одно.
export { normalizeIata }

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
 * остаётся редактируемым оператором ВСЕГДА. Отсюда осознанная асимметрия,
 * и с синхронизацией паспорта на принятии она стала РЕЗЧЕ, а не исчезла:
 * `approveSubmission` теперь копирует в реестр, кроме классифицирующих
 * полей (III.6.*), ещё и принятые ответы паспорта — страну/город/аэропорт/
 * IATA (I.7–I.10, см. `passportFieldsFrom` в `review/decide.ts`), — но
 * НЕ название: правка I.2 оператором по-прежнему НЕ меняет `lounges.name`.
 * Строка реестра держит имя администратора, а экран проверки показывает оба
 * (заголовок — имя реестра, строка I.2 — ответ оператора), и расхождение
 * видно ревьюеру. Это существующее и принятое поведение, не побочный эффект
 * предзаполнения; на нём стоит и заголовок экрана проверки. `provider`
 * (I.3) в синхронизацию тоже не входит — не по принципиальному решению, как
 * имя, а потому, что согласованный разрыв касался четырёх полей, которыми
 * фильтруют реестр и выгрузку; колонка остаётся творением создания лаунжа.
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
 * Единственная запись правил валидности паспорта в исполнимом виде —
 * извлечена из `createLounge`, когда паспорт стал редактируемым
 * (`updateLoungePassport` ниже): «те же проверки, что при создании» иначе
 * были бы вторым рукописным списком, который расползается с первым при
 * первом же новом правиле. Нормализация — часть валидации, а не отдельный
 * шаг: наружу уходит уже готовый `IdentityColumns` (trim, IATA через
 * `normalizeIata`, пустой provider — `null`, см. комментарии внутри), и оба
 * вызывающих пишут в колонки ровно его. Вызывается не напрямую, а через
 * `resolveIdentity` ниже — та сперва спрашивает справочник аэропортов и
 * при известном коде подменяет производные значения; сами ПРАВИЛА валидности
 * по-прежнему записаны только здесь.
 */
function validateIdentity(
  input: CreateLoungeInput,
): { ok: true; identity: IdentityColumns } | { ok: false; error: Localized } {
  const name = input.name.trim()
  const iataCode = normalizeIata(input.iataCode)
  const country = input.country.trim()
  const city = input.city.trim()
  const airport = input.airport.trim()
  // Пустой provider — это «не указан» (колонка nullable), а не пустая строка,
  // которая в строке реестра рисовалась бы лишним разделителем row-sub.
  const provider = input.provider?.trim() || null

  if (name === '') return fail('Name is required', 'Название обязательно')
  if (iataCode === null) {
    return fail('IATA code must be 3 letters', 'Код IATA — три латинские буквы')
  }
  if (country === '') return fail('Country is required', 'Страна обязательна')
  if (city === '') return fail('City is required', 'Город обязателен')
  if (airport === '') return fail('Airport is required', 'Аэропорт обязателен')

  return { ok: true, identity: { name, provider, country, city, airport, iataCode } }
}

/**
 * Валидация + вывод производных колонок из справочника аэропортов — общий
 * первый шаг обоих писателей паспорта (`createLounge`/`updateLoungePassport`).
 * Правило согласовано с пользователем: аэропорт/город/страна ЗАВИСЯТ от кода
 * IATA, и если справочник (`airport_directory`) знает код, в колонки уходят
 * значения СПРАВОЧНИКА — что бы ни прислал клиент. Это «клиентская подсказка,
 * серверные ворота» (правило ветки): формы кабинета показывают выведенные
 * значения read-only, но серверное действие достижимо по сети напрямую, и
 * присланный руками «город» не должен уметь разойтись со справочником.
 * Подмена — НЕ ошибка и не логируется: у честного клиента присланное и
 * выведенное совпадают байт в байт, а нечестному ответ ничего не должен.
 *
 * Кода в справочнике НЕТ — значения клиента идут в обычную валидацию:
 * справочник — не истина в последней инстанции (частные терминалы, новые
 * коды), и ручной ввод остаётся легальным путём. Порядок намеренно
 * «справочник ДО валидации»: при известном коде админ может не заполнять
 * три производных поля вовсе (форма их и не даёт), и валидировать пустоту,
 * которую сейчас же перезапишет справочник, значило бы отказывать на ровном
 * месте. Невалидный код валидация ниже ловит сама (`lookupAirport` на нём
 * возвращает `null`, не падение).
 *
 * Чтение справочника — вне транзакций вызывающих: это статичная таблица,
 * которую меняет только импорт (`db:import-airports`), гонки «справочник
 * поменялся между чтением и записью» здесь не стоят той блокировки.
 */
async function resolveIdentity(
  db: Db,
  input: CreateLoungeInput,
): Promise<{ ok: true; identity: IdentityColumns } | { ok: false; error: Localized }> {
  const directory = await lookupAirport(db, input.iataCode)
  const merged = directory
    ? { ...input, airport: directory.airport, city: directory.city, country: directory.country }
    : input
  return validateIdentity(merged)
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
  // Валидация, нормализация и вывод из справочника — общие с редактированием
  // паспорта (`resolveIdentity` выше): одно правило, один дом.
  const validated = await resolveIdentity(db, input)
  if (!validated.ok) return validated
  const identity = validated.identity

  return db.transaction(async (tx) => {
    const [lounge] = await tx
      .insert(lounges)
      .values(identity)
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

export type UpdateLoungePassportInput = CreateLoungeInput & {
  loungeId: string
  actor: string
}

export type UpdatePassportResult = { ok: true } | { ok: false; error: Localized }

/** Событие правки паспорта — одна константа на запись и на чтение
 *  (`passportHistory` отбирает по ней же), тот же приём, что
 *  `OPERATIONAL_STATUS_EVENT` в `registry/status.ts`. */
export const PASSPORT_EDIT_EVENT = 'passport_edited'

/**
 * Приписать значение колонки в частичный патч. Отдельная генерик-функция,
 * а не строка в цикле, потому что TypeScript не сужает коррелированную пару
 * «ключ + значение по этому ключу» внутри цикла по union ключей: без неё
 * присваивание требует каста, а каст здесь прятал бы ровно ту ошибку
 * (значение не той колонки), которую типы должны ловить.
 */
function assignColumn<K extends keyof IdentityColumns>(
  patch: Partial<IdentityColumns>,
  source: IdentityColumns,
  key: K,
): void {
  patch[key] = source[key]
}

/**
 * Правка паспорта лаунжа из кабинета — единственный честный путь исправить
 * опечатку в названии/городе/IATA БЕЗ цикла «оператор заполнил → ревьюер
 * отметил → оператор исправил → принятие» (тот работает только у анкеты,
 * дошедшей до `submitted`, и чужими руками). Валидация — та же, что при
 * создании, через общий `validateIdentity`: правил два набора быть не может.
 *
 * ОДНА ТРАНЗАКЦИЯ, `FOR UPDATE` НА СТРОКЕ `lounges` ПЕРВЫМ ОПЕРАТОРОМ — это
 * read-then-write формы guard'а семьи 2 (`loungeLockViolationsIn`): и патч
 * колонок, и синхронизация ответов ниже ВЫВОДЯТСЯ из прочитанных старых
 * значений, и без блокировки две одновременные правки прочитали бы один и
 * тот же `current`, записали бы два события с одинаковым `from`, а
 * синхронизация сравнивала бы ответы с уже несуществующим «старым» —
 * ровно та потеря цепочки, ради которой guard существует.
 *
 * СИНХРОНИЗАЦИЯ ОТВЕТОВ (правило согласовано с пользователем): у анкет в
 * редактируемых статусах (`EDITABLE_STATUSES` — draft/changes_requested)
 * ответ предзаполненного поля, который оператор НЕ ТРОГАЛ (дословно, после
 * trim, равен СТАРОМУ значению колонки — то же сравнение, каким
 * `lockedIdentityKeys` решает «замкнуто ли»), переписывается новым значением;
 * тронутый оператором — не трогается никогда; `submitted`/`approved` анкеты
 * не трогаются вовсе. Название (I.2) участвует наравне с остальными: оно
 * предзаполняется, и непочатое обязано следовать за паспортом. Замки формы
 * из этого ВЫВОДЯТСЯ, а не назначаются: синхронизированный ответ снова
 * дословно равен колонке — замок стоит с новым значением; разошедшийся уже
 * был отперт и остаётся отперт. Два края, решённые здесь и закреплённые
 * тестами:
 *  - ОТСУТСТВУЮЩИЙ ответ — не «непочатое предзаполнение», а «предзаполнения
 *    не было» (лаунж старше фичи, пустой provider при создании): выдумывать
 *    оператору ответ, которого он не видел, синхронизация не вправе — поле
 *    остаётся без ответа и без замка, как было.
 *  - Колонка, ставшая ПУСТОЙ (только provider — остальные обязательны):
 *    записать «ничего» в обязательное текстовое поле `saveFieldValue` не
 *    даст (`This field is required`), поэтому ответ остаётся старым и,
 *    разойдясь с колонкой, отпирается — оператор снова хозяин поля.
 *
 * Запись ответов — через НАСТОЯЩИЙ `saveFieldValue`, тем же приёмом, что
 * предзаполнение в `createLounge` (вызов с `tx` даёт SAVEPOINT, не вторую
 * транзакцию; его `assertEditable` берёт `FOR UPDATE` на строку
 * `submissions`, которую эта транзакция УЖЕ держит — см. блокировку ниже, —
 * так что ждать некому). Его отказ здесь недостижим через валидные входы
 * (строки анкет заперты этой же транзакцией, значения — непустые строки
 * настоящих текстовых полей, см. анти-вакуум в `prefill-lock.test.ts`),
 * поэтому не превращается в `fail(...)`, а роняет транзакцию целиком:
 * `ok: false` из колбэка закоммитил бы патч колонок без синхронизации.
 *
 * Редактируемые анкеты запираются (`FOR UPDATE` на их строках `submissions`)
 * ДО записи ответов: статус-переходы (`submitSubmission`, `requestChanges`,
 * `approveSubmission`) берут ту же строку первым оператором, так что между
 * «прочитали статус» и «записали ответ» анкета не может уехать в
 * `submitted` — предикат перепроверяется при захвате (READ COMMITTED,
 * EvalPlanQual: строка, сменившая статус между снимком и блокировкой, из
 * выборки выпадает).
 *
 * Про порядок блокировок, честно: эта транзакция берёт `lounges`, ПОТОМ
 * строки `submissions` — а `approveSubmission` наоборот (лочит `submissions`,
 * потом его слепой UPDATE берёт лок строки `lounges`). Противоположный
 * порядок — это форма цикла, но собраться ему почти не из чего: принятие
 * держит строку АНКЕТЫ В СТАТУСЕ `submitted`, а эта транзакция ждёт только
 * строки, которые её же снимок видел draft/changes_requested, — то есть окно
 * требует, чтобы между нашим снимком и захватом успели закоммититься
 * отправка анкеты И начаться её принятие, дошедшее до записи `lounges`.
 * Если это всё же случится, Postgres разорвёт цикл сам (deadlock detector,
 * ~1s): одна из транзакций упадёт и откатится ЦЕЛИКОМ — атомарность обеих
 * сторон не страдает, цена — ошибка «попробуйте ещё раз» у одного из двух
 * людей, одновременно правивших один лаунж. Устранить окно совсем можно
 * только развернув здесь порядок на «submissions раньше lounges», но это
 * подарило бы тот же цикл `deleteLounge` (он лочит `lounges`, а его каскадный
 * DELETE берёт строки `submissions` — L→S); общего порядка, устраивающего
 * всех трёх писателей, у этих таблиц нет, и выбран порядок, при котором
 * гонка требует самой длинной цепочки совпадений.
 *
 * Правка без изменений (все шесть значений совпали) — успех БЕЗ записи и без
 * события: «изменено: ничего» в истории было бы шумом, а не фактом.
 */
export async function updateLoungePassport(
  db: Db,
  input: UpdateLoungePassportInput,
): Promise<UpdatePassportResult> {
  // Валидация и справочник — до транзакции и блокировок: отказ по неверному
  // вводу не нуждается ни в чтении строки лаунжа, ни в `FOR UPDATE`, а
  // чтение справочника блокировки не требует (см. `resolveIdentity`).
  const validated = await resolveIdentity(db, input)
  if (!validated.ok) return validated
  const next = validated.identity

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        name: lounges.name,
        provider: lounges.provider,
        country: lounges.country,
        city: lounges.city,
        airport: lounges.airport,
        iataCode: lounges.iataCode,
      })
      .from(lounges)
      .where(eq(lounges.id, input.loungeId))
      .for('update')
      .limit(1)

    const current = rows[0]
    if (!current) return fail('Lounge not found', 'Лаунж не найден')

    const changed = IDENTITY_PREFILL.map((entry) => entry.column).filter(
      (column) => current[column] !== next[column],
    )
    if (changed.length === 0) return { ok: true }

    const patch: Partial<IdentityColumns> = {}
    for (const column of changed) assignColumn(patch, next, column)
    await tx.update(lounges).set(patch).where(eq(lounges.id, input.loungeId))

    // Кандидаты синхронизации: изменённые колонки, у которых есть и СТАРОЕ
    // значение (ответу было с чем совпадать), и НОВОЕ непустое (обязательному
    // текстовому полю есть что записать) — оба края разобраны в комментарии
    // функции.
    const syncable = IDENTITY_PREFILL.filter(
      (entry) =>
        changed.includes(entry.column) &&
        current[entry.column] !== null &&
        next[entry.column] !== null,
    )

    if (syncable.length > 0) {
      const editable = await tx
        .select({ id: submissions.id })
        .from(submissions)
        .where(
          and(
            eq(submissions.loungeId, input.loungeId),
            inArray(submissions.status, [...EDITABLE_STATUSES]),
          ),
        )
        .for('update')

      if (editable.length > 0) {
        const answers = await tx
          .select({
            submissionId: fieldValues.submissionId,
            fieldKey: fieldValues.fieldKey,
            value: fieldValues.value,
          })
          .from(fieldValues)
          .where(
            and(
              inArray(fieldValues.submissionId, editable.map((row) => row.id)),
              inArray(fieldValues.fieldKey, syncable.map((entry) => entry.fieldKey)),
            ),
          )

        for (const answer of answers) {
          const entry = syncable.find((item) => item.fieldKey === answer.fieldKey)!
          const previous = current[entry.column]!
          if (typeof answer.value !== 'string') continue
          if (answer.value.trim() !== previous.trim()) continue

          const saved = await saveFieldValue(tx, {
            submissionId: answer.submissionId,
            fieldKey: answer.fieldKey,
            value: next[entry.column],
          })
          if (!saved.ok) {
            throw new Error(
              `updateLoungePassport: sync ${answer.fieldKey} refused — ${saved.error.en}`,
            )
          }
        }
      }
    }

    await tx.insert(events).values({
      loungeId: input.loungeId,
      actor: input.actor,
      action: PASSPORT_EDIT_EVENT,
      payload: {
        changed: Object.fromEntries(
          changed.map((column) => [column, { from: current[column], to: next[column] }]),
        ),
      },
    })

    return { ok: true }
  })
}

export type PassportEdit = {
  actor: string
  at: Date
  changes: { column: keyof IdentityColumns; from: string | null; to: string | null }[]
}

const IDENTITY_COLUMN_SET: ReadonlySet<string> = new Set(
  IDENTITY_PREFILL.map((entry) => entry.column),
)

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

/**
 * Разбор payload события правки — защитный, по образцу `asStatusChange`
 * (`registry/status.ts`): `jsonb` ничего не обещает, и запись миграцией или
 * руками не должна превращаться в объект с `undefined` внутри. Ключи не из
 * `IDENTITY_PREFILL` и пары не из nullable-строк отбрасываются по одной;
 * событие, у которого не осталось ни одной разбираемой пары, выпадает целиком.
 */
function asPassportChanges(payload: unknown): PassportEdit['changes'] | null {
  if (typeof payload !== 'object' || payload === null) return null
  const changed = (payload as Record<string, unknown>)['changed']
  if (typeof changed !== 'object' || changed === null) return null

  const changes: PassportEdit['changes'] = []
  for (const [column, value] of Object.entries(changed)) {
    if (!IDENTITY_COLUMN_SET.has(column)) continue
    if (typeof value !== 'object' || value === null) continue
    const pair = value as Record<string, unknown>
    if (!isNullableString(pair['from']) || !isNullableString(pair['to'])) continue
    changes.push({
      column: column as keyof IdentityColumns,
      from: pair['from'],
      to: pair['to'],
    })
  }
  return changes.length > 0 ? changes : null
}

/**
 * История правок паспорта, старые записи первыми — читатель события
 * `PASSPORT_EDIT_EVENT` (событие без читателя — write-only класс дефекта I2,
 * см. историю `statusHistory`). В историю СМЕН СТАТУСА (`statusHistory`) эти
 * события осознанно НЕ включены: та отбирает по своему `action` и разбирает
 * payload в форму «from-статус → to-статус», в которую правка колонок не
 * укладывается — `asStatusChange` молча выронил бы такие записи, а
 * расширение его формы ради второго смысла сделало бы обе истории хуже.
 * Раздельные события — раздельные читатели; показывает эту историю
 * раскрывашка панели правки паспорта (`EditPassport`).
 */
export async function passportHistory(
  db: Db,
  loungeId: string,
): Promise<PassportEdit[]> {
  const rows = await db
    .select({ actor: events.actor, payload: events.payload, at: events.at })
    .from(events)
    .where(and(eq(events.loungeId, loungeId), eq(events.action, PASSPORT_EDIT_EVENT)))
    .orderBy(asc(events.at))

  return rows.flatMap((row) => {
    const changes = asPassportChanges(row.payload)
    return changes ? [{ actor: row.actor, at: row.at, changes }] : []
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
