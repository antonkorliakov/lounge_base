import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type * as schema from './schema'

/**
 * Единый контракт базы. `PgDatabase` — общий базовый класс, от которого
 * наследуют оба драйвера, что мы используем: и боевой `PostgresJsDatabase`
 * (postgres-js), и тестовый `PgliteDatabase` (PGlite). Параметризован здесь
 * общим (неспециализированным) `PgQueryResultHKT`, а не одним из
 * драйвер-специфичных `PostgresJsQueryResultHKT`/`PgliteQueryResultHKT` —
 * именно это делает тип общим для обоих драйверов без утверждения, что они
 * идентичны.
 *
 * Что это ГАРАНТИРУЕТ (проверено: оба реальных клиента структурно
 * соответствуют этому типу без приведения типов — см. `db/client.ts` и
 * `db/__tests__/harness.ts`):
 *  - `select`/`insert`/`update`/`delete`, `.returning()`, `.onConflictDoUpdate()`
 *    и построители запросов вообще — они не зависят от TQueryResult HKT,
 *    кроме "сырого" результата insert/update/delete БЕЗ `.returning()`,
 *    который здесь честно типизируется как `unknown` (см. ниже), а не как
 *    результат конкретного драйвера.
 *  - голая форма `db.transaction(async (tx) => ...)` без объекта опций —
 *    внутри колбэка `tx` даёт тот же набор методов, что и `Db`.
 *
 * Что это НЕ гарантирует:
 *  - `db.execute(sql\`...\`)` — тип сырого результата специализирован здесь
 *    до `unknown` (через общий, а не драйвер-специфичный HKT), а не до
 *    формы, которую реально возвращает postgres-js. Раньше приведение типа
 *    заявляло форму PGlite для боевого клиента — теперь тип честно не
 *    заявляет ничего, вместо того чтобы заявлять неверное.
 *  - `db.prepare(...)`/подготовленные запросы — оба драйвера расширяют
 *    `PgSession` по-своему; этот общий тип их не описывает.
 *  - объект опций у `db.transaction(fn, config)` — `PgTransactionConfig`
 *    (isolationLevel/accessMode/deferrable) один и тот же ТИП на оба
 *    драйвера, но это не значит одинаковое ПОВЕДЕНИЕ: у PGlite и postgres-js
 *    поддержка этих опций на движке может отличаться. Совпадение типов
 *    здесь не доказывает совпадение семантики выполнения.
 *
 * Эти три пути (execute, prepare, опции transaction) — то, что реально
 * отличается между драйверами; их использование за пределами `src/db`
 * запрещено тестом-заслоном (см. `src/db/__tests__/unsafe-db-paths.test.ts`),
 * который ловит их по исходному тексту, тем же способом, что чистотный
 * тест `src/form-schema/__tests__/purity.test.ts` ловит запрещённые импорты.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>

/**
 * То, что видит колбэк `db.transaction(async (tx) => ...)` — тот же набор
 * методов построителя запросов, что и у `Db`, извлечённый прямо из сигнатуры
 * `transaction`. Общий для всех модулей `src/submissions`, чтобы не заводить
 * по копии на каждый файл.
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
