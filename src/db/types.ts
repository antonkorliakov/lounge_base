import type { drizzle } from 'drizzle-orm/pglite'
import type * as schema from './schema'

/**
 * Единый контракт базы. Боевой клиент (postgres-js) и тестовый (PGlite)
 * дают одинаковый набор методов, которым пользуются прикладные модули,
 * поэтому те принимают `Db` и не знают, против чего работают.
 */
export type Db = ReturnType<typeof drizzle<typeof schema>>

/**
 * То, что видит колбэк `db.transaction(async (tx) => ...)` — тот же набор
 * методов построителя запросов, что и у `Db`, извлечённый прямо из сигнатуры
 * `transaction`. Общий для всех модулей `src/submissions`, чтобы не заводить
 * по копии на каждый файл.
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
