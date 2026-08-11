import { describe, it, expect } from 'vitest'
import { submissionStatus } from '@/db/schema'
import type { SubmissionStatus } from '@/db/schema'
import { EDITABLE_STATUSES } from '@/submissions/editable'
import { REVIEW_STATUSES } from '@/review/blocks'
import { reviewStateFor, resendGateFor } from '../gates'

/**
 * Экран проверки не говорил, в каком состоянии анкета, и предлагал все четыре
 * решения на любой — включая уже принятую, где отмечать ответы бессмысленно, а
 * подтверждать и принимать нельзя. `reviewStateFor` — тот единственный ответ,
 * которым экран теперь и подписывает состояние, и выключает неприменимые шаги.
 *
 * Перечень статусов берётся из `submissionStatus.enumValues` — того же
 * определения, из которого выведен тип `SubmissionStatus`, — а не пишется здесь
 * списком: новый статус попадает в эти проверки сам. Без этого тест проверял бы
 * ровно те четыре состояния, о которых помнил автор, то есть ничего не говорил
 * бы о пятом — а именно «про новое состояние забыли» и есть тот отказ, который
 * здесь важен.
 */
const STATUSES = submissionStatus.enumValues as readonly SubmissionStatus[]

describe('reviewStateFor: состояние анкеты и применимые в нём шаги', () => {
  it('у каждого статуса есть непустая подпись и объяснение на обоих языках', () => {
    // Анти-вакуумность: пустой (или урезанный) перечень статусов сам по себе
    // прошёл бы любой `for`-цикл ниже.
    expect(STATUSES.length).toBeGreaterThanOrEqual(4)

    for (const status of STATUSES) {
      const state = reviewStateFor(status)
      expect(state.status, status).toBe(status)
      for (const text of [state.label, state.note]) {
        expect(text.en.trim(), `${status}.en`).not.toBe('')
        expect(text.ru.trim(), `${status}.ru`).not.toBe('')
      }
    }
  })

  it('решения доступны ровно в окне проверки, и нигде больше', () => {
    const allowed = STATUSES.filter((status) => reviewStateFor(status).decisions.allowed)
    expect(allowed).toEqual(STATUSES.filter((status) => REVIEW_STATUSES.has(status)))
    // Пин самого окна, независимо от `REVIEW_STATUSES`: сравнение с константой
    // выше — это проверка «правило то же самое», а не «правило такое». Обе
    // нужны: первая ловит расхождение, вторая — тихое изменение обеих сторон.
    expect(allowed).toEqual(['submitted'])
  })

  it('отказ по решениям объясняет состояние, а не повторяет «нельзя»', () => {
    for (const status of STATUSES) {
      const state = reviewStateFor(status)
      if (state.decisions.allowed) continue
      // Причина отказа и есть объяснение состояния — один текст, а не два,
      // которые расходятся при первой правке одного из них.
      expect(state.decisions.reason, status).toEqual(state.note)
    }
  })

  it('отмечать ответы можно всюду, откуда замечание ещё дойдёт до оператора', () => {
    const canFlag = STATUSES.filter((status) => reviewStateFor(status).flagging.allowed)
    // Два пути доставки, оба уже определены в системе: возврат на правку
    // (`REVIEW_STATUSES`) и экран правок по ссылке заполнения
    // (`EDITABLE_STATUSES`).
    expect(canFlag).toEqual(
      STATUSES.filter((status) => REVIEW_STATUSES.has(status) || EDITABLE_STATUSES.has(status)),
    )
    expect(canFlag).toEqual(['draft', 'submitted', 'changes_requested'])
    // И тупик ровно один: на принятой анкете замечание сохранилось бы
    // (`raiseFlag` статус не проверяет), но передать его оператору нечем.
    expect(STATUSES.filter((status) => !reviewStateFor(status).flagging.allowed)).toEqual([
      'approved',
    ])
  })

  it('пересылка ссылки — тот же ответ, что у самого действия', () => {
    for (const status of STATUSES) {
      expect(reviewStateFor(status).resend, status).toEqual(resendGateFor(status))
    }
  })
})
