'use server'

import { after } from 'next/server'
import { db } from '@/db/client'
import { requestLogin } from '@/access/team'
import { createMailer } from '@/notify/mailer'
import { loginMail } from '@/notify/messages'

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
