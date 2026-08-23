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
import { lookupAirport } from '@/registry/directory'
import {
  DERIVED_FIELD_KEYS,
  DERIVED_PREFILL,
  IATA_FIELD_KEY,
  normalizeIata,
} from '@/registry/manage'
import { REVIEW_STATUSES } from './blocks'
import { clearFlagsFor } from './flags'

/**
 * Событие правки ответа командой — одна константа на запись и на чтение
 * (тесты и будущие читатели истории отбирают по ней же), тот же приём, что
 * `PASSPORT_EDIT_EVENT` в `registry/manage.ts`. Payload: `{ key, old, new,
 * actor }` — старое значение читается ПОД БЛОКИРОВКОЙ той же транзакции, что
 * пишет новое, так что пара old→new не может описывать чужую промежуточную
 * запись.
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
  // ── Классификация ключа и всё, что можно отказать БЕЗ транзакции ─────────
  if (DERIVED_FIELD_KEYS.includes(input.key)) {
    return fail(
      'Country, city and airport are derived from the IATA code — correct the code instead',
      'Страна, город и аэропорт выводятся из кода IATA — исправьте код',
    )
  }

  if (photoSlotByKey(input.key)) {
    return fail(
      'Photos are evidence from the venue and can only be replaced by the operator — flag the slot and return the questionnaire instead',
      'Фотографии — свидетельство с места, заменить их может только оператор: отметьте слот замечанием и верните анкету',
    )
  }

  if (input.key === IATA_FIELD_KEY) {
    const iata = typeof input.value === 'string' ? normalizeIata(input.value) : null
    if (iata === null) {
      return fail('IATA code must be 3 letters', 'Код IATA — три латинские буквы')
    }

    // Чтение справочника — вне транзакции, как у `resolveIdentity`/
    // `saveOperatorField`: статичная таблица, гонки с импортом не стоят
    // блокировки.
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
      const validation = validateField(field, input.value)
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

      await tx
        .insert(fieldValues)
        .values({
          submissionId: input.submissionId,
          fieldKey: input.key,
          value: input.value,
          editedBy: input.reviewer,
          updatedAt: WRITTEN_AT,
        })
        .onConflictDoUpdate({
          target: [fieldValues.submissionId, fieldValues.fieldKey],
          set: { value: input.value, editedBy: input.reviewer, updatedAt: WRITTEN_AT },
        })

      await tx.insert(events).values({
        submissionId: input.submissionId,
        actor: input.reviewer,
        action: TEAM_EDIT_EVENT,
        payload: {
          key: input.key,
          old: oldRows[0]?.value ?? null,
          new: input.value,
          actor: input.reviewer,
        },
      })

      await clearFlagsFor(tx, input.submissionId, input.key)

      return { ok: true }
    })
  }

  const item = serviceItemByKey(input.key)
  if (item) {
    // Сетевой вход: `value` — произвольный JSON. Не-объект не роняет
    // `validateServiceValue` доступом к полю на null, а честно доезжает до
    // его же отказа (`available: undefined` → «Unknown option») — дверь
    // оператора для того же мусора упала бы раньше типами клиента, отказ тот
    // же по существу.
    const value: ServiceValueInput =
      typeof input.value === 'object' && input.value !== null
        ? (input.value as ServiceValueInput)
        : ({
            available: null,
            chargeType: null,
            price: null,
            currency: null,
            slotMinutes: null,
            bookingRequired: null,
            details: null,
          } satisfies ServiceValueInput)

    return db.transaction(async (tx) => {
      const gate = await lockForReview(tx, input.submissionId)
      if (!gate.ok) return gate

      // Паритет с дверью оператора (`saveServiceValue`): тот же валидатор,
      // та же нормализация (`serviceRowFromInput` — сентинель `''`, гашение
      // offered-only атрибутов).
      const validation = validateServiceValue(item, value)
      if (!validation.ok) return { ok: false, error: validation.error }

      const row = serviceRowFromInput(item, value)

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
