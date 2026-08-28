import { describe, it, expect } from 'vitest'
import { changesRequestedMail, fillLinkMail, approvedMail, loginMail } from '../messages'
import { LOGIN_TTL_MINUTES } from '@/access/team'

describe('письма', () => {
  it('возврат на правку содержит ссылку и число замечаний', () => {
    const mail = changesRequestedMail({
      to: 'operator@lounge.test',
      loungeName: 'Primeclass Lounge',
      fillUrl: 'https://app.test/f/abc',
      flagCount: 3,
      teamCorrectedCount: 0,
    })

    expect(mail.to).toBe('operator@lounge.test')
    expect(mail.subject).toContain('Primeclass Lounge')
    expect(mail.text).toContain('https://app.test/f/abc')
    expect(mail.text).toContain('3')
  })

  /**
   * «Everything else is accepted» — правда ровно пока команда ничего не
   * исправила мимо замечаний: за ссылкой тогда стоят ответы, которых оператор
   * не писал, и письмо обязано сказать об этом (тот же состав и то же
   * условие, что у группы «команда исправила эти ответы» на экране правок,
   * который ссылка открывает — см. `FixesOnly`).
   */
  it('возврат с правками команды: письмо называет их и не говорит «только отмеченное»', () => {
    const mail = changesRequestedMail({
      to: 'operator@lounge.test',
      loungeName: 'Primeclass Lounge',
      fillUrl: 'https://app.test/f/abc',
      flagCount: 1,
      teamCorrectedCount: 2,
    })

    expect(mail.text).toContain('corrected 2 answer(s)')
    expect(mail.text).not.toContain('you only need to fix what is flagged')
    // Принятость остального письмо по-прежнему утверждает — теперь честно.
    expect(mail.text).toContain('Everything else is accepted')
  })

  it('возврат без правок команды — прежний текст, без пустых упоминаний команды', () => {
    const mail = changesRequestedMail({
      to: 'operator@lounge.test',
      loungeName: 'Primeclass Lounge',
      fillUrl: 'https://app.test/f/abc',
      flagCount: 3,
      teamCorrectedCount: 0,
    })

    expect(mail.text).toContain('Everything else is accepted — you only need to fix what is flagged')
    expect(mail.text).not.toContain('corrected')
  })

  it('принятие не содержит ссылки на правку', () => {
    const mail = approvedMail({
      to: 'operator@lounge.test',
      loungeName: 'Primeclass Lounge',
    })

    expect(mail.text).not.toContain('/f/')
  })

  it('письмо входа содержит одноразовую ссылку', () => {
    const mail = loginMail({
      to: 'a.korlyakov@easyto.travel',
      loginUrl: 'https://app.test/admin/login/xyz',
    })

    expect(mail.text).toContain('https://app.test/admin/login/xyz')
  })

  it('тема письма не пустая ни в одном случае', () => {
    const mails = [
      changesRequestedMail({ to: 'a@b.c', loungeName: 'L', fillUrl: 'u', flagCount: 1, teamCorrectedCount: 0 }),
      fillLinkMail({ to: 'a@b.c', loungeName: 'L', fillUrl: 'u' }),
      approvedMail({ to: 'a@b.c', loungeName: 'L' }),
      loginMail({ to: 'a@b.c', loginUrl: 'u' }),
    ]
    for (const mail of mails) expect(mail.subject.trim()).not.toBe('')
  })

  /**
   * Ровно тот дефект, ради которого `fillLinkMail` и появился: пересылка
   * ссылки уходила через `changesRequestedMail`, то есть письмом «changes
   * requested» с телом «N answer(s) need a correction» — на анкете, где
   * возврата на правку не было (а при нуле открытых замечаний ещё и с «0
   * answer(s)»). Проверяется ОТСУТСТВИЕ утверждений, а не только наличие
   * ссылки: письмо с верной ссылкой и придуманным поводом — это ровно то, что
   * было, и «ссылка на месте» такое письмо считает исправным.
   */
  it('пересылка ссылки: ссылка на месте, а утверждений про проверку нет', () => {
    const fillUrl = 'https://app.test/f/abc'
    const mail = fillLinkMail({
      to: 'operator@lounge.test',
      loungeName: 'Primeclass Lounge',
      fillUrl,
    })

    expect(mail.to).toBe('operator@lounge.test')
    expect(mail.subject).toContain('Primeclass Lounge')
    expect(mail.subject).not.toMatch(/changes requested/i)
    expect(mail.text).toContain(fillUrl)
    expect(mail.text).not.toMatch(/correction|flagged|accepted|changes requested|approved/i)

    // Ничего не пересчитывает: у этого состояния нечего считать, так что
    // цифры в тексте не место — кроме самой ссылки, где они принадлежат
    // токену, а не утверждению письма.
    const withoutLink = mail.text
      .split('\n')
      .filter((line) => !line.includes(fillUrl))
      .join('\n')
    expect(withoutLink).not.toMatch(/\d/)

    // Два обещания, которые это письмо намеренно НЕ даёт, потому что не может
    // их сдержать: старые ссылки не отзываются (`issueFillToken` только
    // добавляет строку), а срок жизни — аргумент вызывающего, не знание этого
    // модуля. См. его собственный комментарий.
    expect(mail.text).not.toMatch(/replaces|revok|no longer valid|expires in|valid for/i)
  })

  // Pins two claims the login mail makes about the link it carries: that
  // it works once, and how long it lasts. Both are true today only because
  // they happen to match `access/team.ts`'s `requestLogin` — nothing
  // enforces that at the type level. Asserting against the real
  // `LOGIN_TTL_MINUTES` constant (imported, not re-typed as a literal
  // `20`) means a future change to that constant fails this test instead
  // of quietly leaving the email telling recipients the wrong window.
  it('письмо входа называет реальный срок действия ссылки и её одноразовость', () => {
    const mail = loginMail({ to: 'a@b.c', loginUrl: 'https://app.test/admin/login/xyz' })

    expect(mail.text).toContain('once')
    expect(mail.text).toContain(`${LOGIN_TTL_MINUTES}`)
  })
})
