import { describe, it, expect } from 'vitest'
import { UI, LOCALES, FLAG_REASON_LABELS } from '../dictionaries'
import { FLAG_REASONS } from '@/review/flags'

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
      // Имена слитых шагов (MERGED_FIELD_GROUPS в FormShell.tsx): шаг из
      // нескольких блоков не может носить подпись одного из них.
      'form.stepContacts', 'form.stepAccess', 'form.stepLocation',
    ]) {
      expect(UI, key).toHaveProperty(key)
    }
  })
})

// `satisfies Record<FlagReason, Localized>` уже не даёт пропустить код при
// компиляции. Этот тест — вторая, независимая проверка того же: он идёт от
// самого массива `FLAG_REASONS` в рантайме, поэтому не зависит от того, что
// typecheck запускали (и от того, что кто-то не ослабил `satisfies`).
describe('подписи к кодам замечаний', () => {
  it('есть на каждый код из FLAG_REASONS, и обе локали заполнены', () => {
    for (const code of FLAG_REASONS) {
      const label = FLAG_REASON_LABELS[code]
      expect(label, code).toBeDefined()
      expect(label.en.trim(), code).not.toBe('')
      expect(label.ru.trim(), code).not.toBe('')
    }
  })

  it('лишних кодов нет', () => {
    expect(Object.keys(FLAG_REASON_LABELS).sort()).toEqual([...FLAG_REASONS].sort())
  })
})
