'use server'

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

    // Отправка не дожидается ответа и не может его провалить. Токен уже
    // вставлен в базу (внутри requestLogin) — письмо — это уведомление о
    // уже случившемся факте, а не часть решения "пускать или нет". Оба
    // сбоя, которые createMailer()/`send` документируют за собой
    // (синхронный throw у создания транспорта при плохом MAIL_FROM/
    // SMTP_URL, и отклонённый промис у самой отправки — см. `notify/
    // mailer.ts`), пойманы явно: как необработанный throw, так и
    // необработанный reject здесь одинаково опасны — оба обрушили бы этот
    // server action и вернули бы вызывающему 500 вместо нейтрального
    // { sent: true }, а это именно то различие, которое эта функция обязана
    // скрывать.
    try {
      void createMailer()
        .send(loginMail({ to: email, loginUrl }))
        .catch((err: unknown) => {
          console.error('[admin/login] failed to send login mail', err)
        })
    } catch (err) {
      console.error('[admin/login] failed to construct mailer', err)
    }
  }

  const elapsed = Date.now() - startedAt
  if (elapsed < MIN_RESPONSE_MS) await delay(MIN_RESPONSE_MS - elapsed)

  return { sent: true }
}
