# Phone/Email Field Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seven contact fields of the questionnaire become typed `phone`/`email` fields with a placeholder, a client-side character filter, and a server-side format check; the two mixed fields stay free text.

**Architecture:** Two new members of the `FieldType` union in `src/form-schema/fields.ts`. Every consumer derives its behaviour from the type: `validateField` (server gate), `FieldInput` (the one input component shared by the fill form, the operator's fixes screen and the team's review editor), the dev seed, and the export round-trip test. The allowed-character rule and the format rule live once, in a new pure module `src/form-schema/contact.ts`, and both the client filter and the server validator call it. No DB change: values stay text.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, vitest (node environment — component tests use `renderToStaticMarkup`, there is no DOM library), Playwright e2e against local docker Postgres.

Spec: `docs/superpowers/specs/2026-09-04-phone-email-field-types-design.md`.

## Global Constraints

- Read `node_modules/next/dist/docs/` before touching framework code (AGENTS.md rule).
- One rule in one place: the allowed-character set and the format regexes exist only in `src/form-schema/contact.ts`; `validation.ts` and `FieldInput.tsx` import them.
- `src/form-schema/*` must stay pure: no React, no DOM, no `@/web` imports (`purity.test.ts` enforces it).
- Pure helpers never live in a `'use client'` module — `FieldInput.tsx` is `'use client'`, so the sanitizers go to `form-schema/contact.ts`, not next to `numberFieldValue`.
- Refusal texts are `Localized` (`{ en, ru }`) declared in `validation.ts` next to `REQUIRED`; the client shows what the server returned and never restates the text.
- Placeholders verbatim: phone `+90 212 000 00 00`, email `name@company.com`.
- Phone server rule: after removing spaces, `(`, `)`, `-` the value matches `^\+?\d{6,15}$`.
- Email server rule: `^[^\s@]+@[^\s@]+\.[^\s@]+$`.
- Empty value: required field → existing `REQUIRED`; optional field (`II.4.1`, `II.4.2`) → ok.
- Every test is break-verified: after it passes, flip the rule it pins, watch it fail with a message naming the case, restore. Note the observation in the commit message when it is not obvious.
- Long commands (`npm test`, playwright) run under `caffeinate -dimsu` — the laptop sleeps after one minute idle and kills runs.
- Comments explain WHY and must not assert premises the code does not check.
- Commit after every task with the project's commit style (Russian subject, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer).

## File Map

- Create `src/form-schema/contact.ts` — placeholders, `sanitizePhoneInput`, `sanitizeEmailInput`, `isValidPhone`, `isValidEmail`.
- Create `src/form-schema/__tests__/contact.test.ts` — tables of accepted/rejected inputs for the four helpers.
- Modify `src/form-schema/index.ts` — `export * from './contact'`.
- Modify `src/form-schema/fields.ts` — `FieldType` gains `'phone' | 'email'`; seven fields change `type`.
- Modify `src/form-schema/__tests__/fields.test.ts` — literal pin of the seven keys and the two mixed ones.
- Modify `src/form-schema/validation.ts` — `INVALID_PHONE`, `INVALID_EMAIL`, two `case` branches in `validateField`.
- Modify `src/form-schema/__tests__/validation.test.ts` — server-rule tests.
- Modify `src/export/__tests__/roundtrip.test.ts:78-83` — `enteredFieldValue` produces valid phone/email.
- Modify `scripts/seed-dev.ts:126-137` — drop `EMAIL_LABEL`, branch on type.
- Modify `src/web/FieldInput.tsx:165-335` — `case 'phone': case 'email':` branch.
- Create `src/web/__tests__/fieldInputContact.test.tsx` — static-markup test of attributes.
- Modify `e2e/fill.spec.ts` — one new scenario on the Contacts step.

---

### Task 1: Pure contact helpers

**Files:**
- Create: `src/form-schema/contact.ts`
- Create: `src/form-schema/__tests__/contact.test.ts`
- Modify: `src/form-schema/index.ts`

**Interfaces:**
- Produces:
  - `export const PHONE_PLACEHOLDER = '+90 212 000 00 00'`
  - `export const EMAIL_PLACEHOLDER = 'name@company.com'`
  - `export function sanitizePhoneInput(raw: string): string`
  - `export function sanitizeEmailInput(raw: string): string`
  - `export function isValidPhone(text: string): boolean`
  - `export function isValidEmail(text: string): boolean`

- [ ] **Step 1: Write the failing tests**

Create `src/form-schema/__tests__/contact.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  PHONE_PLACEHOLDER,
  EMAIL_PLACEHOLDER,
  sanitizePhoneInput,
  sanitizeEmailInput,
  isValidPhone,
  isValidEmail,
} from '../contact'

/**
 * Одно правило — одно место: и фильтр ввода в браузере, и серверная проверка
 * читают эти функции. Тесты ниже — таблицы допустимого и недопустимого; текст
 * подсказки под полем сам по себе здесь не проверяется — он в validation.test.
 */
describe('sanitizePhoneInput — что остаётся в поле при наборе и вставке', () => {
  it('пропускает + первым символом, цифры, пробелы, скобки и дефис', () => {
    expect(sanitizePhoneInput('+90 (212) 000-00-00')).toBe('+90 (212) 000-00-00')
  })

  it('буквы и прочие символы исчезают, порядок остальных не меняется', () => {
    expect(sanitizePhoneInput('ab+12 c3#4')).toBe('+12 34')
  })

  it('+ не в начале вырезается, в начале — остаётся', () => {
    expect(sanitizePhoneInput('12+34')).toBe('1234')
    expect(sanitizePhoneInput('++90')).toBe('+90')
  })

  it('пробелы перед номером не мешают + встать первым', () => {
    // Вставка « +90 …» из буфера: без этого правила пробел занял бы первое
    // место, и + пропал бы.
    expect(sanitizePhoneInput('  +90 212')).toBe('+90 212')
  })

  it('пустая строка остаётся пустой', () => {
    expect(sanitizePhoneInput('')).toBe('')
  })

  it('плейсхолдер сам проходит фильтр без изменений', () => {
    expect(sanitizePhoneInput(PHONE_PLACEHOLDER)).toBe(PHONE_PLACEHOLDER)
  })
})

describe('isValidPhone — серверное правило', () => {
  it.each([
    '+90 212 000 00 00',
    '+902120000000',
    '(0212) 000-00-00',
    '123456',
    '+123456789012345',
  ])('принимает %s', (text) => {
    expect(isValidPhone(text)).toBe(true)
  })

  it.each([
    ['12345', 'меньше 6 цифр'],
    ['+1234567890123456', 'больше 15 цифр'],
    ['12+34567', '+ не в начале'],
    ['+90 212 ABC', 'буквы'],
    ['+', 'один плюс'],
    ['', 'пусто — пустоту решает required, не формат'],
  ])('отклоняет %s (%s)', (text) => {
    expect(isValidPhone(text)).toBe(false)
  })

  it('плейсхолдер — допустимый номер', () => {
    expect(isValidPhone(PHONE_PLACEHOLDER)).toBe(true)
  })
})

describe('sanitizeEmailInput — при наборе исчезают только пробельные символы', () => {
  it('вырезает пробелы, табы и переносы, остальное не трогает', () => {
    expect(sanitizeEmailInput(' Na me@Comp any.com\n')).toBe('Name@Company.com')
  })

  it('регистр не меняется', () => {
    expect(sanitizeEmailInput('John.Doe@Example.COM')).toBe('John.Doe@Example.COM')
  })
})

describe('isValidEmail — серверное правило', () => {
  it.each(['name@company.com', 'first.last+tag@sub.domain.co', EMAIL_PLACEHOLDER])(
    'принимает %s',
    (text) => {
      expect(isValidEmail(text)).toBe(true)
    },
  )

  it.each([
    ['name@company', 'домен без точки'],
    ['name.company.com', 'нет @'],
    ['na me@company.com', 'пробел'],
    ['name@@company.com', 'две @'],
    ['@company.com', 'пусто до @'],
    ['', 'пусто'],
  ])('отклоняет %s (%s)', (text) => {
    expect(isValidEmail(text)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/form-schema/__tests__/contact.test.ts`
Expected: FAIL — `Failed to resolve import "../contact"`.

- [ ] **Step 3: Write the module**

Create `src/form-schema/contact.ts`:

```ts
/**
 * Правила контактных полей — телефона (`phone`) и почты (`email`). Живут
 * здесь, в чистой части схемы, а не в `FieldInput.tsx`, потому что их читают
 * двое: фильтр ввода в браузере (что остаётся в поле при наборе и вставке) и
 * серверная проверка в `validation.ts` (что вообще можно сохранить). Два
 * набора правил в двух модулях со временем расходятся — и тогда браузер
 * пропускает то, что сервер отвергает, или наоборот.
 *
 * Плейсхолдеры — тоже здесь: они же стоят в тексте серверного отказа
 * («…например +90 212 000 00 00»), и пример в подсказке обязан совпадать с
 * примером в поле.
 */

export const PHONE_PLACEHOLDER = '+90 212 000 00 00'
export const EMAIL_PLACEHOLDER = 'name@company.com'

/** Символы, допустимые в телефоне где угодно; `+` обрабатывается отдельно —
 *  он допустим только первым. */
const PHONE_CHAR = /[\d\s()-]/

/**
 * Что остаётся в поле телефона после набора или вставки: `+` — только первым
 * символом (ведущие пробелы не считаются — вставка « +90 …» из буфера не
 * должна терять плюс), дальше цифры, пробелы, скобки и дефис. Всё остальное
 * исчезает, порядок остального не меняется.
 */
export function sanitizePhoneInput(raw: string): string {
  let out = ''
  for (const ch of raw) {
    if (out === '' && /\s/.test(ch)) continue
    if (ch === '+') {
      if (out === '') out = '+'
      continue
    }
    if (PHONE_CHAR.test(ch)) out += ch
  }
  return out
}

/**
 * Серверное правило телефона: без разделителей (пробелы, скобки, дефис)
 * остаётся необязательный `+` и 6–15 цифр. 15 — потолок E.164; 6 — короче
 * не бывает даже у местных номеров. Пустая строка НЕ проходит: пустоту решает
 * `required` в `validateField`, а не формат.
 */
export function isValidPhone(text: string): boolean {
  return /^\+?\d{6,15}$/.test(text.replace(/[\s()-]/g, ''))
}

/** В адресе почты при наборе исчезают только пробельные символы: остальное
 *  (точки, плюсы, дефисы, регистр) в адресах законно. */
export function sanitizeEmailInput(raw: string): string {
  return raw.replace(/\s+/g, '')
}

/** Серверное правило почты: одна `@`, без пробелов, домен с точкой. Не RFC
 *  целиком — достаточно, чтобы отсечь опечатки и «напишу потом». */
export function isValidEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
}
```

Add to `src/form-schema/index.ts` after the `./render` line:

```ts
export * from './contact'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/form-schema/__tests__/contact.test.ts src/form-schema/__tests__/purity.test.ts`
Expected: PASS, both files.

- [ ] **Step 5: Break-verify**

Change `{6,15}` to `{5,15}` in `isValidPhone` → run the test → expect the `'12345'` case to fail. Restore. Change `if (out === '') out = '+'` to `out += '+'` → expect `'12+34'` case to fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/form-schema/contact.ts src/form-schema/__tests__/contact.test.ts src/form-schema/index.ts
git commit -m "feat(schema): правила контактных полей — фильтр ввода и формат телефона и почты в одном модуле

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Field types and the server gate

**Files:**
- Modify: `src/form-schema/fields.ts:4-13` (union) and the seven field entries (`II.1.2`, `II.1.3`, `II.2.1`, `II.3.2`, `II.3.3`, `II.4.1`, `II.4.2`)
- Modify: `src/form-schema/validation.ts:33-45` (messages) and `:205-238` (`validateField`)
- Modify: `src/form-schema/__tests__/fields.test.ts`
- Modify: `src/form-schema/__tests__/validation.test.ts`
- Modify: `src/export/__tests__/roundtrip.test.ts:78-83`

**Interfaces:**
- Consumes: `isValidPhone`, `isValidEmail`, `PHONE_PLACEHOLDER`, `EMAIL_PLACEHOLDER` from `./contact` (Task 1).
- Produces: `FieldType` includes `'phone' | 'email'`; `validateField` returns `INVALID_PHONE` / `INVALID_EMAIL` (`Localized`) for malformed values.

- [ ] **Step 1: Write the failing schema pin**

Append to `describe('плоские поля', …)` in `src/form-schema/__tests__/fields.test.ts`:

```ts
  /**
   * Контактные поля закреплены БУКВАЛЬНО, по ключам, а не «все поля, в чьей
   * подписи есть phone/email»: смешанные II.2.2 («name/email/phone») и II.2.3
   * («phone/email/whatsApp…») подпись такую несут, но остаются свободным
   * текстом — решение пользователя, одно правило к ним не подходит. Тест,
   * выведенный из подписей, эти два поля отнёс бы к типизированным.
   */
  it('контактные поля: пять телефонов и две почты закреплены по ключам, смешанные — text', () => {
    const typeOf = (key: string) => FIELDS.find((f) => f.key === key)!.type
    for (const key of ['II.1.2', 'II.2.1', 'II.3.2', 'II.4.1', 'II.4.2']) {
      expect(typeOf(key), key).toBe('phone')
    }
    for (const key of ['II.1.3', 'II.3.3']) expect(typeOf(key), key).toBe('email')
    for (const key of ['II.2.2', 'II.2.3']) expect(typeOf(key), key).toBe('text')
    expect(FIELDS.filter((f) => f.type === 'phone' || f.type === 'email')).toHaveLength(7)
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/form-schema/__tests__/fields.test.ts`
Expected: FAIL — `expected 'text' to be 'phone'` for `II.1.2`.

- [ ] **Step 3: Extend the union and retype the seven fields**

In `src/form-schema/fields.ts` change the union to:

```ts
export type FieldType =
  | 'text'
  | 'textarea'
  | 'date'
  | 'number'
  | 'select'
  | 'select_with_detail'
  | 'multi_select'
  | 'template'
  // Контактные поля: правила ввода и формата — `contact.ts`, проверка —
  // `validateField`, ввод — `FieldInput`. Значение в базе остаётся текстом.
  | 'phone'
  | 'email'
```

Change `type: 'text'` to `type: 'phone'` in the entries with keys `II.1.2`, `II.2.1`, `II.3.2`, `II.4.1`, `II.4.2`, and to `type: 'email'` in `II.1.3`, `II.3.3`. Leave `II.2.2`, `II.2.3`, `II.3.1` as `text`.

- [ ] **Step 4: Run typecheck to find every switch that must learn the new types**

Run: `npm run typecheck`
Expected: FAIL in `src/form-schema/validation.ts` (`assertNeverFieldType(field.type)` — argument of type `'phone' | 'email'` is not assignable to `never`). No other file fails: `FieldInput.tsx` and `seed-dev.ts` fall through to a `default` without `never`, `render.ts` only special-cases `template`. Those two get their branches in Tasks 3 and 4.

- [ ] **Step 5: Write the failing validation tests**

Add to `src/form-schema/__tests__/validation.test.ts`, next to the date test (it uses the same `field(key)` helper defined at the top of that file):

```ts
describe('контактные поля — сервер как ворота', () => {
  it('телефон: допустимый формат принимается, недопустимый — отказ с примером', () => {
    expect(validateField(field('II.1.2'), '+90 (212) 000-00-00').ok).toBe(true)
    const refused = validateField(field('II.1.2'), '+90 212 ABC')
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.error.en).toBe(
        'Enter the number in international format, e.g. +90 212 000 00 00',
      )
      expect(refused.error.ru).toBe(
        'Введите номер в международном формате, например +90 212 000 00 00',
      )
    }
  })

  it('почта: допустимый адрес принимается, без домена с точкой — отказ с примером', () => {
    expect(validateField(field('II.1.3'), 'ops@lounge.example').ok).toBe(true)
    const refused = validateField(field('II.1.3'), 'ops@lounge')
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.error.en).toBe('Enter a valid email address, e.g. name@company.com')
      expect(refused.error.ru).toBe('Введите адрес почты, например name@company.com')
    }
  })

  it('пустое значение: у обязательного — «Поле обязательно», у необязательного — допустимо', () => {
    // II.1.2 required, II.4.1 (стационарный, «если есть») — нет.
    const required = validateField(field('II.1.2'), '')
    expect(required.ok).toBe(false)
    if (!required.ok) expect(required.error.ru).toBe('Поле обязательно')
    expect(validateField(field('II.4.1'), '').ok).toBe(true)
    expect(validateField(field('II.4.1'), '   ').ok).toBe(true)
  })

  it('не-строка (произвольный JSON клиента) — отказ, не исключение', () => {
    expect(validateField(field('II.1.2'), 12345678).ok).toBe(false)
    expect(validateField(field('II.1.3'), { email: 'x@y.z' }).ok).toBe(false)
  })

  it('смешанное поле II.2.2 осталось текстом: любой непустой ввод принимается', () => {
    expect(validateField(field('II.2.2'), 'Ali, ali@x.y, +90 1').ok).toBe(true)
  })
})
```

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run src/form-schema/__tests__/validation.test.ts`
Expected: FAIL — the file does not even compile until Step 7, or the `+90 212 ABC` case is accepted (`ok: true`) because it currently hits the `text` branch.

- [ ] **Step 7: Add messages and branches to `validation.ts`**

Add the import at the top of `src/form-schema/validation.ts`:

```ts
import { EMAIL_PLACEHOLDER, PHONE_PLACEHOLDER, isValidEmail, isValidPhone } from './contact'
```

After `NOT_A_NUMBER` add:

```ts
// Пример в отказе — тот же плейсхолдер, что стоит в поле (`contact.ts`):
// подсказка и пример под полем не могут разойтись.
const INVALID_PHONE = fail(
  `Enter the number in international format, e.g. ${PHONE_PLACEHOLDER}`,
  `Введите номер в международном формате, например ${PHONE_PLACEHOLDER}`,
)
const INVALID_EMAIL = fail(
  `Enter a valid email address, e.g. ${EMAIL_PLACEHOLDER}`,
  `Введите адрес почты, например ${EMAIL_PLACEHOLDER}`,
)
```

In `validateField`, before `case 'text':` add:

```ts
    // Пустота — вопрос `required`, формат — вопрос `contact.ts`; не-строка
    // (`asText` → null) — отказ формата, как у даты, а не исключение.
    case 'phone': {
      const text = asText(value) ?? ''
      if (text === '') return field.required ? REQUIRED : ok
      return isValidPhone(text) ? ok : INVALID_PHONE
    }

    case 'email': {
      const text = asText(value) ?? ''
      if (text === '') return field.required ? REQUIRED : ok
      return isValidEmail(text) ? ok : INVALID_EMAIL
    }
```

- [ ] **Step 8: Teach the export round-trip generator the new types**

In `src/export/__tests__/roundtrip.test.ts`, `enteredFieldValue`, add before `case 'date':`:

```ts
    // Контактные поля проходят валидацию только в своём формате; ключ поля
    // всё равно должен читаться из значения, чтобы ячейка, уехавшая в чужую
    // колонку, не совпала со «своим» значением случайно.
    case 'phone':
      return `+90 212 ${String(100 + position).padStart(3, '0')} 00 00`
    case 'email':
      return `answer-${field.key.toLowerCase().replaceAll('.', '-')}@example.com`
```

- [ ] **Step 9: Run the suites and typecheck**

Run: `npm run typecheck && npx vitest run src/form-schema src/export`
Expected: typecheck clean; all tests PASS (fields pin, validation, roundtrip).

- [ ] **Step 10: Break-verify**

In `validateField` swap `INVALID_PHONE` for `ok` in the `phone` branch → validation test fails on `+90 212 ABC`. Restore. Change `II.4.2` back to `'text'` → fields pin fails naming `II.4.2`. Restore.

- [ ] **Step 11: Commit**

```bash
git add src/form-schema/fields.ts src/form-schema/validation.ts src/form-schema/__tests__/fields.test.ts src/form-schema/__tests__/validation.test.ts src/export/__tests__/roundtrip.test.ts
git commit -m "feat(schema): типы поля phone и email — семь контактных полей, серверный отказ с примером

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Seed follows the field type

**Files:**
- Modify: `scripts/seed-dev.ts:126-137`

**Interfaces:**
- Consumes: `FieldType` `'phone' | 'email'` (Task 2); `PHONE_PLACEHOLDER` from `../src/form-schema` (Task 1); existing `seedEmailFor` from `./dev-support`.

- [ ] **Step 1: Confirm the seed currently throws on the new types**

Run: `npm run seed`
Expected: process exits with `seed-dev: неизвестный тип поля phone` (the `default` branch of `valueForField`). This is the failing state the task fixes.

- [ ] **Step 2: Replace the label regex with type branches**

Delete the `EMAIL_LABEL` constant and its doc comment (`scripts/seed-dev.ts:~120-127`). Change the `text`/`textarea` case and add two cases:

```ts
    case 'text':
    case 'textarea':
      return `Test value ${field.key}`

    // Контактные поля отвечают в своём формате — иначе `saveFieldValue`
    // откажет, и сид упадёт. Почта — через `seedEmailFor`: e2e ждёт именно
    // этот адрес в уведомлении «Ссылка отправлена на …» (II.1.3). Раньше
    // почту угадывал регэксп по подписи поля; теперь тип поля говорит сам.
    case 'phone':
      return PHONE_PLACEHOLDER
    case 'email':
      return seedEmailFor(field.key)
```

Add `PHONE_PLACEHOLDER` to the existing `import { … } from '../src/form-schema'` list.

- [ ] **Step 3: Run the seed in every mode**

Run:
```bash
npm run seed && npm run seed -- --complete && npm run seed -- --submitted && npm run seed -- --changes-requested
```
Expected: each prints a fill URL and exits 0. (Docker Postgres must be up: `docker compose up -d`.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/seed-dev.ts
git commit -m "chore(seed): контактные поля заполняются по типу, а не по регэкспу подписи

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: The input — placeholder, keyboard, character filter

**Files:**
- Modify: `src/web/FieldInput.tsx:3-4` (imports) and `:165-335` (switch)
- Create: `src/web/__tests__/fieldInputContact.test.tsx`

**Interfaces:**
- Consumes: `sanitizePhoneInput`, `sanitizeEmailInput`, `PHONE_PLACEHOLDER`, `EMAIL_PLACEHOLDER` from `@/form-schema` (Task 1); `FieldType` `'phone' | 'email'` (Task 2).

- [ ] **Step 1: Write the failing markup test**

Create `src/web/__tests__/fieldInputContact.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { fieldByKey, PHONE_PLACEHOLDER, EMAIL_PLACEHOLDER } from '@/form-schema'
import { LocaleProvider } from '@/i18n/context'
import { FieldInput } from '../FieldInput'

/**
 * Контактное поле в том виде, в каком его видит оператор: тип инпута даёт
 * телефонную/почтовую клавиатуру на мобильном, плейсхолдер подсказывает
 * формат, `autocomplete` подставляет свои данные. Среда node, DOM нет —
 * рендер `renderToStaticMarkup`, как в fieldInputLocked.test.tsx; фильтр
 * символов при наборе (onChange) закреплён на чистых функциях в
 * form-schema/__tests__/contact.test.ts — здесь проверяется, что инпут их
 * ВЫЗЫВАЕТ, через сам факт нужного типа поля (ветка одна на оба атрибута).
 */
function render(key: string, value: unknown = ''): string {
  return renderToStaticMarkup(
    <LocaleProvider initial="en">
      <FieldInput field={fieldByKey(key)!} value={value} onChange={() => {}} />
    </LocaleProvider>,
  )
}

describe('FieldInput: контактные поля', () => {
  it('телефон — type=tel, inputmode=tel, autocomplete=tel и плейсхолдер-пример', () => {
    const html = render('II.1.2')
    expect(html).toContain('type="tel"')
    expect(html).toContain('inputmode="tel"')
    expect(html).toContain('autocomplete="tel"')
    expect(html).toContain(`placeholder="${PHONE_PLACEHOLDER}"`)
  })

  it('почта — type=email, inputmode=email, autocomplete=email и плейсхолдер-пример', () => {
    const html = render('II.1.3')
    expect(html).toContain('type="email"')
    expect(html).toContain('inputmode="email"')
    expect(html).toContain('autocomplete="email"')
    expect(html).toContain(`placeholder="${EMAIL_PLACEHOLDER}"`)
  })

  it('смешанное поле II.2.2 осталось обычным текстом без плейсхолдера', () => {
    const html = render('II.2.2')
    expect(html).toContain('type="text"')
    expect(html).not.toContain('placeholder=')
  })

  it('уже сохранённое значение показывается как есть, даже если под новые правила не подходит', () => {
    // Старые ответы не переписываются; править их можно только на допустимое.
    expect(render('II.1.2', 'call reception')).toContain('value="call reception"')
  })

  it('отказ сервера рисуется под полем тем же .fix-comment, что у остальных', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider initial="en">
        <FieldInput
          field={fieldByKey('II.1.3')!}
          value="ops@lounge"
          onChange={() => {}}
          error="Enter a valid email address, e.g. name@company.com"
        />
      </LocaleProvider>,
    )
    expect(html).toContain('class="fix-comment"')
    expect(html).toContain('Enter a valid email address')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/web/__tests__/fieldInputContact.test.tsx`
Expected: FAIL — `type="tel"` not found (the default branch renders `type="text"`).

- [ ] **Step 3: Add the branch to `FieldInput`**

Change the import at `src/web/FieldInput.tsx:4` to:

```ts
import {
  OPTION_LISTS,
  needsDetail,
  PHONE_PLACEHOLDER,
  EMAIL_PLACEHOLDER,
  sanitizePhoneInput,
  sanitizeEmailInput,
} from '@/form-schema'
```

In the `switch (field.type)` add before `case 'textarea':`:

```tsx
    // Контактные поля: тип инпута даёт нужную клавиатуру на мобильном,
    // плейсхолдер — пример формата (тот же, что в тексте серверного отказа,
    // см. `contact.ts`), а onChange пропускает через фильтр символов — буква в
    // телефоне не появляется, пробел в почте тоже. Фильтр — подсказка, а не
    // ворота: сохранить всё равно можно только то, что примет `validateField`.
    // `field.example` здесь не рисуется: пример уже в плейсхолдере.
    case 'phone':
    case 'email': {
      const phone = field.type === 'phone'
      const sanitize = phone ? sanitizePhoneInput : sanitizeEmailInput
      return (
        <div className="field">
          {label}
          {hint}
          <input
            id={field.key}
            type={phone ? 'tel' : 'email'}
            inputMode={phone ? 'tel' : 'email'}
            autoComplete={phone ? 'tel' : 'email'}
            placeholder={phone ? PHONE_PLACEHOLDER : EMAIL_PLACEHOLDER}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(sanitize(e.target.value))}
          />
          {errorNode}
        </div>
      )
    }
```

- [ ] **Step 4: Run the web suites and typecheck**

Run: `npm run typecheck && npx vitest run src/web`
Expected: clean; all PASS (including `fieldInputLocked`, `fixesOnly`, `stepFields` — none of them pin `type="text"` on a contact field; if one does, read its intent before touching it and update the pin, naming the reason in the commit).

- [ ] **Step 5: Break-verify**

Swap `phone ? 'tel' : 'email'` for `'text'` in `type=` → the first two tests fail. Restore.

- [ ] **Step 6: Check placeholder colour in both themes**

Run: `grep -n "placeholder" src/app/globals.css`. If there is no `::placeholder` rule, add one next to the `.field input` rules, with a dark-mode counterpart in the existing dark block (house rule: every colour has a dark pair):

```css
.field input::placeholder { color: var(--muted); opacity: 1; }
```

(Use the muted text token already defined in `globals.css`; if it is named differently, use that name — do not invent a new colour.) If a rule exists, leave it.

- [ ] **Step 7: Commit**

```bash
git add src/web/FieldInput.tsx src/web/__tests__/fieldInputContact.test.tsx src/app/globals.css
git commit -m "feat(fill): поля телефона и почты — клавиатура, плейсхолдер-пример, фильтр символов при наборе

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: End-to-end — the operator types garbage and gets guided

**Files:**
- Modify: `e2e/fill.spec.ts` (add one test after the Critical 2 test, ~line 372)

**Interfaces:**
- Consumes: `seed()`, `clickNext()` helpers already in the file; the Contacts step is step 2 (`clickNext(page, 1)`); server messages from Task 2; `autosave` header text `Some answers were not accepted` and `Saved` from the existing UI.

- [ ] **Step 1: Write the scenario**

```ts
/**
 * Контактные поля (spec 2026-09-04): фильтр при наборе — подсказка, отказ
 * сервера — ворота, и оба видны оператору. Телефон: буквы не появляются,
 * `+` не в начале исчезает. Почта: адрес без домена с точкой ДОХОДИТ до
 * сервера (фильтр пропускает всё, кроме пробелов) и возвращается отказом под
 * полем; исправление снимает отказ и даёт «Saved». Реальный путь целиком —
 * автосохранение с задержкой 600 мс, ответ сервера, перерисовка.
 */
test('контактные поля: телефон отфильтрован при наборе, почта без домена отвергнута сервером с примером', async ({ page }) => {
  const url = seed()
  await page.goto(url)

  await clickNext(page)
  await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible()

  const phone = page.getByLabel(/Contact Number - Lounge Operations Manager/)
  // pressSequentially — посимвольно, как набирает человек: fill() подставил бы
  // строку одним событием и проверил бы только вставку.
  await phone.click()
  await phone.pressSequentially('ab+90 (212)x 00+0-00-00')
  await expect(phone).toHaveValue('+90 (212) 000-00-00')
  await expect(page.getByText('Saved')).toBeVisible()
  await expect(phone).toHaveAttribute('placeholder', '+90 212 000 00 00')

  const email = page.getByLabel(/Email Address - Lounge Operations Manager/)
  await email.fill('ops@lounge')
  await expect(page.getByText('Some answers were not accepted')).toBeVisible()
  await expect(
    page.getByText('Enter a valid email address, e.g. name@company.com'),
  ).toBeVisible()
  await expect(page.getByText('Saved')).toHaveCount(0)

  // Пробел при наборе не появляется — фильтр почты.
  await email.pressSequentially(' .example')
  await expect(email).toHaveValue('ops@lounge.example')
  await expect(page.getByText('Saved')).toBeVisible()
  await expect(page.getByText('Enter a valid email address')).toHaveCount(0)
  await expect(page.getByText('Some answers were not accepted')).toHaveCount(0)

  // Перечитываем с сервера: сохранилось исправленное, а не отвергнутое.
  await page.reload()
  await clickNext(page)
  await expect(page.getByLabel(/Email Address - Lounge Operations Manager/)).toHaveValue(
    'ops@lounge.example',
  )
  await expect(page.getByLabel(/Contact Number - Lounge Operations Manager/)).toHaveValue(
    '+90 (212) 000-00-00',
  )
})
```

Note on the phone sequence: `a`,`b` dropped; `+` first → kept; `90 (212)` kept; `x` dropped; ` 00` kept; second `+` dropped; `0-00-00` kept → `+90 (212) 000-00-00`. If the seed pre-fills the phone (draft seed does not fill block II — check `npm run seed` output form is empty on Contacts; if it is pre-filled, `await phone.clear()` first).

- [ ] **Step 2: Run the single test**

Run: `caffeinate -dimsu npx playwright test e2e/fill.spec.ts -g "контактные поля"`
Expected: PASS. If the `Saved` assertion after the phone races with the email refusal (both on one step), keep them in this order — the phone save completes before the email is typed because `toBeVisible('Saved')` waits for it.

- [ ] **Step 3: Break-verify**

Temporarily change `isValidEmail` to `return true` → run the test → expect it to fail at `Some answers were not accepted`. Restore.

- [ ] **Step 4: Run the full e2e suite**

Run: `caffeinate -dimsu npx playwright test`
Expected: all PASS (38 tests). Known flake: `review.spec.ts` «правка из устаревшей вкладки» failed once under load in a previous run and passed on rerun; if it fails alone, rerun once before investigating.

- [ ] **Step 5: Commit**

```bash
git add e2e/fill.spec.ts
git commit -m "test(e2e): контактные поля — фильтр телефона при наборе, отказ сервера по почте с примером, исправление снимает отказ

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Gates, browser check, hand-off

**Files:**
- none new; verification only

- [ ] **Step 1: Four gates, one at a time, dev server stopped**

```bash
npm run typecheck
caffeinate -dimsu npx vitest run
caffeinate -dimsu npm run build
caffeinate -dimsu npx playwright test
```
Expected: all green. Record counts.

- [ ] **Step 2: Browser check (Browser pane, `next-dev` from `.claude/launch.json`)**

1. `npm run seed` → open the fill URL → step 2 «Contacts». Confirm: grey placeholders in the phone and email fields; typing letters into the phone does nothing; typing a space into the email does nothing; `ops@lounge` shows the red refusal under the field; `ops@lounge.example` clears it and shows «Saved».
2. Mobile 375 px: the same, and the on-screen keyboard type is not testable here — just confirm layout.
3. Dark theme: placeholder legible, refusal red pair visible.
4. `npm run seed -- --submitted` → log in as `reviewer@easyto.travel` (`npx tsx scripts/dev-login-link.ts reviewer@easyto.travel`) → open the submission → block «Primary Operational Contact» → pencil on the email row → editor shows the same placeholder; save `bad@address` → refusal inside the editor, draft kept; save a valid address → row updates.
5. Stop the dev server.

- [ ] **Step 3: Hand-off**

Report: gate counts, browser observations, any pins changed. Then present the finishing menu (1 merge locally / 2 PR / 3 keep) and WAIT for the answer — never merge or push without it (user's explicit instruction of 2026-09-03).

---

## Self-review

- **Spec coverage.** Seven typed fields, two mixed left as text → Task 2. Allowed characters and paste behaviour → Task 1 + Task 4. Server rules and both refusal texts → Task 2. Empty required/optional → Task 2. Placeholders, `inputMode`, `type`, `autoComplete` → Task 4. `example` not rendered for these fields → Task 4 branch omits it. Fill form / fixes screen / review editor share `FieldInput` → Task 4 covers all three; review editor exercised in Task 6 browser check. Old values shown as-is → Task 4 test. Seed by type → Task 3. Roundtrip export test → Task 2 Step 8. e2e scenario → Task 5. No DB change → no task, by design.
- **Placeholders scan.** None.
- **Type consistency.** `sanitizePhoneInput`, `sanitizeEmailInput`, `isValidPhone`, `isValidEmail`, `PHONE_PLACEHOLDER`, `EMAIL_PLACEHOLDER` are named identically in Tasks 1, 2, 3, 4. `INVALID_PHONE` / `INVALID_EMAIL` used only inside `validation.ts`.
