/**
 * Вливает справочник аэропортов из `src/db/reference/airports.tsv` в таблицу
 * `airport_directory`:
 *
 *   npm run db:import-airports            (локальная база — .env.local)
 *   npm run db:import-airports -- --prod  (боевая — .env.production.local)
 *
 * TSV в репозитории — источник истины; скрипт перезапускаем (идемпотентный
 * upsert, см. `importAirports` в `src/registry/directory.ts` — разбор и
 * запись живут ТАМ и покрыты юнит-тестами, здесь только чтение файла,
 * окружение и секундомер). Обновление справочника — правка TSV + повторный
 * прогон.
 *
 * Умолчание — ЛОКАЛЬНАЯ база (`.env.local`), а не боевая, и это осознанное
 * отличие от `ops.ts`: этот скрипт запускают e2e-тесты (докер-базе нужен
 * справочник — см. `e2e/directory.spec.ts`), и умолчание «сначала
 * .env.production.local» означало бы, что тестовый прогон на машине с
 * боевым env-файлом молча пишет в прод. Боевой прогон — явным `--prod`
 * (или явным `DATABASE_URL=...` в окружении: `loadEnvFile` заполняет только
 * незаданное, явная переменная побеждает всегда — как и в `ops.ts`).
 * Таблицу создаёт миграция 0005 (колонку `prominent` — 0006), НЕ этот
 * скрипт: на базе без них скрипт честно падает («relation/column does not
 * exist»), а не чинит схему сам.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDb } from '../src/db/client'
import { parseAirportsTsv, importAirports } from '../src/registry/directory'
import { closeDbConnection, loadEnvFile } from './dev-support'

const TSV_PATH = resolve(process.cwd(), 'src/db/reference/airports.tsv')

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const prod = args.includes('--prod')
  const unknown = args.filter((arg) => arg !== '--prod')
  if (unknown.length > 0) {
    // Отказ на незнакомом аргументе — то же правило, что у seed-dev.ts:
    // опечатка не должна молча превращаться в другой режим.
    throw new Error(`import-airports: неизвестные аргументы ${unknown.join(', ')} — допустим только --prod`)
  }

  if (prod) loadEnvFile(resolve(process.cwd(), '.env.production.local'))
  loadEnvFile(resolve(process.cwd(), '.env.local'))

  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL не задан')
  const db = createDb(url)

  const rows = parseAirportsTsv(readFileSync(TSV_PATH, 'utf8'))
  const startedAt = performance.now()
  const imported = await importAirports(db, rows)
  const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1)

  process.stdout.write(`Справочник аэропортов: ${imported} строк за ${elapsed}s (${prod ? 'prod' : 'local'})\n`)
  await closeDbConnection(db)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
