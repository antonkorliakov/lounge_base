/**
 * Печатает одноразовую ссылку входа для указанной почты — ровно одну строку,
 * как и `seed-dev.ts` (её целиком читает `e2e/review.spec.ts`).
 *
 * Зачем это существует. Настоящий вход выдаёт ссылку только письмом, а
 * консольный почтальон (`src/notify/mailer.ts`) по умолчанию печатает тело БЕЗ
 * ссылки — она одноразовый пропуск, и печатать его в лог по умолчанию
 * означало бы утечку. Значит, тест не может получить ссылку из вывода
 * сервера, не включив `MAIL_CONSOLE_SHOW_BODY=true` и не парся его stdout. Он
 * получает её тем же `requestLogin`, каким пользуется само действие входа —
 * то есть проверяет ту же выдачу токена, а не свою.
 *
 * Скрипт НИЧЕГО не создаёт, кроме токена: участника команды заводит сид
 * (`ensureReviewer` в `seed-dev.ts`). Незнакомый адрес — отказ с текстом
 * `requestLogin`, а не тихое добавление в команду: скрипт, выдающий доступ,
 * запущенный не туда, — это выдача доступа, а не ошибка запуска.
 *
 * Только для локальной работы и тестов: он обходит письмо, то есть обходит
 * доказательство того, что человек владеет этим адресом.
 */
import { resolve } from 'node:path'
import { closeDbConnection, loadEnvFile } from './dev-support'
import { createDb } from '../src/db/client'
import { requestLogin } from '../src/access/team'

async function main(): Promise<void> {
  loadEnvFile(resolve(process.cwd(), '.env.local'))

  const email = process.argv[2]
  const url = process.env.DATABASE_URL
  if (!email) throw new Error('usage: dev-login-link.ts <email>')
  if (!url) throw new Error('DATABASE_URL не задан')

  const db = createDb(url)
  const result = await requestLogin(db, email)
  if (!('token' in result)) {
    await closeDbConnection(db)
    throw new Error(`dev-login-link: ${result.error.ru}`)
  }

  // Тот же `APP_URL ?? http://localhost:3000`, что и у маршрута входа
  // (`src/app/admin/login/[token]/route.ts`) и у писем: ссылка обязана вести
  // на тот же origin, иначе cookie сессии поставится не туда.
  const base = process.env.APP_URL ?? 'http://localhost:3000'
  process.stdout.write(`${base}/admin/login/${result.token}\n`)

  await closeDbConnection(db)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
