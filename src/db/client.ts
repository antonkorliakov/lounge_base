import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'
import type { Db } from './types'

export function createDb(url: string): Db {
  // `prepare: false` — не оптимизация, а совместимость с продакшеном.
  // На Vercel строка подключения ведёт на пулер (PgBouncer в transaction-
  // режиме у Neon и аналогов), а в этом режиме именованные prepared
  // statements не работают: пулер может отдать следующий запрос сессии
  // другому соединению, где statement не подготовлен, и запрос падает с
  // "prepared statement ... does not exist" — не при сборке, а на живом
  // трафике. Локально (docker, прямое соединение) флаг стоит немного
  // производительности и ничего не меняет в поведении, поэтому он
  // безусловный: один клиент, одна конфигурация, нечему разъезжаться.
  return drizzle(postgres(url, { prepare: false }), { schema })
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
