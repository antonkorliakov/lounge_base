import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'
import type { Db } from './types'

export function createDb(url: string): Db {
  return drizzle(postgres(url), { schema }) as unknown as Db
}

let cached: Db | undefined

export function db(): Db {
  if (!cached) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL не задан')
    cached = createDb(url)
  }
  return cached
}
