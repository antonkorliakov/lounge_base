import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/**
 * Хэширование паролей команды — scrypt из `node:crypto`, без новых
 * зависимостей. Формат хранения самоописывающийся:
 *
 *   scrypt:N:r:p:<salt base64url>:<hash base64url>
 *
 * Параметры лежат В САМОМ значении, а не в коде, поэтому их можно поднять
 * (см. `SCRYPT_PARAMS` ниже), не ломая старые хэши: `verifyPassword` читает
 * N/r/p из строки и проверяет старый пароль по старым параметрам, а
 * следующий `hashPassword` (смена пароля, `set-password`) запишет уже новые.
 * Никакой миграции «перехэшировать всё» при подъёме параметров не требуется —
 * да она и невозможна: пароля в открытом виде нет нигде.
 *
 * Модуль намеренно только про криптографию: ни одной строки SQL. Кто и когда
 * пишет хэш в `team_members.password_hash` — дело `access/team.ts`
 * (`setMemberPassword`, `loginWithPassword`).
 */

/**
 * Одно место для правила «какой пароль вообще принимается». Проверяется в
 * `setMemberPassword` (`team.ts`) — единственной точке записи пароля, — а не
 * в каждой форме отдельно: смена пароля из кабинета и `ops set-password`
 * получают одну и ту же границу автоматически.
 */
export const MIN_PASSWORD_LENGTH = 8

/**
 * N=2^15, r=8, p=1 — ~50 мс на этой машине (замерено при выборе), заметно
 * дороже подбора по словарю оффлайн и терпимо на каждый вход. Не OWASP-овский
 * максимум (N=2^17): каждый НЕВЕРНЫЙ вход жжёт те же миллисекунды CPU на
 * serverless-раннтайме, так что параметр — ещё и рычаг DoS; формат хранения
 * выше существует ровно затем, чтобы поднять N позже одним изменением здесь.
 *
 * `maxmem` обязателен и должен расти вместе с N: scrypt требует ~128*N*r байт
 * (для этих параметров — ровно 32 МиБ, дефолтный потолок ноды), и N=2^16 без
 * подъёма `maxmem` не хэшировал бы, а падал в рантайме.
 */
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const
const SCRYPT_MAXMEM = 64 * 1024 * 1024
const SALT_BYTES = 16
const KEY_BYTES = 32

type StoredHash = {
  N: number
  r: number
  p: number
  salt: Buffer
  hash: Buffer
}

/**
 * Экспортируется ради тестов (закрепить формат и параметры `DUMMY_STORED_HASH`),
 * не как приглашение читать хэши где-то ещё. `null` на любой не своей строке —
 * повреждённое значение в базе должно читаться как «пароль не подходит», а не
 * ронять вход пятисоткой.
 */
export function parseStoredHash(stored: string): StoredHash | null {
  const parts = stored.split(':')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null
  const [, nText, rText, pText, saltText, hashText] = parts
  const N = Number(nText)
  const r = Number(rText)
  const p = Number(pText)
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null
  if (N <= 1 || r <= 0 || p <= 0) return null
  const salt = Buffer.from(saltText!, 'base64url')
  const hash = Buffer.from(hashText!, 'base64url')
  // Нижние границы длин, а не только «не пусто». Длина ключа при проверке
  // выводится из длины хранимого хэша, а у scrypt короткий вывод — ПРЕФИКС
  // длинного: обрезанное (при повреждении или подмене в базе) значение
  // проверялось бы «успешно» по всё меньшему числу байт, вплоть до одного.
  // 16 байт хэша (128 бит) и 8 соли — пол, ниже которого значение читается
  // как повреждённое, а не как «более короткий, но честный» хэш. Умеренная
  // обрезка выше пола по-прежнему проходит с верным паролем — это свойство
  // формата, а не дыра: переписывать `password_hash` может только тот, у
  // кого уже есть запись в базу.
  if (salt.length < 8 || hash.length < 16) return null
  return { N, r, p, salt, hash }
}

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  params: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // `maxmem` из константы, а не 128*N*r из распарсенных параметров: строка
    // из базы не должна уметь заказать у сервера гигабайты памяти. Хэш с
    // параметрами выше потолка не проверяется (reject -> false в verify) —
    // это правильный отказ, а не ограничение: такой хэш никогда не был бы
    // записан `hashPassword` с текущими константами.
    scrypt(password, salt, keyLength, { ...params, maxmem: SCRYPT_MAXMEM }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const hash = await deriveKey(password, salt, KEY_BYTES, SCRYPT_PARAMS)
  const { N, r, p } = SCRYPT_PARAMS
  return `scrypt:${N}:${r}:${p}:${salt.toString('base64url')}:${hash.toString('base64url')}`
}

/**
 * `timingSafeEqual` на буферах ЗАВЕДОМО одной длины: ключ выводится длиной
 * `hash.length` из распарсенного значения, так что сравнение всегда получает
 * равные буферы и не бросает. Проверка длины перед сравнением всё равно
 * стоит (повреждённое значение, у которого парс прошёл, а длина нулевая,
 * отсеивает `parseStoredHash`) — это пояс к подтяжкам, он ничего не стоит.
 *
 * Честная граница: `timingSafeEqual` выравнивает время СРАВНЕНИЯ, и это
 * пиннится тестом только по поведению (подмена на `===` делает сравнение
 * ложным всегда — тест раунд-трипа падает). Подмену на `a.equals(b)` —
 * поведенчески идентичную, но с ранним выходом по первому расхождению —
 * никакой юнит-тест не поймает: это свойство времени, а не результата.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored)
  if (!parsed) return false
  let derived: Buffer
  try {
    derived = await deriveKey(password, parsed.salt, parsed.hash.length, parsed)
  } catch {
    return false
  }
  if (derived.length !== parsed.hash.length) return false
  return timingSafeEqual(derived, parsed.hash)
}

/**
 * Фиктивный хэш для веток «участника нет» / «пароль не задан» / «вход
 * заблокирован» в `loginWithPassword`: там всё равно выполняется
 * `verifyPassword(password, DUMMY_STORED_HASH)` — с ТЕМИ ЖЕ параметрами и
 * длинами, что у настоящего, — чтобы неизвестная почта не отвечала быстрее
 * известной на всю стоимость scrypt (пол `PASSWORD_MIN_RESPONSE_MS` в
 * действии входа такой разрыв прикрыть не мог бы, см. комментарий там).
 * Результат в этих ветках игнорируется: даже угадав пароль этой строки
 * (случайные 32 байта, выброшенные при генерации), войти нельзя.
 *
 * Константа, а не `hashPassword()` при старте модуля: генерация на импорте
 * жгла бы scrypt при каждом холодном старте, а детерминированная строка ещё
 * и позволяет тесту закрепить, что её параметры не отстали от
 * `SCRYPT_PARAMS` при их будущем подъёме.
 */
export const DUMMY_STORED_HASH =
  'scrypt:32768:8:1:C4tX-kPnRKa7EBAGEMdlhg:kbeuxvaDqqtKSnpnQKRp6Lg3kL-w2Q33O42hPqd8DPw'

/** Ради теста, который держит DUMMY_STORED_HASH в ногу с SCRYPT_PARAMS. */
export const CURRENT_SCRYPT_PARAMS = SCRYPT_PARAMS
export const CURRENT_KEY_BYTES = KEY_BYTES
export const CURRENT_SALT_BYTES = SALT_BYTES
