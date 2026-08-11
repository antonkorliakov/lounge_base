/**
 * Общее для локальных скриптов (`seed-dev.ts`, `dev-login-link.ts`) и для
 * e2e-набора, который их запускает. Модуль намеренно без побочных эффектов и
 * почти без зависимостей (`node:fs`/`node:path`), чтобы его мог импортировать
 * и тест Playwright, и скрипт под `tsx` — в отличие от самого `seed-dev.ts`,
 * который при импорте выполнил бы `main()`.
 */
import { existsSync, readFileSync } from 'node:fs'

/**
 * Почта проверяющего, которого заводит `npm run seed`. Живёт здесь, а не
 * литералом в `seed-dev.ts`, `dev-login-link.ts` и `e2e/review.spec.ts`
 * порознь: три копии одного адреса — это три места, которые нужно помнить
 * править вместе, а расхождение проявилось бы как «вход не работает», без
 * подсказки почему.
 *
 * Уже в нижнем регистре, и это важно: `addTeamMember` (`src/access/team.ts`)
 * нормализует адрес перед записью, так что адрес с заглавной буквой здесь
 * хранился бы в базе в другом виде, чем написано тут, и любая проверка «есть
 * ли такой участник» по этой константе не нашла бы его.
 */
export const SEED_REVIEWER_EMAIL = 'reviewer@easyto.travel'

/**
 * `drizzle-kit push`/Next dev load `.env.local` themselves; a plain `tsx`
 * script does not. Rather than requiring every caller (including
 * `e2e/fill.spec.ts`, which shells out to `npm run seed`) to remember to
 * export `DATABASE_URL` first, read it from `.env.local` here — but only to
 * fill in what the real environment doesn't already provide, so an explicit
 * `export DATABASE_URL=...` still wins.
 */
/**
 * Закрывает соединение, открытое `createDb`.
 *
 * `createDb` открывает соединение `postgres-js` без idle-таймаута, поэтому
 * процесс сам не завершается после последнего запроса — он висит вечно, держа
 * сокет. И `seed-dev.ts`, и `dev-login-link.ts` запускаются из e2e через
 * `execSync`, который ждёт выхода дочернего процесса, так что незакрытое
 * соединение подвесило бы тест целиком.
 *
 * Аргумент `unknown`, а не `Db`: общий тип `Db` (`src/db/types.ts`) намеренно
 * не привязан к драйверу (взят из pglite-перегрузки `drizzle`, см. его
 * собственный комментарий) и типизированного `.end()` не открывает, а тянуть
 * сюда `src/db/*` ради одного каста означало бы притащить drizzle и postgres в
 * процесс Playwright, который импортирует этот модуль только за одной
 * константой. Каст живёт в одном месте — здесь.
 */
export function closeDbConnection(db: unknown): Promise<void> {
  return (db as { $client: { end: () => Promise<void> } }).$client.end()
}

export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([\w.-]+)\s*=(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]!
    let value = (match[2] ?? '').trim()
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = value
  }
}
