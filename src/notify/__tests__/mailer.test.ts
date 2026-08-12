import { describe, it, expect, vi, afterEach } from 'vitest'
import { mailDelivers, createMailer } from '../mailer'

/**
 * `mailDelivers()` — единственное определение «SMTP настроен», и весь смысл
 * его существования в том, что оно не может разойтись с тем, какой почтальон
 * вернёт `createMailer()`. Поэтому здесь не два независимых утверждения, а
 * ПАРА на каждое состояние среды: что говорит предикат — и какой ветке
 * `createMailer` это соответствует, различённой по наблюдаемому поведению:
 *
 *  - консольный почтальон предупреждает в `console.warn` и не ходит в сеть —
 *    его `send` завершается успешно без SMTP-сервера;
 *  - SMTP-ветка опознаётся её собственным контрактом: `MAIL_FROM` обязателен,
 *    и его отсутствие — синхронный бросок из `createMailer()` ещё до всякой
 *    отправки (см. `smtpMailer`). Настоящую отправку тест не делает и не
 *    должен: важно, ЧТО выбрано, а не работает ли nodemailer.
 *
 * Если однажды «настроен» перестанет значить «SMTP_URL непуст» (скажем,
 * добавится второй транспорт), эта пара заставит поменять оба места разом.
 */
describe('mailDelivers: предикат и выбор почтальона — одно правило', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('SMTP_URL не задан: доставки нет, и createMailer даёт консольный почтальон', async () => {
    vi.stubEnv('SMTP_URL', '')
    vi.stubEnv('MAIL_CONSOLE_SHOW_BODY', '')

    expect(mailDelivers()).toBe(false)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await createMailer().send({ to: 'op@example.test', subject: 's', text: 't' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SMTP_URL is not set'))
    // Тело по умолчанию удержано (см. consoleMailer) — печатается заглушка.
    expect(write).toHaveBeenCalledWith(expect.stringContaining('body withheld'))
  })

  it('пустая строка — то же самое, что отсутствие: пустой SMTP_URL не «настроен»', () => {
    vi.stubEnv('SMTP_URL', '')
    expect(mailDelivers()).toBe(false)
  })

  it('SMTP_URL задан: доставка есть, и createMailer идёт SMTP-веткой (требует MAIL_FROM)', () => {
    vi.stubEnv('SMTP_URL', 'smtp://mail.example.test:587')
    vi.stubEnv('MAIL_FROM', '')

    expect(mailDelivers()).toBe(true)
    // Опознание SMTP-ветки по её контракту: без MAIL_FROM она отказывает
    // синхронно, до первой отправки, — консольная ветка не требует ничего.
    expect(() => createMailer()).toThrow(/MAIL_FROM/)
  })
})
