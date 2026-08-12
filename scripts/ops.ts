/**
 * Операционные команды для боевой системы, пока в интерфейсе нет экранов
 * «пригласить в команду», «завести лаунж» и «выдать первую ссылку». Namel:
 *
 *   npm run ops -- login   <email>
 *   npm run ops -- invite  <email> [Имя]
 *   npm run ops -- lounge  "<Название>" <IATA> [Страна] [Город] [Аэропорт]
 *
 * Читает окружение из `.env.production.local` (боевая база), с откатом на
 * `.env.local`. Значение `DATABASE_URL`, заданное в окружении явно, всё равно
 * побеждает — см. `loadEnvFile`.
 *
 * Это временный мост, а НЕ штатный путь: `invite` и `lounge` обходят
 * отсутствующий UI, а `login` существует потому, что почта ещё не отправляется
 * по-настоящему (SMTP не настроен), и ссылку входа приходится печатать вручную.
 * Когда появятся соответствующие экраны и рассылка, этот скрипт станет не нужен.
 */
import { resolve } from 'node:path'
import { createDb } from '../src/db/client'
import { lounges, submissions } from '../src/db/schema'
import { addTeamMember, requestLogin } from '../src/access/team'
import { issueFillToken, FILL_TOKEN_TTL_DAYS } from '../src/access/tokens'
import { closeDbConnection, loadEnvFile } from './dev-support'

function fail(message: string): never {
  process.stderr.write(message + '\n')
  process.exit(1)
}

async function main(): Promise<void> {
  // Боевое окружение первым: этот скрипт существует ради прод-операций.
  // `.env.local` — запасной вариант для локального прогона против docker.
  loadEnvFile(resolve(process.cwd(), '.env.production.local'))
  loadEnvFile(resolve(process.cwd(), '.env.local'))

  const url = process.env.DATABASE_URL
  if (!url) fail('DATABASE_URL не задан (нет .env.production.local?)')
  const base = process.env.APP_URL ?? 'http://localhost:3000'

  const [command, ...rest] = process.argv.slice(2)
  const db = createDb(url)

  if (command === 'login') {
    const email = rest[0]
    if (!email) fail('usage: npm run ops -- login <email>')
    const result = await requestLogin(db, email)
    if (!('token' in result)) {
      // requestLogin отвечает одинаково для известной и неизвестной почты —
      // это защита формы входа, но в консольной операции нам нужна правда.
      fail(`Почты ${email} нет в команде — сначала: npm run ops -- invite ${email}`)
    }
    process.stdout.write(`${base}/admin/login/${result.token}\n`)
  } else if (command === 'invite') {
    const email = rest[0]
    if (!email) fail('usage: npm run ops -- invite <email> [Имя]')
    // Имя обязательно у `addTeamMember`; если не передали — берём часть адреса
    // до @, чтобы в списке команды было что показать, а не пустая строка.
    const name = rest.slice(1).join(' ') || email.split('@')[0]!
    await addTeamMember(db, { email, name })
    process.stdout.write(`Добавлен в команду: ${email}\n`)
  } else if (command === 'lounge') {
    const name = rest[0]
    const iata = rest[1]
    if (!name || !iata) {
      fail('usage: npm run ops -- lounge "<Название>" <IATA> [Страна] [Город] [Аэропорт]')
    }
    const [lounge] = await db
      .insert(lounges)
      .values({
        name,
        iataCode: iata,
        country: rest[2] ?? '',
        city: rest[3] ?? '',
        airport: rest[4] ?? '',
      })
      .returning()
    const [submission] = await db
      .insert(submissions)
      .values({ loungeId: lounge!.id })
      .returning()
    const { token } = await issueFillToken(db, {
      submissionId: submission!.id,
      ttlDays: FILL_TOKEN_TTL_DAYS,
    })
    process.stdout.write(`Лаунж «${name}» заведён. Ссылка заполнения (живёт ${FILL_TOKEN_TTL_DAYS} дней):\n`)
    process.stdout.write(`${base}/f/${token}\n`)
  } else {
    fail('команды: login <email> | invite <email> [Имя] | lounge "<Название>" <IATA> [Страна] [Город] [Аэропорт]')
  }

  await closeDbConnection(db)
}

void main()
