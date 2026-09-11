# Schedule Rules Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the seven-row day grid with a rules editor («these days — this schedule»), add «first flight / last flight» as interval boundaries, show a live week summary under the editor, and keep the stored per-day model, server gate and export intact.

**Architecture:** Storage stays `WeekHours` (seven days, within-day windows). Rules are a VIEW: two pure functions in `src/form-schema/schedule.ts` — `expandRules(rules) → WeekHours` (night ranges split across midnight into this day and the next) and `collapseWeek(week) → rules` (tails re-merged, equal days grouped). A new component `HoursRulesEditor` holds the rule list in local state, writes `expandRules(rules)` through the same `onChange`, and renders a seven-line summary from the same per-day texts the review screen prints. Boundaries gain two string markers, `'firstFlight'` / `'lastFlight'`, allowed only where `HoursOptions.flightBounds` is true (III.1.1).

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, vitest (node env — component tests use `renderToStaticMarkup`, no DOM library), Playwright e2e against local docker Postgres.

Spec: `docs/superpowers/specs/2026-09-11-schedule-rules-editor-design.md`.

## Global Constraints

- Read `node_modules/next/dist/docs/` before touching framework code (AGENTS.md rule).
- One rule in one place: rules ⇄ week conversion, day grouping, night splitting, marker rules and per-day text live only in `src/form-schema/schedule.ts`. Components call them.
- `src/form-schema/*` stays pure (no React/DOM/`@/web`); pure helpers never live in a `'use client'` module.
- Storage model unchanged: `WeekHours`, per-day, windows within the day, `to > from` for clock windows, no overlap, `24:00` only as an end. NO migration.
- Markers: `from` may be `'firstFlight'`, `to` may be `'lastFlight'`; a window carrying a marker is the ONLY window of its day; markers never split across midnight; markers allowed only when `hoursOptions.flightBounds` is true (III.1.1 only).
- A night range (both clocks, `to < from`) expands to `from–24:00` on its day and `00:00–to` on the NEXT day (Sun → Mon). `to === from` is a form refusal.
- Days in no rule are `none` (closed, word from `noneLabel`); days in a rule whose start is not yet entered stay UNANSWERED (undefined) — the draft saves, completeness holds submission.
- A day belongs to at most one rule; toggling it in another rule moves it.
- First rule pre-selects all seven days.
- Canonical text prints rules («Mon–Fri 09:00–21:00; Sat–Sun first flight–23:00»), grouping days with equal text in week order, non-adjacent via comma («Mon–Thu, Sat–Sun»); night ranges print «02:00–01:00 (next day)» / «(след. дня)». Per-day export cells keep the stored split form; marker cells print words.
- Dictionary keys and their exact strings are listed in Task 4 Step 1 — use them verbatim; delete the listed obsolete keys in Task 5.
- Comments explain WHY and never assert premises the code does not check. Every test break-verified. Long commands under `caffeinate -dimsu` (laptop sleeps after one minute). Commit per task, Russian subject, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Never merge or push without Anton's explicit answer to the finishing menu.

## File Map

- Modify `src/form-schema/schedule.ts` — markers, `flightBounds`, rules model (`expandRules`, `collapseWeek`, `toggleDay`, `splitDay`), per-day texts and grouping; later: delete quick actions and `nextWindowBlockedReason`.
- Modify `src/form-schema/fields.ts` — `flightBounds` on III.1.1/III.1.3.
- Modify `src/form-schema/__tests__/schedule.test.ts`, `fields.test.ts`.
- Create `src/web/HoursRulesEditor.tsx`, `src/web/RangeEditor.tsx`.
- Modify `src/web/FieldInput.tsx`, `src/web/CleaningScheduleEditor.tsx`, `src/i18n/dictionaries.ts`, `src/app/globals.css`.
- Delete `src/web/WeekHoursEditor.tsx`, `src/web/WindowsEditor.tsx`.
- Rewrite `src/web/__tests__/scheduleEditors.test.tsx`; modify `e2e/fill.spec.ts`.

---

### Task 1: Flight markers in the stored model

**Files:**
- Modify: `src/form-schema/schedule.ts` (`HoursOptions`, `CLEANING_DAY_OPTIONS`, `windowsProblem`, `dayHoursProblem`, `nextWindowStart`, `formatWindow`/`formatWindows`, `formatDayHours`)
- Modify: `src/form-schema/fields.ts` (III.1.1, III.1.3 `hoursOptions`)
- Modify: `src/form-schema/__tests__/schedule.test.ts`, `src/form-schema/__tests__/fields.test.ts`
- Modify: `src/form-schema/render.ts` (call-site of `formatWindows` if any), `src/web/WindowsEditor.tsx` (only if typecheck demands — see Step 5)

**Interfaces:**
- Produces:
  - `export const FIRST_FLIGHT = 'firstFlight'`, `export const LAST_FLIGHT = 'lastFlight'`
  - `export function isStartBound(v: unknown): boolean` (clock other than `24:00`, or `FIRST_FLIGHT`)
  - `export function isEndBound(v: unknown): boolean` (clock incl. `24:00`, or `LAST_FLIGHT`)
  - `export function hasMarker(window: Window): boolean`
  - `HoursOptions.flightBounds: boolean`
  - `DayHoursProblem` gains `'flightNotAllowed'`
  - `formatWindows(windows: Window[], locale: 'en' | 'ru'): string` (locale is NEW — markers are words)

- [ ] **Step 1: Write the failing tests**

Append to `src/form-schema/__tests__/schedule.test.ts` (extend imports; `OPEN`/`PEAK` fixtures at the top of the file must gain `flightBounds: true` for `OPEN` and `false` for `PEAK` — do that in this step, it is what makes the marker cases meaningful):

```ts
describe('границы «первый / последний рейс»', () => {
  it('интервал с маркерами корректен по форме', () => {
    expect(windowsProblem([{ from: FIRST_FLIGHT, to: LAST_FLIGHT }])).toBe(null)
    expect(windowsProblem([{ from: FIRST_FLIGHT, to: '23:00' }])).toBe(null)
    expect(windowsProblem([{ from: '01:00', to: LAST_FLIGHT }])).toBe(null)
    expect(windowsProblem([{ from: FIRST_FLIGHT, to: null }])).toBe(null)
  })

  it('интервал с маркером — единственный в дне', () => {
    expect(windowsProblem([{ from: FIRST_FLIGHT, to: '12:00' }, { from: '13:00', to: '20:00' }])).toBe('order')
    expect(windowsProblem([{ from: '06:00', to: '12:00' }, { from: '13:00', to: LAST_FLIGHT }])).toBe('order')
  })

  it('маркер не на своей стороне — негодное время', () => {
    expect(windowsProblem([{ from: LAST_FLIGHT, to: '12:00' }])).toBe('clock')
    expect(windowsProblem([{ from: '06:00', to: FIRST_FLIGHT }])).toBe('clock')
  })

  it('маркеры разрешены только там, где поле их допускает', () => {
    const day = { kind: 'windows', windows: [{ from: FIRST_FLIGHT, to: LAST_FLIGHT }] }
    expect(dayHoursProblem(day, OPEN)).toBe(null)
    expect(dayHoursProblem(day, PEAK)).toBe('flightNotAllowed')
    expect(weekHoursProblem({ mon: day }, PEAK)).toBe('flightNotAllowed')
  })

  it('после интервала с маркером второй не предлагается', () => {
    expect(nextWindowStart([{ from: '01:00', to: LAST_FLIGHT }])).toBe(null)
    expect(nextWindowStart([{ from: FIRST_FLIGHT, to: '23:00' }])).toBe(null)
  })

  it('маркеры печатаются словами, на обоих языках', () => {
    expect(formatWindows([{ from: FIRST_FLIGHT, to: LAST_FLIGHT }], 'en')).toBe('first flight–last flight')
    expect(formatWindows([{ from: FIRST_FLIGHT, to: '23:00' }], 'en')).toBe('first flight–23:00')
    expect(formatWindows([{ from: '01:00', to: LAST_FLIGHT }], 'ru')).toBe('с 01:00 до последнего рейса')
    expect(formatWindows([{ from: FIRST_FLIGHT, to: LAST_FLIGHT }], 'ru')).toBe('с первого рейса до последнего')
    expect(formatWindows([{ from: FIRST_FLIGHT, to: '23:00' }], 'ru')).toBe('с первого рейса до 23:00')
    // Обычные времена по-русски — как раньше, тире без предлогов.
    expect(formatWindows([{ from: '09:00', to: '21:00' }], 'ru')).toBe('09:00–21:00')
  })

  it('день с маркерами считается заполненным', () => {
    const week = everyDay({ kind: 'windows', windows: [{ from: FIRST_FLIGHT, to: LAST_FLIGHT }] })
    expect(weekHoursComplete(week, OPEN)).toBe(true)
  })
})
```

Add to `src/form-schema/__tests__/fields.test.ts`, inside the existing schedule pin: the `toEqual` objects for III.1.1 and III.1.3 gain `flightBounds: true` (III.1.1) and `flightBounds: false` (III.1.3), plus one assertion `expect(FIELDS.filter((f) => f.hoursOptions?.flightBounds)).toHaveLength(1)` with a comment: рейсы — ответ про часы работы лаунжа, у пиковых часов и уборки такого смысла нет.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/form-schema/__tests__/schedule.test.ts src/form-schema/__tests__/fields.test.ts`
Expected: FAIL — `FIRST_FLIGHT` not exported; `flightBounds` missing.

- [ ] **Step 3: Implement**

In `src/form-schema/schedule.ts`:

```ts
/** Границы интервала, которые не время: «с первого рейса», «до последнего
 *  рейса». Хранятся строками рядом с часами, потому что это ответ на тот же
 *  вопрос («когда открыто»), только без цифр: у маленького аэропорта лаунж
 *  живёт по расписанию рейсов, и заставлять оператора выдумывать время — ложь
 *  в данных. Разрешены только там, где `HoursOptions.flightBounds`. */
export const FIRST_FLIGHT = 'firstFlight'
export const LAST_FLIGHT = 'lastFlight'

export type HoursOptions = {
  allDay: boolean
  /** Можно ли вместо времени поставить «первый рейс» / «последний рейс». Только
   *  у часов работы: пик «с первого рейса» и уборка «до последнего рейса» —
   *  не ответы. */
  flightBounds: boolean
  noneLabel: Localized
}

export const CLEANING_DAY_OPTIONS: HoursOptions = {
  allDay: false,
  flightBounds: false,
  noneLabel: { en: 'No cleaning', ru: 'Без уборки' },
}

/** Годится ли значение как НАЧАЛО интервала: время (не конец суток) или «первый рейс». */
export function isStartBound(value: unknown): boolean {
  return value === FIRST_FLIGHT || (isClock(value) && value !== END_OF_DAY)
}

/** Годится ли значение как КОНЕЦ интервала: время (включая 24:00) или «последний рейс». */
export function isEndBound(value: unknown): boolean {
  return value === LAST_FLIGHT || isClock(value)
}

export function hasMarker(window: Window): boolean {
  return window.from === FIRST_FLIGHT || window.to === LAST_FLIGHT
}
```

In `windowsProblem`, replace the two `clock` checks and the ordering block:

```ts
    if (!isStartBound(from)) return 'clock'
    if (to !== null && !isEndBound(to)) return 'clock'

    // Интервал с маркером не сравним по времени ни с чем — он единственный
    // в дне. Второй рядом с ним (до или после) — отказ порядка.
    const marker = from === FIRST_FLIGHT || to === LAST_FLIGHT
    if (marker && value.length > 1) return 'order'
    if (marker) return null

    const start = clockMinutes(from as string)
    // …остальное без изменений (order / overlap / previousEnd / previousStart)
```

In `dayHoursProblem`, after computing the windows problem for `kind === 'windows'`:

```ts
  const windows = (hours as { windows?: unknown }).windows
  const problem = windowsProblem(windows)
  if (problem) return problem
  if (!options.flightBounds && (windows as Window[]).some(hasMarker)) return 'flightNotAllowed'
  return null
```

and extend the type: `export type DayHoursProblem = 'shape' | 'kind' | 'allDayNotAllowed' | 'flightNotAllowed' | Exclude<WindowsProblem, null> | null`.

In `nextWindowStart`: `if (hasMarker(last)) return null` before the `to` checks (a marker window is the only one). In `nextWindowBlockedReason`: return `'full'` for a marker window (this function is deleted in Task 5; keep typecheck green now).

Formatting — replace `formatWindow`/`formatWindows`:

```ts
const BOUND_WORD: Record<'en' | 'ru', { first: string; last: string }> = {
  en: { first: 'first flight', last: 'last flight' },
  ru: { first: 'первого рейса', last: 'последнего рейса' },
}

/** Один интервал. Времена — через тире; маркер по-русски требует предлогов
 *  («с первого рейса до 23:00»), по-английски тире читается и с ними. */
function formatWindow(window: Window, locale: 'en' | 'ru'): string {
  const marker = hasMarker(window)
  const from = window.from === FIRST_FLIGHT ? BOUND_WORD[locale].first : isClock(window.from) ? window.from : UNANSWERED
  const to =
    window.to === null ? '…'
    : window.to === LAST_FLIGHT ? (locale === 'ru' && window.from === FIRST_FLIGHT ? 'последнего' : BOUND_WORD[locale].last)
    : isClock(window.to) ? window.to : UNANSWERED
  if (marker && locale === 'ru') return `с ${from} до ${to}`
  return `${from}–${to}`
}

export function formatWindows(windows: Window[], locale: 'en' | 'ru'): string {
  return windows.map((window) => formatWindow(window, locale)).join(', ')
}
```

`formatDayHours` passes `locale` to `formatWindows`. Search for other callers of `formatWindows` (`grep -rn "formatWindows(" src`) and add the locale argument (`'en'` in cells/export).

`src/form-schema/fields.ts`: III.1.1 `hoursOptions: { allDay: true, flightBounds: true, noneLabel: … }`, III.1.3 `{ allDay: false, flightBounds: false, noneLabel: … }`.

- [ ] **Step 4: Run and typecheck**

Run: `npm run typecheck && npx vitest run src/form-schema src/web src/submissions src/export`
Expected: green. If typecheck names `WindowsEditor.tsx` (it imports `Window`/`nextWindowStart`), the change is additive and should compile; do not restructure it — Task 5 deletes it.

- [ ] **Step 5: Break-verify**

Remove `if (marker && value.length > 1) return 'order'` → the «единственный в дне» test fails. Restore. Remove the `flightNotAllowed` check → the PEAK case fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/form-schema/schedule.ts src/form-schema/fields.ts src/form-schema/__tests__/schedule.test.ts src/form-schema/__tests__/fields.test.ts src/form-schema/render.ts
git commit -m "feat(schema): границы «первый / последний рейс» у интервала — только у часов работы, единственный в дне

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Rules ⇄ week

**Files:**
- Modify: `src/form-schema/schedule.ts`
- Modify: `src/form-schema/__tests__/schedule.test.ts`

**Interfaces:**
- Produces:
  - `export type Range = { from: string; to: string | null }` (`from` may be `''` — not entered yet; markers allowed as in `Window`)
  - `export type RuleHours = { kind: 'allDay' } | { kind: 'windows'; ranges: Range[] }`
  - `export type HoursRule = { days: Weekday[]; hours: RuleHours }`
  - `export function emptyRule(days: Weekday[]): HoursRule`
  - `export function isNightRange(range: Range): boolean` (both clocks, `to < from`)
  - `export function expandRules(rules: HoursRule[]): WeekHours`
  - `export function collapseWeek(week: WeekHours): HoursRule[]`
  - `export function toggleDay(rules: HoursRule[], index: number, day: Weekday): HoursRule[]`
  - `export function splitDay(rules: HoursRule[], day: Weekday): HoursRule[]`
  - `export function nextDay(day: Weekday): Weekday`, `export function previousDay(day: Weekday): Weekday`

- [ ] **Step 1: Write the failing tests**

Append to `schedule.test.ts`:

```ts
const W = ['mon', 'tue', 'wed', 'thu', 'fri'] as const
const E = ['sat', 'sun'] as const
const rule = (days: readonly Weekday[], from: string, to: string | null): HoursRule =>
  ({ days: [...days], hours: { kind: 'windows', ranges: [{ from, to }] } })

describe('expandRules — правила ложатся в дни', () => {
  it('№1: будни и выходные', () => {
    const week = expandRules([rule(W, '09:00', '21:00'), rule(E, '10:00', '20:00')])
    expect(week.mon).toEqual({ kind: 'windows', windows: [{ from: '09:00', to: '21:00' }] })
    expect(week.sun).toEqual({ kind: 'windows', windows: [{ from: '10:00', to: '20:00' }] })
  })

  it('№2: ночной график разбивается по суткам, хвост уходит в СЛЕДУЮЩИЙ день', () => {
    const week = expandRules([rule(W, '02:00', '01:00'), rule(E, '05:00', '01:00')])
    expect(week.mon).toEqual({ kind: 'windows', windows: [{ from: '00:00', to: '01:00' }, { from: '02:00', to: END_OF_DAY }] })
    expect(week.sat).toEqual({ kind: 'windows', windows: [{ from: '00:00', to: '01:00' }, { from: '05:00', to: END_OF_DAY }] })
    // Хвост воскресенья попадает в понедельник — неделя по кругу.
    expect(week.mon!.kind === 'windows' && week.mon.windows[0]).toEqual({ from: '00:00', to: '01:00' })
  })

  it('№3 и №4: все дни одинаково; круглосуточно', () => {
    expect(expandRules([rule(WEEKDAYS, '07:00', '22:00')]).thu).toEqual({ kind: 'windows', windows: [{ from: '07:00', to: '22:00' }] })
    expect(expandRules([{ days: [...WEEKDAYS], hours: { kind: 'allDay' } }]).sun).toEqual({ kind: 'allDay' })
  })

  it('№5: день без правила закрыт', () => {
    const week = expandRules([rule(['mon', 'tue', 'wed', 'thu', 'sat', 'sun'], '09:00', '21:00')])
    expect(week.fri).toEqual({ kind: 'none' })
  })

  it('№6: маркеры не разбиваются и ложатся как есть', () => {
    const week = expandRules([rule(WEEKDAYS, FIRST_FLIGHT, LAST_FLIGHT)])
    expect(week.wed).toEqual({ kind: 'windows', windows: [{ from: FIRST_FLIGHT, to: LAST_FLIGHT }] })
    expect(expandRules([rule(E, FIRST_FLIGHT, '23:00')]).sat).toEqual({ kind: 'windows', windows: [{ from: FIRST_FLIGHT, to: '23:00' }] })
  })

  it('день в правиле без времени остаётся НЕОТВЕЧЕННЫМ, а не закрытым', () => {
    const week = expandRules([rule(W, '09:00', '21:00'), rule(E, '', null)])
    expect(week.sat).toBeUndefined()
    expect(week.mon).toBeDefined()
  })

  it('незакрытый диапазон — незакрытый интервал (сохраняется, анкета неполна)', () => {
    const week = expandRules([rule(WEEKDAYS, '09:00', null)])
    expect(week.mon).toEqual({ kind: 'windows', windows: [{ from: '09:00', to: null }] })
    expect(weekHoursComplete(week, OPEN)).toBe(false)
  })

  it('to === from — негодная форма, которую поймает ворота', () => {
    const week = expandRules([rule(WEEKDAYS, '09:00', '09:00')])
    expect(weekHoursProblem(week, OPEN)).toBe('order')
  })

  it('хвост ночи, наехавший на свой интервал следующего дня, — пересечение', () => {
    const week = expandRules([rule(['mon'], '22:00', '03:00'), rule(['tue'], '02:00', '10:00')])
    expect(weekHoursProblem(week, OPEN)).toBe('overlap')
  })

  it('интервалы дня упорядочены после раскладки', () => {
    const week = expandRules([rule(['mon'], '22:00', '02:00'), rule(['tue'], '09:00', '18:00')])
    expect(week.tue).toEqual({ kind: 'windows', windows: [{ from: '00:00', to: '02:00' }, { from: '09:00', to: '18:00' }] })
  })
})

describe('collapseWeek — дни собираются в правила', () => {
  const cases: [string, HoursRule[]][] = [
    ['№1', [rule(W, '09:00', '21:00'), rule(E, '10:00', '20:00')]],
    ['№2', [rule(W, '02:00', '01:00'), rule(E, '05:00', '01:00')]],
    ['№3', [rule(WEEKDAYS, '07:00', '22:00')]],
    ['№4', [{ days: [...WEEKDAYS], hours: { kind: 'allDay' } }]],
    ['№5', [rule(['mon', 'tue', 'wed', 'thu', 'sat', 'sun'], '09:00', '21:00')]],
    ['№6', [rule(WEEKDAYS, FIRST_FLIGHT, LAST_FLIGHT)]],
    ['№6 смешанно', [rule(W, '01:00', LAST_FLIGHT), rule(E, FIRST_FLIGHT, '23:00')]],
    ['разрывной день', [{ days: [...WEEKDAYS], hours: { kind: 'windows', ranges: [{ from: '01:00', to: '11:00' }, { from: '12:00', to: '23:00' }] } }]],
  ]

  it.each(cases)('%s: expand → collapse возвращает те же правила', (_name, rules) => {
    expect(collapseWeek(expandRules(rules))).toEqual(rules)
  })

  it.each(cases)('%s: collapse → expand возвращает ту же неделю', (_name, rules) => {
    const week = expandRules(rules)
    expect(expandRules(collapseWeek(week))).toEqual(week)
  })

  it('полный день 00:00–24:00 не считается хвостом предыдущего', () => {
    const week: WeekHours = { mon: { kind: 'windows', windows: [{ from: '20:00', to: END_OF_DAY }] }, tue: { kind: 'windows', windows: [{ from: '00:00', to: END_OF_DAY }] } }
    const rules = collapseWeek(week)
    expect(rules.find((r) => r.days.includes('mon'))!.hours).toEqual({ kind: 'windows', ranges: [{ from: '20:00', to: END_OF_DAY }] })
  })

  it('дни none и неотвеченные в правила не попадают', () => {
    expect(collapseWeek({ mon: { kind: 'none' }, tue: { kind: 'allDay' } })).toEqual([{ days: ['tue'], hours: { kind: 'allDay' } }])
    expect(collapseWeek({})).toEqual([])
  })
})

describe('toggleDay и splitDay', () => {
  it('день переходит из одного правила в другое', () => {
    const out = toggleDay([rule(WEEKDAYS, '09:00', '21:00'), rule([], '', null)], 1, 'sat')
    expect(out[0]!.days).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sun'])
    expect(out[1]!.days).toEqual(['sat'])
  })

  it('повторное нажатие снимает день с его правила', () => {
    const out = toggleDay([rule(WEEKDAYS, '09:00', '21:00')], 0, 'fri')
    expect(out[0]!.days).not.toContain('fri')
  })

  it('splitDay уносит день в новое пустое правило в конце списка', () => {
    const out = splitDay([rule(WEEKDAYS, '09:00', '21:00')], 'sat')
    expect(out).toHaveLength(2)
    expect(out[0]!.days).not.toContain('sat')
    expect(out[1]).toEqual({ days: ['sat'], hours: { kind: 'windows', ranges: [{ from: '', to: null }] } })
  })

  it('входные правила не мутируются', () => {
    const rules = [rule(WEEKDAYS, '09:00', '21:00')]
    toggleDay(rules, 0, 'fri'); splitDay(rules, 'sat')
    expect(rules[0]!.days).toHaveLength(7)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/form-schema/__tests__/schedule.test.ts`
Expected: FAIL — names not exported.

- [ ] **Step 3: Implement**

Append to `schedule.ts`:

```ts
/**
 * Правила — то, как оператор ДУМАЕТ о графике: «эти дни — такой режим».
 * Хранение остаётся по дням (`WeekHours`); правила — представление, которое
 * редактор показывает и через которое пишет. Две функции ниже переводят туда и
 * обратно, и их обратимость закреплена тестами на живых графиках лаунжей.
 *
 * `Range.from === ''` — время ещё не введено: такой диапазон в неделю не
 * ложится вовсе (день остаётся неотвеченным), потому что «правило без
 * времени» — нормальное состояние черновика на полпути, а не ошибка формы.
 */
export type Range = { from: string; to: string | null }
export type RuleHours = { kind: 'allDay' } | { kind: 'windows'; ranges: Range[] }
export type HoursRule = { days: Weekday[]; hours: RuleHours }

export function emptyRule(days: Weekday[]): HoursRule {
  return { days, hours: { kind: 'windows', ranges: [{ from: '', to: null }] } }
}

export function nextDay(day: Weekday): Weekday {
  return WEEKDAYS[(WEEKDAYS.indexOf(day) + 1) % 7]!
}
export function previousDay(day: Weekday): Weekday {
  return WEEKDAYS[(WEEKDAYS.indexOf(day) + 6) % 7]!
}

/** Ночной диапазон: оба конца — времена и конец меньше начала («02:00–01:00»). */
export function isNightRange(range: Range): boolean {
  return isClock(range.from) && range.to !== null && isClock(range.to) && clockMinutes(range.to) < clockMinutes(range.from)
}

function sortWindows(windows: Window[]): Window[] {
  return [...windows].sort((a, b) => {
    const start = (w: Window): number => (isClock(w.from) ? clockMinutes(w.from) : -1)
    return start(a) - start(b)
  })
}

/**
 * Правила → семь дней. Ночной диапазон делится по суткам: `from–24:00`
 * сегодня и `00:00–to` ЗАВТРА (после воскресенья — понедельник). Именно
 * завтра: «пн 02:00–01:00» — это закрытие во вторник в час ночи, и у лаунжа,
 * закрытого по пятницам, ночь четверга честно даёт пятнице `00:00–01:00`.
 * Дни без правила закрыты (`none`); дни в правиле без введённого времени —
 * неотвечены (в неделю не попадают). Повторы дня между правилами редактор не
 * допускает; для значения, пришедшего мимо него, побеждает последнее правило.
 */
export function expandRules(rules: HoursRule[]): WeekHours {
  const own: Partial<Record<Weekday, DayHours>> = {}
  const tails: Partial<Record<Weekday, Window[]>> = {}
  const covered = new Set<Weekday>()

  for (const rule of rules) {
    for (const day of rule.days) {
      covered.add(day)
      if (rule.hours.kind === 'allDay') { own[day] = { kind: 'allDay' }; continue }
      const windows: Window[] = []
      for (const range of rule.hours.ranges) {
        if (range.from === '') continue
        if (isNightRange(range)) {
          windows.push({ from: range.from, to: END_OF_DAY })
          ;(tails[nextDay(day)] ??= []).push({ from: '00:00', to: range.to })
        } else {
          windows.push({ from: range.from, to: range.to })
        }
      }
      if (windows.length > 0) own[day] = { kind: 'windows', windows }
      else delete own[day]
    }
  }

  const week: WeekHours = {}
  for (const day of WEEKDAYS) {
    const base = own[day]
    const tail = tails[day] ?? []
    if (base?.kind === 'windows') week[day] = { kind: 'windows', windows: sortWindows([...tail, ...base.windows]) }
    else if (base) week[day] = base
    else if (tail.length > 0) week[day] = { kind: 'windows', windows: sortWindows(tail) }
    else if (!covered.has(day)) week[day] = { kind: 'none' }
    // covered, но без времени — неотвечен: ключа нет.
  }
  return week
}

/**
 * Семь дней → правила. Сначала склейка ночи: интервал `00:00–X` дня D — хвост
 * интервала `Y–24:00` предыдущего дня, если такой есть; они становятся одним
 * ночным диапазоном `Y–X` у предыдущего дня. Полный день `00:00–24:00`
 * хвостом не считается. Потом дни с одинаковым набором диапазонов
 * объединяются в правило; порядок правил — по первому дню. Закрытые и
 * неотвеченные дни правил не образуют.
 */
export function collapseWeek(week: WeekHours): HoursRule[] {
  const ranges: Partial<Record<Weekday, Range[] | 'allDay'>> = {}
  for (const day of WEEKDAYS) {
    const hours = week[day]
    if (!hours || hours.kind === 'none') continue
    if (hours.kind === 'allDay') { ranges[day] = 'allDay'; continue }
    ranges[day] = hours.windows.map((w) => ({ from: w.from, to: w.to }))
  }

  for (const day of WEEKDAYS) {
    const list = ranges[day]
    if (!Array.isArray(list)) continue
    const tailIndex = list.findIndex((r) => r.from === '00:00' && r.to !== null && isClock(r.to) && r.to !== END_OF_DAY)
    if (tailIndex < 0) continue
    const prev = ranges[previousDay(day)]
    if (!Array.isArray(prev)) continue
    const headIndex = prev.findIndex((r) => r.to === END_OF_DAY && isClock(r.from))
    if (headIndex < 0) continue
    const tail = list[tailIndex]!
    prev[headIndex] = { from: prev[headIndex]!.from, to: tail.to }
    list.splice(tailIndex, 1)
    if (list.length === 0) delete ranges[day]
  }

  const rules: HoursRule[] = []
  for (const day of WEEKDAYS) {
    const value = ranges[day]
    if (value === undefined) continue
    const key = JSON.stringify(value)
    const existing = rules.find((r) => JSON.stringify(r.hours.kind === 'allDay' ? 'allDay' : r.hours.ranges) === key)
    if (existing) { existing.days.push(day); continue }
    rules.push({ days: [day], hours: value === 'allDay' ? { kind: 'allDay' } : { kind: 'windows', ranges: value } })
  }
  return rules
}

/** Нажатие дня в правиле `index`: если день там — снять; иначе — забрать у
 *  любого другого правила и добавить сюда. День принадлежит одному правилу.
 *  Новый массив, входной не мутируется — результат кладут в состояние React. */
export function toggleDay(rules: HoursRule[], index: number, day: Weekday): HoursRule[] {
  return rules.map((rule, i) => {
    const has = rule.days.includes(day)
    if (i === index) return { ...rule, days: has ? rule.days.filter((d) => d !== day) : sortDays([...rule.days, day]) }
    return has ? { ...rule, days: rule.days.filter((d) => d !== day) } : rule
  })
}

/** «Изменить» у дня в итоге: день уходит из своего правила в новое, пустое,
 *  в конец списка — оператор правит тот день, который в итоге не сошёлся. */
export function splitDay(rules: HoursRule[], day: Weekday): HoursRule[] {
  return [...rules.map((r) => ({ ...r, days: r.days.filter((d) => d !== day) })), emptyRule([day])]
}

function sortDays(days: Weekday[]): Weekday[] {
  return [...days].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b))
}
```

Note for the `collapseWeek` day-merge: the night tail on day D was produced by the previous day's rule, so after merging, D's own windows (if any) remain and D groups by them. The «№2» fixture round-trips because every day has a tail and a head; the «разрывной день» fixture has no `00:00` starts and is untouched.

- [ ] **Step 4: Run**

Run: `npm run typecheck && npx vitest run src/form-schema`
Expected: green.

- [ ] **Step 5: Break-verify**

Change `nextDay(day)` to `day` in `expandRules` → the «№2» test fails on `mon`/`sat`. Restore. Change `r.to !== END_OF_DAY` in the tail search to allow it → «полный день» test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/form-schema/schedule.ts src/form-schema/__tests__/schedule.test.ts
git commit -m "feat(schema): правила ⇄ неделя — раскладка ночи по суткам, склейка хвостов, обратимость на живых графиках

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Canonical text by rules

**Files:**
- Modify: `src/form-schema/schedule.ts` (`formatWeekHours`, new `dayTexts`, `groupDaysByText`, `formatRange`; remove `compressDays`)
- Modify: `src/form-schema/__tests__/schedule.test.ts` (update the «канонический текст недельных часов» block)

**Interfaces:**
- Produces:
  - `export function formatRange(range: Range, locale: 'en' | 'ru'): string` — «09:00–21:00», «02:00–01:00 (next day)», «first flight–23:00», «09:00–…», «—» for `from === ''`
  - `export function dayTexts(week: WeekHours, options: HoursOptions, locale: 'en' | 'ru'): Record<Weekday, string>` — per-day text in the RULES view (night merged), `noneLabel` for closed, `—` for unanswered
  - `formatWeekHours(value, options, locale)` — groups `dayTexts` by equal text in week order

- [ ] **Step 1: Rewrite the failing tests**

Replace the body of `describe('канонический текст недельных часов', …)`:

```ts
  it('№1: будни и выходные', () => {
    expect(formatWeekHours(expandRules([rule(W, '09:00', '21:00'), rule(E, '10:00', '20:00')]), OPEN, 'en'))
      .toBe('Mon–Fri 09:00–21:00; Sat–Sun 10:00–20:00')
  })

  it('№2: ночь печатается как её вводили, с пометкой', () => {
    const week = expandRules([rule(W, '02:00', '01:00'), rule(E, '05:00', '01:00')])
    expect(formatWeekHours(week, OPEN, 'en')).toBe('Mon–Fri 02:00–01:00 (next day); Sat–Sun 05:00–01:00 (next day)')
    expect(formatWeekHours(week, OPEN, 'ru')).toBe('Пн–Пт 02:00–01:00 (след. дня); Сб–Вс 05:00–01:00 (след. дня)')
  })

  it('№4 и №5: круглосуточно; несмежные дни через запятую, закрытый — словом поля', () => {
    expect(formatWeekHours(expandRules([{ days: [...WEEKDAYS], hours: { kind: 'allDay' } }]), OPEN, 'ru')).toBe('Пн–Вс Круглосуточно')
    expect(formatWeekHours(expandRules([rule(['mon', 'tue', 'wed', 'thu', 'sat', 'sun'], '09:00', '21:00')]), OPEN, 'en'))
      .toBe('Mon–Thu, Sat–Sun 09:00–21:00; Fri Closed')
  })

  it('№6: рейсы словами на обоих языках', () => {
    expect(formatWeekHours(expandRules([rule(WEEKDAYS, FIRST_FLIGHT, LAST_FLIGHT)]), OPEN, 'en')).toBe('Mon–Sun first flight–last flight')
    expect(formatWeekHours(expandRules([rule(WEEKDAYS, FIRST_FLIGHT, LAST_FLIGHT)]), OPEN, 'ru')).toBe('Пн–Вс с первого рейса до последнего')
    expect(formatWeekHours(expandRules([rule(W, '09:00', '21:00'), rule(E, FIRST_FLIGHT, '23:00')]), OPEN, 'ru'))
      .toBe('Пн–Пт 09:00–21:00; Сб–Вс с первого рейса до 23:00')
  })

  it('неотвеченные дни — прочерк; подпись пустого берётся у поля', () => {
    expect(formatWeekHours({ mon: { kind: 'windows', windows: [{ from: '09:00', to: '18:00' }] } }, OPEN, 'en')).toBe('Mon 09:00–18:00; Tue–Sun —')
    expect(formatWeekHours(everyDay({ kind: 'none' }), PEAK, 'en')).toBe('Mon–Sun No peak')
  })

  it('разрывной день печатает интервалы через запятую; недописанный — многоточием', () => {
    expect(formatWeekHours(everyDay({ kind: 'windows', windows: [{ from: '01:00', to: '11:00' }, { from: '12:00', to: '23:00' }] }), OPEN, 'en'))
      .toBe('Mon–Sun 01:00–11:00, 12:00–23:00')
    expect(formatWeekHours(everyDay({ kind: 'windows', windows: [{ from: '01:00', to: null }] }), OPEN, 'en')).toBe('Mon–Sun 01:00–…')
  })

  it('старый текстовый ответ печатается как есть', () => {
    expect(formatWeekHours('Monday – Saturday: 00:00 – 23:59', OPEN, 'en')).toBe('Monday – Saturday: 00:00 – 23:59')
  })

  it('dayTexts — то, что видит оператор в итоге под редактором', () => {
    const texts = dayTexts(expandRules([rule(W, '02:00', '01:00'), rule(['sat'], '10:00', '20:00')]), OPEN, 'ru')
    expect(texts.mon).toBe('02:00–01:00 (след. дня)')
    expect(texts.sat).toBe('10:00–20:00')
    expect(texts.sun).toBe('Закрыто')
  })
```

Keep the existing cells tests; update the one that asserted the old «Mon–Tue 24h; Wed Closed; Thu–Sun 24h» adjacency form to the new grouping `Mon–Tue, Thu–Sun 24h; Wed Closed`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/form-schema/__tests__/schedule.test.ts`
Expected: FAIL — `dayTexts` not exported; grouping differs.

- [ ] **Step 3: Implement**

In `schedule.ts` replace `compressDays` and the body of `formatWeekHours`:

```ts
const NEXT_DAY: Localized = { en: 'next day', ru: 'след. дня' }

/** Один диапазон правила — как его вводил оператор: ночь одной записью с
 *  пометкой, маркеры словами, пустое начало — прочерк. */
export function formatRange(range: Range, locale: 'en' | 'ru'): string {
  if (range.from === '') return UNANSWERED
  const text = formatWindow({ from: range.from, to: range.to }, locale)
  return isNightRange(range) ? `${text} (${NEXT_DAY[locale]})` : text
}

function formatRuleHours(hours: RuleHours, locale: 'en' | 'ru'): string {
  if (hours.kind === 'allDay') return ALL_DAY_LABEL[locale]
  return hours.ranges.map((r) => formatRange(r, locale)).join(', ')
}

/**
 * Текст каждого дня В ПРЕДСТАВЛЕНИИ ПРАВИЛ: ночь склеена обратно (см.
 * `collapseWeek`), закрытый день — словом поля, неотвеченный — прочерком.
 * Это один источник и для канонического текста (экран проверки, лист одной
 * анкеты), и для итога под редактором: оператор и проверяющий читают одно.
 */
export function dayTexts(week: WeekHours, options: HoursOptions, locale: 'en' | 'ru'): Record<Weekday, string> {
  const rules = collapseWeek(week)
  const out = {} as Record<Weekday, string>
  for (const day of WEEKDAYS) {
    const rule = rules.find((r) => r.days.includes(day))
    if (rule) out[day] = formatRuleHours(rule.hours, locale)
    else if (week[day]?.kind === 'none') out[day] = options.noneLabel[locale]
    else out[day] = UNANSWERED
  }
  return out
}

/** Дни с одинаковым текстом — одной группой в порядке недели: смежные —
 *  отрезком («Mon–Thu»), несмежные — через запятую («Mon–Thu, Sat–Sun»). Порядок
 *  групп — по первому дню. */
function groupDaysByText(texts: Record<Weekday, string>, locale: 'en' | 'ru'): string {
  const groups: { text: string; days: Weekday[] }[] = []
  for (const day of WEEKDAYS) {
    const group = groups.find((g) => g.text === texts[day])
    if (group) group.days.push(day)
    else groups.push({ text: texts[day], days: [day] })
  }
  return groups.map((g) => `${formatDaySpans(g.days, locale)} ${g.text}`).join('; ')
}

function formatDaySpans(days: Weekday[], locale: 'en' | 'ru'): string {
  const spans: string[] = []
  let start = 0
  for (let i = 1; i <= days.length; i += 1) {
    const adjacent = i < days.length && WEEKDAYS.indexOf(days[i]!) === WEEKDAYS.indexOf(days[i - 1]!) + 1
    if (adjacent) continue
    const first = DAY_SHORT[days[start]!][locale]
    const last = DAY_SHORT[days[i - 1]!][locale]
    spans.push(i - start === 1 ? first : `${first}–${last}`)
    start = i
  }
  return spans.join(', ')
}

export function formatWeekHours(value: unknown, options: HoursOptions, locale: 'en' | 'ru'): string {
  if (isLegacyText(value)) return value
  if (!isPlainObject(value)) return ''
  return groupDaysByText(dayTexts(value as WeekHours, options, locale), locale)
}
```

`formatDayHours` and `weekHoursCells` stay per-day (stored form) — the export column of a day must say when the lounge is open THAT day. Delete `compressDays` if nothing else uses it (`grep -rn compressDays src`).

- [ ] **Step 4: Run**

Run: `npm run typecheck && npx vitest run src/form-schema src/export src/web`
Expected: green. If `renderValues.test.ts` or `render.test.ts` pinned the old adjacency form, update the expected strings to the new grouping and say so in the commit.

- [ ] **Step 5: Break-verify**

Make `groupDaysByText` group only adjacent days → «№5» fails (`Mon–Thu 09:00–21:00; Fri Closed; Sat–Sun 09:00–21:00`). Restore. Drop the `(next day)` suffix → «№2» fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/form-schema/schedule.ts src/form-schema/__tests__/schedule.test.ts
git commit -m "feat(schema): канонический текст печатает правила — ночь одной записью, дни с одним режимом одной группой

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The rules editor

**Files:**
- Create: `src/web/RangeEditor.tsx`, `src/web/HoursRulesEditor.tsx`
- Modify: `src/i18n/dictionaries.ts` (add keys), `src/app/globals.css` (add `.hr-*` rules)
- Create: `src/web/__tests__/hoursRulesEditor.test.tsx`

**Interfaces:**
- Consumes: Tasks 1–3 (`HoursRule`, `Range`, `expandRules`, `collapseWeek`, `toggleDay`, `splitDay`, `emptyRule`, `isNightRange`, `dayTexts`, `nextWindowStart`, `hasMarker`, `FIRST_FLIGHT`, `LAST_FLIGHT`, `WEEKDAYS`, `HoursOptions`, `weekHoursProblem`).
- Produces:
  - `export function HoursRulesEditor(props: { value: unknown; options: HoursOptions; onChange: (week: WeekHours) => void; idPrefix: string }): React.JSX.Element` — SAME contract as `WeekHoursEditor`, so Task 5 is a rename at the call sites.
  - `export function RangeEditor(props: { range: Range; options: HoursOptions; onChange: (range: Range) => void; id: string }): React.JSX.Element`

- [ ] **Step 1: Add the dictionary entries**

In `src/i18n/dictionaries.ts` `UI`, add:

```ts
  'schedule.orFirstFlight': { en: 'or first flight', ru: 'или первый рейс' },
  'schedule.orLastFlight': { en: 'or last flight', ru: 'или последний рейс' },
  'schedule.fromFirstFlight': { en: 'from first flight', ru: 'с первого рейса' },
  'schedule.toLastFlight': { en: 'to last flight', ru: 'до последнего рейса' },
  'schedule.useTime': { en: 'Enter a time instead', ru: 'Указать время' },
  'schedule.nextDay': { en: 'until {to} the next day', ru: 'до {to} следующего дня' },
  'schedule.otherHours': { en: 'Other hours for some days', ru: 'Другие часы для части дней' },
  'schedule.ruleN': { en: 'Schedule {n}', ru: 'Режим {n}' },
  'schedule.weekSummary': { en: 'Week at a glance', ru: 'Итог на неделю' },
  'schedule.change': { en: 'change', ru: 'изменить' },
  'schedule.rulePickDays': { en: 'Schedule {n}: pick the days', ru: 'Режим {n}: выберите дни' },
  'schedule.ruleSetTime': { en: 'Schedule {n}: set the time', ru: 'Режим {n}: укажите время' },
  'schedule.allDayShort': { en: '24h', ru: '24ч' },
  'schedule.removeRule': { en: 'Remove this schedule', ru: 'Убрать режим' },
  'schedule.addRange': { en: 'Add an interval', ru: 'Добавить интервал' },
```

Placeholders `{n}` / `{to}` are substituted with `.replace('{n}', …)` in the component (check how `useLocale().t` handles arguments — if it has no interpolation, do the replace at the call site).

- [ ] **Step 2: Write the failing component test**

Create `src/web/__tests__/hoursRulesEditor.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FIRST_FLIGHT, LAST_FLIGHT, expandRules, type HoursOptions, type Weekday } from '@/form-schema'
import { LocaleProvider } from '@/i18n/context'
import { UI } from '@/i18n/dictionaries'
import { HoursRulesEditor } from '../HoursRulesEditor'

const OPEN: HoursOptions = { allDay: true, flightBounds: true, noneLabel: { en: 'Closed', ru: 'Закрыто' } }
const PEAK: HoursOptions = { allDay: false, flightBounds: false, noneLabel: { en: 'No peak', ru: 'Нет пика' } }
const W: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri']
const E: Weekday[] = ['sat', 'sun']
const rule = (days: Weekday[], from: string, to: string | null) => ({ days, hours: { kind: 'windows' as const, ranges: [{ from, to }] } })

/**
 * Разметка редактора правил, как её видит оператор. Среда node, DOM нет —
 * `renderToStaticMarkup`; поведение нажатий закреплено на чистых функциях
 * (`schedule.test.ts`: toggleDay, splitDay, expandRules) и сквозным
 * сценарием (`e2e/fill.spec.ts`). Здесь — что показано и чем управляется.
 */
function render(value: unknown, options: HoursOptions): string {
  return renderToStaticMarkup(
    <LocaleProvider initial="en">
      <HoursRulesEditor value={value} options={options} onChange={() => {}} idPrefix="III.1.1" />
    </LocaleProvider>,
  )
}
const pressed = (html: string) => (html.match(/aria-pressed="true"/g) ?? []).length

describe('HoursRulesEditor', () => {
  it('пустое поле открывается одним правилом на все семь дней', () => {
    const html = render(undefined, OPEN)
    expect(html.match(/class="hr-rule"/g)).toHaveLength(1)
    expect(pressed(html)).toBe(7)
    expect(html).toContain(UI['schedule.ruleN'].en.replace('{n}', '1'))
    expect(html).not.toContain('aria-label="' + UI['schedule.removeRule'].en) // единственное правило не убрать
  })

  it('два правила: дни поделены, у каждого свой крестик', () => {
    const html = render(expandRules([rule(W, '09:00', '21:00'), rule(E, '10:00', '20:00')]), OPEN)
    expect(html.match(/class="hr-rule"/g)).toHaveLength(2)
    expect(pressed(html)).toBe(7)
    expect(html.match(new RegExp(UI['schedule.removeRule'].en, 'g'))).toHaveLength(2)
    expect(html).toContain('value="09:00"')
    expect(html).toContain('value="20:00"')
  })

  it('итог на неделю — семь строк тем же текстом, что на экране проверки', () => {
    const html = render(expandRules([rule(W, '09:00', '21:00'), rule(['sat'], '10:00', '20:00')]), OPEN)
    expect(html).toContain(UI['schedule.weekSummary'].en)
    expect(html.match(/class="hr-sum-row"/g)).toHaveLength(7)
    expect(html).toContain('Closed') // воскресенье ни в одном правиле
    expect(html.match(new RegExp(UI['schedule.change'].en, 'g'))).toHaveLength(7)
  })

  it('ссылки «или первый/последний рейс» только где поле их допускает', () => {
    expect(render(undefined, OPEN)).toContain(UI['schedule.orFirstFlight'].en)
    expect(render(undefined, PEAK)).not.toContain(UI['schedule.orFirstFlight'].en)
    expect(render(undefined, PEAK)).not.toContain(UI['schedule.allDayShort'].en)
  })

  it('маркер показан словами с возвратом к времени, без поля времени', () => {
    const html = render(expandRules([rule([...W, ...E], FIRST_FLIGHT, LAST_FLIGHT)]), OPEN)
    expect(html).toContain(UI['schedule.fromFirstFlight'].en)
    expect(html).toContain(UI['schedule.toLastFlight'].en)
    expect(html).not.toContain('type="time"')
    expect(html.match(new RegExp(UI['schedule.useTime'].en, 'g'))).toHaveLength(2)
  })

  it('ночной диапазон подписан «до … следующего дня»', () => {
    const html = render(expandRules([rule([...W, ...E], '02:00', '01:00')]), OPEN)
    expect(html).toContain(UI['schedule.nextDay'].en.replace('{to}', '01:00'))
  })

  it('«добавить интервал» показана только при заполненной паре времён без маркеров', () => {
    expect(render(expandRules([rule([...W, ...E], '01:00', '11:00')]), OPEN)).toContain(UI['schedule.addRange'].en)
    expect(render(expandRules([rule([...W, ...E], '09:00', null)]), OPEN)).not.toContain(UI['schedule.addRange'].en)
    expect(render(expandRules([rule([...W, ...E], FIRST_FLIGHT, '23:00')]), OPEN)).not.toContain(UI['schedule.addRange'].en)
  })

  it('старый текстовый ответ показан с пометкой над обычным первым правилом', () => {
    const html = render('Monday – Saturday: 00:00 – 23:59', OPEN)
    expect(html).toContain('Monday – Saturday: 00:00 – 23:59')
    expect(html).toContain(UI['form.freeFormAnswer'].en)
    expect(pressed(html)).toBe(7)
  })

  it('кнопка под правилами названа задачей оператора', () => {
    expect(render(undefined, OPEN)).toContain(UI['schedule.otherHours'].en)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/web/__tests__/hoursRulesEditor.test.tsx`
Expected: FAIL — cannot resolve `../HoursRulesEditor`.

- [ ] **Step 4: Implement `RangeEditor`**

Create `src/web/RangeEditor.tsx`:

```tsx
'use client'

import type React from 'react'
import { FIRST_FLIGHT, LAST_FLIGHT, isNightRange, type HoursOptions, type Range } from '@/form-schema'
import { useLocale } from '@/i18n/context'

/**
 * Одна пара границ «с … до …». Граница — либо `<input type="time">`, либо
 * слово-маркер («с первого рейса») с возвратом к времени. Ссылка «или
 * первый рейс» стоит ПОСЛЕ поля времени и только где поле её допускает
 * (`options.flightBounds`): у пиковых часов рейсов нет.
 *
 * Правил тут нет: ночной диапазон распознаёт `isNightRange`, разбивает по
 * суткам `expandRules`; компонент лишь подписывает его оператору.
 */
export function RangeEditor(props: {
  range: Range
  options: HoursOptions
  onChange: (range: Range) => void
  id: string
}): React.JSX.Element {
  const { t } = useLocale()
  const { range, onChange } = props

  const bound = (key: 'from' | 'to', marker: string, word: string, orWord: string): React.JSX.Element => {
    const value = range[key]
    if (value === marker) {
      return (
        <span className="hr-marker">
          {word}
          <button type="button" className="hr-link" aria-label={t('schedule.useTime')} onClick={() => onChange({ ...range, [key]: key === 'from' ? '' : null })}>×</button>
        </span>
      )
    }
    return (
      <span className="hr-bound">
        <input
          id={`${props.id}-${key}`}
          type="time"
          step={300}
          aria-label={t(key === 'from' ? 'schedule.from' : 'schedule.to')}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange({ ...range, [key]: key === 'to' && e.target.value === '' ? null : e.target.value })}
        />
        {props.options.flightBounds && (
          <button type="button" className="hr-link" onClick={() => onChange({ ...range, [key]: marker })}>{orWord}</button>
        )}
      </span>
    )
  }

  return (
    <span className="hr-range">
      <span className="hr-prep">{t('schedule.from')}</span>
      {bound('from', FIRST_FLIGHT, t('schedule.fromFirstFlight'), t('schedule.orFirstFlight'))}
      <span className="hr-prep">{t('schedule.to')}</span>
      {bound('to', LAST_FLIGHT, t('schedule.toLastFlight'), t('schedule.orLastFlight'))}
      {isNightRange(range) && range.to && (
        <span className="hr-night">{t('schedule.nextDay').replace('{to}', range.to)}</span>
      )}
    </span>
  )
}
```

(`schedule.from` / `schedule.to` already exist: «From»/«С», «To»/«До». Render them lower-case via CSS `text-transform: lowercase` on `.hr-prep`, or add lower-case keys — pick one and say which in the report.)

- [ ] **Step 5: Implement `HoursRulesEditor`**

Create `src/web/HoursRulesEditor.tsx`:

```tsx
'use client'

import { useEffect, useState, type JSX } from 'react'
import {
  WEEKDAYS, collapseWeek, dayTexts, emptyRule, expandRules, hasMarker, isClock, nextWindowStart,
  splitDay, toggleDay, weekHoursProblem,
  type HoursOptions, type HoursRule, type Range, type WeekHours, type Weekday,
} from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { RangeEditor } from './RangeEditor'

/**
 * Редактор часов ПРАВИЛАМИ: «эти дни — такой режим». Список правил живёт в
 * состоянии компонента, а не выводится из значения на каждом рендере: правило,
 * у которого ещё нет дней или времени, в неделю не ложится (`expandRules` его
 * пропускает), и выведенный заново список его бы потерял — оператор нажал
 * «другие часы», а строка исчезла. Наружу уходит `expandRules(rules)` — тот же
 * `onChange`, что у любого поля; сервер видит только дни.
 *
 * Значение снаружи (первый рендер, правка командой, автосохранение вернуло
 * другое) пересобирает список через `collapseWeek`, но ТОЛЬКО когда оно
 * отличается от того, что дали бы текущие правила: иначе каждое собственное
 * сохранение стирало бы недозаполненные правила.
 */
function initialRules(value: unknown, options: HoursOptions): HoursRule[] {
  if (typeof value === 'string' || !value || typeof value !== 'object') return [emptyRule([...WEEKDAYS])]
  const week = value as WeekHours
  const clean: WeekHours = {}
  for (const day of WEEKDAYS) {
    const hours = week[day]
    if (hours !== undefined && weekHoursProblem({ [day]: hours }, options) !== 'shape' && weekHoursProblem({ [day]: hours }, options) !== 'kind') clean[day] = hours
  }
  const rules = collapseWeek(clean)
  return rules.length > 0 ? rules : [emptyRule([...WEEKDAYS])]
}

export function HoursRulesEditor(props: {
  value: unknown
  options: HoursOptions
  onChange: (week: WeekHours) => void
  idPrefix: string
}): JSX.Element {
  const { t, pick } = useLocale()
  const { options, onChange } = props
  const legacy = typeof props.value === 'string' && props.value.trim() !== '' ? props.value : null
  const [rules, setRules] = useState<HoursRule[]>(() => initialRules(props.value, options))

  const incoming = JSON.stringify(props.value ?? null)
  useEffect(() => {
    if (JSON.stringify(expandRules(rules)) !== incoming && typeof props.value !== 'string') {
      setRules(initialRules(props.value, options))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- пересборка только от внешнего значения
  }, [incoming])

  const commit = (next: HoursRule[]): void => { setRules(next); onChange(expandRules(next)) }
  const setRule = (i: number, rule: HoursRule): void => commit(rules.map((r, k) => (k === i ? rule : r)))
  const week = expandRules(rules)
  const texts = dayTexts(week, options, pick({ en: 'en', ru: 'ru' }) as 'en' | 'ru')

  const incomplete = rules.findIndex((r) => r.days.length === 0)
  const noTime = rules.findIndex((r) => r.hours.kind === 'windows' && r.hours.ranges.some((x) => x.from === ''))

  return (
    <div className="hr">
      {legacy !== null && (
        <div className="hr-legacy"><p className="hr-legacy-value">{legacy}</p><p className="field-hint">{t('form.freeFormAnswer')}</p></div>
      )}

      {rules.map((rule, i) => (
        <div className="hr-rule" key={i}>
          <p className="hr-name">{t('schedule.ruleN').replace('{n}', String(i + 1))}</p>
          <div className="hr-row">
            <span className="chip-row hr-days" role="group" aria-label={t('schedule.ruleN').replace('{n}', String(i + 1))}>
              {WEEKDAYS.map((day) => (
                <button key={day} type="button" aria-pressed={rule.days.includes(day)} aria-label={t(`schedule.day.${day}`)}
                  onClick={() => commit(toggleDay(rules, i, day))}>
                  {t(`schedule.day.${day}`).slice(0, 2)}
                </button>
              ))}
            </span>

            {rule.hours.kind === 'windows' && rule.hours.ranges.map((range, k) => (
              <RangeEditor key={k} id={`${props.idPrefix}-r${i}-${k}`} range={range} options={options}
                onChange={(next) => {
                  const ranges = (rule.hours as { ranges: Range[] }).ranges.map((x, m) => (m === k ? next : x))
                  setRule(i, { ...rule, hours: { kind: 'windows', ranges } })
                }} />
            ))}
            {rule.hours.kind === 'allDay' && <span className="hr-allday-text">{t('schedule.allDay')}</span>}

            {options.allDay && (
              <button type="button" className="hr-chip" aria-pressed={rule.hours.kind === 'allDay'}
                onClick={() => setRule(i, { ...rule, hours: rule.hours.kind === 'allDay' ? { kind: 'windows', ranges: [{ from: '', to: null }] } : { kind: 'allDay' } })}>
                {t('schedule.allDayShort')}
              </button>
            )}

            {rule.hours.kind === 'windows' && canAddRange(rule.hours.ranges) && (
              <button type="button" className="hr-link" onClick={() => {
                const ranges = (rule.hours as { ranges: Range[] }).ranges
                const start = nextWindowStart(ranges.map((x) => ({ from: x.from, to: x.to })))
                if (start) setRule(i, { ...rule, hours: { kind: 'windows', ranges: [...ranges, { from: start, to: null }] } })
              }}>{t('schedule.addRange')}</button>
            )}

            {rules.length > 1 && (
              <button type="button" className="hr-x" aria-label={t('schedule.removeRule')} onClick={() => commit(rules.filter((_, k) => k !== i))}>×</button>
            )}
          </div>
        </div>
      ))}

      <button type="button" className="hr-link hr-add" onClick={() => commit([...rules, emptyRule([])])}>{t('schedule.otherHours')}</button>

      {incomplete >= 0 && <p className="field-hint">{t('schedule.rulePickDays').replace('{n}', String(incomplete + 1))}</p>}
      {incomplete < 0 && noTime >= 0 && <p className="field-hint">{t('schedule.ruleSetTime').replace('{n}', String(noTime + 1))}</p>}

      <div className="hr-sum">
        <p className="hr-sum-title">{t('schedule.weekSummary')}</p>
        {WEEKDAYS.map((day) => (
          <div className="hr-sum-row" key={day}>
            <span className="hr-sum-day">{t(`schedule.day.${day}`)}</span>
            <span className={week[day]?.kind === 'none' ? 'hr-sum-closed' : undefined}>{texts[day]}</span>
            <button type="button" className="hr-link" onClick={() => commit(splitDay(rules, day))}>{t('schedule.change')}</button>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Второй интервал предлагается только после полной пары времён без маркеров:
 *  у интервала с маркером второго не бывает (правило схемы), у ночного —
 *  следующий начинался бы уже завтра. */
function canAddRange(ranges: Range[]): boolean {
  const last = ranges[ranges.length - 1]
  if (!last || last.to === null || hasMarker({ from: last.from, to: last.to })) return false
  return isClock(last.from) && isClock(last.to) && nextWindowStart([{ from: last.from, to: last.to }]) !== null
}
```

Read `useLocale()`'s actual API before wiring `pick`/locale (the existing editors use `t` and `pick`; the current locale code may be exposed as `locale` — use that instead of the `pick` trick if it exists). Use `Weekday` type import if needed by `splitDay` calls.

- [ ] **Step 6: Styles**

Append to `src/app/globals.css` after the `.wh-*` block (Task 5 removes `.wh-*`):

```css
/* Редактор часов правилами. Полоска дней — сегментный ряд компактных чипов
   (тот же aria-pressed-стиль, что у .chip-row). Ссылки-действия («или первый
   рейс», «изменить», «другие часы») — текстовые, а не кнопки: действие
   второго плана не должно спорить весом с полями времени. */
.hr { display: flex; flex-direction: column; gap: 10px; }
.hr-rule { padding: 8px 0; border-top: 1px solid #e4e6ea; }
.hr-rule:first-of-type { border-top: none; padding-top: 0; }
.hr-name { font-size: 12px; opacity: .6; margin: 0 0 6px; }
.hr-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.hr-days { gap: 3px; }
.hr-days button { width: 34px; height: 34px; min-width: 0; padding: 0; font-size: 13px; border-radius: 6px; }
.hr-range { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.hr-prep { font-size: 14px; opacity: .7; text-transform: lowercase; }
.hr-bound, .hr-marker { display: inline-flex; align-items: center; gap: 4px; }
.hr-range input[type='time'] { width: auto; min-width: 7rem; min-height: 36px; padding: 6px 8px; }
.hr-link { border: none; background: none; min-height: 0; padding: 0 2px; font-size: 13px; color: #2563eb; text-decoration: underline; cursor: pointer; }
.hr-chip { min-height: 34px; padding: 0 10px; font-size: 13px; border-radius: 6px; }
.hr-chip[aria-pressed='true'] { background: #2563eb; border-color: #2563eb; color: #fff; }
.hr-x { width: 34px; min-height: 34px; min-width: 0; padding: 0; font-size: 16px; opacity: .7; }
.hr-night { flex-basis: 100%; font-size: 13px; opacity: .7; }
.hr-add { align-self: flex-start; font-size: 14px; }
.hr-sum { margin-top: 6px; padding-top: 10px; border-top: 1px solid #d3d1c7; }
.hr-sum-title { font-size: 13px; font-weight: 600; margin: 0 0 6px; }
.hr-sum-row { display: grid; grid-template-columns: 7.5rem 1fr auto; gap: 6px 12px; font-size: 14px; padding: 2px 0; }
.hr-sum-day { opacity: .7; }
.hr-sum-closed { opacity: .55; }
.hr-legacy { border: 1px dashed #e4e6ea; border-radius: 8px; padding: 8px 10px; }
.hr-legacy-value { margin: 0; white-space: pre-wrap; }
@media (max-width: 640px) {
  .hr-sum-row { grid-template-columns: 5.5rem 1fr auto; }
}
```

Dark counterparts inside the existing dark block: `.hr-rule { border-top-color: #2a2d34; } .hr-sum { border-top-color: #444441; } .hr-legacy { border-color: #2a2d34; } .hr-link { color: #8fb4ff; }` — check the file for the accent the dark block already uses for links and reuse that value instead of inventing one.

- [ ] **Step 7: Run and typecheck**

Run: `npm run typecheck && npx vitest run src/web/__tests__/hoursRulesEditor.test.tsx src/web`
Expected: green (the old `scheduleEditors.test.tsx` still passes — nothing is wired yet).

- [ ] **Step 8: Break-verify**

Remove the `options.flightBounds &&` guard in `RangeEditor` → the PEAK test fails. Restore. Make `initialRules` return `[emptyRule([])]` for an empty value → the «одним правилом на все семь дней» test fails (`pressed` 0). Restore.

- [ ] **Step 9: Commit**

```bash
git add src/web/RangeEditor.tsx src/web/HoursRulesEditor.tsx src/web/__tests__/hoursRulesEditor.test.tsx src/i18n/dictionaries.ts src/app/globals.css
git commit -m "feat(fill): редактор часов правилами — полоска дней, границы-рейсы, итог на неделю с «изменить»

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Wire in, remove the day grid

**Files:**
- Modify: `src/web/FieldInput.tsx`, `src/web/CleaningScheduleEditor.tsx`
- Delete: `src/web/WeekHoursEditor.tsx`, `src/web/WindowsEditor.tsx`
- Modify: `src/form-schema/schedule.ts` (delete `dayCopyable`, `applyToAll`, `applyToWeekdays`, `applyToWeekend`, `copyPreviousDay`, `WEEKDAY_WORKDAYS`, `WEEKDAY_WEEKEND`, `nextWindowBlockedReason`, `NextWindowBlockedReason`), `src/form-schema/__tests__/schedule.test.ts` (their tests)
- Modify: `src/i18n/dictionaries.ts` (delete obsolete keys), `src/app/globals.css` (delete `.wh-*` incl. dark pairs)
- Rewrite: `src/web/__tests__/scheduleEditors.test.tsx` (drop the `WeekHoursEditor` describe; keep/adapt `CleaningScheduleEditor` and `FieldInput` describes)

- [ ] **Step 1: Wire**

`FieldInput.tsx`: replace the `WeekHoursEditor` import and JSX with `HoursRulesEditor` (same props). `CleaningScheduleEditor.tsx`: weekly branch renders `HoursRulesEditor` with `CLEANING_DAY_OPTIONS`; the `WindowsEditor` used for daily/monthly/quarterly intervals is replaced by a list of `RangeEditor`s (one per window, `options={CLEANING_DAY_OPTIONS}`) plus the same «Добавить интервал» link rule as in `HoursRulesEditor` (`canAddRange` — export it from `HoursRulesEditor.tsx` or move it to `schedule.ts` as `canAddRange(ranges: Range[]): boolean` — prefer `schedule.ts`, it is a rule). A night range in a cleaning schedule is meaningless: for cleaning, treat `isNightRange` as a form problem by NOT splitting — simplest: `CleaningScheduleEditor` writes `windows` directly (no `expandRules`), so a night pair stays `to < from` and the existing `windowsProblem` refuses it with `INVALID_CLEANING`; `RangeEditor` will still show the «next day» caption — pass a prop `night={false}` to suppress it there (add the optional prop to `RangeEditor`, default true).

- [ ] **Step 2: Delete**

Remove the two old components and the listed helpers/tests/keys/CSS. `grep -rn "WeekHoursEditor\|WindowsEditor\|applyToAll\|copyPreviousDay\|dayCopyable\|nextWindowBlockedReason\|schedule\.sameAllWeek\|schedule\.byHours\|wh-" src e2e` must return nothing except the e2e file (Task 6 rewrites it).

- [ ] **Step 3: Update `scheduleEditors.test.tsx`**

Delete the `describe('WeekHoursEditor', …)` block entirely (its subject is gone; `hoursRulesEditor.test.tsx` covers the replacement). In the `CleaningScheduleEditor` describe, the «еженедельно — недельная сетка без «24 часа»» test now asserts the rules editor: `html.match(/class="hr-rule"/g)` has length 1, no `schedule.allDayShort`, no `schedule.orFirstFlight`, and `No cleaning` appears in the summary. In the `FieldInput` describe: III.1.1 renders `hr-rule` with «24h» chip and «or first flight»; III.1.3 renders `hr-rule` without either.

- [ ] **Step 4: Gates**

Run: `npm run typecheck && caffeinate -dimsu npx vitest run`
Expected: whole unit suite green.

- [ ] **Step 5: Commit**

```bash
git add -A src/web src/form-schema src/i18n src/app/globals.css
git commit -m "refactor(fill): сетка по дням и её быстрые действия удалены — оба расписания идут через редактор правил

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: End-to-end, gates, browser

**Files:**
- Modify: `e2e/fill.spec.ts` (replace the two schedule tests at ~437 and ~536)

- [ ] **Step 1: Rewrite the e2e**

Delete the test «“+ интервал”: недоступна с объяснением …» (feature removed). Replace the «расписание: …» test with the walkthrough:

```ts
test('расписание правилами: время на все дни, «изменить» у субботы, «или первый рейс», ночь, итог — и всё это с сервера после перезагрузки', async ({ page }) => {
  const url = seed()
  await page.goto(url)
  await clickNext(page, 2)
  await expect(page.getByRole('heading', { name: 'Operating Schedule', level: 1 })).toBeVisible()

  const hours = page.locator('.field').filter({ hasText: 'Lounge Operating Hours' })
  const rules = hours.locator('.hr-rule')
  const summaryRow = (day: string) => hours.locator('.hr-sum-row').filter({ hasText: day })

  // Одно правило на все дни: ввёл время — итог заполнился на всю неделю.
  await expect(rules).toHaveCount(1)
  await rules.nth(0).locator('input[type="time"]').nth(0).fill('09:00')
  await rules.nth(0).locator('input[type="time"]').nth(1).fill('21:00')
  await expect(page.getByText('Saved')).toBeVisible()
  await expect(summaryRow('Sunday')).toContainText('09:00–21:00')

  // «Изменить» у субботы рождает правило 2 уже с субботой.
  await summaryRow('Saturday').getByRole('button', { name: 'change' }).click()
  await expect(rules).toHaveCount(2)
  await expect(rules.nth(1).getByRole('button', { name: 'Saturday' })).toHaveAttribute('aria-pressed', 'true')
  await expect(rules.nth(0).getByRole('button', { name: 'Saturday' })).toHaveAttribute('aria-pressed', 'false')
  await expect(summaryRow('Saturday')).toContainText('—')

  // Воскресенье — в правило 2 нажатием, оно гаснет в правиле 1.
  await rules.nth(1).getByRole('button', { name: 'Sunday' }).click()
  await expect(rules.nth(0).getByRole('button', { name: 'Sunday' })).toHaveAttribute('aria-pressed', 'false')

  // Выходные: с первого рейса до 23:00.
  await rules.nth(1).getByRole('button', { name: 'or first flight' }).click()
  await expect(rules.nth(1).getByText('from first flight')).toBeVisible()
  await rules.nth(1).locator('input[type="time"]').fill('23:00')
  await expect(page.getByText('Saved')).toBeVisible()
  await expect(summaryRow('Saturday')).toContainText('first flight–23:00')

  // Пиковые: ни «24h», ни рейсов.
  const peak = page.locator('.field').filter({ hasText: 'Peak Hours' })
  await expect(peak.getByRole('button', { name: '24h' })).toHaveCount(0)
  await expect(peak.getByRole('button', { name: 'or first flight' })).toHaveCount(0)

  // Перезагрузка: два правила и тот же итог пришли с сервера.
  await page.reload()
  await clickNext(page, 2)
  await expect(hours.locator('.hr-rule')).toHaveCount(2)
  await expect(summaryRow('Monday')).toContainText('09:00–21:00')
  await expect(summaryRow('Sunday')).toContainText('first flight–23:00')
})

test('расписание правилами: ночной график вводится как есть и читается обратно; наезд хвоста на свой интервал не роняет редактор', async ({ page }) => {
  const url = seed()
  await page.goto(url)
  await clickNext(page, 2)
  const hours = page.locator('.field').filter({ hasText: 'Lounge Operating Hours' })
  const rules = hours.locator('.hr-rule')
  const summaryRow = (day: string) => hours.locator('.hr-sum-row').filter({ hasText: day })

  await rules.nth(0).locator('input[type="time"]').nth(0).fill('02:00')
  await rules.nth(0).locator('input[type="time"]').nth(1).fill('01:00')
  await expect(rules.nth(0).getByText('until 01:00 the next day')).toBeVisible()
  await expect(page.getByText('Saved')).toBeVisible()
  await expect(summaryRow('Monday')).toContainText('02:00–01:00 (next day)')

  // Хвост понедельника (00:00–01:00 во вторник) наезжает на свой интервал вторника → отказ виден, правила на месте.
  await summaryRow('Tuesday').getByRole('button', { name: 'change' }).click()
  await rules.nth(1).locator('input[type="time"]').nth(0).fill('00:30')
  await rules.nth(1).locator('input[type="time"]').nth(1).fill('10:00')
  await expect(page.getByText('Check the schedule: times must run forward and windows must not overlap')).toBeVisible()
  await expect(rules).toHaveCount(2)
  await rules.nth(1).locator('input[type="time"]').nth(0).fill('02:00')
  await expect(page.getByText('Saved')).toBeVisible()

  await page.reload()
  await clickNext(page, 2)
  await expect(summaryRow('Monday')).toContainText('02:00–01:00 (next day)')
  await expect(summaryRow('Tuesday')).toContainText('02:00–10:00')
})
```

Adapt locators to what the app renders (read the components first); explain deviations in the test comments. The review-screen text for this data is pinned by unit tests — do not add a review e2e step unless one already exists to adapt.

- [ ] **Step 2: Run**

`caffeinate -dimsu npx playwright test e2e/fill.spec.ts -g "расписание правилами"`, then the whole suite `caffeinate -dimsu npx playwright test`. Known flake: review.spec «правка из устаревшей вкладки» — rerun alone once if it alone fails.

- [ ] **Step 3: Commit**

```bash
git add e2e/fill.spec.ts
git commit -m "test(e2e): расписание правилами — «изменить» у дня, рейсы, ночь, итог с сервера

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 4: Four gates, then browser check**

`npm run typecheck`; `caffeinate -dimsu npx vitest run`; `caffeinate -dimsu npm run build`; `caffeinate -dimsu npx playwright test`. Browser (next-dev): the six patterns from the spec table at 1280 and 375, light and dark; the review editor pencil on III.1.1 shows the rules editor and saving updates the row's canonical text; the flat xlsx has per-day cells with the split night form and marker words. Then present the finishing menu and WAIT.

---

## Self-review

- **Spec coverage.** Markers as boundaries, `flightBounds` on III.1.1 only, marker-only-window rule, no night for markers → Task 1. Rules model, night split to next day, `to===from` refusal, tail overlap refusal, unanswered vs closed, exclusivity, `splitDay` → Task 2. Canonical text by rules with «(next day)», non-adjacent grouping, `noneLabel`, per-day cells unchanged → Task 3. Editor: first rule all days, «Режим N», day strip, links «или … рейс», «24ч», night caption, add-interval only for complete clock pairs, «×» only with >1 rule, «Другие часы для части дней», summary with «изменить», one incompleteness line, legacy note → Task 4. Removal of the grid, bulk actions, per-day markers and dictionary keys → Task 5. e2e, gates, browser → Task 6.
- **Placeholder scan.** None.
- **Type consistency.** `Range`, `HoursRule`, `RuleHours`, `expandRules`, `collapseWeek`, `toggleDay`, `splitDay`, `emptyRule`, `isNightRange`, `dayTexts`, `formatRange`, `FIRST_FLIGHT`, `LAST_FLIGHT`, `hasMarker`, `isStartBound`, `isEndBound`, `HoursOptions.flightBounds`, `HoursRulesEditor`, `RangeEditor` spelled identically across tasks. `formatWindows` gains a `locale` parameter in Task 1 and is called with it everywhere after.
