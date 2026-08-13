'use server'

import { after } from 'next/server'
import { cookies } from 'next/headers'
import { db } from '@/db/client'
import { loginWithPassword, requestLogin } from '@/access/team'
import { SESSION_COOKIE, sessionCookieOptions } from '@/access/session'
import { createMailer } from '@/notify/mailer'
import { loginMail } from '@/notify/messages'
import type { Localized } from '@/form-schema'

// Пол на длительность ответа. Без него известная почта (SELECT + INSERT в
// requestLogin) и неизвестная (один SELECT) отвечают за заметно разное
// время, и по одной этой разнице форма входа превращается в способ
// перечислить состав команды — даже если тело ответа у обеих веток
// побайтово одинаково. Это не строгая защита (см. отчёт задачи: она
// выравнивает типичный случай, а не гарантирует константное время для
// любых условий), но именно поэтому отправка письма ниже вынесена из
// дожидаемого пути: без этого самой большой и самой шумной переменной в
// таймере был бы реальный SMTP-разговор, который эта задержка не смогла бы
// перекрыть никаким разумным полом.
const MIN_RESPONSE_MS = 150

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function requestLoginAction(
  email: string,
): Promise<{ sent: boolean }> {
  const startedAt = Date.now()
  const result = await requestLogin(db(), email)

  // Ответ одинаков для известной и неизвестной почты: иначе форма входа
  // превращается в способ проверить, кто состоит в команде.
  if ('token' in result) {
    const base = process.env.APP_URL ?? 'http://localhost:3000'
    const loginUrl = `${base}/admin/login/${result.token}`

    // Отправка не дожидается ответа (см. MIN_RESPONSE_MS выше — SMTP-
    // разговор не должен быть таймером) и не может его провалить — но
    // раньше здесь стоял голый "fire-and-forget" (`void mailer.send(...)`
    // без ничего, что удерживало бы это дальше). На serverless-раннтайме
    // исполнение может быть остановлено сразу после того, как ответ ушёл
    // клиенту — именно то, что отличает "не дожидаться" от "дать шанс
    // выполниться вообще": промис было бы создан, но раннтайм мог оборвать
    // процесс до того, как он settled, и письмо с единственной работающей
    // ссылкой входа просто не ушло бы — без единой строки в логах.
    // `after()` (`next/server`) существует ровно для этого: планирует
    // работу, которая обязана выполниться после того, как ответ уже отдан,
    // но раннтайм обязан не завершаться, пока она не закончится — то есть
    // именно "вне таймера ответа, но не 'может исполниться, а может и нет'".
    // Проверено вручную (см. отчёт задачи): при запущенном `next dev`
    // ответ формы приходит почти мгновенно, а строка `[mail] → ...`
    // печатается в лог сервера уже после того, как браузер получил ответ —
    // то есть `after()` действительно откладывает работу за пределы
    // отправки ответа, а не просто переименовывает `await`.
    after(async () => {
      try {
        await createMailer().send(loginMail({ to: email, loginUrl }))
      } catch (err) {
        console.error('[admin/login] failed to send login mail', err)
      }
    })
  }

  const elapsed = Date.now() - startedAt
  if (elapsed < MIN_RESPONSE_MS) await delay(MIN_RESPONSE_MS - elapsed)

  return { sent: true }
}

// Свой пол, не MIN_RESPONSE_MS, и выше него — потому что у парольного входа
// другая арифметика. Разницу «есть ли scrypt в ветке» закрывает не пол, а
// фиктивный хэш в `loginWithPassword` (ветка без реального хэша сжигает те
// же ~50+ мс о DUMMY_STORED_HASH — пол в 150 мс, под которым одна ветка
// стоит почти нисколько, а другая всю цену scrypt, не прикрыл бы ничего:
// медленная ветка просто вылезала бы за него). Полу остаётся спрятать
// остаток: лишний UPDATE счётчика на неверном пароле против его отсутствия
// на неизвестной почте. 400 мс — с запасом больше типичной суммы
// SELECT + scrypt + UPDATE, чтобы пол в типичном случае действительно
// СВЯЗЫВАЛ длительность, а не был всегда ниже неё (пол, который никогда не
// достигается, ничего не выравнивает). Та же оговорка, что у
// MIN_RESPONSE_MS: это выравнивание типичного случая, не гарантия
// константного времени при любых условиях.
const PASSWORD_MIN_RESPONSE_MS = 400

// Один — буквально один и тот же объект — ответ на все четыре причины
// отказа (нет такой почты / пароль не задан / пароль неверный / вход
// заблокирован): тело и статус (у server action он всегда 200) неотличимы,
// различие умирает в `loginWithPassword`, который на любую из причин
// возвращает null. Отдельный текст «вы заблокированы» подтверждал бы, что
// адрес в команде. Не экспортируется не по забывчивости: из модуля с
// 'use server' можно экспортировать только async-функции.
const LOGIN_FAILED: Localized = {
  en: 'Sign-in failed. Check the email and password.',
  ru: 'Войти не получилось. Проверьте почту и пароль.',
}

export async function loginWithPasswordAction(
  email: string,
  password: string,
): Promise<{ ok: true } | { ok: false; error: Localized }> {
  const startedAt = Date.now()
  const result = await loginWithPassword(db(), email, password)

  if (result) {
    // Той же cookie с теми же атрибутами, что ставит маршрут magic-ссылки
    // (`login/[token]/route.ts`), — из одного `sessionCookieOptions`. У
    // действия нет NextResponse, поэтому путь другой: `cookies().set` из
    // `next/headers` — штатный способ Server Function по документации
    // (`next/dist/docs`: set/delete разрешены в Server Functions и Route
    // Handlers, до начала стриминга).
    const store = await cookies()
    store.set(SESSION_COOKIE, result.sessionId, sessionCookieOptions())
  }

  // Пол накрывает и успех, и отказ: успеху скрывать нечего (ответ сам
  // говорит «вошёл»), но одна ветвь без пола была бы ещё одним таймером,
  // по которому можно отличать ветки отказа от почти-успеха.
  const elapsed = Date.now() - startedAt
  if (elapsed < PASSWORD_MIN_RESPONSE_MS) await delay(PASSWORD_MIN_RESPONSE_MS - elapsed)

  if (!result) return { ok: false, error: LOGIN_FAILED }
  return { ok: true }
}
