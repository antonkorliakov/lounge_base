import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import * as schema from '../schema'
import type { Db } from '../types'

const MIGRATIONS = join(process.cwd(), 'src/db/migrations')

/**
 * Where the migrated-template tarball is cached on disk, keyed by a hash of
 * the migration files' own contents so a migration change invalidates the
 * cache automatically instead of silently serving a stale schema.
 * `node_modules/.cache` because it is already gitignored, already
 * machine-local, and already expected to be safe to delete at any time.
 */
const CACHE_DIR = join(process.cwd(), 'node_modules', '.cache', 'pglite-template')

/** Loud on purpose — has caught a real "forgot to run `npm run db:generate`"
 *  mistake before; moving migration-replay off the per-test hot path must
 *  not weaken that. */
function migrationFiles(): string[] {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  if (files.length === 0) {
    throw new Error('нет миграций — запустите npm run db:generate')
  }
  return files
}

async function applyMigrations(client: PGlite, files: string[]): Promise<void> {
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) await client.exec(trimmed)
    }
  }
}

function cachePathFor(files: string[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file)
    hash.update(readFileSync(join(MIGRATIONS, file)))
  }
  return join(CACHE_DIR, `${hash.digest('hex')}.tar`)
}

/**
 * Builds a fully migrated PGlite data directory exactly once, dumps it
 * (`dumpDataDir`), and caches the dump on disk so every worker process —
 * across the whole `npm test` invocation, and across later invocations too,
 * until the migrations change — reuses it instead of replaying every
 * migration statement per test. `dumpDataDir`/`loadDataDir` (PGlite 0.5.4)
 * is the supported round-trip for this: verified directly (dump one client,
 * `new PGlite({ loadDataDir: dump })` a second, confirmed the schema and
 * rows are intact) before relying on it here.
 *
 * A module-level promise means every `createTestDb()` call *within this
 * process* awaits the same in-flight build rather than racing to start one.
 * That alone does not make the build happen only once for the whole test
 * run, though: Vitest gives each test *file* its own isolated module
 * registry, so this module-level promise is re-created per file regardless
 * of worker-process reuse. The disk cache is what makes the actual
 * migration replay happen at most a handful of times (bounded by how many
 * files/workers miss a cold cache at once) instead of once per test — and
 * exactly zero times on every run after the first, since the cache survives
 * between `npm test` invocations.
 *
 * No cross-process lock: on a cold cache, more than one process may miss
 * the `existsSync` check and each build its own copy. That is accepted —
 * it costs a little redundant CPU on the very first run, never correctness,
 * because every write goes to a per-builder-unique temp path and is moved
 * into place with `renameSync` (atomic on POSIX), so a reader never
 * observes a partially written file, and whichever complete dump lands
 * last is just as valid as any other (all migrated the same schema).
 *
 * `'none'` compression: this tarball never leaves the machine or touches a
 * slow medium in a way where size matters more than CPU — gzip would only
 * add compress/decompress cost for no benefit here.
 */
let template: Promise<Buffer> | undefined

function getTemplate(): Promise<Buffer> {
  if (!template) {
    template = (async () => {
      const files = migrationFiles()
      const cachePath = cachePathFor(files)
      if (existsSync(cachePath)) return readFileSync(cachePath)

      const client = new PGlite()
      await applyMigrations(client, files)
      const dump = await client.dumpDataDir('none')
      await client.close()
      const buffer = Buffer.from(await dump.arrayBuffer())

      mkdirSync(CACHE_DIR, { recursive: true })
      const tmpPath = join(CACHE_DIR, `${randomUUID()}.tmp`)
      writeFileSync(tmpPath, buffer)
      renameSync(tmpPath, cachePath)
      return buffer
    })()
  }
  return template
}

/**
 * A fresh, fully migrated, isolated test database. Isolation is unchanged
 * by this caching: `loadDataDir` seeds a brand-new PGlite instance's data
 * directory from a copy of the cached bytes, and nothing else ever opens or
 * mutates that cached template afterwards — every call still gets its own
 * database that no other test can see or affect. The only thing now shared
 * across calls is the read-only migrated starting point.
 */
export async function createTestDb(): Promise<Db> {
  const buffer = await getTemplate()
  // `new Uint8Array(buffer)` copies into a fresh, non-shared `ArrayBuffer` —
  // `Buffer`'s own backing store is typed `ArrayBufferLike` (it may be a
  // `SharedArrayBuffer`), which `Blob`'s `BlobPart` does not accept directly.
  const client = new PGlite({ loadDataDir: new Blob([new Uint8Array(buffer)]) })
  await client.waitReady
  return drizzle(client, { schema })
}
