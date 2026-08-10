import { describe, it, expect } from 'vitest'
import { changesRequestedMail, approvedMail, loginMail } from '../messages'

describe('письма', () => {
  it('возврат на правку содержит ссылку и число замечаний', () => {
    const mail = changesRequestedMail({
      to: 'operator@lounge.test',
      loungeName: 'Primeclass Lounge',
      fillUrl: 'https://app.test/f/abc',
      flagCount: 3,
    })

    expect(mail.to).toBe('operator@lounge.test')
    expect(mail.subject).toContain('Primeclass Lounge')
    expect(mail.text).toContain('https://app.test/f/abc')
    expect(mail.text).toContain('3')
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
      changesRequestedMail({ to: 'a@b.c', loungeName: 'L', fillUrl: 'u', flagCount: 1 }),
      approvedMail({ to: 'a@b.c', loungeName: 'L' }),
      loginMail({ to: 'a@b.c', loginUrl: 'u' }),
    ]
    for (const mail of mails) expect(mail.subject.trim()).not.toBe('')
  })
})
