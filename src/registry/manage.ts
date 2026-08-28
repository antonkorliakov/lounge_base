import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Localized } from '@/form-schema'
import type { Db } from '@/db/types'
import { lounges, submissions, photos, fieldValues, events } from '@/db/schema'
import { issueFillToken, FILL_TOKEN_TTL_DAYS } from '@/access/tokens'
import { saveFieldValue } from '@/submissions/values'
import { EDITABLE_STATUSES } from '@/submissions/editable'
import { normalizeIata } from './iata'
import { lookupAirport, type DirectoryEntry } from './directory'
import {
  IDENTITY_PREFILL,
  DERIVED_PREFILL,
  DERIVED_FIELD_KEYS,
  IATA_FIELD_KEY,
  type IdentityColumns,
} from './identity'

// Соответствие «паспорт ↔ поля блока I» и производные от него списки живут в
// листовом `registry/identity.ts` (клиентские компоненты формы заполнения не
// могут импортировать этот модуль — см. довод там). Ре-экспорт сохраняет
// прежние серверные импорты правдой: запись одна.
export {
  IDENTITY_PREFILL,
  DERIVED_PREFILL,
  DERIVED_FIELD_KEYS,
  IATA_FIELD_KEY,
  lockedIdentityKeys,
} from './identity'
export type { IdentityColumns } from './identity'

/**
 * Вход обоих писателей паспорта — ТОЛЬКО то, что администратор решает сам:
 * имя, провайдер и код IATA. Аэропорт/город/страна из контракта убраны
 * намеренно (решение согласовано с пользователем): они ВЫВОДЯТСЯ из кода
 * справочником (`resolveIdentity`), клиентское значение для них игнорировалось
 * бы всегда — а поле, которое всегда игнорируется, не должно существовать в
 * контракте вовсе. Прежний ручной путь «кода нет в справочнике — заполните
 * тройку руками» удалён: лаунж можно завести только для аэропорта из
 * справочника, неизвестный код — честный отказ (лекарство — обновить
 * `src/db/reference/airports.tsv` и прогнать `db:import-airports`).
 */
export type CreateLoungeInput = {
  name: string
  provider: string | null
  iataCode: string
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
 * Единственная запись правил валидности паспорта в исполнимом виде — общий
 * первый шаг обоих писателей (`createLounge`/`updateLoungePassport`): «те же
 * проверки, что при создании» иначе были бы вторым рукописным списком.
 * Нормализация — часть валидации: наружу уходит готовый `IdentityColumns`
 * (trim имени, IATA через `normalizeIata`, пустой provider — `null`: колонка
 * nullable, а пустая строка рисовалась бы в строке реестра лишним
 * разделителем row-sub).
 *
 * СПРАВОЧНИК — ВОРОТА, НЕ ПОДСКАЗКА (правило согласовано с пользователем):
 * аэропорт/город/страна выводятся ТОЛЬКО из `airport_directory` по коду IATA —
 * клиент их не присылает вовсе (см. `CreateLoungeInput`), а серверное действие
 * достижимо по сети напрямую, и разойтись со справочником тройка не может
 * по построению. Кода в справочнике НЕТ — честный отказ, а не ручной ввод:
 * прежний miss-путь удалён, лаунж заводится только для аэропорта из
 * справочника; новый код добавляется обновлением TSV + `db:import-airports`.
 * Следствие для СТАРЫХ строк с ручными значениями: их колонки никто не
 * трогает, но ПРАВКА такого паспорта теперь требует кода из справочника —
 * осознанная цена, отказ называет лекарство.
 *
 * Проверок «страна/город/аэропорт непусты» больше нет — и это не ослабление:
 * единственный источник тройки — справочник, а его импорт
 * (`parseAirportsTsv`) падает на пустой колонке, так что пустых значений он
 * не выдаёт по построению.
 *
 * Чтение справочника — вне транзакций вызывающих: это статичная таблица,
 * которую меняет только импорт (`db:import-airports`), гонки «справочник
 * поменялся между чтением и записью» здесь не стоят той блокировки.
 */
async function resolveIdentity(
  db: Db,
  input: CreateLoungeInput,
): Promise<{ ok: true; identity: IdentityColumns } | { ok: false; error: Localized }> {
  const name = input.name.trim()
  const provider = input.provider?.trim() || null
  const iataCode = normalizeIata(input.iataCode)

  if (name === '') return fail('Name is required', 'Название обязательно')
  if (iataCode === null) {
    return fail('IATA code must be 3 letters', 'Код IATA — три латинские буквы')
  }

  const directory = await lookupAirport(db, iataCode)
  if (directory === null) {
    return fail(
      `Code ${iataCode} is not in the airport directory — a lounge can only be created ` +
        'for an airport from the directory; new airports are added by updating the directory',
      `Код ${iataCode} не найден в справочнике аэропортов — лаунж можно завести только ` +
        'для аэропорта из справочника; новый аэропорт добавляется обновлением справочника',
    )
  }

  return {
    ok: true,
    identity: {
      name,
      provider,
      iataCode,
      airport: directory.airport,
      city: directory.city,
      country: directory.country,
    },
  }
}

/**
 * Завести лаунж из кабинета: строка `lounges` + анкета с предзаполненным
 * паспортом (см. `IDENTITY_PREFILL`) + первый fill-токен. Единственная
 * санкционированная композиция создания: `scripts/ops.ts lounge` теперь
 * ходит СЮДА, а не повторяет вставки сырыми insert'ами — одна композиция,
 * одни правила (обязательность страны/города/аэропорта, нормализация IATA,
 * предзаполнение). Всё в ОДНОЙ транзакции: insert'ы, упавшие посередине,
 * оставили бы лаунж без анкеты — строку реестра, которую нельзя ни открыть,
 * ни заполнить. Страна/город/аэропорт в колонки приходят ТОЛЬКО из
 * справочника (`resolveIdentity`): колонки notNull, пустых значений
 * справочник не выдаёт по построению, и пустые опции в фильтрах реестра
 * (`filterOptions` отдаёт значения как есть) появиться не могут.
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

export type OperatorSaveResult =
  /** `savedKeys` — все ключи, чьи ответы эта запись изменила: сам ключ для
   *  обычного поля, вся четвёрка I.10+I.7/8/9 для кода IATA. Вызывающий
   *  (`saveFieldAction`) снимает замечания ровно по этому списку —
   *  исправленный код отвечает и на замечание «не та страна». */
  | { ok: true; savedKeys: readonly string[] }
  | { ok: false; error: Localized }

/**
 * Отказ прямой правке производного поля (I.7/I.8/I.9) — ОДИН текст на обе
 * двери записи ответов: оператора (`saveOperatorField` ниже) и команды
 * (`editAnswerDuringReview`, `src/review/edit.ts`). Правило одно — тройка
 * выводится из кода, правится код, — и раньше текст был скопирован в
 * `edit.ts` от руки с комментарием, УТВЕРЖДАВШИМ паритет, которого ничто не
 * проверяло; теперь обе двери возвращают этот объект, а паритет закреплён
 * тестом (`src/review/__tests__/edit.test.ts`, `toEqual(operator.error)`).
 */
export const DERIVED_FIELDS_REFUSAL: Localized = {
  en: 'Country, city and airport are derived from the IATA code — correct the code instead',
  ru: 'Страна, город и аэропорт выводятся из кода IATA — исправьте код',
}

export type DirectoryCodeResolution =
  | { ok: true; iata: string; directory: DirectoryEntry }
  | { ok: false; error: Localized }

/**
 * Голова ворот кода IATA — нормализация и справочник, ЕДИНСТВЕННОЙ записью
 * на обе двери записи ответов (та же пара, что у `DERIVED_FIELDS_REFUSAL`
 * выше): «код — три латинские буквы» и «код есть в справочнике» с их
 * текстами отказов. `resolveIdentity` НЕ ходит сюда намеренно: его промах
 * справочника — про другой поступок («лаунж можно завести только…»), и слить
 * тексты значило бы объяснять админу создание лаунжа словами про правку
 * ответа. Чтение справочника — вне транзакций вызывающих, довод у
 * `resolveIdentity`.
 */
export async function resolveDirectoryCode(
  db: Db,
  value: unknown,
): Promise<DirectoryCodeResolution> {
  const iata = typeof value === 'string' ? normalizeIata(value) : null
  if (iata === null) {
    return fail('IATA code must be 3 letters', 'Код IATA — три латинские буквы')
  }

  const directory = await lookupAirport(db, iata)
  if (directory === null) {
    return fail(
      `Code ${iata} is not in the airport directory — country, city and airport ` +
        'can only be derived from a directory code; new airports are added by ' +
        'updating the directory',
      `Код ${iata} не найден в справочнике аэропортов — страна, город и аэропорт ` +
        'выводятся только из кода справочника; новый аэропорт добавляется ' +
        'обновлением справочника',
    )
  }

  return { ok: true, iata, directory }
}

/**
 * ЕДИНСТВЕННАЯ дверь оператора к записи ответа плоского поля — то, что
 * вызывает `saveFieldAction` (`src/app/f/[token]/actions.ts`) вместо голого
 * `saveFieldValue`. Ворота производных полей живут ЗДЕСЬ, в слое действия
 * оператора, а НЕ в самом `saveFieldValue` — и это граница, а не пропуск:
 * `saveFieldValue` обязан оставаться свободным для предзаполнения
 * (`createLounge`), синхронизации паспорта (`updateLoungePassport`), сидов и
 * юнит-стендов, которым нужны сырые записи любых ключей. Оператор же ходит
 * только через серверные действия ссылки заполнения, и эта функция — их
 * общий путь для полей.
 *
 * Правила (решение пользователя — справочник как ворота, продолжение
 * `resolveIdentity`):
 *
 *  1. Прямая запись производного поля (I.7/I.8/I.9, см. `DERIVED_FIELD_KEYS`)
 *     — ОТКАЗ всегда: тройка выводится из кода IATA, исправляется код.
 *     Прежний замок был только в UI, а действие достижимо по сети напрямую —
 *     держатель токена мог записать любую страну поверх выведенной; теперь
 *     сервер отказывает сам (правило ветки: клиентская проверка — подсказка).
 *  2. Запись кода IATA (I.10) — через справочник: голова ворот (нормализация
 *     + промах справочника с текстами отказов) — общий `resolveDirectoryCode`
 *     с дверью команды (источник тройки один), попадание — В ОДНОЙ
 *     ТРАНЗАКЦИИ записываются код и вся выведенная тройка. Атомарность
 *     обязательна: код `ESB` с городом `Istanbul` — состояние, которого не
 *     должен уметь оставить ни один сбой между четырьмя записями. Приём тот
 *     же, что у предзаполнения `createLounge`: `saveFieldValue` с `tx` даёт
 *     SAVEPOINT, а не вторую транзакцию; первый вызов берёт `FOR UPDATE` на
 *     строку `submissions` (`assertEditable`), так что статус не может
 *     уехать между записями четвёрки. Отказ ПЕРВОЙ записи (анкета закрыта,
 *     пустое значение) возвращается значением — записано ещё ничего не было;
 *     отказ ПОСЛЕДУЮЩИХ недостижим через валидные входы (строка уже заперта
 *     этой транзакцией, значения — непустые строки справочника) и потому
 *     роняет транзакцию целиком, а не коммитит половину четвёрки — тот же
 *     выбор и довод, что у предзаполнения.
 *  3. Любое другое поле — обычный `saveFieldValue`, без изменений.
 *
 * Снятие замечаний сюда НЕ входит (граница модулей: registry/submissions не
 * видят review) — вызывающий делает это по `savedKeys`, второй транзакцией,
 * best-effort (`clearFlagAfterSave` и его довод).
 */
export async function saveOperatorField(
  db: Db,
  input: { submissionId: string; fieldKey: string; value: unknown },
): Promise<OperatorSaveResult> {
  if (DERIVED_FIELD_KEYS.includes(input.fieldKey)) {
    return { ok: false, error: DERIVED_FIELDS_REFUSAL }
  }

  if (input.fieldKey === IATA_FIELD_KEY) {
    // Нормализация и справочник — общей головой обеих дверей записи
    // (`resolveDirectoryCode` выше), вне транзакции: статичная таблица,
    // гонки с импортом не стоят блокировки.
    const resolved = await resolveDirectoryCode(db, input.value)
    if (!resolved.ok) return resolved
    const { iata, directory } = resolved

    return db.transaction(async (tx) => {
      const code = await saveFieldValue(tx, {
        submissionId: input.submissionId,
        fieldKey: IATA_FIELD_KEY,
        value: iata,
      })
      if (!code.ok) return code

      for (const entry of DERIVED_PREFILL) {
        const derived = await saveFieldValue(tx, {
          submissionId: input.submissionId,
          fieldKey: entry.fieldKey,
          value: directory[entry.column],
        })
        if (!derived.ok) {
          throw new Error(
            `saveOperatorField: derived ${entry.fieldKey} refused — ${derived.error.en}`,
          )
        }
      }

      return {
        ok: true as const,
        savedKeys: [IATA_FIELD_KEY, ...DERIVED_FIELD_KEYS],
      }
    })
  }

  const saved = await saveFieldValue(db, input)
  return saved.ok ? { ok: true, savedKeys: [input.fieldKey] } : saved
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
 * дошедшей до `submitted`, и чужими руками). Валидация и ворота справочника —
 * те же, что при создании, через общий `resolveIdentity`: правил два набора
 * быть не может.
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
