import { isDeepStrictEqual } from 'node:util'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  fieldByKey,
  photoSlotByKey,
  serviceItemByKey,
  validateField,
  validateServiceValue,
  type ServiceValueInput,
} from '@/form-schema'
import type { Db, Tx } from '@/db/types'
import { events, fieldValues, serviceValues, submissions } from '@/db/schema'
import { fail, type SaveResult } from '@/submissions/editable'
import { serviceRowFromInput } from '@/submissions/values'
import {
  DERIVED_FIELDS_REFUSAL,
  DERIVED_PREFILL,
  DERIVED_FIELD_KEYS,
  IATA_FIELD_KEY,
  resolveDirectoryCode,
} from '@/registry/manage'
import { REVIEW_STATUSES } from './blocks'
import { clearFlagsFor } from './flags'

/**
 * Событие правки ответа командой — одна константа на запись и на чтение
 * (тесты и будущие читатели истории отбирают по ней же), тот же приём, что
 * `PASSPORT_EDIT_EVENT` в `registry/manage.ts`. Payload: `{ key, old, new,
 * actor }` — старое значение читается ПОД БЛОКИРОВКОЙ той же транзакции, что
 * пишет новое, так что пара old→new не может описывать чужую промежуточную
 * запись. Две гарантии формы, обе — свойства двери, а не удача входа:
 * `new` присутствует ВСЕГДА (`undefined` нормализуется в `null` у входа —
 * иначе jsonb молча выбросил бы ключ), и событий с `old`, равным `new`, не
 * бывает (правка тем же значением — честный no-op, без записи и события).
 */
export const TEAM_EDIT_EVENT = 'answer_edited_by_team'

/**
 * Часы БАЗЫ, и именно `clock_timestamp()` — ровно то же правило и по тем же
 * двум причинам, что у `WRITTEN_AT` в `src/submissions/values.ts` (читайте
 * длинный довод там): `blockProgress` сравнивает `updatedAt` с
 * `confirmedAt`, сравнение осмысленно только между показаниями одних часов,
 * и штамп должен браться в момент выполнения оператора — ПОСЛЕ захвата
 * блокировки, — а не в момент начала транзакции. Для этой двери второй пункт
 * особенно нагружен: правка команды обязана обесценить подтверждение блока
 * (`confirmedAt < updatedAt` — производное правило), и штамп времени начала
 * транзакции, простоявшей в очереди за `confirmBlock`, перевернул бы порядок.
 */
const WRITTEN_AT = sql`clock_timestamp()`

const NOT_UNDER_REVIEW = () =>
  fail('This submission is not open for review', 'Анкета сейчас не на проверке')

/**
 * Единственная дверь КОМАНДЫ к правке ответа анкеты — то, что вызывает
 * `editAnswerAction` (`src/app/admin/s/[submissionId]/actions.ts`). Живёт в
 * `src/review`, потому что это действие РЕВЬЮЕРА: его окно — ровно
 * `REVIEW_STATUSES` (`submitted`), точное дополнение окна оператора
 * (`EDITABLE_STATUSES` — draft/changes_requested, см.
 * `src/submissions/editable.ts`). Дверь оператора (`saveOperatorField` /
 * `saveServiceValue`) сюда НЕ ходит и наоборот: окна дизъюнктны нарочно —
 * в каждый момент ответ пишет ровно одна сторона, и `assertEditable` здесь
 * не используется именно потому, что он проверяет ПРОТИВОПОЛОЖНОЕ окно.
 *
 * Правила по видам ключа (те же ворота, что у двери оператора, — один
 * валидатор, один справочник, одно правило нормализации):
 *
 *  1. Производные поля паспорта (I.7/I.8/I.9, `DERIVED_FIELD_KEYS`) — отказ
 *     всегда, тем же текстом, что у `saveOperatorField`: тройка выводится из
 *     кода IATA, правится код (I.10).
 *  2. Код IATA (I.10) — только код из справочника (`lookupAirport`, промах —
 *     отказ с лекарством), попадание — в ОДНОЙ транзакции пишется вся
 *     четвёрка: код + выведенная тройка, все четыре с провенансом команды,
 *     по событию на каждый ключ, замечания всех четырёх снимаются. Прямая
 *     атомарность, а не SAVEPOINT-приём `saveOperatorField`: его нижний слой
 *     (`saveFieldValue`) заперт на окно оператора и здесь неприменим.
 *  3. Плоское поле — `validateField`, позиция услуг — `validateServiceValue`
 *     + `serviceRowFromInput`: ровно те же проверки и та же нормализация,
 *     которыми ходит дверь оператора. Значение, которое отказали бы
 *     оператору, отказывается и команде — паритет закреплён тестами.
 *  4. Слот фотографии — отказ всегда: снимок — свидетельство С МЕСТА, его
 *     делает и прикладывает оператор; «исправленное» командой фото перестало
 *     бы быть свидетельством. Команде остаётся отметить слот замечанием и
 *     вернуть анкету — серверного пути правки фото не существует вовсе.
 *
 * Всё — одна транзакция с `FOR UPDATE` на строке `submissions` ПЕРВЫМ
 * оператором (гейт статуса читается из-под блокировки; guard семьи 1
 * применяется к этой функции — она пишет `field_values`/`service_values` в
 * `src/review`). Снятие замечания — `clearFlagsFor` (свой модуль), вызванный
 * С `tx`: его внутренний `db.transaction` на транзакции даёт SAVEPOINT, а не
 * вторую транзакцию, его собственный `FOR UPDATE` берёт строку, которую эта
 * транзакция уже держит (ждать некому), — то есть правка, событие, снятое
 * замечание и сброшенное подтверждение блока фиксируются вместе или не
 * фиксируются вовсе. Это сильнее операторского пути (`clearFlagAfterSave` —
 * вторая транзакция, best-effort) и доступно здесь именно потому, что оба
 * модуля — review: границы «submissions не видит review» этот вызов не
 * пересекает.
 *
 * Подтверждение блока обесценивается ДВАЖДЫ, и это дополнение, а не дубль
 * (тот же расклад, что у операторской правки): производное правило
 * `blockProgress` (`confirmedAt < updatedAt` — `clock_timestamp()` выше) и
 * DELETE в `clearFlagsFor`. Ни то ни другое здесь не переизобретается.
 */
export async function editAnswerDuringReview(
  db: Db,
  input: { submissionId: string; key: string; value: unknown; reviewer: string },
): Promise<SaveResult> {
  // Сетевой вход: `undefined` нормализуется в `null` У ДВЕРИ, один раз на все
  // ветки. Иначе drizzle выбрасывает `value` из SET вовсе — «успешная» правка
  // оставляла бы СТАРОЕ значение под НОВЫМ провенансом и штампом, событие
  // писалось бы без `new`, а замечание снималось бы ни за что. `null` — то,
  // что вход и означает («ответа нет»), и его валидаторы судят по-настоящему.
  const value: unknown = input.value === undefined ? null : input.value

  // ── Классификация ключа и всё, что можно отказать БЕЗ транзакции ─────────
  if (DERIVED_FIELD_KEYS.includes(input.key)) {
    // Тот же объект, что возвращает дверь оператора, — не копия текста
    // (паритет закреплён тестом `toEqual(operator.error)`).
    return { ok: false, error: DERIVED_FIELDS_REFUSAL }
  }

  if (photoSlotByKey(input.key)) {
    return fail(
      'Photos are evidence from the venue and can only be replaced by the operator — flag the slot and return the questionnaire instead',
      'Фотографии — свидетельство с места, заменить их может только оператор: отметьте слот замечанием и верните анкету',
    )
  }

  if (input.key === IATA_FIELD_KEY) {
    // Нормализация и справочник — общей головой обеих дверей записи
    // (`resolveDirectoryCode`, `src/registry/manage.ts`), вне транзакции:
    // статичная таблица, гонки с импортом не стоят блокировки.
    const resolved = await resolveDirectoryCode(db, value)
    if (!resolved.ok) return resolved
    const { iata, directory } = resolved

    // Четвёрка целиком: I.10 = код, тройка = значения справочника — тот же
    // источник и то же соответствие (`DERIVED_PREFILL`), что у двери
    // оператора; расходиться им не из чего.
    const quartet: { key: string; value: string }[] = [
      { key: IATA_FIELD_KEY, value: iata },
      ...DERIVED_PREFILL.map((entry) => ({
        key: entry.fieldKey,
        value: directory[entry.column],
      })),
    ]

    return db.transaction(async (tx) => {
      const gate = await lockForReview(tx, input.submissionId)
      if (!gate.ok) return gate

      // Старые значения всей четвёрки — одним чтением, под уже взятой
      // блокировкой: пары old→new в событиях описывают именно то состояние,
      // поверх которого легла эта правка.
      const oldRows = await tx
        .select({ fieldKey: fieldValues.fieldKey, value: fieldValues.value })
        .from(fieldValues)
        .where(
          and(
            eq(fieldValues.submissionId, input.submissionId),
            inArray(
              fieldValues.fieldKey,
              quartet.map((entry) => entry.key),
            ),
          ),
        )
      const oldByKey = new Map(oldRows.map((row) => [row.fieldKey, row.value]))

      // Выбор ТОГО ЖЕ аэропорта — не правка, а один клик до неё (у I.10
      // выбор из списка и есть сохранение): вся четвёрка уже стоит ровно
      // такой — честный no-op, без записи, события, снятого замечания и
      // обесцененного подтверждения блока. Частичное совпадение (код тот же,
      // тройка разошлась) правкой остаётся: четвёрку надо выровнять.
      if (
        quartet.every((entry) => isDeepStrictEqual(oldByKey.get(entry.key), entry.value))
      ) {
        return { ok: true }
      }

      for (const entry of quartet) {
        await tx
          .insert(fieldValues)
          .values({
            submissionId: input.submissionId,
            fieldKey: entry.key,
            value: entry.value,
            editedBy: input.reviewer,
            updatedAt: WRITTEN_AT,
          })
          .onConflictDoUpdate({
            target: [fieldValues.submissionId, fieldValues.fieldKey],
            set: { value: entry.value, editedBy: input.reviewer, updatedAt: WRITTEN_AT },
          })

        await tx.insert(events).values({
          submissionId: input.submissionId,
          actor: input.reviewer,
          action: TEAM_EDIT_EVENT,
          payload: {
            key: entry.key,
            old: oldByKey.get(entry.key) ?? null,
            new: entry.value,
            actor: input.reviewer,
          },
        })

        // Исправленный код отвечает и на замечание «не та страна» — снимаются
        // замечания всей четвёрки, тем же правилом, что `savedKeys` у двери
        // оператора. `tx`, не `db`: SAVEPOINT в этой же транзакции (см.
        // комментарий функции).
        await clearFlagsFor(tx, input.submissionId, entry.key)
      }

      return { ok: true }
    })
  }

  const field = fieldByKey(input.key)
  if (field) {
    return db.transaction(async (tx) => {
      const gate = await lockForReview(tx, input.submissionId)
      if (!gate.ok) return gate

      // Тот же валидатор, что у двери оператора (`saveFieldValue`), — одно
      // правило: значение, отказанное оператору, отказывается и команде.
      const validation = validateField(field, value)
      if (!validation.ok) return { ok: false, error: validation.error }

      const oldRows = await tx
        .select({ value: fieldValues.value })
        .from(fieldValues)
        .where(
          and(
            eq(fieldValues.submissionId, input.submissionId),
            eq(fieldValues.fieldKey, input.key),
          ),
        )
        .limit(1)

      // То же значение, что уже стоит (сравнение старого, прочитанного под
      // этой блокировкой, с новым; jsonb — глубоко), — честный no-op: ничего
      // не записано, событие old===new не выдумано, замечание не снято ни за
      // что, подтверждение блока не обесценено. Один клик до этого состояния
      // есть: черновик редактора предзаполняется сохранённым значением.
      if (oldRows.length > 0 && isDeepStrictEqual(oldRows[0]!.value, value)) {
        return { ok: true }
      }

      await tx
        .insert(fieldValues)
        .values({
          submissionId: input.submissionId,
          fieldKey: input.key,
          value,
          editedBy: input.reviewer,
          updatedAt: WRITTEN_AT,
        })
        .onConflictDoUpdate({
          target: [fieldValues.submissionId, fieldValues.fieldKey],
          set: { value, editedBy: input.reviewer, updatedAt: WRITTEN_AT },
        })

      await tx.insert(events).values({
        submissionId: input.submissionId,
        actor: input.reviewer,
        action: TEAM_EDIT_EVENT,
        payload: {
          key: input.key,
          old: oldRows[0]?.value ?? null,
          new: value,
          actor: input.reviewer,
        },
      })

      await clearFlagsFor(tx, input.submissionId, input.key)

      return { ok: true }
    })
  }

  const item = serviceItemByKey(input.key)
  if (item) {
    // Сетевой вход: `value` — произвольный JSON, включая ЧАСТИЧНЫЙ объект.
    // Каждый атрибут нормализуется по отдельности (`?? null` — отсутствующий
    // и `undefined` становятся «нет ответа»), а не только весь не-объект
    // целиком: частичный объект раньше проскакивал `typeof`-проверку и
    // доезжал `price: undefined` до `String(undefined)` в numeric-колонке —
    // краш вместо отказа. Дверь оператора тот же вход останавливает типами
    // клиента; здесь ту же полноту формы гарантирует эта нормализация, а
    // дальше судит ТОТ ЖЕ `validateServiceValue` (`available: undefined → null`
    // честно доезжает до его отказа «Unknown option»). Сентинель `''` у
    // `available` переживает `??` нетронутым — его гасит `serviceRowFromInput`.
    const raw: Partial<ServiceValueInput> =
      typeof value === 'object' && value !== null ? (value as Partial<ServiceValueInput>) : {}
    const serviceValue: ServiceValueInput = {
      available: raw.available ?? null,
      chargeType: raw.chargeType ?? null,
      price: raw.price ?? null,
      currency: raw.currency ?? null,
      slotMinutes: raw.slotMinutes ?? null,
      bookingRequired: raw.bookingRequired ?? null,
      details: raw.details ?? null,
    }

    return db.transaction(async (tx) => {
      const gate = await lockForReview(tx, input.submissionId)
      if (!gate.ok) return gate

      // Паритет с дверью оператора (`saveServiceValue`): тот же валидатор,
      // та же нормализация (`serviceRowFromInput` — сентинель `''`, гашение
      // offered-only атрибутов).
      const validation = validateServiceValue(item, serviceValue)
      if (!validation.ok) return { ok: false, error: validation.error }

      const row = serviceRowFromInput(item, serviceValue)

      const oldRows = await tx
        .select({
          available: serviceValues.available,
          chargeType: serviceValues.chargeType,
          price: serviceValues.price,
          currency: serviceValues.currency,
          slotMinutes: serviceValues.slotMinutes,
          bookingRequired: serviceValues.bookingRequired,
          details: serviceValues.details,
        })
        .from(serviceValues)
        .where(
          and(
            eq(serviceValues.submissionId, input.submissionId),
            eq(serviceValues.itemKey, input.key),
          ),
        )
        .limit(1)

      // Тот же no-op, что у ветки поля, — сравниваются НОРМАЛИЗОВАННЫЕ строки
      // (`serviceRowFromInput` с обеих сторон записи: старая уже лежит в этой
      // форме). Цена — численно: numeric-колонка возвращает '50.00' там, где
      // вход написал '50', и строковое сравнение считало бы равные цены
      // разными — ошибка в безопасную сторону, но ровно на самом частом пути
      // «открыл карточку, ничего не менял, нажал Сохранить».
      const withNumericPrice = (r: typeof row): Omit<typeof row, 'price'> & { price: number | null } =>
        ({ ...r, price: r.price === null ? null : Number(r.price) })
      if (
        oldRows.length > 0 &&
        isDeepStrictEqual(withNumericPrice(oldRows[0]!), withNumericPrice(row))
      ) {
        return { ok: true }
      }

      await tx
        .insert(serviceValues)
        .values({
          submissionId: input.submissionId,
          itemKey: input.key,
          ...row,
          editedBy: input.reviewer,
          updatedAt: WRITTEN_AT,
        })
        .onConflictDoUpdate({
          target: [serviceValues.submissionId, serviceValues.itemKey],
          set: { ...row, editedBy: input.reviewer, updatedAt: WRITTEN_AT },
        })

      await tx.insert(events).values({
        submissionId: input.submissionId,
        actor: input.reviewer,
        action: TEAM_EDIT_EVENT,
        payload: {
          key: input.key,
          old: oldRows[0] ?? null,
          new: row,
          actor: input.reviewer,
        },
      })

      await clearFlagsFor(tx, input.submissionId, input.key)

      return { ok: true }
    })
  }

  return fail('Unknown field', 'Неизвестное поле')
}

/**
 * `FOR UPDATE` на строке `submissions` + гейт `REVIEW_STATUSES` — первая
 * пара операторов каждой ветки записи выше, тем же порядком (родитель
 * раньше детей) и с теми же текстами отказа, что у `confirmBlock`.
 * Числится в `LOCK_DELEGATES` (`__tests__/lock-order-guard.ts`): guard
 * семьи 1 видит записи `editAnswerDuringReview` в `field_values`/
 * `service_values`, а блокировку — только инлайном или через делегата из
 * этого списка; честность делегата машинно проверяется
 * (`provenLockDelegatesIn` требует настоящий `.for('update')` в ЭТОМ теле).
 */
async function lockForReview(tx: Tx, submissionId: string): Promise<SaveResult> {
  const rows = await tx
    .select({ status: submissions.status })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .for('update')
    .limit(1)

  const status = rows[0]?.status
  if (!status) return fail('Submission not found', 'Анкета не найдена')
  if (!REVIEW_STATUSES.has(status)) return NOT_UNDER_REVIEW()
  return { ok: true }
}
