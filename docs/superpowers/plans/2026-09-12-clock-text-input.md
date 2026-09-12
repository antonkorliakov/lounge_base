# Clock Text Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the browser `<input type="time">` in every schedule range («from … to …») with a plain text field masked as `HH:MM`, so the operator can paste a time, select all and retype, while the stored model, server gate and week rules stay untouched.

**Architecture:** Three pure functions in a new module `src/form-schema/clockInput.ts` decide what a keystroke or paste leaves in the field (`sanitizeClockInput`), whether the text is a valid boundary and what goes into the `Range` (`parseClockInput` — `'24:00'` in «to» becomes the editor's existing `'00:00'` end-of-day representation), and how an unfinished entry is completed on blur (`completeClockInput`). A new client component `src/web/ClockInput.tsx` holds the typed text locally, commits only valid values, and is dropped into `RangeEditor` where `<input type="time">` was — all three schedule fields (operating hours, peak hours, cleaning) share it.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, vitest (node env — component tests use `renderToStaticMarkup`, no DOM library), Playwright e2e against local docker Postgres.

Spec: `docs/superpowers/specs/2026-09-12-clock-text-input-design.md`.

## Global Constraints

- Read `node_modules/next/dist/docs/` before touching framework code (AGENTS.md rule).
- One rule in one place: what stays in the field, what counts as a time, what blur completes — only in `src/form-schema/clockInput.ts`. The component calls them; nothing else re-implements a regex.
- `src/form-schema/*` stays pure (no React/DOM/`@/web`); `purity.test.ts` enforces it. Pure helpers never live in a `'use client'` module.
- Storage and the server gate do NOT change: `Window`, `WeekHours`, `END_OF_DAY = '24:00'`, `isClock`, `clockMinutes`, `rangeToWindow`, `windowToRange` stay as they are. The «00:00 typed as an end = end of the day» rule remains theirs; `parseClockInput` only maps a typed `'24:00'` onto that same `'00:00'`.
- The `Range` the component writes is exactly what `RangeEditor` writes today: `from` is `''` when unset, `to` is `null` when unset; otherwise a `HH:MM` string.
- Every colour has a dark pair in the `@media (prefers-color-scheme: dark)` block of `src/app/globals.css`.
- Dictionary key added: `'schedule.clockPlaceholder': { en: 'HH:MM', ru: 'ЧЧ:ММ' }`. No other text changes.
- Comments explain WHY and never assert premises the code does not check. Every test break-verified (comment out the branch it pins, watch it fail, restore). Long commands under `caffeinate -dimsu` (laptop sleeps after one minute). Commit per task, Russian subject, trailer EXACTLY `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` verbatim.
- Never merge or push without Anton's explicit answer to the finishing menu.

## File Map

| File | Responsibility |
|---|---|
| `src/form-schema/clockInput.ts` (create) | `ClockBound`, `sanitizeClockInput`, `parseClockInput`, `completeClockInput` — the only rules about typing a time |
| `src/form-schema/index.ts` (modify) | `export * from './clockInput'` |
| `src/form-schema/__tests__/clockInput.test.ts` (create) | tables of allowed / refused input |
| `src/web/ClockInput.tsx` (create) | the masked text field: local text, commit valid values, complete on blur, `aria-invalid` |
| `src/web/RangeEditor.tsx` (modify) | render `ClockInput` instead of `<input type="time">`; nothing else |
| `src/i18n/dictionaries.ts` (modify) | `schedule.clockPlaceholder` |
| `src/app/globals.css` (modify) | `.hr-clock` replaces `.hr-range input[type='time']`; invalid border, light + dark |
| `src/web/__tests__/scheduleEditors.test.tsx` (modify) | `RangeEditor` markup: text/numeric/placeholder, no `aria-invalid` on valid values |
| `src/web/__tests__/hoursRulesEditor.test.tsx` (modify) | the «marker has no time field» assertion switches from `type="time"` to `hr-clock` |
| `e2e/fill.spec.ts` (modify) | locators by label; paste / select-all / blur-completion / invalid scenario; cleaning `24:00` |

---

### Task 1: Pure rules — `clockInput.ts`

**Files:**
- Create: `src/form-schema/clockInput.ts`
- Modify: `src/form-schema/index.ts` (add one export line after `export * from './contact'`)
- Test: `src/form-schema/__tests__/clockInput.test.ts`

**Interfaces:**
- Consumes: `isClock(value: unknown): value is string` and `END_OF_DAY = '24:00'` from `./schedule`.
- Produces (used by Task 2):
  - `export type ClockBound = 'from' | 'to'`
  - `export function sanitizeClockInput(raw: string): string`
  - `export function parseClockInput(text: string, bound: ClockBound): string | null`
  - `export function completeClockInput(text: string): string`

- [ ] **Step 1: Write the failing tests**

Create `src/form-schema/__tests__/clockInput.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { sanitizeClockInput, parseClockInput, completeClockInput } from '../clockInput'

/**
 * Одно правило — одно место: фильтр набора, «годится ли как граница» и
 * достраивание на blur читают только эти функции; `ClockInput` их вызывает,
 * а сам ничего про формат не знает. Ниже — таблицы допустимого и
 * недопустимого. Сервер здесь не при чём: он и так пускает только `isClock`.
 */
describe('sanitizeClockInput — что остаётся в поле при наборе', () => {
  it('набор по одной цифре: двоеточие встаёт само после второй', () => {
    expect(sanitizeClockInput('0')).toBe('0')
    expect(sanitizeClockInput('09')).toBe('09')
    expect(sanitizeClockInput('093')).toBe('09:3')
    expect(sanitizeClockInput('0930')).toBe('09:30')
  })

  it('больше четырёх цифр не бывает', () => {
    expect(sanitizeClockInput('093015')).toBe('09:30')
  })

  it('набранный оператором разделитель не пропадает: «9:» → «09:», а следующая цифра идёт в минуты', () => {
    expect(sanitizeClockInput('9:')).toBe('09:')
    expect(sanitizeClockInput('9:0')).toBe('09:0')
    expect(sanitizeClockInput('09:')).toBe('09:')
  })

  it('стирание минут оставляет часы без хвоста', () => {
    // «09:3» → backspace → браузер отдаёт «09:» → мы оставляем «09:»;
    // ещё backspace → «09» → «09». Двоеточие не возвращается насильно.
    expect(sanitizeClockInput('09')).toBe('09')
  })
})

describe('sanitizeClockInput — что остаётся после вставки', () => {
  it.each([
    ['9:00', '09:00'],
    ['9.00', '09:00'],
    ['9 00', '09:00'],
    ['09:00', '09:00'],
    ['0900', '09:00'],
    ['9:3', '09:3'],
    ['123:45', '23:45'],
    [' 21:00 ', '21:00'],
  ])('%s → %s', (raw, expected) => {
    expect(sanitizeClockInput(raw)).toBe(expected)
  })

  it('без единой цифры — пусто', () => {
    expect(sanitizeClockInput('abc')).toBe('')
    expect(sanitizeClockInput('')).toBe('')
    expect(sanitizeClockInput(':')).toBe('')
  })

  it('диапазон не проверяет: «99:99» остаётся в поле (подсветит parse)', () => {
    expect(sanitizeClockInput('99:99')).toBe('99:99')
  })
})

describe('parseClockInput — годится ли набранное как граница', () => {
  it('полное время часов 00–23 проходит в обоих полях как есть', () => {
    expect(parseClockInput('09:30', 'from')).toBe('09:30')
    expect(parseClockInput('09:30', 'to')).toBe('09:30')
    expect(parseClockInput('00:00', 'from')).toBe('00:00')
    expect(parseClockInput('00:00', 'to')).toBe('00:00')
    expect(parseClockInput('23:59', 'to')).toBe('23:59')
  })

  it('пусто — null', () => {
    expect(parseClockInput('', 'from')).toBeNull()
    expect(parseClockInput('', 'to')).toBeNull()
  })

  it.each(['9', '09', '09:', '09:3', '25:00', '09:60', '99:99', 'ab'])('обрезок или мусор «%s» — null', (text) => {
    expect(parseClockInput(text, 'from')).toBeNull()
    expect(parseClockInput(text, 'to')).toBeNull()
  })

  // Конец суток: в `Range` он живёт как «00:00 в поле "до"» (правило I1,
  // `rangeToWindow`), а не как буквальное `END_OF_DAY`. Набранное «24:00»
  // переводится в то же представление — итог и подпись «до конца дня»
  // одинаковы для обоих написаний. Началом интервала конец суток быть не может.
  it('«24:00» в «до» — это «00:00»; в «с» — отказ', () => {
    expect(parseClockInput('24:00', 'to')).toBe('00:00')
    expect(parseClockInput('24:00', 'from')).toBeNull()
  })

  it('«24:30» — не конец суток и не время', () => {
    expect(parseClockInput('24:30', 'to')).toBeNull()
  })
})

describe('completeClockInput — что достраивается на blur', () => {
  it.each([
    ['9', '09:00'],
    ['09', '09:00'],
    ['09:', '09:00'],
    ['0', '00:00'],
  ])('«%s» → «%s»', (text, expected) => {
    expect(completeClockInput(text)).toBe(expected)
  })

  it.each(['', '09:3', '09:30', '25', '99:99', '24:00'])('«%s» остаётся как есть', (text) => {
    expect(completeClockInput(text)).toBe(text)
  })
})
```

Note on `'25' → stays`: a two-digit entry is completed only when it can be hours (`00`–`23`); `completeClockInput('25')` must return `'25'` unchanged so the field shows the operator's own garbage, not a guessed `'25:00'`. The `'0' → '00:00'` row is deliberate: a single digit is an hour.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/form-schema/__tests__/clockInput.test.ts`
Expected: FAIL — `Cannot find module '../clockInput'`.

- [ ] **Step 3: Write the module**

Create `src/form-schema/clockInput.ts`:

```ts
import { END_OF_DAY, isClock } from './schedule'

/** Какую границу набирают: конец суток («24:00») законен только у «до». */
export type ClockBound = 'from' | 'to'

/**
 * Что остаётся в поле после набора или вставки. Правило одно на клавишу и на
 * буфер: цифры и не больше четырёх, двоеточие ставим сами после первых двух.
 *
 * Разделитель, который оператор набрал сам («9:»), — сигнал «часы закончены»:
 * первая группа дополняется нулём до двух знаков, дальше идут минуты. Без
 * этого набранное двоеточие пропадало бы, и следующая цифра приклеивалась к
 * часам («9:» + «0» → «90»). Лишние знаки часов срезаются слева («123:45» →
 * «23:45»): при вставке чаще лишний ведущий символ, чем лишний последний.
 *
 * Диапазон здесь не проверяется — «99:99» остаётся в поле, чтобы оператор
 * видел, что набрал; годность решает `parseClockInput`.
 */
export function sanitizeClockInput(raw: string): string {
  const groups = raw.split(/\D+/).filter((g) => g !== '')
  if (groups.length === 0) return ''
  const hoursDone = groups.length >= 2 || /\d\D/.test(raw)
  if (hoursDone) {
    const hours = groups[0].padStart(2, '0').slice(-2)
    const minutes = (groups[1] ?? '').slice(0, 2)
    return `${hours}:${minutes}`
  }
  const digits = groups[0].slice(0, 4)
  return digits.length <= 2 ? digits : `${digits.slice(0, 2)}:${digits.slice(2)}`
}

/**
 * Годится ли набранное как граница и в каком виде оно идёт в `Range`.
 * Пусто и обрезки — `null` (границы нет; `RangeEditor` пишет `''` для «с» и
 * `null` для «до», как и раньше).
 *
 * «24:00» переводится в «00:00» — представление конца суток, которое `Range`
 * уже использует (правило I1: `rangeToWindow` делает из «00:00 в "до"»
 * `END_OF_DAY`). Так оба написания дают один итог и одну подпись «до конца
 * дня», а правило «что значит конец» остаётся в `rangeToWindow`, не здесь.
 * Началом интервала конец суток быть не может — для «с» это отказ.
 */
export function parseClockInput(text: string, bound: ClockBound): string | null {
  if (text === '') return null
  if (text === END_OF_DAY) return bound === 'to' ? '00:00' : null
  return isClock(text) ? text : null
}

/**
 * Что достраивать при уходе из поля: только часы без минут («9», «09»,
 * «09:») → «09:00», и только если это часы (00–23). Всё остальное — как есть:
 * «09:3» может значить и 09:03, и 09:30, а «25» — не время; догадка здесь
 * была бы ложью в данных.
 */
export function completeClockInput(text: string): string {
  const match = /^(\d{1,2}):?$/.exec(text)
  if (!match) return text
  const hours = match[1].padStart(2, '0')
  return Number(hours) <= 23 ? `${hours}:00` : text
}
```

Add to `src/form-schema/index.ts`, after the `./contact` line:

```ts
export * from './clockInput'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/form-schema/__tests__/clockInput.test.ts src/form-schema/__tests__/purity.test.ts`
Expected: PASS, all tests (purity confirms the module imports nothing forbidden).

- [ ] **Step 5: Break-verify**

Temporarily change `const hoursDone = groups.length >= 2 || /\d\D/.test(raw)` to `const hoursDone = groups.length >= 2` → the «9:» test must fail. Restore. Temporarily make `parseClockInput` return `text` for `END_OF_DAY` regardless of bound → the «24:00 в "с"» test must fail. Restore. Run the file again: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/form-schema/clockInput.ts src/form-schema/index.ts src/form-schema/__tests__/clockInput.test.ts
git commit -m "feat(schema): правила набора времени — что остаётся в поле, что годится как граница, что достраивать на blur

Новый чистый модуль clockInput.ts: sanitizeClockInput (цифры, не больше четырёх,
двоеточие само; набранный разделитель уважается), parseClockInput («24:00» в «до»
→ «00:00», представление конца суток из правила I1), completeClockInput («9» →
«09:00»). Сервер и хранение не меняются: isClock остаётся воротами.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `ClockInput` component, `RangeEditor` wiring, styles, dictionary

**Files:**
- Create: `src/web/ClockInput.tsx`
- Modify: `src/web/RangeEditor.tsx` (the `bound` helper — replace the `<input type="time">` element; update the doc comment's first sentence)
- Modify: `src/i18n/dictionaries.ts` (add one key next to `'schedule.to'`)
- Modify: `src/app/globals.css` (line `.hr-range input[type='time'] {…}` and the dark block near `.hr-link { color: #7ab3ff; }`)
- Test: `src/web/__tests__/scheduleEditors.test.tsx` (add a `describe('RangeEditor')`), `src/web/__tests__/hoursRulesEditor.test.tsx` (one assertion)

**Interfaces:**
- Consumes from Task 1: `sanitizeClockInput`, `parseClockInput`, `completeClockInput`, `ClockBound` via `@/form-schema`.
- Produces: `ClockInput` props `{ value: string; bound: ClockBound; onCommit: (value: string | null) => void; id: string; label: string; placeholder: string; inputRef?: React.Ref<HTMLInputElement> }`; input carries `className="hr-clock"`, `type="text"`, `inputMode="numeric"`, `autoComplete="off"`, `maxLength={5}`, `aria-invalid="true"` only when text is non-empty and unparsable.

- [ ] **Step 1: Write the failing tests**

Append to `src/web/__tests__/scheduleEditors.test.tsx` (add `RangeEditor` and `UI` imports at the top if missing — `UI` is already imported; add `import { RangeEditor } from '../RangeEditor'` and `import { fieldByKey, type HoursOptions } from '@/form-schema'`, merging with the existing `fieldByKey` import):

```tsx
/**
 * Поле времени — текстовое с маской, не `<input type="time">`: у браузерного
 * контрола нельзя ни вставить «09:00», ни выделить всё (Anton, 2026-09-12).
 * Здесь — разметка, которую видит оператор; поведение набора закреплено на
 * чистых функциях (`clockInput.test.ts`) и сквозным сценарием
 * (`e2e/fill.spec.ts`). Атрибуты проверяются в JSX-регистре
 * (`inputMode`, `autoComplete`), как в fieldInputContact.test.tsx — так их
 * отдаёт установленный react-dom/server.
 */
const OPEN: HoursOptions = { allDay: true, flightBounds: true }

function renderRange(range: { from: string; to: string | null }): string {
  return renderToStaticMarkup(
    <LocaleProvider initial="en">
      <RangeEditor id="r" range={range} options={OPEN} onChange={() => {}} />
    </LocaleProvider>,
  )
}

describe('RangeEditor: поле времени', () => {
  it('текстовое, с цифровой клавиатурой, без автозаполнения, с подсказкой формата', () => {
    const html = renderRange({ from: '', to: null })
    expect(html).not.toContain('type="time"')
    expect(html.match(/type="text"/g)).toHaveLength(2)
    expect(html.match(/inputMode="numeric"/g)).toHaveLength(2)
    expect(html.match(/autoComplete="off"/g)).toHaveLength(2)
    expect(html.match(/maxLength="5"/g)).toHaveLength(2)
    expect(html.match(new RegExp(`placeholder="${UI['schedule.clockPlaceholder'].en}"`, 'g'))).toHaveLength(2)
    expect(html.match(/class="hr-clock"/g)).toHaveLength(2)
  })

  it('заданное время показано как есть и не подсвечено', () => {
    const html = renderRange({ from: '09:00', to: '00:00' })
    expect(html).toContain('value="09:00"')
    expect(html).toContain('value="00:00"')
    expect(html).not.toContain('aria-invalid')
  })

  it('пустое поле не подсвечено: пусто — это «ещё не ответил», не ошибка', () => {
    expect(renderRange({ from: '', to: null })).not.toContain('aria-invalid')
  })
})
```

In `src/web/__tests__/hoursRulesEditor.test.tsx`, in the test «маркер показан словами с возвратом к времени, без поля времени», replace

```ts
    expect(html).not.toContain('type="time"')
```

with

```ts
    expect(html).not.toContain('class="hr-clock"')
```

(`type="time"` no longer exists anywhere, so the old assertion would pass vacuously.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/web/__tests__/scheduleEditors.test.tsx src/web/__tests__/hoursRulesEditor.test.tsx`
Expected: the three new `RangeEditor` tests FAIL (`type="text"` count 0, `UI['schedule.clockPlaceholder']` undefined); the changed hoursRulesEditor assertion PASSES already (vacuous until Task 2 lands — that is fine, it becomes meaningful in Step 4).

- [ ] **Step 3: Dictionary key**

In `src/i18n/dictionaries.ts`, directly after `'schedule.to': { en: 'To', ru: 'До' },` add:

```ts
  // Подсказка формата в поле времени: текстовое поле с маской (Anton,
  // 2026-09-12: у <input type="time"> нельзя ни вставить, ни выделить всё).
  'schedule.clockPlaceholder': { en: 'HH:MM', ru: 'ЧЧ:ММ' },
```

- [ ] **Step 4: Write the component**

Create `src/web/ClockInput.tsx`:

```tsx
'use client'

import { useEffect, useRef, useState, type JSX, type Ref } from 'react'
import { completeClockInput, parseClockInput, sanitizeClockInput, type ClockBound } from '@/form-schema'

/**
 * Текстовое поле времени с маской «ЧЧ:ММ». Заменяет `<input type="time">`:
 * у браузерного контрола часы и минуты — отдельные сегменты, в него нельзя
 * ни вставить «09:00» из буфера, ни выделить всё и перепечатать (Anton,
 * 2026-09-12). Правил формата здесь нет — они в `clockInput.ts`; компонент
 * решает только, когда что показывать и когда отдавать наверх.
 *
 * Текст живёт локально, в `Range` уходит только годное время (или `null`,
 * если границы пока нет): итог недели и подсказка «укажите время» видят то
 * же, что оператор. Пропс `value` переписывает текст только вне фокуса —
 * иначе снятие границы (`null` при неполном тексте) стирало бы то, что
 * оператор набирает. На blur обрезок достраивается (`completeClockInput`),
 * а годный текст заменяется тем, что легло в `Range`: «24:00» становится
 * «00:00» с подписью «до конца дня» — так поле после перезагрузки выглядит
 * ровно так же, как сразу после ввода. Негодный текст («25:00») остаётся
 * подсвеченным, в `Range` его нет.
 */
export function ClockInput(props: {
  value: string
  bound: ClockBound
  onCommit: (value: string | null) => void
  id: string
  label: string
  placeholder: string
  inputRef?: Ref<HTMLInputElement>
}): JSX.Element {
  const [text, setText] = useState(props.value)
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setText(props.value)
  }, [props.value])

  const invalid = text !== '' && parseClockInput(text, props.bound) === null

  return (
    <input
      id={props.id}
      ref={props.inputRef}
      className="hr-clock"
      type="text"
      inputMode="numeric"
      autoComplete="off"
      maxLength={5}
      placeholder={props.placeholder}
      aria-label={props.label}
      aria-invalid={invalid || undefined}
      value={text}
      onFocus={() => {
        focused.current = true
      }}
      onChange={(e) => {
        const next = sanitizeClockInput(e.target.value)
        setText(next)
        props.onCommit(parseClockInput(next, props.bound))
      }}
      onBlur={() => {
        focused.current = false
        const completed = completeClockInput(text)
        const parsed = parseClockInput(completed, props.bound)
        if (parsed === null) return
        setText(parsed)
        // Достроенное («9» → «09:00») наверх ещё не уходило; уже годное
        // («24:00» → «00:00») ушло на onChange, повторять его незачем.
        if (completed !== text) props.onCommit(parsed)
      }}
    />
  )
}
```

In `src/web/RangeEditor.tsx`:

1. Add the import after the `useLocale` import: `import { ClockInput } from './ClockInput'`.
2. In the doc comment, change the first sentence «Граница — либо `<input type="time">`, либо слово-маркер» to «Граница — либо текстовое поле времени (`ClockInput`, маска ЧЧ:ММ), либо слово-маркер». Leave the rest of the comment (its `<input type="time">` mentions describe why the `Range` holds `'00:00'` for the end of day — still true: the text field shows what `Range` holds).
3. Replace the `<input … type="time" … />` element inside `bound` with:

```tsx
        <ClockInput
          id={`${props.id}-${key}`}
          inputRef={key === 'from' ? props.fromRef : undefined}
          bound={key}
          value={typeof value === 'string' ? value : ''}
          label={t(key === 'from' ? 'schedule.from' : 'schedule.to')}
          placeholder={t('schedule.clockPlaceholder')}
          onCommit={(next) => onChange({ ...range, [key]: key === 'from' ? (next ?? '') : next })}
        />
```

(`typeof value === 'string'` already excludes the marker case, which returned earlier; `''` for `from` and `null` for `to` are the same unset values `RangeEditor` wrote before.)

- [ ] **Step 5: Styles**

In `src/app/globals.css`, replace the line

```css
.hr-range input[type='time'] { width: auto; min-width: 7rem; min-height: 36px; padding: 6px 8px; }
```

with

```css
/* Текстовое поле времени: под пять знаков «ЧЧ:ММ» плюс отступы; табличные
   цифры — чтобы «11:11» и «00:00» были одной ширины и колонки правил не
   дёргались. `.field input { width: 100% }` выше перекрывается по
   специфичности этим же селектором внутри .hr-range. */
.hr-range .hr-clock { width: 5.5rem; min-height: 36px; padding: 6px 8px; font-variant-numeric: tabular-nums; }
/* Незаконченное или негодное время: красная рамка вместо текста ошибки —
   подсказка «укажите время» под редактором уже говорит словами. */
.hr-range .hr-clock[aria-invalid='true'] { border-color: #b91c1c; }
```

In the dark block, directly after `.hr-link { color: #7ab3ff; }`, add:

```css
  .hr-range .hr-clock[aria-invalid='true'] { border-color: #fca5a5; }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/web src/i18n src/form-schema`
Expected: PASS. If the `inputMode`/`autoComplete`/`maxLength` assertions fail on attribute casing, look at what `fieldInputContact.test.tsx` asserts for the same attributes in this repo and match that casing — do NOT change the component.

- [ ] **Step 7: Break-verify**

Temporarily remove `aria-invalid={invalid || undefined}` → nothing fails yet (valid values only) — that is expected; the invalid state is pinned by e2e in Task 3. Temporarily change `type="text"` to `type="time"` → the first `RangeEditor` test must fail. Restore. Temporarily make the marker branch in `RangeEditor` render `<ClockInput>` too → the hoursRulesEditor assertion must fail. Restore.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
npx tsc --noEmit -p tsconfig.json
npm run lint
git add src/web/ClockInput.tsx src/web/RangeEditor.tsx src/i18n/dictionaries.ts src/app/globals.css src/web/__tests__/scheduleEditors.test.tsx src/web/__tests__/hoursRulesEditor.test.tsx
git commit -m "feat(fill): время в расписаниях — текстовое поле с маской ЧЧ:ММ вместо <input type=\"time\">

В браузерный контрол нельзя ни вставить «09:00», ни выделить всё и
перепечатать. ClockInput держит набранное локально, в Range отдаёт только
годное время, на blur достраивает «9» до «09:00» и показывает набранное
«24:00» как «00:00» с подписью «до конца дня». Все три поля (часы работы,
пик, уборка) идут через один RangeEditor.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: End-to-end — locators by label, paste, select-all, blur completion, invalid, cleaning `24:00`

**Files:**
- Modify: `e2e/fill.spec.ts` — the three schedule tests (search for `input[type="time"]`; nine occurrences) and add one new test after the night-schedule test.

**Interfaces:**
- Consumes: `ClockInput` markup from Task 2 (`aria-label` «From» / «To», `aria-invalid="true"` when unparsable), dictionary texts `Schedule 1: set the time`, `until the end of the day`.

Prerequisites: Docker Desktop running (`docker ps` shows `lounge_base-db-1`; if not, `open -a Docker` and wait), no server on :3000 that is not the Playwright one (Playwright starts its own). Run Playwright under `caffeinate -dimsu`.

- [ ] **Step 1: Replace the locators**

In `e2e/fill.spec.ts`, every `locator('input[type="time"]').nth(0)` / `.first()` becomes `getByLabel('From', { exact: true })`, every `.nth(1)` becomes `getByLabel('To', { exact: true })`, and the single `rules.nth(1).locator('input[type="time"]').fill('23:00')` (rule 2 has «from first flight» as a marker, so its only field is «to») becomes `rules.nth(1).getByLabel('To', { exact: true }).fill('23:00')`. Concretely:

```ts
  await rules.nth(0).getByLabel('From', { exact: true }).fill('09:00')
  await rules.nth(0).getByLabel('To', { exact: true }).fill('21:00')
  …
  await rules.nth(1).getByLabel('To', { exact: true }).fill('23:00')
  …
  await rules.nth(0).getByLabel('From', { exact: true }).fill('02:00')
  await rules.nth(0).getByLabel('To', { exact: true }).fill('01:00')
  …
  await rules.nth(1).getByLabel('From', { exact: true }).fill('00:30')
  await rules.nth(1).getByLabel('To', { exact: true }).fill('10:00')
  …
  await rules.nth(1).getByLabel('From', { exact: true }).fill('02:00')
```

`exact: true` matters: the visible prepositions «from»/«to» are plain spans, not labels, but the marker's «×» button carries `aria-label="Enter a time instead"`, and a substring match on «To» would not hit it only by luck of casing — be explicit.

- [ ] **Step 2: Cleaning test — type `24:00`**

In the test «график уборки: ежедневно, окно до полуночи…», replace

```ts
  await cleaning.locator('input[type="time"]').first().fill('22:00')
  await cleaning.locator('input[type="time"]').nth(1).fill('00:00')
  await expect(cleaning.getByText('until the end of the day')).toBeVisible()
```

with

```ts
  await cleaning.getByLabel('From', { exact: true }).fill('22:00')
  // «24:00» набирается текстом (у <input type="time"> такого значения не
  // было) и значит то же, что «00:00» в «до»: подпись появляется сразу, а
  // после blur поле показывает «00:00» — то, что лежит в Range и что
  // покажет перезагрузка (spec 2026-09-12, «Поле»).
  await cleaning.getByLabel('To', { exact: true }).fill('24:00')
  await expect(cleaning.getByText('until the end of the day')).toBeVisible()
  await cleaning.getByLabel('To', { exact: true }).press('Tab')
  await expect(cleaning.getByLabel('To', { exact: true })).toHaveValue('00:00')
```

and the final reload assertion becomes

```ts
  await expect(cleaningAgain.getByLabel('To', { exact: true })).toHaveValue('00:00')
```

Update the test's doc comment: replace «not the internal "00:00" the input box shows» with «and the text field shows that same "00:00" whether the operator typed 00:00 or 24:00».

- [ ] **Step 3: New test — paste, select-all, blur completion, invalid**

Insert after the night-schedule test (before the I4 cleaning comment block):

```ts
/**
 * Текстовое поле времени (spec 2026-09-12): то, чего `<input type="time">`
 * не умел. Вставка любого формата (`fill('9.00')` — Playwright кладёт строку
 * целиком одним событием, как буфер обмена), выделить всё и перепечатать,
 * недописанные часы достраиваются на blur, негодное подсвечено и в
 * расписание не попадает. Правила формата закреплены юнитами
 * (`clockInput.test.ts`); здесь — что они доходят до оператора и до сервера.
 */
test('поле времени текстом: вставка «9.00», выделить всё и перепечатать, «21» → «21:00» на blur, «25:00» подсвечено и не сохраняется', async ({ page }) => {
  const url = seed()
  await page.goto(url)
  await clickNext(page, 2)
  const hours = page.locator('.field').filter({ hasText: 'Lounge Operating Hours' })
  const rule = hours.locator('.hr-rule').nth(0)
  const from = rule.getByLabel('From', { exact: true })
  const to = rule.getByLabel('To', { exact: true })
  const summaryRow = (day: string) => hours.locator('.hr-sum-row').filter({ hasText: day })

  // Вставка «9.00» → «09:00» сразу, без blur.
  await from.fill('9.00')
  await expect(from).toHaveValue('09:00')

  // «21» + Tab → «21:00»: часы без минут достраиваются при уходе из поля.
  await to.fill('21')
  await expect(to).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('Schedule 1: set the time')).toBeVisible()
  await to.press('Tab')
  await expect(to).toHaveValue('21:00')
  await expect(to).not.toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('Saved')).toBeVisible()
  await expect(summaryRow('Monday')).toContainText('09:00–21:00')

  // Выделить всё и перепечатать — клавишами, как оператор.
  await from.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('10:00')
  await expect(from).toHaveValue('10:00')
  await expect(summaryRow('Monday')).toContainText('10:00–21:00')

  // Негодное время: подсвечено, границы в расписании нет, черновик жив.
  await to.fill('25:00')
  await expect(to).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('Schedule 1: set the time')).toBeVisible()
  await to.press('Tab')
  await expect(to).toHaveValue('25:00')
  await expect(to).toHaveAttribute('aria-invalid', 'true')

  // Перезагрузка: сервер держит «с 10:00», конца нет — поле «до» пустое.
  await page.reload()
  await clickNext(page, 2)
  await expect(hours.locator('.hr-rule').nth(0).getByLabel('From', { exact: true })).toHaveValue('10:00')
  await expect(hours.locator('.hr-rule').nth(0).getByLabel('To', { exact: true })).toHaveValue('')
})
```

Why `fill('21')` then Tab and not `type`: `fill` replaces the whole value in one input event, the same shape a paste produces; `keyboard.type` is used once, deliberately, for the select-all-and-retype path where per-key sanitising (the auto-colon) is the thing under test.

- [ ] **Step 4: Run the three schedule tests plus the new one**

Run: `caffeinate -dimsu npx playwright test e2e/fill.spec.ts -g "расписание правилами|график уборки|поле времени текстом"`
Expected: PASS, 4 tests. If «Saved» is flaky after the blur commit, wait on `summaryRow` first (already ordered that way above) — do not loosen assertions.

If the select-all step leaves `from` as `'10:0'` or similar: the per-key path is broken in `sanitizeClockInput`/`onChange`, not in the test — go back to Task 1's table and add the failing sequence as a unit test before fixing.

- [ ] **Step 5: Break-verify the new test**

Temporarily remove `completeClockInput` from `onBlur` in `ClockInput.tsx` (commit `parseClockInput(text, …)` only) → the «21 → 21:00» step must fail. Restore. Temporarily drop `aria-invalid` from the component → the `aria-invalid` assertions must fail. Restore.

- [ ] **Step 6: Full gates and commit**

```bash
npx tsc --noEmit -p tsconfig.json
npm run lint
caffeinate -dimsu npx vitest run
caffeinate -dimsu npx playwright test
git add e2e/fill.spec.ts
git commit -m "test(e2e): поле времени текстом — вставка, выделить всё, достраивание на blur, негодное подсвечено; локаторы по подписи From/To

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

If the known flake in `e2e/review.spec.ts` («правка из устаревшей вкладки») fails once in the full run, rerun that file alone before concluding anything; the branch does not touch that path.

---

## Self-review against the spec

- Sanitize rules 1–4 (groups, separator-after-hours, single group with auto-colon, no digits → empty) — Task 1 tests and code.
- Parse (empty → null, full HH:MM, `24:00` only in «to» → `00:00`, rest null) — Task 1.
- Complete (`9`/`09`/`09:` → `09:00`, rest as-is) — Task 1; the spec's «одна или две цифры без минут, с двоеточием после них или без» is exactly the `^(\d{1,2}):?$` rule, plus the 00–23 guard so `25` is not turned into a plausible-looking time.
- Field: text/numeric/autocomplete off/maxLength 5/placeholder/`hr-clock`/`aria-invalid` — Task 2 component; local text + commit only valid + prop sync only when unfocused + blur behaviour — Task 2 component; placeholder dictionary key — Task 2 Step 3; styles light + dark — Task 2 Step 5.
- `RangeEditor` unchanged apart from the field; markers, captions, `fromRef` kept — Task 2 Step 4.
- Tests: unit (Task 1), component (Task 2), `hoursRulesEditor` assertion migrated (Task 2), e2e locators + paste + select-all + cleaning `24:00` (Task 3). The spec's e2e list named «вставить 9.00 … и итог недели» and «выделить всё» — both in Task 3 Step 3; blur-completion and invalid are added because the component's blur branch and `aria-invalid` have no other runtime pin (node tests cannot type).
- Out of scope respected: no `24:00` display, no dropdown, no guessing of `09:3`.
