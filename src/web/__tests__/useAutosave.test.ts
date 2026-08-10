import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  queueDrain,
  readQueue,
  writeQueue,
  mergeRejected,
  shouldDrainOnMount,
} from '../useAutosave'

class MemoryStorage {
  private data = new Map<string, string>()
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, value) }
  removeItem(key: string) { this.data.delete(key) }
}

describe('очередь автосохранения', () => {
  let storage: MemoryStorage

  beforeEach(() => {
    storage = new MemoryStorage()
  })

  it('пустая очередь читается как пустой объект', () => {
    expect(readQueue(storage, 'sub-1')).toEqual({})
  })

  it('запись переживает чтение', () => {
    writeQueue(storage, 'sub-1', { 'I.2': 'Primeclass' })
    expect(readQueue(storage, 'sub-1')).toEqual({ 'I.2': 'Primeclass' })
  })

  it('очередь досылается и очищается при успехе', async () => {
    writeQueue(storage, 'sub-1', { 'I.2': 'Primeclass', 'I.3': 'Çelebi' })
    const save = vi.fn().mockResolvedValue({ ok: true })

    await queueDrain(storage, 'sub-1', save)

    expect(save).toHaveBeenCalledTimes(2)
    expect(readQueue(storage, 'sub-1')).toEqual({})
  })

  it('при ошибке несохранённое остаётся в очереди', async () => {
    writeQueue(storage, 'sub-1', { 'I.2': 'Primeclass', 'I.3': 'Çelebi' })
    const save = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('offline'))

    await queueDrain(storage, 'sub-1', save)

    expect(readQueue(storage, 'sub-1')).toEqual({ 'I.3': 'Çelebi' })
  })

  it('битый JSON не роняет чтение', () => {
    storage.setItem('lounge.draft.sub-1', '{не json')
    expect(readQueue(storage, 'sub-1')).toEqual({})
  })

  it('JSON-массив в хранилище — не валидная очередь', () => {
    storage.setItem('lounge.draft.sub-1', '[1,2,3]')
    expect(readQueue(storage, 'sub-1')).toEqual({})
  })

  // --- Гонка push/drain: наивная реализация (снимок в начале, одна запись
  // remaining в конце) стирает то, что попало в очередь во время отправки. ---

  it('ключ, добавленный во время досылки другого ключа, не стирается финальной записью', async () => {
    writeQueue(storage, 'sub-1', { 'I.2': 'A' })
    const save = vi.fn(async () => {
      // имитирует push, случившийся, пока запрос для I.2 летит по сети
      const live = readQueue(storage, 'sub-1')
      writeQueue(storage, 'sub-1', { ...live, 'I.4': 'B' })
      return { ok: true }
    })

    await queueDrain(storage, 'sub-1', save)

    // I.2 подтверждён и должен уйти из очереди; I.4, добавленный во время
    // отправки, должен остаться — драйн не видел и не отправлял его.
    expect(readQueue(storage, 'sub-1')).toEqual({ 'I.4': 'B' })
  })

  it('более новое значение того же ключа не подменяется устаревшим при успехе', async () => {
    writeQueue(storage, 'sub-1', { 'I.2': 'old' })
    const save = vi.fn(async () => {
      // пользователь правит I.2 ещё раз, пока старое значение отправляется
      writeQueue(storage, 'sub-1', { 'I.2': 'new' })
      return { ok: true }
    })

    await queueDrain(storage, 'sub-1', save)

    expect(readQueue(storage, 'sub-1')).toEqual({ 'I.2': 'new' })
  })

  it('при сетевом сбое более новое значение того же ключа не заменяется устаревшим (воскрешение)', async () => {
    writeQueue(storage, 'sub-1', { 'I.3': 'old' })
    const save = vi.fn(async () => {
      writeQueue(storage, 'sub-1', { 'I.3': 'new' })
      throw new Error('offline')
    })

    await queueDrain(storage, 'sub-1', save)

    // Наивная реализация переписала бы очередь на { 'I.3': 'old' } —
    // устаревшее значение "воскресло" бы над правкой, которую отправить
    // ещё не успели.
    expect(readQueue(storage, 'sub-1')).toEqual({ 'I.3': 'new' })
  })

  // --- Отказ валидации — не то же самое, что обрыв связи. ---

  it('отклонённое сервером значение уходит из очереди навсегда и попадает в rejected', async () => {
    writeQueue(storage, 'sub-1', { 'I.2': 'invalid' })
    const save = vi.fn().mockResolvedValue({ ok: false, error: 'плохое значение' })

    const { rejected } = await queueDrain(storage, 'sub-1', save)

    expect(readQueue(storage, 'sub-1')).toEqual({})
    expect(rejected).toEqual({ 'I.2': 'плохое значение' })
  })

  it('различает сетевой сбой (остаётся в очереди) и отказ валидации (уходит навсегда)', async () => {
    writeQueue(storage, 'sub-1', { net: 'x', bad: 'y' })
    const save = vi.fn(async (key: string) => {
      if (key === 'net') throw new Error('offline')
      return { ok: false, error: 'invalid' }
    })

    const { rejected } = await queueDrain(storage, 'sub-1', save)

    expect(readQueue(storage, 'sub-1')).toEqual({ net: 'x' })
    expect(rejected).toEqual({ bad: 'invalid' })
  })

  it('успешно сохранённый ключ попадает в saved', async () => {
    writeQueue(storage, 'sub-1', { 'I.2': 'ok-value' })
    const save = vi.fn().mockResolvedValue({ ok: true })

    const { saved } = await queueDrain(storage, 'sub-1', save)

    expect(saved).toEqual(['I.2'])
  })

  // --- Fix round 1: устаревший отказ не должен отмечаться как rejected, и
  // успешное сохранение должно снимать ранее записанный отказ. ---

  it('устаревший отказ (значение изменилось за время отправки) не попадает в rejected', async () => {
    writeQueue(storage, 'sub-1', { 'I.2': 'invalid' })
    const save = vi.fn(async () => {
      // Оператор успевает исправить значение, пока запрос с invalid летит
      // по сети и получает отказ.
      writeQueue(storage, 'sub-1', { 'I.2': 'fixed' })
      return { ok: false, error: 'плохое значение' }
    })

    const { rejected } = await queueDrain(storage, 'sub-1', save)

    // Отказ относится к значению, которого больше нигде нет — ни в очереди,
    // ни (по построению сценария) на экране. Отмечать по нему поле как
    // невалидное — ложный сигнал.
    expect(rejected).toEqual({})
    // Исправленное значение остаётся в очереди для следующей досылки —
    // отказ по старому значению не должен его стирать.
    expect(readQueue(storage, 'sub-1')).toEqual({ 'I.2': 'fixed' })
  })

  it('mergeRejected: успешное сохранение снимает ранее записанный отказ по этому ключу', () => {
    const next = mergeRejected(
      { 'I.2': 'старая ошибка', 'I.3': 'другая ошибка' },
      { saved: ['I.2'], rejected: {} },
    )

    expect(next).toEqual({ 'I.3': 'другая ошибка' })
  })

  it('mergeRejected: новые отказы добавляются, а не заменяют весь набор', () => {
    const next = mergeRejected(
      { 'I.2': 'старая ошибка' },
      { saved: [], rejected: { 'I.5': 'новая ошибка' } },
    )

    expect(next).toEqual({ 'I.2': 'старая ошибка', 'I.5': 'новая ошибка' })
  })

  it('mergeRejected: пустой результат драйна не создаёт новый объект без нужды', () => {
    const prev = { 'I.2': 'старая ошибка' }
    const next = mergeRejected(prev, { saved: [], rejected: {} })

    expect(next).toBe(prev)
  })

  // --- Fix round 1: недосланное при монтировании должно уходить сразу, а не
  // ждать первого push или события online. ---

  it('shouldDrainOnMount: непустая очередь и онлайн — досылать', () => {
    expect(shouldDrainOnMount(2, true)).toBe(true)
  })

  it('shouldDrainOnMount: пустая очередь — не запускать бесполезный запрос', () => {
    expect(shouldDrainOnMount(0, true)).toBe(false)
  })

  it('shouldDrainOnMount: оффлайн — ждать событие online, а не пытаться самим', () => {
    expect(shouldDrainOnMount(3, false)).toBe(false)
  })

  // --- Minor: сравнение значений не должно зависеть от порядка ключей. ---

  it('два объекта с одинаковыми полями в разном порядке ключей считаются одинаковыми', async () => {
    writeQueue(storage, 'sub-1', { 'X.1': { available: 'yes', price: 10 } })
    const save = vi.fn(async () => {
      // То же самое значение, но собранное с другим порядком ключей —
      // должно всё равно распознаваться как неизменившееся.
      writeQueue(storage, 'sub-1', { 'X.1': { price: 10, available: 'yes' } })
      return { ok: true }
    })

    await queueDrain(storage, 'sub-1', save)

    expect(readQueue(storage, 'sub-1')).toEqual({})
  })
})
