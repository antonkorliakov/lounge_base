import { describe, it, expect } from 'vitest'
import { UI, LOCALES } from '../dictionaries'

describe('словари интерфейса', () => {
  it('поддерживаются ровно две локали', () => {
    expect(LOCALES).toEqual(['en', 'ru'])
  })

  it('у каждой строки заполнены обе локали', () => {
    for (const [key, value] of Object.entries(UI)) {
      expect(value.en.trim(), key).not.toBe('')
      expect(value.ru.trim(), key).not.toBe('')
    }
  })

  it('содержит ключи, нужные форме', () => {
    for (const key of [
      'form.next', 'form.back', 'form.saved', 'form.savingOffline',
      'form.submit', 'form.submitted', 'services.pass1Title',
      'services.pass2Title', 'photos.upload', 'fixes.title',
    ]) {
      expect(UI, key).toHaveProperty(key)
    }
  })
})
