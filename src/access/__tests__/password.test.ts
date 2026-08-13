import { describe, it, expect } from 'vitest'
import {
  CURRENT_KEY_BYTES,
  CURRENT_SALT_BYTES,
  CURRENT_SCRYPT_PARAMS,
  DUMMY_STORED_HASH,
  hashPassword,
  parseStoredHash,
  verifyPassword,
} from '../password'

describe('хэширование пароля', () => {
  it('раунд-трип: захэшированный пароль проходит проверку', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true)
  })

  it('неверный пароль не проходит', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('correct horse battery stapl', stored)).toBe(false)
    expect(await verifyPassword('', stored)).toBe(false)
  })

  it('соль случайна на каждый вызов: два хэша одного пароля различаются', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')])
    expect(a).not.toBe(b)
  })

  it('формат самоописывающийся: параметры лежат в самой строке и парсятся обратно', async () => {
    const stored = await hashPassword('whatever')
    const parsed = parseStoredHash(stored)
    expect(parsed).not.toBeNull()
    expect({ N: parsed!.N, r: parsed!.r, p: parsed!.p }).toEqual(CURRENT_SCRYPT_PARAMS)
    expect(parsed!.salt.length).toBe(CURRENT_SALT_BYTES)
    expect(parsed!.hash.length).toBe(CURRENT_KEY_BYTES)
  })

  it('пароль проверяется по параметрам ИЗ СТРОКИ, а не из констант: старый хэш с другими параметрами остаётся проверяемым', async () => {
    // Ровно то, ради чего параметры хранятся в значении: строка, записанная
    // при N=16384 (вдвое ниже нынешнего), обязана проверяться и после
    // подъёма констант. Собрана руками через те же примитивы формата.
    const { scryptSync, randomBytes } = await import('node:crypto')
    const salt = randomBytes(16)
    const hash = scryptSync('old password', salt, 32, { N: 16384, r: 8, p: 1 })
    const legacy = `scrypt:16384:8:1:${salt.toString('base64url')}:${hash.toString('base64url')}`

    expect(await verifyPassword('old password', legacy)).toBe(true)
    expect(await verifyPassword('not it', legacy)).toBe(false)
  })

  it('повреждённое значение — отказ, а не исключение', async () => {
    const stored = await hashPassword('whatever')
    // Чужой префикс, мусорные параметры, пустая строка — всё это «пароль не
    // подходит», а не 500 на входе.
    expect(await verifyPassword('whatever', stored.replace('scrypt', 'bcrypt'))).toBe(false)
    expect(await verifyPassword('whatever', 'scrypt:0:0:0::')).toBe(false)
    expect(await verifyPassword('whatever', '')).toBe(false)
  })

  it('обрезанный хэш: ниже пола длины — отказ даже с верным паролем; выше пола неверный пароль всё равно не проходит', async () => {
    const stored = await hashPassword('whatever')
    const parts = stored.split(':')

    // Хэш короче 16 байт — повреждение, а не «короткий, но честный» формат.
    // Без пола длины это проходило БЫ: короткий вывод scrypt — префикс
    // длинного, и первая версия этого теста поймала ровно это — обрезанное
    // значение верифицировалось верным паролем как ни в чём не бывало.
    const below = [...parts.slice(0, 5), parts[5]!.slice(0, 12)].join(':')
    expect(await verifyPassword('whatever', below)).toBe(false)

    // Умеренная обрезка (выше пола) — свойство формата: верный пароль
    // пройдёт по оставшимся байтам. Неверный — нет, и без исключения о
    // несовпадении длин буферов.
    const above = [...parts.slice(0, 5), parts[5]!.slice(0, -10)].join(':')
    expect(await verifyPassword('not the password', above)).toBe(false)
  })

  it('параметры выше потолка памяти — отказ, а не заказ гигабайтов у сервера', async () => {
    // N из строки, требующий больше SCRYPT_MAXMEM: deriveKey отклоняет его
    // (maxmem — константа модуля, не функция от распарсенного N).
    const huge = `scrypt:1048576:8:1:${'A'.repeat(22)}:${'B'.repeat(43)}`
    expect(await verifyPassword('whatever', huge)).toBe(false)
  })

  it('в хранимой строке нет самого пароля', async () => {
    const stored = await hashPassword('sekret-parol-123')
    expect(stored).not.toContain('sekret-parol-123')
  })

  it('фиктивный хэш не отстаёт от текущих параметров — иначе ветки без реального хэша выдавали бы себя временем', () => {
    const parsed = parseStoredHash(DUMMY_STORED_HASH)
    expect(parsed).not.toBeNull()
    expect({ N: parsed!.N, r: parsed!.r, p: parsed!.p }).toEqual(CURRENT_SCRYPT_PARAMS)
    expect(parsed!.salt.length).toBe(CURRENT_SALT_BYTES)
    expect(parsed!.hash.length).toBe(CURRENT_KEY_BYTES)
  })
})
