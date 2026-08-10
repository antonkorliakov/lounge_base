import type { drizzle } from 'drizzle-orm/pglite'
import type * as schema from './schema'

/**
 * Единый контракт базы. Боевой клиент (postgres-js) и тестовый (PGlite)
 * дают одинаковый набор методов, которым пользуются прикладные модули,
 * поэтому те принимают `Db` и не знают, против чего работают.
 */
export type Db = ReturnType<typeof drizzle<typeof schema>>
