import { and, asc, eq } from 'drizzle-orm'
import type { Localized } from '@/form-schema'
import type { Db } from '@/db/types'
import type { OperationalStatus } from '@/db/schema'
import { lounges, events, operationalStatus } from '@/db/schema'

export type StatusResult = { ok: true } | { ok: false; error: Localized }

export type StatusChange = {
  from: OperationalStatus | null
  to: OperationalStatus
  until: string | null
  comment: string | null
  actor: string
  at: Date
}

/** Событие, которым записывается смена ЭКСПЛУАТАЦИОННОГО статуса. Одна
 *  константа на запись и на чтение: `statusHistory` отбирает историю по ней же,
 *  а не по строковому литералу, написанному второй раз. */
export const OPERATIONAL_STATUS_EVENT = 'operational_status_changed'

/**
 * Подписи и правило «предлагается ли дата открытия» — по одной записи на
 * статус. `Record<OperationalStatus, ...>`, а НЕ массив с рукописным списком
 * id: полная запись обязывает typescript ругаться, если в `operationalStatus`
 * (`db/schema.ts`) добавят статус и забудут подпись здесь. Массив в плане это
 * не ловил — новый статус просто не имел бы подписи, и ни один тест не
 * заметил бы (тест сравнивал массив с таким же рукописным списком). Тот же
 * приём, которым `FLAG_REASONS`/`EDITABLE_STATUSES` держат по одному
 * определению своих множеств.
 *
 * Порядок показа человеку задаёт `OPERATIONAL_STATUSES` ниже — из
 * `enumValues`, то есть из того же порядка, в котором статусы объявлены в
 * схеме. Отдельного рукописного порядка нет: незачем иметь второй список,
 * который может разойтись с первым.
 */
const STATUS_META: Record<OperationalStatus, { label: Localized; allowsDate: boolean }> = {
  active: { allowsDate: false, label: { en: 'Active', ru: 'Действующий' } },
  temporarily_closed: {
    allowsDate: true,
    label: { en: 'Temporarily closed', ru: 'Временно закрыт' },
  },
  under_renovation: {
    allowsDate: true,
    label: { en: 'Under renovation', ru: 'На ремонте' },
  },
  closed: { allowsDate: false, label: { en: 'Closed', ru: 'Закрыт' } },
}

/**
 * Дата ожидаемого открытия предлагается только у временных состояний и
 * всегда необязательна: срок часто неизвестен, и честное «не указан»
 * лучше выдуманной даты.
 */
export const OPERATIONAL_STATUSES: {
  id: OperationalStatus
  label: Localized
  allowsDate: boolean
}[] = operationalStatus.enumValues.map((id) => ({ id, ...STATUS_META[id] }))

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

const fail = (en: string, ru: string): StatusResult => ({ ok: false, error: { en, ru } })

/**
 * Форма И существование даты в календаре. Одной формы не хватает: `2026-02-30`
 * и `2026-13-01` регулярному выражению подходят, а `status_until` — настоящая
 * колонка `date`, так что Postgres такую строку не примет и бросит. Отказ,
 * который этот модуль обещает возвращать значением (`ok: false`), превратился
 * бы в исключение и в 500-ю у вызывающего — то есть в «непонятно, что
 * случилось» вместо «дата неверна».
 *
 * Проверка round-trip'ом через `Date.UTC`, а не сравнением с числом дней в
 * месяце: `Date` сам знает про длину месяцев и про 29 февраля в високосном
 * году, и переполнение он не отвергает, а переносит (31 апреля становится 1
 * мая) — именно это и видно по расхождению разобранных чисел с тем, что
 * `Date` вернул. UTC, а не локальное время: дата здесь календарная, без
 * времени и без зоны, и в зоне с отрицательным смещением локальный
 * конструктор сдвинул бы день на предыдущий.
 */
function isCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value)
  if (!match) return false

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

/**
 * Меняет эксплуатационный статус лаунжа и записывает смену в `events`.
 *
 * Переходы свободны в обе стороны, включая возврат из «закрыт» в
 * «действующий» (Global Constraints плана 3): статус объекта это факт о мире,
 * а не рабочий процесс с этапами, и закрытый лаунж действительно может
 * открыться снова. Поэтому здесь нет ни таблицы разрешённых переходов, ни
 * проверки «откуда куда» — прежний статус читается только чтобы записать его
 * в историю.
 *
 * ОДНА ТРАНЗАКЦИЯ, С БЛОКИРОВКОЙ СТРОКИ `lounges` ПЕРВЫМ ОПЕРАТОРОМ. В плане
 * это были три независимых оператора (чтение прежнего статуса, `UPDATE`,
 * `INSERT` события), и это ровно та check-then-write, которую эта ветка чинила
 * уже семь раз в других модулях — список и разбор в
 * `src/review/__tests__/lock-order-guard.ts`. Здесь она ломает две вещи:
 *
 *  1. Историю. Две одновременные смены читают один и тот же `previous` и
 *     пишут два события, каждое со своим `from: 'active'`, хотя вторая
 *     смена шла уже не из `active`. История перестаёт быть цепочкой:
 *     `to` предыдущей записи не совпадает с `from` следующей, и по ней
 *     больше нельзя восстановить, что с объектом происходило.
 *  2. Само правило «каждая смена статуса записана». Падение процесса между
 *     `UPDATE` и `INSERT` оставляет новый статус без события — то же
 *     обоснование, по которому `requestChanges`/`approveSubmission`
 *     (`src/review/decide.ts`) держат переход и его событие в одной
 *     транзакции.
 *
 * Блокировка не отменяет того, что смены свободны: она не запрещает переход,
 * а лишь выстраивает одновременные в очередь, чтобы каждая видела результат
 * предыдущей.
 *
 * Её наличие и позиция теперь проверяются структурно, а не только этим
 * комментарием: вторая проверка в `src/review/__tests__/lock-order-guard.ts`
 * (`loungeLockViolationsIn`) требует блокировки строки `lounges` от всякой
 * экспортируемой функции, которая эту строку читает и затем пишет. До неё
 * удаление `.for('update')` отсюда не ломало ни один тест — ни в этом
 * модуле, ни в самом guard'е (у него ни `src/registry` не было среди
 * каталогов, ни `lounges` среди таблиц). Правило теперь падает с именем
 * функции; тот же комментарий-ловушка, что и в семье `submissions`, здесь не
 * работает — guard вырезает комментарии перед сканированием, так что упоминание
 * `.for('update')` в этом абзаце доказательством не считается.
 *
 * Про порядок блокировок и `approveSubmission`: тот тоже пишет `lounges`
 * (классифицирующие поля при принятии), и его комментарий до сих пор
 * утверждал, что кроме него `lounges` не пишет никто. С этим модулем это
 * перестало быть правдой, комментарий там исправлен. Взаимной блокировки не
 * возникает: `approveSubmission` берёт строку `submissions`, потом пишет
 * `lounges`; здесь берётся только строка `lounges`, а `events` —
 * append-only INSERT, на котором ждать нечего. Цикл «А ждёт Б, Б ждёт А»
 * не складывается, потому что эта транзакция не ждёт ничего, кроме своей
 * одной строки.
 */
export async function setOperationalStatus(
  db: Db,
  input: {
    loungeId: string
    status: OperationalStatus
    until: string | null
    comment: string | null
    actor: string
  },
): Promise<StatusResult> {
  const meta = STATUS_META[input.status]
  // Проверка не лишняя, хотя тип `OperationalStatus` её как будто
  // гарантирует: значение приходит из формы (`FormData`, строка), и вызывающий
  // сузит его прежде, чем позвать этот модуль. Пустая запись здесь означала бы
  // `undefined.allowsDate` ниже.
  if (!meta) return fail('Unknown status', 'Неизвестный статус')

  // Валидация до всякого обращения к базе: отказ по неверному вводу не
  // нуждается ни в чтении, ни в блокировке.
  if (input.until !== null) {
    if (!meta.allowsDate) {
      return fail(
        'This status has no reopening date',
        'У этого статуса нет даты открытия',
      )
    }
    if (!isCalendarDate(input.until)) {
      return fail('Use the date picker', 'Выберите дату в календаре')
    }
  }

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ status: lounges.operationalStatus })
      .from(lounges)
      .where(eq(lounges.id, input.loungeId))
      .for('update')
      .limit(1)

    const previous = rows[0]?.status
    if (!previous) return fail('Lounge not found', 'Лаунж не найден')

    // Дата и комментарий относятся к конкретному состоянию: при смене они
    // теряют смысл, поэтому переписываются целиком, а не дополняются.
    await tx
      .update(lounges)
      .set({
        operationalStatus: input.status,
        statusUntil: input.until,
        statusComment: input.comment,
      })
      .where(eq(lounges.id, input.loungeId))

    await tx.insert(events).values({
      loungeId: input.loungeId,
      actor: input.actor,
      action: OPERATIONAL_STATUS_EVENT,
      payload: {
        from: previous,
        to: input.status,
        until: input.until,
        comment: input.comment,
      },
    })

    return { ok: true }
  })
}

/**
 * История смен статуса, старые записи первыми.
 *
 * Отбор по `action`, а не по форме payload. В плане строки фильтровались
 * условием `'to' in payload`, и сегодня это совпадало бы с правильным
 * ответом случайно: на `loungeId` висит ещё `approved` (`approveSubmission`
 * пишет его с `payload.classifying`), у которого ключа `to` нет. Но `payload`
 * это `jsonb` без схемы, и запретить будущему событию нести ключ `to` нечем —
 * а план 3 добавит на лаунж ещё события. Отбор по `action` спрашивает, ЧЕМ
 * событие является, вместо того чтобы угадывать это по содержимому; заодно
 * это условие уходит в SQL, а не отсеивает лишние строки уже в процессе.
 *
 * Разбор payload остаётся защитным (`asStatusChange` ниже возвращает `null`
 * на всё, что не похоже на смену статуса) — по той же причине, по которой
 * `toFlagReason` в `review/flags.ts` не доверяет своей текстовой колонке:
 * `jsonb` ничего не обещает, и строка, записанная миграцией или руками, не
 * должна превращаться в объект с `undefined` внутри.
 */
export async function statusHistory(
  db: Db,
  loungeId: string,
): Promise<StatusChange[]> {
  const rows = await db
    .select({ actor: events.actor, payload: events.payload, at: events.at })
    .from(events)
    .where(
      and(eq(events.loungeId, loungeId), eq(events.action, OPERATIONAL_STATUS_EVENT)),
    )
    .orderBy(asc(events.at))

  return rows.flatMap((row) => {
    const change = asStatusChange(row.payload)
    return change ? [{ ...change, actor: row.actor, at: row.at }] : []
  })
}

const STATUS_SET: ReadonlySet<string> = new Set<string>(operationalStatus.enumValues)

const isStatus = (value: unknown): value is OperationalStatus =>
  typeof value === 'string' && STATUS_SET.has(value)

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

function asStatusChange(
  payload: unknown,
): Omit<StatusChange, 'actor' | 'at'> | null {
  if (typeof payload !== 'object' || payload === null) return null
  const value = payload as Record<string, unknown>

  // `to` обязателен: запись без него не описывает смену. `from` — `null` у
  // самой первой смены не бывает (у лаунжа всегда есть прежний статус, по
  // умолчанию `active`), но тип его допускает, и лишать историю записи из-за
  // отсутствующего `from` было бы хуже, чем показать её без него.
  if (!isStatus(value['to'])) return null
  if (!isNullableString(value['until']) || !isNullableString(value['comment'])) return null

  return {
    from: isStatus(value['from']) ? value['from'] : null,
    to: value['to'],
    until: value['until'],
    comment: value['comment'],
  }
}
