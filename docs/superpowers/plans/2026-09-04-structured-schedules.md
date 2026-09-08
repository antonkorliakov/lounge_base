# Structured Schedules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the free-text answers of three schedule fields (III.1.1 Lounge Operating Hours, III.1.3 Peak Hours, III.1.4 Deep Cleaning Schedule) with two structured field types, a day-grid editor with quick actions, a server-side gate, canonical rendering and per-weekday export columns.

**Architecture:** All schedule rules live in one pure module `src/form-schema/schedule.ts` — types, validation, completeness, quick actions, canonical text, export cells. `validateField` and `FieldInput` only call it. Three React components (`WindowsEditor` → `WeekHoursEditor` → `CleaningScheduleEditor`) compose bottom-up and hold no rules of their own. No DB migration: `field_values.value` is `jsonb` and the structure goes in the same column.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Drizzle/Postgres, vitest (node env — component tests use `renderToStaticMarkup`, there is no DOM library), Playwright e2e against local docker Postgres, exceljs for xlsx.

Spec: `docs/superpowers/specs/2026-09-04-structured-schedules-design.md`.

## Global Constraints

- Read `node_modules/next/dist/docs/` before touching framework code (AGENTS.md rule).
- One rule in one place: every schedule rule (time format, window ordering, completeness, quick actions, canonical text, export cells) exists only in `src/form-schema/schedule.ts`. `validation.ts`, `completeness.ts`, `FieldInput.tsx`, the three editors, `columns.ts`, `rows.ts` and the seed only call it.
- `src/form-schema/*` must stay pure: no React, no DOM, no `@/web` imports (`purity.test.ts` enforces it).
- Pure helpers never live in a `'use client'` module — the editors import from `@/form-schema`, never reimplement.
- Time format `HH:MM`, 24-hour. `from` is `00:00`–`23:59`; `to` is `00:01`–`24:00` or `null` (unfinished). `to > from` always — no window crosses midnight.
- Windows in a day: sorted by `from`, non-overlapping; touching allowed (`…–11:00` then `11:00–…`).
- Weekday order everywhere: `mon tue wed thu fri sat sun`.
- III.1.1 `hoursOptions = { allDay: true, noneLabel: { en: 'Closed', ru: 'Закрыто' } }`; III.1.3 `hoursOptions = { allDay: false, noneLabel: { en: 'No peak', ru: 'Нет пика' } }`. `{ kind: 'allDay' }` on a field with `allDay: false` is a server refusal.
- `null`/`undefined` = a cleared answer (never a format refusal) — the review editor turns `undefined` into `null` (`src/review/edit.ts:113`). Same rule as the contact fields.
- Refusal texts are `Localized` (`{ en, ru }`) declared in `validation.ts` next to `REQUIRED`; the client shows what the server returned and never restates it.
- Unfinished window (`to: null`) SAVES but leaves the questionnaire incomplete — a refusal there would destroy the draft mid-typing.
- Legacy free-text answers are never rewritten: they display verbatim with the note `form.freeFormAnswer` (`{ en: 'Free-form answer from an earlier version', ru: 'Ответ в свободной форме, из прежней версии' }`).
- Every colour has a dark-mode counterpart; state buttons reuse the existing `aria-pressed` styling (`.avail-toggle`, `.chip-row` in `globals.css`).
- Comments explain WHY and must not assert premises the code does not check.
- Every test is break-verified: after it passes, flip the rule it pins, watch it fail naming the case, restore. Note the observation in the report.
- Long commands (`npm test`, playwright, build) run under `caffeinate -dimsu` — the laptop sleeps after one minute idle and kills runs.
- Commit per task, Russian subject, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Docker Postgres must be up for db-touching tests: `docker compose up -d`.

## File Map

- Create `src/form-schema/schedule.ts` — the whole rule set (types, validation, completeness, quick actions, formatting, export cells).
- Create `src/form-schema/__tests__/schedule.test.ts` — its tests.
- Modify `src/form-schema/index.ts` — `export * from './schedule'`.
- Modify `src/form-schema/fields.ts` — `FieldType` gains `'weekHours' | 'cleaningSchedule'`; `Field` gains `hoursOptions`; three fields retyped.
- Modify `src/form-schema/validation.ts` — two `case` branches + two refusal texts.
- Modify `src/form-schema/render.ts` — `formatFieldValue` routes the two types to `schedule.ts`.
- Modify `src/submissions/completeness.ts` — uses `fieldAnswered`.
- Create `src/web/WindowsEditor.tsx`, `src/web/WeekHoursEditor.tsx`, `src/web/CleaningScheduleEditor.tsx`.
- Modify `src/web/FieldInput.tsx` — two new cases.
- Modify `src/app/globals.css` — grid/rows/windows styles with dark pairs.
- Modify `src/export/columns.ts`, `src/export/rows.ts`, `src/export/__tests__/columns.test.ts`.
- Modify `scripts/seed-dev.ts`, `e2e/fill.spec.ts`.
- Tests touched: `fields.test.ts`, `validation.test.ts`, `completeness.test.ts`, `render.test.ts`, `roundtrip.test.ts`, plus new `src/web/__tests__/scheduleEditors.test.tsx`.

---

### Task 1: Schedule types and the validation core

**Files:**
- Create: `src/form-schema/schedule.ts`
- Create: `src/form-schema/__tests__/schedule.test.ts`
- Modify: `src/form-schema/index.ts`

**Interfaces:**
- Produces:
  - `export const WEEKDAYS = ['mon','tue','wed','thu','fri','sat','sun'] as const`
  - `export type Weekday = (typeof WEEKDAYS)[number]`
  - `export const NTHS = [1, 2, 3, 4, 'last'] as const`; `export type Nth = (typeof NTHS)[number]`
  - `export const CADENCES = ['daily','weekly','monthly','quarterly'] as const`; `export type Cadence = (typeof CADENCES)[number]`
  - `export type Window = { from: string; to: string | null }`
  - `export type DayHours = { kind: 'allDay' } | { kind: 'none' } | { kind: 'windows'; windows: Window[] }`
  - `export type WeekHours = Partial<Record<Weekday, DayHours>>`
  - `export type HoursOptions = { allDay: boolean; noneLabel: Localized }`
  - `export type CleaningSchedule = { cadence: 'daily'; windows: Window[] } | { cadence: 'weekly'; days: WeekHours } | { cadence: 'monthly' | 'quarterly'; nth: Nth; weekday: Weekday; windows: Window[] }`
  - `export const END_OF_DAY = '24:00'`
  - `export function isClock(value: unknown): value is string`
  - `export function clockMinutes(clock: string): number`
  - `export type WindowsProblem = 'shape' | 'clock' | 'order' | 'overlap' | 'empty' | null`
  - `export function windowsProblem(value: unknown): WindowsProblem`
  - `export function weekHoursProblem(value: unknown, options: HoursOptions): 'shape' | 'day' | 'kind' | 'allDayNotAllowed' | WindowsProblem`
  - `export function cleaningProblem(value: unknown, ): 'shape' | 'cadence' | 'nth' | 'day' | WindowsProblem | 'kind' | 'allDayNotAllowed'`
  - `export const CLEANING_DAY_OPTIONS: HoursOptions` (`{ allDay: false, noneLabel: { en: 'No cleaning', ru: 'Без уборки' } }`)

`*Problem` functions return `null` when the value is well-formed and a short reason tag otherwise. Task 4 maps the tag to one `Localized` refusal per field type — the tags exist so tests can name the exact rule that fired.

- [ ] **Step 1: Write the failing tests**

Create `src/form-schema/__tests__/schedule.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  WEEKDAYS,
  NTHS,
  CADENCES,
  END_OF_DAY,
  isClock,
  clockMinutes,
  windowsProblem,
  weekHoursProblem,
  cleaningProblem,
  CLEANING_DAY_OPTIONS,
  type HoursOptions,
  type WeekHours,
} from '../schedule'

const OPEN: HoursOptions = { allDay: true, noneLabel: { en: 'Closed', ru: 'Закрыто' } }
const PEAK: HoursOptions = { allDay: false, noneLabel: { en: 'No peak', ru: 'Нет пика' } }

/** Полная неделя одним видом — короче, чем перечислять семь ключей в каждом тесте. */
function everyDay(day: WeekHours[Weekday]): WeekHours {
  return Object.fromEntries(WEEKDAYS.map((d) => [d, day])) as WeekHours
}
type Weekday = (typeof WEEKDAYS)[number]

describe('константы порядка', () => {
  it('дни недели — понедельник первым, семь штук', () => {
    expect(WEEKDAYS).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
  })

  it('порядковые номера дня месяца и периодичности закреплены', () => {
    expect(NTHS).toEqual([1, 2, 3, 4, 'last'])
    expect(CADENCES).toEqual(['daily', 'weekly', 'monthly', 'quarterly'])
  })
})

describe('isClock и clockMinutes', () => {
  it.each(['00:00', '09:05', '23:59', '24:00'])('принимает %s', (v) => {
    expect(isClock(v)).toBe(true)
  })

  it.each(['9:05', '24:01', '25:00', '12:60', '12', '12:5', '', ' 12:00', '12:00 ', 900, null])(
    'отклоняет %s',
    (v) => {
      expect(isClock(v)).toBe(false)
    },
  )

  it('минуты от полуночи — то, по чему сравниваются границы', () => {
    expect(clockMinutes('00:00')).toBe(0)
    expect(clockMinutes('09:05')).toBe(545)
    expect(clockMinutes(END_OF_DAY)).toBe(1440)
  })
})

describe('windowsProblem — список интервалов одного дня', () => {
  it('корректный список: непересекающиеся по возрастанию, касание разрешено', () => {
    expect(windowsProblem([{ from: '01:00', to: '11:00' }, { from: '11:00', to: '23:00' }])).toBe(null)
    expect(windowsProblem([{ from: '00:00', to: END_OF_DAY }])).toBe(null)
  })

  it('недописанный интервал — не ошибка формы (черновик сохраняется)', () => {
    expect(windowsProblem([{ from: '01:00', to: null }])).toBe(null)
  })

  it.each([
    [[], 'empty'],
    ['not an array', 'shape'],
    [[{ from: '01:00' }], 'shape'],
    [[{ from: '1:00', to: '11:00' }], 'clock'],
    [[{ from: '01:00', to: '01:00' }], 'order'],
    [[{ from: '11:00', to: '01:00' }], 'order'],
    [[{ from: END_OF_DAY, to: null }], 'clock'],
    [[{ from: '11:00', to: '12:00' }, { from: '01:00', to: '02:00' }], 'order'],
    [[{ from: '01:00', to: '12:00' }, { from: '11:00', to: '13:00' }], 'overlap'],
  ])('отклоняет %j как %s', (value, expected) => {
    expect(windowsProblem(value)).toBe(expected)
  })

  it('недописанный интервал не мешает проверить порядок остальных', () => {
    expect(windowsProblem([{ from: '05:00', to: null }, { from: '01:00', to: '02:00' }])).toBe('order')
  })
})

describe('weekHoursProblem', () => {
  it('частичная неделя корректна: незаполненный день — «не отвечено», а не ошибка', () => {
    expect(weekHoursProblem({ mon: { kind: 'allDay' } }, OPEN)).toBe(null)
    expect(weekHoursProblem({}, OPEN)).toBe(null)
  })

  it('полная неделя всех трёх видов', () => {
    expect(weekHoursProblem(everyDay({ kind: 'none' }), OPEN)).toBe(null)
    expect(
      weekHoursProblem(everyDay({ kind: 'windows', windows: [{ from: '06:00', to: '09:00' }] }), PEAK),
    ).toBe(null)
  })

  it('круглосуточно там, где поле его не разрешает — отказ', () => {
    expect(weekHoursProblem({ mon: { kind: 'allDay' } }, PEAK)).toBe('allDayNotAllowed')
  })

  it.each([
    ['not an object', 'shape'],
    [[], 'shape'],
    [{ funday: { kind: 'none' } }, 'day'],
    [{ mon: { kind: 'sometimes' } }, 'kind'],
    [{ mon: { kind: 'windows' } }, 'shape'],
    [{ mon: { kind: 'windows', windows: [] } }, 'empty'],
    [{ mon: { kind: 'windows', windows: [{ from: '11:00', to: '01:00' }] } }, 'order'],
  ])('отклоняет %j как %s', (value, expected) => {
    expect(weekHoursProblem(value, OPEN)).toBe(expected)
  })
})

describe('cleaningProblem', () => {
  it('все четыре периодичности в корректном виде', () => {
    expect(cleaningProblem({ cadence: 'daily', windows: [{ from: '14:30', to: '15:00' }] })).toBe(null)
    expect(
      cleaningProblem({ cadence: 'weekly', days: { mon: { kind: 'windows', windows: [{ from: '02:00', to: '04:00' }] } } }),
    ).toBe(null)
    expect(
      cleaningProblem({ cadence: 'monthly', nth: 1, weekday: 'mon', windows: [{ from: '22:00', to: '23:30' }] }),
    ).toBe(null)
    expect(
      cleaningProblem({ cadence: 'quarterly', nth: 'last', weekday: 'sun', windows: [{ from: '01:00', to: '05:00' }] }),
    ).toBe(null)
  })

  it('еженедельная уборка не знает «круглосуточно» — тот же запрет, что у пиковых часов', () => {
    expect(CLEANING_DAY_OPTIONS.allDay).toBe(false)
    expect(cleaningProblem({ cadence: 'weekly', days: { mon: { kind: 'allDay' } } })).toBe('allDayNotAllowed')
  })

  it.each([
    ['not an object', 'shape'],
    [{ cadence: 'yearly', windows: [] }, 'cadence'],
    [{ cadence: 'daily' }, 'shape'],
    [{ cadence: 'daily', windows: [] }, 'empty'],
    [{ cadence: 'weekly', days: 'mon' }, 'shape'],
    [{ cadence: 'monthly', nth: 5, weekday: 'mon', windows: [{ from: '01:00', to: '02:00' }] }, 'nth'],
    [{ cadence: 'monthly', nth: 1, weekday: 'funday', windows: [{ from: '01:00', to: '02:00' }] }, 'day'],
    [{ cadence: 'quarterly', nth: 1, weekday: 'mon', windows: [{ from: '02:00', to: '01:00' }] }, 'order'],
  ])('отклоняет %j как %s', (value, expected) => {
    expect(cleaningProblem(value)).toBe(expected)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/form-schema/__tests__/schedule.test.ts`
Expected: FAIL — `Failed to resolve import "../schedule"`.

- [ ] **Step 3: Write the module**

Create `src/form-schema/schedule.ts`:

```ts
/**
 * Правила расписаний — недельных часов (`weekHours`: III.1.1 часы работы,
 * III.1.3 пиковые часы) и графика уборки (`cleaningSchedule`: III.1.4).
 * Живут здесь, в чистой части схемы, потому что их читают трое: редакторы в
 * браузере (какие состояния и кнопки показывать, что делают быстрые
 * действия), серверная проверка в `validation.ts` (что можно сохранить и
 * что считается заполненным) и выгрузка (`export/columns.ts`, `rows.ts` —
 * ячейка на день недели). Три копии правил разошлись бы: браузер собрал бы
 * значение, которое сервер не принимает, или файл напечатал бы день, которого
 * в структуре нет.
 *
 * Ночные интервалы через полночь не поддерживаются СОЗНАТЕЛЬНО (решение
 * пользователя): «22:00–02:00» вводится как «22:00–24:00» сегодня и
 * «00:00–02:00» завтра. Поэтому конец интервала всегда больше начала, и
 * сравнение границ — обычное сравнение минут от полуночи, без ветки «а вдруг
 * это следующий день».
 */
import type { Localized } from './types'

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Weekday = (typeof WEEKDAYS)[number]

export const NTHS = [1, 2, 3, 4, 'last'] as const
export type Nth = (typeof NTHS)[number]

export const CADENCES = ['daily', 'weekly', 'monthly', 'quarterly'] as const
export type Cadence = (typeof CADENCES)[number]

/** Конец суток. `<input type="time">` такого значения не принимает, поэтому в
 *  редакторе он ставится кнопкой «до конца дня» (см. `WindowsEditor`), а здесь
 *  он законное значение `to` — иначе «работаем до полуночи» пришлось бы писать
 *  как 23:59 и терять минуту. */
export const END_OF_DAY = '24:00'

export type Window = { from: string; to: string | null }

export type DayHours =
  | { kind: 'allDay' }
  | { kind: 'none' }
  | { kind: 'windows'; windows: Window[] }

export type WeekHours = Partial<Record<Weekday, DayHours>>

export type HoursOptions = {
  /** Есть ли у дня состояние «круглосуточно». У часов работы есть, у пиковых
   *  часов и у еженедельной уборки — нет: «пик круглые сутки» и «уборка
   *  круглые сутки» это не ответы, а недоразумение. */
  allDay: boolean
  /** Подпись пустого состояния дня: «Closed» у часов работы, «No peak» у
   *  пиковых. Одно и то же состояние (`kind: 'none'`) читается по-разному в
   *  зависимости от вопроса, поэтому подпись живёт у поля, а не в структуре. */
  noneLabel: Localized
}

export type CleaningSchedule =
  | { cadence: 'daily'; windows: Window[] }
  | { cadence: 'weekly'; days: WeekHours }
  | { cadence: 'monthly' | 'quarterly'; nth: Nth; weekday: Weekday; windows: Window[] }

/** Дни еженедельной уборки — та же недельная сетка, что у часов, но без
 *  «круглосуточно» и с подписью «без уборки». */
export const CLEANING_DAY_OPTIONS: HoursOptions = {
  allDay: false,
  noneLabel: { en: 'No cleaning', ru: 'Без уборки' },
}

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/

export function isClock(value: unknown): value is string {
  if (typeof value !== 'string') return false
  return value === END_OF_DAY || CLOCK.test(value)
}

/** Минуты от полуночи: 0..1440 (1440 — только `END_OF_DAY`). Единственный
 *  способ сравнивать границы — строки сравнивать нельзя даже при нулевом
 *  паддинге, потому что '24:00' лексикографически меньше '3:00' был бы
 *  верным лишь случайно. */
export function clockMinutes(clock: string): number {
  if (clock === END_OF_DAY) return 24 * 60
  const [hours, minutes] = clock.split(':')
  return Number(hours) * 60 + Number(minutes)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type WindowsProblem = 'shape' | 'clock' | 'order' | 'overlap' | 'empty' | null

/**
 * Что не так со списком интервалов одного дня, или `null`, если всё в порядке.
 * Пустой список — `empty`: день с состоянием «по часам» и без интервалов не
 * значит ничего, для «не работаем» есть `kind: 'none'`.
 *
 * Недописанный интервал (`to: null`) формой НЕ нарушен: оператор только что
 * нажал «+ интервал», отказ на этом месте уносил бы черновик. Незаполненность
 * ловит `weekHoursComplete` (Task 3), то есть отправка, а не сохранение.
 * Порядок при этом проверяется по `from`, который есть всегда.
 */
export function windowsProblem(value: unknown): WindowsProblem {
  if (!Array.isArray(value)) return 'shape'
  if (value.length === 0) return 'empty'

  let previousEnd = -1
  let previousStart = -1
  for (const window of value) {
    if (!isPlainObject(window) || !('from' in window) || !('to' in window)) return 'shape'
    const { from, to } = window as { from: unknown; to: unknown }
    // `from` не может быть концом суток: интервал, начинающийся в 24:00, пуст.
    if (!isClock(from) || from === END_OF_DAY) return 'clock'
    if (to !== null && !isClock(to)) return 'clock'

    const start = clockMinutes(from)
    if (start <= previousStart) return 'order'
    if (to !== null) {
      const end = clockMinutes(to)
      if (end <= start) return 'order'
      if (previousEnd > start) return 'overlap'
      previousEnd = end
    }
    previousStart = start
  }
  return null
}

export type WeekHoursProblem =
  | 'shape'
  | 'day'
  | 'kind'
  | 'allDayNotAllowed'
  | Exclude<WindowsProblem, null>
  | null

/** Что не так со недельной сеткой, или `null`. Отсутствующий день — «не
 *  отвечено»: это законное состояние черновика, полноту считает
 *  `weekHoursComplete` (Task 3). */
export function weekHoursProblem(value: unknown, options: HoursOptions): WeekHoursProblem {
  if (!isPlainObject(value)) return 'shape'

  for (const [day, hours] of Object.entries(value)) {
    if (!(WEEKDAYS as readonly string[]).includes(day)) return 'day'
    if (!isPlainObject(hours)) return 'shape'
    const kind = (hours as { kind?: unknown }).kind
    if (kind === 'allDay') {
      if (!options.allDay) return 'allDayNotAllowed'
      continue
    }
    if (kind === 'none') continue
    if (kind !== 'windows') return 'kind'
    const problem = windowsProblem((hours as { windows?: unknown }).windows)
    if (problem) return problem
  }
  return null
}

export type CleaningProblem = 'cadence' | 'nth' | WeekHoursProblem

/** Что не так с графиком уборки, или `null`. */
export function cleaningProblem(value: unknown): CleaningProblem {
  if (!isPlainObject(value)) return 'shape'
  const cadence = value.cadence
  if (typeof cadence !== 'string' || !(CADENCES as readonly string[]).includes(cadence)) {
    return 'cadence'
  }

  if (cadence === 'weekly') return weekHoursProblem(value.days, CLEANING_DAY_OPTIONS)

  if (cadence === 'monthly' || cadence === 'quarterly') {
    if (!(NTHS as readonly unknown[]).includes(value.nth)) return 'nth'
    if (typeof value.weekday !== 'string' || !(WEEKDAYS as readonly string[]).includes(value.weekday)) {
      return 'day'
    }
  }
  return windowsProblem(value.windows)
}
```

Add to `src/form-schema/index.ts` after the `./contact` line:

```ts
export * from './schedule'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/form-schema`
Expected: PASS, including `purity.test.ts`.

- [ ] **Step 5: Break-verify**

Change `if (previousEnd > start) return 'overlap'` to `>=` → the touching-windows case (`01:00–11:00`, `11:00–23:00`) fails. Restore. Change `if (from === END_OF_DAY) return 'clock'` to allow it → the `[{from:'24:00',to:null}]` case fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/form-schema/schedule.ts src/form-schema/__tests__/schedule.test.ts src/form-schema/index.ts
git commit -m "feat(schema): типы расписаний и правила формы — интервалы, недельная сетка, периодичность уборки

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Completeness and quick actions

**Files:**
- Modify: `src/form-schema/schedule.ts`
- Modify: `src/form-schema/__tests__/schedule.test.ts`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces:
  - `export function windowsFinished(windows: Window[]): boolean`
  - `export function weekHoursComplete(value: unknown, options: HoursOptions): boolean`
  - `export function cleaningComplete(value: unknown): boolean`
  - `export function applyToAll(week: WeekHours, from: Weekday): WeekHours`
  - `export function applyToWeekdays(week: WeekHours, from: Weekday): WeekHours`
  - `export function applyToWeekend(week: WeekHours, from: Weekday): WeekHours`
  - `export function copyPreviousDay(week: WeekHours, day: Weekday): WeekHours`
  - `export function switchCadence(current: CleaningSchedule | null, cadence: Cadence): CleaningSchedule`
  - `export const WEEKDAY_WORKDAYS: readonly Weekday[]` (`mon`…`fri`), `export const WEEKDAY_WEEKEND: readonly Weekday[]` (`sat`, `sun`)

- [ ] **Step 1: Write the failing tests**

Append to `src/form-schema/__tests__/schedule.test.ts` (extend the import list with the new names):

```ts
describe('полнота недельной сетки', () => {
  const windows = [{ from: '01:00', to: '11:00' }]

  it('отвечены все семь дней и хотя бы один открыт — заполнено', () => {
    expect(weekHoursComplete(everyDay({ kind: 'windows', windows }), OPEN)).toBe(true)
    expect(
      weekHoursComplete({ ...everyDay({ kind: 'none' }), mon: { kind: 'allDay' } }, OPEN),
    ).toBe(true)
  })

  it('не все дни отвечены — не заполнено', () => {
    const week = everyDay({ kind: 'none' }) as Record<string, unknown>
    delete week.sun
    expect(weekHoursComplete(week, OPEN)).toBe(false)
  })

  it('вся неделя пустая — не заполнено: лаунж, закрытый всегда, это не ответ', () => {
    expect(weekHoursComplete(everyDay({ kind: 'none' }), OPEN)).toBe(false)
    expect(weekHoursComplete(everyDay({ kind: 'none' }), PEAK)).toBe(false)
  })

  it('недописанный интервал — сохраняется, но не заполнено', () => {
    const week = everyDay({ kind: 'windows', windows: [{ from: '01:00', to: null }] })
    expect(weekHoursProblem(week, OPEN)).toBe(null)
    expect(weekHoursComplete(week, OPEN)).toBe(false)
  })

  it('сломанное по форме значение не заполнено (а не бросает)', () => {
    expect(weekHoursComplete('mon 9-5', OPEN)).toBe(false)
    expect(weekHoursComplete(null, OPEN)).toBe(false)
  })
})

describe('полнота графика уборки', () => {
  it('каждая периодичность с дописанными интервалами — заполнено', () => {
    expect(cleaningComplete({ cadence: 'daily', windows: [{ from: '14:30', to: '15:00' }] })).toBe(true)
    expect(
      cleaningComplete({ cadence: 'monthly', nth: 1, weekday: 'mon', windows: [{ from: '22:00', to: '23:30' }] }),
    ).toBe(true)
    expect(
      cleaningComplete({ cadence: 'weekly', days: { ...everyDay({ kind: 'none' }), mon: { kind: 'windows', windows: [{ from: '02:00', to: '04:00' }] } } }),
    ).toBe(true)
  })

  it('еженедельная без единого дня с интервалами — не заполнено', () => {
    expect(cleaningComplete({ cadence: 'weekly', days: everyDay({ kind: 'none' }) })).toBe(false)
  })

  it('недописанный интервал — не заполнено', () => {
    expect(cleaningComplete({ cadence: 'daily', windows: [{ from: '14:30', to: null }] })).toBe(false)
  })

  it('старый текстовый ответ — не заполнено: его надо ввести заново структурой', () => {
    expect(cleaningComplete('Every day: 14:30 – 15:00')).toBe(false)
  })
})

describe('быстрые действия — чистые функции над неделей', () => {
  const mon = { kind: 'windows', windows: [{ from: '09:00', to: '18:00' }] } as const

  it('«одинаково всю неделю» раскладывает день-источник на все семь', () => {
    const out = applyToAll({ mon, sun: { kind: 'none' } }, 'mon')
    expect(Object.keys(out).sort()).toEqual([...WEEKDAYS].sort())
    for (const day of WEEKDAYS) expect(out[day], day).toEqual(mon)
  })

  it('«на будни» не трогает выходные, «на выходные» не трогает будни', () => {
    const week = applyToWeekdays({ mon, sat: { kind: 'none' } }, 'mon')
    expect(WEEKDAY_WORKDAYS.every((d) => week[d]?.kind === 'windows')).toBe(true)
    expect(week.sat).toEqual({ kind: 'none' })
    expect(week.sun).toBeUndefined()

    const weekend = applyToWeekend({ mon, sat: { kind: 'none' } }, 'mon')
    expect(WEEKDAY_WEEKEND.every((d) => weekend[d]?.kind === 'windows')).toBe(true)
    expect(weekend.tue).toBeUndefined()
  })

  it('«как в предыдущем дне» берёт соседа слева; у понедельника соседа нет', () => {
    expect(copyPreviousDay({ mon }, 'tue').tue).toEqual(mon)
    expect(copyPreviousDay({ mon }, 'mon')).toEqual({ mon })
    // Предыдущий день не отвечен — копировать нечего, неделя не меняется.
    expect(copyPreviousDay({ mon }, 'thu')).toEqual({ mon })
  })

  it('источник не мутируется — редактор кладёт результат в состояние React', () => {
    const week = { mon }
    applyToAll(week, 'mon')
    expect(Object.keys(week)).toEqual(['mon'])
  })

  it('день-источник, который не отвечен, ничего не раскладывает', () => {
    expect(applyToAll({}, 'mon')).toEqual({})
  })
})

describe('switchCadence', () => {
  const windows = [{ from: '02:00', to: '04:00' }]

  it('daily → monthly переносит интервалы и ставит первый понедельник', () => {
    const out = switchCadence({ cadence: 'daily', windows }, 'monthly')
    expect(out).toEqual({ cadence: 'monthly', nth: 1, weekday: 'mon', windows })
  })

  it('monthly → quarterly сохраняет и день, и интервалы', () => {
    const out = switchCadence({ cadence: 'monthly', nth: 'last', weekday: 'sun', windows }, 'quarterly')
    expect(out).toEqual({ cadence: 'quarterly', nth: 'last', weekday: 'sun', windows })
  })

  it('в weekly и обратно интервалы не переносятся: там они привязаны к дням', () => {
    expect(switchCadence({ cadence: 'daily', windows }, 'weekly')).toEqual({ cadence: 'weekly', days: {} })
    expect(switchCadence({ cadence: 'weekly', days: { mon: { kind: 'windows', windows } } }, 'daily')).toEqual({
      cadence: 'daily',
      windows: [],
    })
  })

  it('из пустоты (или из старого текста) — пустая форма выбранной периодичности', () => {
    expect(switchCadence(null, 'daily')).toEqual({ cadence: 'daily', windows: [] })
    expect(switchCadence(null, 'quarterly')).toEqual({
      cadence: 'quarterly', nth: 1, weekday: 'mon', windows: [],
    })
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/form-schema/__tests__/schedule.test.ts`
Expected: FAIL — the new names are not exported.

- [ ] **Step 3: Implement**

Append to `src/form-schema/schedule.ts`:

```ts
export const WEEKDAY_WORKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri']
export const WEEKDAY_WEEKEND: readonly Weekday[] = ['sat', 'sun']

/** Все интервалы дописаны (`to` задан). Незаполненность — вопрос полноты
 *  анкеты, не формы значения; см. `windowsProblem`. */
export function windowsFinished(windows: Window[]): boolean {
  return windows.every((window) => window.to !== null)
}

function dayFinished(hours: DayHours): boolean {
  return hours.kind === 'windows' ? windowsFinished(hours.windows) : true
}

function dayHasHours(hours: DayHours): boolean {
  return hours.kind === 'allDay' || (hours.kind === 'windows' && hours.windows.length > 0)
}

/**
 * Недельная сетка заполнена: значение корректно по форме, отвечены все семь
 * дней, все интервалы дописаны и хотя бы один день несёт часы. Последнее
 * условие — не придирка: у часов работы неделя из семи «закрыто» означала бы
 * лаунж, который не работает никогда, а у пиковых часов и уборки — что
 * оператор прошёл сетку, ничего не сказав.
 */
export function weekHoursComplete(value: unknown, options: HoursOptions): boolean {
  if (weekHoursProblem(value, options) !== null) return false
  const week = value as WeekHours
  const days = WEEKDAYS.map((day) => week[day])
  if (days.some((hours) => hours === undefined)) return false
  const present = days as DayHours[]
  return present.every(dayFinished) && present.some(dayHasHours)
}

/** График уборки заполнен: корректен по форме, интервалы дописаны, и есть
 *  хотя бы один интервал (у еженедельной — хотя бы один день с интервалами). */
export function cleaningComplete(value: unknown): boolean {
  if (cleaningProblem(value) !== null) return false
  const schedule = value as CleaningSchedule
  if (schedule.cadence === 'weekly') return weekHoursComplete(schedule.days, CLEANING_DAY_OPTIONS)
  return schedule.windows.length > 0 && windowsFinished(schedule.windows)
}

function spread(week: WeekHours, from: Weekday, targets: readonly Weekday[]): WeekHours {
  const source = week[from]
  // Копировать нечего — неделя возвращается как есть, а не затирается
  // пустотой: кнопка быстрого действия не должна уметь стереть введённое.
  if (!source) return week
  const out: WeekHours = { ...week }
  for (const day of targets) out[day] = source
  return out
}

/** «Одинаково всю неделю»: день-источник (в интерфейсе — понедельник) едет во
 *  все семь. Новый объект, источник не мутируется — результат кладут в
 *  состояние React, а мутация не вызвала бы перерисовку. */
export function applyToAll(week: WeekHours, from: Weekday): WeekHours {
  return spread(week, from, WEEKDAYS)
}

export function applyToWeekdays(week: WeekHours, from: Weekday): WeekHours {
  return spread(week, from, WEEKDAY_WORKDAYS)
}

export function applyToWeekend(week: WeekHours, from: Weekday): WeekHours {
  return spread(week, from, WEEKDAY_WEEKEND)
}

/** «Как в предыдущем дне»: сосед слева по `WEEKDAYS`. У понедельника соседа
 *  нет, а неотвеченный сосед копировать нечего — в обоих случаях неделя не
 *  меняется (кнопка в интерфейсе в это время выключена, но правило живёт
 *  здесь, а не в компоненте). */
export function copyPreviousDay(week: WeekHours, day: Weekday): WeekHours {
  const index = WEEKDAYS.indexOf(day)
  if (index <= 0) return week
  return spread(week, WEEKDAYS[index - 1]!, [day])
}

/**
 * Смена периодичности уборки. Интервалы переносятся между `daily`, `monthly` и
 * `quarterly` — там это один список на весь график; в `weekly` они привязаны к
 * дням, поэтому при переходе в неё и из неё список начинается пустым (склеивать
 * «интервалы вообще» с «интервалами вторника» значило бы придумывать за
 * оператора). `nth`/`weekday` при переходе daily → monthly берут первый
 * понедельник как отправную точку, которую видно и легко поменять.
 */
export function switchCadence(current: CleaningSchedule | null, cadence: Cadence): CleaningSchedule {
  const carried = current && current.cadence !== 'weekly' ? current.windows : []

  if (cadence === 'daily') return { cadence, windows: carried }
  if (cadence === 'weekly') return { cadence, days: {} }

  const nth = current && (current.cadence === 'monthly' || current.cadence === 'quarterly') ? current.nth : 1
  const weekday =
    current && (current.cadence === 'monthly' || current.cadence === 'quarterly') ? current.weekday : 'mon'
  return { cadence, nth, weekday, windows: carried }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/form-schema`
Expected: PASS.

- [ ] **Step 5: Break-verify**

Remove `&& present.some(dayHasHours)` → the «вся неделя пустая» case fails. Restore. Change `spread` to return `{ ...week }` when the source is missing → the «источник не отвечен» case fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/form-schema/schedule.ts src/form-schema/__tests__/schedule.test.ts
git commit -m "feat(schema): полнота расписаний и быстрые действия недели как чистые функции

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Canonical text and export cells

**Files:**
- Modify: `src/form-schema/schedule.ts`
- Modify: `src/form-schema/__tests__/schedule.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `export function formatWindows(windows: Window[]): string`
  - `export function formatDayHours(hours: DayHours | undefined, options: HoursOptions, locale: 'en' | 'ru'): string`
  - `export function formatWeekHours(value: unknown, options: HoursOptions, locale: 'en' | 'ru'): string`
  - `export function formatCleaning(value: unknown, locale: 'en' | 'ru'): string`
  - `export function weekHoursCells(value: unknown, options: HoursOptions): Record<Weekday | 'free', string | null>`
  - `export function cleaningCells(value: unknown): Record<Weekday | 'cadence' | 'free', string | null>`

- [ ] **Step 1: Write the failing tests**

Append to `src/form-schema/__tests__/schedule.test.ts` (extend imports):

```ts
describe('канонический текст недельных часов', () => {
  const nine = { kind: 'windows', windows: [{ from: '09:00', to: '18:00' }] } as const

  it('одинаковые соседние дни сжимаются в отрезок', () => {
    const week = { ...everyDay(nine), sun: { kind: 'none' } } as WeekHours
    expect(formatWeekHours(week, OPEN, 'en')).toBe('Mon–Sat 09:00–18:00; Sun Closed')
    expect(formatWeekHours(week, OPEN, 'ru')).toBe('Пн–Сб 09:00–18:00; Вс Закрыто')
  })

  it('одиночный день не превращается в отрезок', () => {
    const week = { ...everyDay({ kind: 'allDay' }), wed: { kind: 'none' } } as WeekHours
    expect(formatWeekHours(week, OPEN, 'en')).toBe('Mon–Tue 24h; Wed Closed; Thu–Sun 24h')
  })

  it('разрывной день печатает интервалы через запятую', () => {
    const week = everyDay({ kind: 'windows', windows: [{ from: '01:00', to: '11:00' }, { from: '12:00', to: '23:00' }] })
    expect(formatWeekHours(week, OPEN, 'en')).toBe('Mon–Sun 01:00–11:00, 12:00–23:00')
  })

  it('неотвеченный день — прочерк, недописанный интервал — многоточие', () => {
    expect(formatWeekHours({ mon: nine }, OPEN, 'en')).toBe('Mon 09:00–18:00; Tue–Sun —')
    expect(
      formatWeekHours(everyDay({ kind: 'windows', windows: [{ from: '01:00', to: null }] }), OPEN, 'en'),
    ).toBe('Mon–Sun 01:00–…')
  })

  it('подпись пустого состояния берётся у поля', () => {
    expect(formatWeekHours(everyDay({ kind: 'none' }), PEAK, 'en')).toBe('Mon–Sun No peak')
    expect(formatWeekHours(everyDay({ kind: 'none' }), PEAK, 'ru')).toBe('Пн–Вс Нет пика')
  })

  it('старый текстовый ответ печатается как есть', () => {
    expect(formatWeekHours('Monday – Saturday: 00:00 – 23:59', OPEN, 'en')).toBe(
      'Monday – Saturday: 00:00 – 23:59',
    )
  })
})

describe('канонический текст графика уборки', () => {
  const windows = [{ from: '02:00', to: '04:00' }]

  it('ежедневно и еженедельно', () => {
    expect(formatCleaning({ cadence: 'daily', windows }, 'en')).toBe('Daily 02:00–04:00')
    expect(formatCleaning({ cadence: 'daily', windows }, 'ru')).toBe('Ежедневно 02:00–04:00')
    const weekly = { cadence: 'weekly', days: { ...everyDay({ kind: 'none' }), mon: { kind: 'windows', windows } } }
    expect(formatCleaning(weekly, 'en')).toBe('Weekly: Mon 02:00–04:00; Tue–Sun No cleaning')
  })

  it('ежемесячно и ежеквартально с порядковым днём', () => {
    expect(
      formatCleaning({ cadence: 'monthly', nth: 1, weekday: 'mon', windows }, 'en'),
    ).toBe('Monthly, 1st Monday 02:00–04:00')
    expect(
      formatCleaning({ cadence: 'monthly', nth: 1, weekday: 'mon', windows }, 'ru'),
    ).toBe('Ежемесячно, 1-й понедельник 02:00–04:00')
    expect(
      formatCleaning({ cadence: 'quarterly', nth: 'last', weekday: 'sun', windows }, 'en'),
    ).toBe('Quarterly, last Sunday 02:00–04:00')
    expect(
      formatCleaning({ cadence: 'quarterly', nth: 'last', weekday: 'sun', windows }, 'ru'),
    ).toBe('Ежеквартально, последнее воскресенье 02:00–04:00')
  })

  it('старый текст — как есть', () => {
    expect(formatCleaning('Every day: 14:30 – 15:00', 'en')).toBe('Every day: 14:30 – 15:00')
  })
})

describe('ячейки выгрузки', () => {
  it('недельные часы: колонка на день, старый текст в свободной колонке', () => {
    const week = { ...everyDay({ kind: 'allDay' }), sun: { kind: 'windows', windows: [{ from: '03:00', to: END_OF_DAY }] }, sat: { kind: 'none' } } as WeekHours
    const cells = weekHoursCells(week, OPEN)
    expect(cells.mon).toBe('24h')
    expect(cells.sat).toBe('Closed')
    expect(cells.sun).toBe('03:00–24:00')
    expect(cells.free).toBe(null)

    const legacy = weekHoursCells('Mon-Sun 09-18', OPEN)
    expect(legacy.free).toBe('Mon-Sun 09-18')
    expect(legacy.mon).toBe(null)
  })

  it('неотвеченный день — пустая ячейка, а не прочерк: в файле пусто это пусто', () => {
    expect(weekHoursCells({ mon: { kind: 'none' } }, OPEN).tue).toBe(null)
  })

  it('уборка: ежедневная заполняет все семь дней', () => {
    const cells = cleaningCells({ cadence: 'daily', windows: [{ from: '14:30', to: '15:00' }] })
    expect(cells.cadence).toBe('Daily')
    for (const day of WEEKDAYS) expect(cells[day], day).toBe('14:30–15:00')
  })

  it('уборка: месячная ставит интервал в колонку своего дня', () => {
    const cells = cleaningCells({ cadence: 'monthly', nth: 1, weekday: 'mon', windows: [{ from: '22:00', to: '23:30' }] })
    expect(cells.cadence).toBe('Monthly, 1st')
    expect(cells.mon).toBe('22:00–23:30')
    expect(cells.tue).toBe(null)
  })

  it('уборка: еженедельная — по дням; квартальная называет периодичность', () => {
    const weekly = cleaningCells({ cadence: 'weekly', days: { mon: { kind: 'windows', windows: [{ from: '02:00', to: '04:00' }] }, tue: { kind: 'none' } } })
    expect(weekly.cadence).toBe('Weekly')
    expect(weekly.mon).toBe('02:00–04:00')
    expect(weekly.tue).toBe('No cleaning')
    expect(weekly.wed).toBe(null)

    expect(cleaningCells({ cadence: 'quarterly', nth: 'last', weekday: 'sun', windows: [{ from: '01:00', to: '05:00' }] }).cadence).toBe(
      'Quarterly, last',
    )
  })

  it('уборка: старый текст — в свободной колонке, остальные пусты', () => {
    const cells = cleaningCells('Every day: 14:30 – 15:00')
    expect(cells.free).toBe('Every day: 14:30 – 15:00')
    expect(cells.cadence).toBe(null)
    expect(cells.mon).toBe(null)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/form-schema/__tests__/schedule.test.ts`
Expected: FAIL — formatting names not exported.

- [ ] **Step 3: Implement**

Append to `src/form-schema/schedule.ts`:

```ts
const DAY_SHORT: Record<Weekday, Localized> = {
  mon: { en: 'Mon', ru: 'Пн' }, tue: { en: 'Tue', ru: 'Вт' }, wed: { en: 'Wed', ru: 'Ср' },
  thu: { en: 'Thu', ru: 'Чт' }, fri: { en: 'Fri', ru: 'Пт' }, sat: { en: 'Sat', ru: 'Сб' },
  sun: { en: 'Sun', ru: 'Вс' },
}

const DAY_FULL: Record<Weekday, Localized> = {
  mon: { en: 'Monday', ru: 'понедельник' }, tue: { en: 'Tuesday', ru: 'вторник' },
  wed: { en: 'Wednesday', ru: 'среда' }, thu: { en: 'Thursday', ru: 'четверг' },
  fri: { en: 'Friday', ru: 'пятница' }, sat: { en: 'Saturday', ru: 'суббота' },
  sun: { en: 'Sunday', ru: 'воскресенье' },
}

const ALL_DAY_LABEL: Localized = { en: '24h', ru: 'Круглосуточно' }
const UNANSWERED = '—'

const CADENCE_LABEL: Record<Cadence, Localized> = {
  daily: { en: 'Daily', ru: 'Ежедневно' },
  weekly: { en: 'Weekly', ru: 'Еженедельно' },
  monthly: { en: 'Monthly', ru: 'Ежемесячно' },
  quarterly: { en: 'Quarterly', ru: 'Ежеквартально' },
}

const NTH_LABEL: Record<string, Localized> = {
  '1': { en: '1st', ru: '1-й' }, '2': { en: '2nd', ru: '2-й' }, '3': { en: '3rd', ru: '3-й' },
  '4': { en: '4th', ru: '4-й' }, last: { en: 'last', ru: 'последнее' },
}

/** Один интервал; недописанный печатается с многоточием — читатель видит, что
 *  ответ начат и не закончен, а не что конец совпал с началом. */
function formatWindow(window: Window): string {
  return `${window.from}–${window.to ?? '…'}`
}

export function formatWindows(windows: Window[]): string {
  return windows.map(formatWindow).join(', ')
}

export function formatDayHours(
  hours: DayHours | undefined,
  options: HoursOptions,
  locale: 'en' | 'ru',
): string {
  if (!hours) return UNANSWERED
  if (hours.kind === 'allDay') return ALL_DAY_LABEL[locale]
  if (hours.kind === 'none') return options.noneLabel[locale]
  return formatWindows(hours.windows)
}

/** Соседние дни с одинаковым текстом сливаются в отрезок: «Mon–Sat 09:00–18:00»
 *  вместо шести строк. Сравниваются именно ТЕКСТЫ дней, а не структуры: два дня,
 *  которые читаются одинаково, для читателя и есть одно и то же. */
function compressDays(texts: Record<Weekday, string>, locale: 'en' | 'ru'): string {
  const parts: string[] = []
  let start = 0
  for (let index = 1; index <= WEEKDAYS.length; index += 1) {
    const same = index < WEEKDAYS.length && texts[WEEKDAYS[index]!] === texts[WEEKDAYS[start]!]
    if (same) continue
    const first = DAY_SHORT[WEEKDAYS[start]!][locale]
    const last = DAY_SHORT[WEEKDAYS[index - 1]!][locale]
    const span = index - start === 1 ? first : `${first}–${last}`
    parts.push(`${span} ${texts[WEEKDAYS[start]!]}`)
    start = index
  }
  return parts.join('; ')
}

function isLegacyText(value: unknown): value is string {
  return typeof value === 'string'
}

export function formatWeekHours(
  value: unknown,
  options: HoursOptions,
  locale: 'en' | 'ru',
): string {
  // Старый свободный текст печатается дословно: он остаётся ответом, пока
  // оператор не введёт структуру (см. spec, «старые текстовые ответы»).
  if (isLegacyText(value)) return value
  if (weekHoursProblem(value, options) !== null) return String(value ?? '')

  const week = value as WeekHours
  const texts = Object.fromEntries(
    WEEKDAYS.map((day) => [day, formatDayHours(week[day], options, locale)]),
  ) as Record<Weekday, string>
  return compressDays(texts, locale)
}

export function formatCleaning(value: unknown, locale: 'en' | 'ru'): string {
  if (isLegacyText(value)) return value
  if (cleaningProblem(value) !== null) return String(value ?? '')

  const schedule = value as CleaningSchedule
  const cadence = CADENCE_LABEL[schedule.cadence][locale]

  if (schedule.cadence === 'weekly') {
    return `${cadence}: ${formatWeekHours(schedule.days, CLEANING_DAY_OPTIONS, locale)}`
  }
  if (schedule.cadence === 'daily') {
    return `${cadence} ${formatWindows(schedule.windows)}`
  }
  const nth = NTH_LABEL[String(schedule.nth)]![locale]
  const day = DAY_FULL[schedule.weekday][locale]
  return `${cadence}, ${nth} ${day} ${formatWindows(schedule.windows)}`
}

/**
 * Ячейки выгрузки для недельных часов: своя колонка на каждый день плюс
 * `free` для старого свободного текста. Ячейка дня — текст БЕЗ имени дня (имя
 * несёт заголовок колонки) и БЕЗ прочерка: пустая ячейка файла и значит «не
 * отвечено», а «—» получатель принял бы за значение. Язык — английский, как у
 * всей выгрузки (`rows.ts` печатает `locale: 'en'`).
 */
export function weekHoursCells(
  value: unknown,
  options: HoursOptions,
): Record<Weekday | 'free', string | null> {
  const empty = Object.fromEntries(WEEKDAYS.map((day) => [day, null])) as Record<Weekday, string | null>

  if (isLegacyText(value)) return { ...empty, free: value }
  if (weekHoursProblem(value, options) !== null) return { ...empty, free: null }

  const week = value as WeekHours
  const cells = Object.fromEntries(
    WEEKDAYS.map((day) => [day, week[day] ? formatDayHours(week[day], options, 'en') : null]),
  ) as Record<Weekday, string | null>
  return { ...cells, free: null }
}

/** Ячейки выгрузки графика уборки: периодичность, семь дней, свободный текст.
 *  Ежедневная заполняет все семь дней (это и значит «каждый день»), месячная и
 *  квартальная — только колонку своего дня недели, а `Cadence` при них несёт и
 *  порядковый номер («Monthly, 1st»), которому иначе негде появиться. */
export function cleaningCells(
  value: unknown,
): Record<Weekday | 'cadence' | 'free', string | null> {
  const empty = Object.fromEntries(WEEKDAYS.map((day) => [day, null])) as Record<Weekday, string | null>

  if (isLegacyText(value)) return { ...empty, cadence: null, free: value }
  if (cleaningProblem(value) !== null) return { ...empty, cadence: null, free: null }

  const schedule = value as CleaningSchedule

  if (schedule.cadence === 'weekly') {
    const days = weekHoursCells(schedule.days, CLEANING_DAY_OPTIONS)
    const { free: _free, ...perDay } = days
    return { ...perDay, cadence: CADENCE_LABEL.weekly.en, free: null }
  }

  const text = formatWindows(schedule.windows)
  if (schedule.cadence === 'daily') {
    const cells = Object.fromEntries(WEEKDAYS.map((day) => [day, text])) as Record<Weekday, string | null>
    return { ...cells, cadence: CADENCE_LABEL.daily.en, free: null }
  }

  return {
    ...empty,
    [schedule.weekday]: text,
    cadence: `${CADENCE_LABEL[schedule.cadence].en}, ${NTH_LABEL[String(schedule.nth)]!.en}`,
    free: null,
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/form-schema`
Expected: PASS.

- [ ] **Step 5: Break-verify**

In `compressDays` change `index - start === 1 ? first : …` to always produce a span → the «одиночный день» case fails (`Wed–Wed Closed`). Restore. In `weekHoursCells` return `formatDayHours(...)` unconditionally instead of `week[day] ? … : null` → the «неотвеченный день» case fails (`—` instead of `null`). Restore.

- [ ] **Step 6: Commit**

```bash
git add src/form-schema/schedule.ts src/form-schema/__tests__/schedule.test.ts
git commit -m "feat(schema): канонический текст расписаний со сжатием дней и ячейки выгрузки

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Field types, the server gate, completeness and rendering

**Files:**
- Modify: `src/form-schema/fields.ts` (`FieldType` union ~lines 4-15; `Field` type; entries `III.1.1`, `III.1.3`, `III.1.4`)
- Modify: `src/form-schema/validation.ts` (messages after `NOT_A_NUMBER`; `validateField`; new `fieldAnswered`)
- Modify: `src/form-schema/render.ts` (`formatFieldValue`)
- Modify: `src/submissions/completeness.ts` (use `fieldAnswered`)
- Modify: `src/form-schema/__tests__/fields.test.ts`, `validation.test.ts`, `render.test.ts`
- Modify: `src/submissions/__tests__/completeness.test.ts`
- Modify: `src/export/__tests__/roundtrip.test.ts` (`enteredFieldValue`)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `FieldType` includes `'weekHours' | 'cleaningSchedule'`
  - `Field.hoursOptions: HoursOptions | null` (non-null exactly on `weekHours` fields)
  - `export function fieldAnswered(field: Field, value: unknown): boolean` (in `validation.ts`)
  - `validateField` refuses malformed schedules with `INVALID_SCHEDULE` / `INVALID_CLEANING`

- [ ] **Step 1: Write the failing schema pins**

Append to `describe('плоские поля', …)` in `src/form-schema/__tests__/fields.test.ts`:

```ts
  /**
   * Три расписания закреплены БУКВАЛЬНО по ключам, как и контактные поля:
   * подпись («… Hours», «… Schedule») носят и соседние поля (III.1.2
   * «Seasonal schedule changes» — обычный select), так что вывод по подписи
   * отнёс бы к расписаниям не то.
   */
  it('расписания: два weekHours и одно cleaningSchedule, у weekHours есть hoursOptions', () => {
    const byKey = (key: string) => FIELDS.find((f) => f.key === key)!
    expect(byKey('III.1.1').type).toBe('weekHours')
    expect(byKey('III.1.3').type).toBe('weekHours')
    expect(byKey('III.1.4').type).toBe('cleaningSchedule')
    expect(byKey('III.1.2').type).toBe('select_with_detail')

    // Круглосуточно есть только у часов работы: «пик круглые сутки» — не ответ.
    expect(byKey('III.1.1').hoursOptions).toEqual({
      allDay: true, noneLabel: { en: 'Closed', ru: 'Закрыто' },
    })
    expect(byKey('III.1.3').hoursOptions).toEqual({
      allDay: false, noneLabel: { en: 'No peak', ru: 'Нет пика' },
    })

    // `hoursOptions` — только у weekHours: у остальных типов он ничего не
    // значил бы, а редактор читает его без проверки типа.
    for (const field of FIELDS) {
      expect(field.hoursOptions === null, field.key).toBe(field.type !== 'weekHours')
    }
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/form-schema/__tests__/fields.test.ts`
Expected: FAIL — `expected 'text' to be 'weekHours'`.

- [ ] **Step 3: Extend the union, the `Field` type, and retype three fields**

In `src/form-schema/fields.ts`: add to the import at the top `import type { HoursOptions } from './schedule'`; extend the union:

```ts
  | 'phone'
  | 'email'
  // Расписания: правила — `schedule.ts`, проверка — `validateField`, ввод —
  // `WeekHoursEditor`/`CleaningScheduleEditor`. Значение — структура в том же
  // jsonb-столбце, миграции нет.
  | 'weekHours'
  | 'cleaningSchedule'
```

Add to `Field`:

```ts
  /**
   * Настройка недельной сетки — только у полей типа `weekHours`, у остальных
   * `null` (закреплено тестом): какие состояния есть у дня и как читается
   * пустое. Живёт на поле, а не в структуре значения, потому что это свойство
   * ВОПРОСА: одна и та же пустая клетка у часов работы значит «закрыто», а у
   * пиковых часов — «нет пика».
   */
  hoursOptions: HoursOptions | null
```

Add `hoursOptions: null` to the `base` object (so every existing field keeps compiling), then set the three fields:

```ts
  {
    ...base,
    key: 'III.1.1',
    section: 'III',
    block: 'III.1',
    type: 'weekHours',
    label: { en: 'Lounge Operating Hours', ru: 'Часы работы лаунжа' },
    hoursOptions: { allDay: true, noneLabel: { en: 'Closed', ru: 'Закрыто' } },
    required: true,
  },
```

`III.1.3`: same shape, `label` unchanged, `hoursOptions: { allDay: false, noneLabel: { en: 'No peak', ru: 'Нет пика' } }`. `III.1.4`: `type: 'cleaningSchedule'`, label unchanged, no `hoursOptions` (stays `null` from `base`). Remove the `example:` line from all three — the grid IS the example now, and a free-text example next to a grid would contradict it; keep every other property.

- [ ] **Step 4: Run typecheck to find every consumer**

Run: `npm run typecheck`
Expected: FAIL in `src/form-schema/validation.ts` only (`assertNeverFieldType`). `FieldInput.tsx`, `seed-dev.ts`, `render.ts` fall through to defaults and get their branches in later steps/tasks — if typecheck names any other file, report it as a concern with the exact error rather than patching beyond this task's file list.

- [ ] **Step 5: Write the failing gate and completeness tests**

Add to `src/form-schema/__tests__/validation.test.ts`:

```ts
describe('расписания — сервер как ворота', () => {
  const week = Object.fromEntries(
    ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { kind: 'allDay' }]),
  )

  it('корректная неделя принимается, сломанная — отказ', () => {
    expect(validateField(field('III.1.1'), week).ok).toBe(true)
    const refused = validateField(field('III.1.1'), { mon: { kind: 'windows', windows: [{ from: '11:00', to: '01:00' }] } })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.en).toBe('Check the schedule: times must run forward and windows must not overlap')
  })

  it('круглосуточно у пиковых часов — отказ (поле его не разрешает)', () => {
    expect(validateField(field('III.1.3'), { mon: { kind: 'allDay' } }).ok).toBe(false)
  })

  it('недописанный интервал сохраняется — черновик не теряется', () => {
    expect(validateField(field('III.1.1'), { mon: { kind: 'windows', windows: [{ from: '09:00', to: null }] } }).ok).toBe(true)
  })

  it('график уборки: все периодичности принимаются, чужая — отказ', () => {
    expect(validateField(field('III.1.4'), { cadence: 'daily', windows: [{ from: '02:00', to: '04:00' }] }).ok).toBe(true)
    const refused = validateField(field('III.1.4'), { cadence: 'yearly', windows: [] })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.en).toBe('Check the cleaning schedule: pick a cadence and set the times')
  })

  it('null — очищенный ответ, не отказ; строка — старый ответ, тоже не отказ', () => {
    expect(validateField(field('III.1.1'), null).ok).toBe(false) // обязательное → REQUIRED
    if (!validateField(field('III.1.1'), null).ok) {
      const r = validateField(field('III.1.1'), null)
      if (!r.ok) expect(r.error.ru).toBe('Поле обязательно')
    }
    // Старый текстовый ответ не отвергается: он уже лежит в базе.
    expect(validateField(field('III.1.1'), 'Monday – Saturday: 00:00 – 23:59').ok).toBe(true)
  })
})

describe('fieldAnswered', () => {
  it('для прежних типов — «не пусто»', () => {
    expect(fieldAnswered(field('I.2'), 'Primeclass')).toBe(true)
    expect(fieldAnswered(field('I.2'), '  ')).toBe(false)
  })

  it('для расписаний — правило полноты, а не «не пусто»', () => {
    // Одного дня недостаточно, хотя значение и не пустое.
    expect(fieldAnswered(field('III.1.1'), { mon: { kind: 'allDay' } })).toBe(false)
    const full = Object.fromEntries(
      ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { kind: 'allDay' }]),
    )
    expect(fieldAnswered(field('III.1.1'), full)).toBe(true)
    // Старый текстовый ответ не считается заполненным: его надо ввести заново.
    expect(fieldAnswered(field('III.1.1'), 'Mon-Sun 09-18')).toBe(false)
    expect(fieldAnswered(field('III.1.4'), { cadence: 'daily', windows: [{ from: '02:00', to: '04:00' }] })).toBe(true)
  })
})
```

Add to `src/form-schema/__tests__/render.test.ts`:

```ts
it('расписание печатается каноническим текстом через formatFieldValue', () => {
  const week = Object.fromEntries(
    ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, { kind: 'allDay' }]),
  )
  expect(
    formatFieldValue(fieldByKey('III.1.1')!, { ...week, sun: { kind: 'none' } }, { locale: 'en', template: 'phrase' }),
  ).toBe('Mon–Sat 24h; Sun Closed')
  expect(
    formatFieldValue(fieldByKey('III.1.4')!, { cadence: 'daily', windows: [{ from: '02:00', to: '04:00' }] }, { locale: 'ru', template: 'slots' }),
  ).toBe('Ежедневно 02:00–04:00')
})
```

Add to `src/submissions/__tests__/completeness.test.ts` (follow the file's existing seeding helper):

```ts
it('расписание с недописанным интервалом — анкета неполна', async () => {
  const db = await createTestDb()
  const submissionId = await seedComplete(db)
  await saveFieldValue(db, {
    submissionId,
    fieldKey: 'III.1.1',
    value: { mon: { kind: 'windows', windows: [{ from: '09:00', to: null }] } },
  })
  const missing = await missingItems(db, submissionId)
  expect(missing.fieldKeys).toContain('III.1.1')
})
```

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run src/form-schema src/submissions`
Expected: FAIL — `fieldAnswered` not exported; schedule values accepted/refused wrongly.

- [ ] **Step 7: Implement the gate, `fieldAnswered` and rendering**

In `src/form-schema/validation.ts` add the import:

```ts
import {
  cleaningComplete, cleaningProblem, weekHoursComplete, weekHoursProblem,
} from './schedule'
```

After `NOT_A_NUMBER` add:

```ts
// Один текст на все нарушения формы расписания, а не текст на тег: оператор в
// браузере физически не может собрать сетку с пересечением или обратным
// временем (редактор такого не даёт), так что до этого отказа доходит только
// запись мимо интерфейса — старая вкладка или скрипт. Ему нужна честная
// причина, а не разбор какого именно правила; разбор есть у тегов
// `windowsProblem`, и он проверяется тестами схемы.
const INVALID_SCHEDULE = fail(
  'Check the schedule: times must run forward and windows must not overlap',
  'Проверьте расписание: время должно идти вперёд, интервалы не должны пересекаться',
)
const INVALID_CLEANING = fail(
  'Check the cleaning schedule: pick a cadence and set the times',
  'Проверьте график уборки: выберите периодичность и укажите время',
)
```

In `validateField`, before `case 'text':`:

```ts
    // Пустота — вопрос `required`; СТРОКА — старый ответ прежней версии
    // анкеты (свободный текст), он уже лежит в базе и отказом его не
    // «исправить»: поле просто считается незаполненным (`fieldAnswered`
    // ниже), пока оператор не введёт структуру. Всё остальное судит
    // `schedule.ts`.
    case 'weekHours': {
      if (value === null || value === undefined) return field.required ? REQUIRED : ok
      if (typeof value === 'string') return ok
      const options = field.hoursOptions
      if (!options) return INVALID_SCHEDULE
      return weekHoursProblem(value, options) === null ? ok : INVALID_SCHEDULE
    }

    case 'cleaningSchedule': {
      if (value === null || value === undefined) return field.required ? REQUIRED : ok
      if (typeof value === 'string') return ok
      return cleaningProblem(value) === null ? ok : INVALID_CLEANING
    }
```

At the end of `validation.ts` add:

```ts
/**
 * Дан ли на поле ОТВЕТ, годный для отправки. Для прежних типов это «значение
 * не пусто» — правило, которое годами жило в `completeness.ts` как приватный
 * `isBlank`. Расписания сломали это равенство: сетка с одним заполненным днём
 * не пуста, но и не ответ, а старый свободный текст — ответ прежней версии
 * анкеты, который надо ввести заново структурой. Правило переехало сюда,
 * рядом с `validateField`, чтобы «что можно сохранить» и «что считается
 * отвеченным» стояли в одном модуле и не расходились.
 */
export function fieldAnswered(field: Field, value: unknown): boolean {
  if (field.type === 'weekHours') {
    return field.hoursOptions ? weekHoursComplete(value, field.hoursOptions) : false
  }
  if (field.type === 'cleaningSchedule') return cleaningComplete(value)

  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length === 0 ? false : true
  return true
}
```

In `src/form-schema/render.ts`, inside `formatFieldValue`, before the `Array.isArray` line (schedules are objects, but the legacy string case must be reached too), insert:

```ts
  // Расписания печатаются каноническим текстом — одним и тем же на экране
  // проверки, в карточке правок, в листе одной анкеты. Старый свободный текст
  // `formatWeekHours` отдаёт дословно, поэтому эта ветка стоит ДО общего
  // `String(raw)` ниже.
  if (field.type === 'weekHours') {
    return field.hoursOptions
      ? formatWeekHours(raw, field.hoursOptions, style.locale)
      : String(raw)
  }
  if (field.type === 'cleaningSchedule') return formatCleaning(raw, style.locale)
```

with the import `import { formatCleaning, formatWeekHours } from './schedule'`.

In `src/submissions/completeness.ts`: replace the `isBlank` helper and its use with `fieldAnswered`:

```ts
  const fieldKeys = FIELDS.filter(
    (field) => field.required && !fieldAnswered(field, values.fields[field.key]),
  ).map((field) => field.key)
```

Delete the now-unused local `isBlank` (its rule lives in `fieldAnswered`) and add `fieldAnswered` to the `@/form-schema` import.

In `src/export/__tests__/roundtrip.test.ts`, `enteredFieldValue`, add before `case 'date':`:

```ts
    // Расписания проходят валидацию только структурой; свой набор часов у
    // каждого поля, чтобы ячейка, уехавшая в чужую колонку, не совпала со
    // «своей» случайно.
    case 'weekHours': {
      const from = `${String(6 + (position % 12)).padStart(2, '0')}:00`
      const day = { kind: 'windows' as const, windows: [{ from, to: '23:00' }] }
      return Object.fromEntries(WEEKDAYS.map((weekday) => [weekday, day]))
    }
    case 'cleaningSchedule':
      return { cadence: 'daily' as const, windows: [{ from: '14:30', to: '15:00' }] }
```

with `WEEKDAYS` added to its `@/form-schema` import.

- [ ] **Step 8: Run the suites and typecheck**

Run: `npm run typecheck && caffeinate -dimsu npx vitest run src/form-schema src/submissions src/export`
Expected: typecheck clean; all PASS. The export column tests are expected to FAIL only in Task 7 (they are not in this range) — if `columns.test.ts` runs here and fails, note it and continue; Task 7 owns it.

- [ ] **Step 9: Break-verify**

Swap `INVALID_SCHEDULE` for `ok` in the `weekHours` branch → the reversed-times test fails. Restore. Make `fieldAnswered` return `!isBlank`-style `true` for a one-day week → the `fieldAnswered` test fails. Restore.

- [ ] **Step 10: Commit**

```bash
git add src/form-schema/fields.ts src/form-schema/validation.ts src/form-schema/render.ts src/submissions/completeness.ts src/form-schema/__tests__/fields.test.ts src/form-schema/__tests__/validation.test.ts src/form-schema/__tests__/render.test.ts src/submissions/__tests__/completeness.test.ts src/export/__tests__/roundtrip.test.ts
git commit -m "feat(schema): типы weekHours и cleaningSchedule — ворота, полнота через fieldAnswered, канонический текст

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: The day-grid editor

**Files:**
- Create: `src/web/WindowsEditor.tsx`, `src/web/WeekHoursEditor.tsx`
- Create: `src/web/__tests__/scheduleEditors.test.tsx`
- Modify: `src/app/globals.css`
- Modify: `src/i18n/dictionaries.ts`

**Interfaces:**
- Consumes: `Window`, `DayHours`, `WeekHours`, `Weekday`, `WEEKDAYS`, `HoursOptions`, `END_OF_DAY`, `applyToAll`, `applyToWeekdays`, `applyToWeekend`, `copyPreviousDay` from `@/form-schema`.
- Produces:
  - `export function WindowsEditor(props: { windows: Window[]; onChange: (windows: Window[]) => void; idPrefix: string }): React.JSX.Element`
  - `export function WeekHoursEditor(props: { value: unknown; options: HoursOptions; onChange: (week: WeekHours) => void; idPrefix: string }): React.JSX.Element`
  - New `UI` keys (Task 6 and the review screen reuse them): `schedule.allDay`, `schedule.byHours`, `schedule.addWindow`, `schedule.removeWindow`, `schedule.untilEndOfDay`, `schedule.sameAllWeek`, `schedule.copyPrevious`, `schedule.copyToWorkdays`, `schedule.copyToWeekend`, `schedule.from`, `schedule.to`, `form.freeFormAnswer`, `schedule.cadence`, `schedule.nth`, `schedule.weekday`, plus `schedule.day.mon`…`schedule.day.sun`.

- [ ] **Step 1: Add the dictionary entries**

In `src/i18n/dictionaries.ts`, inside `UI`, add (English first, exactly these strings):

```ts
  'schedule.allDay': { en: '24 hours', ru: '24 часа' },
  'schedule.byHours': { en: 'By hours', ru: 'По часам' },
  'schedule.addWindow': { en: '+ interval', ru: '+ интервал' },
  'schedule.removeWindow': { en: 'Remove interval', ru: 'Убрать интервал' },
  'schedule.untilEndOfDay': { en: 'until end of day', ru: 'до конца дня' },
  'schedule.sameAllWeek': { en: 'Same all week', ru: 'Одинаково всю неделю' },
  'schedule.copyPrevious': { en: 'Same as previous day', ru: 'Как в предыдущем дне' },
  'schedule.copyToWorkdays': { en: 'Copy Mon to weekdays', ru: 'Скопировать пн на будни' },
  'schedule.copyToWeekend': { en: 'Copy Mon to weekend', ru: 'Скопировать пн на выходные' },
  'schedule.from': { en: 'From', ru: 'С' },
  'schedule.to': { en: 'To', ru: 'До' },
  'schedule.cadence': { en: 'How often', ru: 'Как часто' },
  'schedule.nth': { en: 'Which one', ru: 'Какой по счёту' },
  'schedule.weekday': { en: 'Day of week', ru: 'День недели' },
  'schedule.day.mon': { en: 'Monday', ru: 'Понедельник' },
  'schedule.day.tue': { en: 'Tuesday', ru: 'Вторник' },
  'schedule.day.wed': { en: 'Wednesday', ru: 'Среда' },
  'schedule.day.thu': { en: 'Thursday', ru: 'Четверг' },
  'schedule.day.fri': { en: 'Friday', ru: 'Пятница' },
  'schedule.day.sat': { en: 'Saturday', ru: 'Суббота' },
  'schedule.day.sun': { en: 'Sunday', ru: 'Воскресенье' },
  'form.freeFormAnswer': {
    en: 'Free-form answer from an earlier version — fill the grid to replace it',
    ru: 'Ответ в свободной форме, из прежней версии — заполните сетку, чтобы заменить его',
  },
```

- [ ] **Step 2: Write the failing component test**

Create `src/web/__tests__/scheduleEditors.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { WEEKDAYS, type HoursOptions } from '@/form-schema'
import { LocaleProvider } from '@/i18n/context'
import { UI } from '@/i18n/dictionaries'
import { WeekHoursEditor } from '../WeekHoursEditor'

const OPEN: HoursOptions = { allDay: true, noneLabel: { en: 'Closed', ru: 'Закрыто' } }
const PEAK: HoursOptions = { allDay: false, noneLabel: { en: 'No peak', ru: 'Нет пика' } }

/**
 * Сетка в том виде, в каком её видит оператор. Среда node, DOM нет — рендер
 * `renderToStaticMarkup`, как в fieldInputLocked.test.tsx. Поведение нажатий
 * закреплено на чистых функциях (`schedule.test.ts`) и сквозным сценарием
 * (`e2e/fill.spec.ts`); здесь проверяется, что видно и чем управляется.
 */
function render(value: unknown, options: HoursOptions): string {
  return renderToStaticMarkup(
    <LocaleProvider initial="en">
      <WeekHoursEditor value={value} options={options} onChange={() => {}} idPrefix="III.1.1" />
    </LocaleProvider>,
  )
}

describe('WeekHoursEditor', () => {
  it('семь строк с подписями дней и кнопками состояния', () => {
    const html = render({}, OPEN)
    for (const day of WEEKDAYS) {
      expect(html, day).toContain(UI[`schedule.day.${day}`].en)
    }
    expect(html.match(/class="wh-row"/g)).toHaveLength(7)
    expect(html).toContain(UI['schedule.allDay'].en)
    expect(html).toContain('Closed')
    expect(html).toContain(UI['schedule.byHours'].en)
  })

  it('состояния берутся у поля: у пиковых часов нет «24 часа», а пустое читается «No peak»', () => {
    const html = render({}, PEAK)
    expect(html).not.toContain(UI['schedule.allDay'].en)
    expect(html).toContain('No peak')
  })

  it('выбранное состояние помечено aria-pressed — то же, чем помечены Да|Нет у услуг', () => {
    const html = render({ mon: { kind: 'none' } }, OPEN)
    expect(html).toContain('aria-pressed="true"')
  })

  it('интервалы дня показываются только у состояния «по часам»', () => {
    expect(render({ mon: { kind: 'allDay' } }, OPEN)).not.toContain('type="time"')
    const html = render({ mon: { kind: 'windows', windows: [{ from: '09:00', to: '18:00' }] } }, OPEN)
    expect(html).toContain('type="time"')
    expect(html).toContain('value="09:00"')
    expect(html).toContain('value="18:00"')
    expect(html).toContain(UI['schedule.addWindow'].en)
  })

  it('конец суток показывается кнопкой, а не значением 24:00 в поле времени', () => {
    // `<input type="time">` значения 24:00 не принимает — иначе поле осталось бы пустым.
    const html = render({ mon: { kind: 'windows', windows: [{ from: '03:00', to: '24:00' }] } }, OPEN)
    expect(html).toContain(UI['schedule.untilEndOfDay'].en)
    expect(html).not.toContain('value="24:00"')
  })

  it('быстрые действия на месте; «как в предыдущем дне» — не у понедельника', () => {
    const html = render({ mon: { kind: 'allDay' } }, OPEN)
    expect(html).toContain(UI['schedule.sameAllWeek'].en)
    expect(html).toContain(UI['schedule.copyToWorkdays'].en)
    expect(html).toContain(UI['schedule.copyToWeekend'].en)
    expect(html.match(new RegExp(UI['schedule.copyPrevious'].en, 'g'))).toHaveLength(6)
  })

  it('старый текстовый ответ показан над пустой сеткой с пометкой', () => {
    const html = render('Monday – Saturday: 00:00 – 23:59', OPEN)
    expect(html).toContain('Monday – Saturday: 00:00 – 23:59')
    expect(html).toContain(UI['form.freeFormAnswer'].en)
    expect(html).toContain('aria-pressed="false"')
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/web/__tests__/scheduleEditors.test.tsx`
Expected: FAIL — cannot resolve `../WeekHoursEditor`.

- [ ] **Step 4: Implement `WindowsEditor`**

Create `src/web/WindowsEditor.tsx`:

```tsx
'use client'

import type React from 'react'
import { END_OF_DAY, type Window } from '@/form-schema'
import { useLocale } from '@/i18n/context'

/**
 * Интервалы ОДНОГО дня (или одного графика уборки). Правил здесь нет: порядок,
 * непересечение и полнота живут в `schedule.ts` и проверяются сервером; этот
 * компонент только показывает список и отдаёт наверх новый массив.
 *
 * Новый интервал появляется с `to: null` — незакрытым. Так и задумано: отказ
 * на полпути набора уносил бы черновик, поэтому незакрытый интервал
 * сохраняется, а отправку держит правило полноты (`windowsFinished`).
 */
export function WindowsEditor(props: {
  windows: Window[]
  onChange: (windows: Window[]) => void
  /** Префикс id для связки label с полем: ключ поля плюс день, чтобы на
   *  странице с семью днями и двумя расписаниями id не столкнулись. */
  idPrefix: string
}): React.JSX.Element {
  const { t } = useLocale()
  const { windows, onChange } = props

  const replace = (index: number, window: Window): void => {
    onChange(windows.map((current, position) => (position === index ? window : current)))
  }

  return (
    <div className="wh-windows">
      {windows.map((window, index) => {
        const id = `${props.idPrefix}-w${index}`
        const endOfDay = window.to === END_OF_DAY
        return (
          <div className="wh-window" key={index}>
            <label htmlFor={`${id}-from`}>{t('schedule.from')}</label>
            <input
              id={`${id}-from`}
              type="time"
              step={300}
              value={window.from}
              onChange={(e) => replace(index, { ...window, from: e.target.value })}
            />
            <label htmlFor={`${id}-to`}>{t('schedule.to')}</label>
            <input
              id={`${id}-to`}
              type="time"
              step={300}
              // `<input type="time">` не принимает 24:00 — при таком значении
              // поле осталось бы пустым, и «работаем до полуночи» выглядело бы
              // как незаполненный конец. Поэтому конец суток живёт нажатой
              // кнопкой рядом, а поле в это время пустое и выключено.
              value={endOfDay ? '' : (window.to ?? '')}
              disabled={endOfDay}
              onChange={(e) => replace(index, { ...window, to: e.target.value === '' ? null : e.target.value })}
            />
            <button
              type="button"
              aria-pressed={endOfDay}
              onClick={() => replace(index, { ...window, to: endOfDay ? null : END_OF_DAY })}
            >
              {t('schedule.untilEndOfDay')}
            </button>
            <button
              type="button"
              className="wh-drop"
              aria-label={t('schedule.removeWindow')}
              onClick={() => onChange(windows.filter((_, position) => position !== index))}
            >
              ×
            </button>
          </div>
        )
      })}
      <button
        type="button"
        className="wh-add"
        onClick={() => onChange([...windows, { from: '09:00', to: null }])}
      >
        {t('schedule.addWindow')}
      </button>
    </div>
  )
}
```

- [ ] **Step 5: Implement `WeekHoursEditor`**

Create `src/web/WeekHoursEditor.tsx`:

```tsx
'use client'

import type React from 'react'
import {
  WEEKDAYS,
  applyToAll,
  applyToWeekdays,
  applyToWeekend,
  copyPreviousDay,
  weekHoursProblem,
  type DayHours,
  type HoursOptions,
  type WeekHours,
  type Weekday,
} from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { WindowsEditor } from './WindowsEditor'

/** Сохранённое значение → сетка. Старый свободный текст (и любое значение, не
 *  прошедшее форму) сеткой не является: она начинается пустой, а текст
 *  показывается над ней с пометкой — ответ виден, и его есть чем заменить. */
function asWeek(value: unknown, options: HoursOptions): { week: WeekHours; legacy: string | null } {
  if (typeof value === 'string' && value.trim() !== '') return { week: {}, legacy: value }
  if (weekHoursProblem(value, options) !== null) return { week: {}, legacy: null }
  return { week: (value ?? {}) as WeekHours, legacy: null }
}

export function WeekHoursEditor(props: {
  value: unknown
  options: HoursOptions
  onChange: (week: WeekHours) => void
  idPrefix: string
}): React.JSX.Element {
  const { t, pick } = useLocale()
  const { options, onChange } = props
  const { week, legacy } = asWeek(props.value, options)

  const setDay = (day: Weekday, hours: DayHours): void => onChange({ ...week, [day]: hours })

  const states: { key: 'allDay' | 'none' | 'windows'; label: string }[] = [
    ...(options.allDay ? [{ key: 'allDay' as const, label: t('schedule.allDay') }] : []),
    { key: 'none' as const, label: pick(options.noneLabel) },
    { key: 'windows' as const, label: t('schedule.byHours') },
  ]

  return (
    <div className="wh">
      {legacy !== null && (
        <div className="wh-legacy">
          <p className="wh-legacy-value">{legacy}</p>
          <p className="field-hint">{t('form.freeFormAnswer')}</p>
        </div>
      )}

      <div className="wh-bulk">
        <button type="button" disabled={!week.mon} onClick={() => onChange(applyToAll(week, 'mon'))}>
          {t('schedule.sameAllWeek')}
        </button>
        <button type="button" disabled={!week.mon} onClick={() => onChange(applyToWeekdays(week, 'mon'))}>
          {t('schedule.copyToWorkdays')}
        </button>
        <button type="button" disabled={!week.mon} onClick={() => onChange(applyToWeekend(week, 'mon'))}>
          {t('schedule.copyToWeekend')}
        </button>
      </div>

      {WEEKDAYS.map((day, index) => {
        const hours = week[day]
        return (
          <div className="wh-row" key={day}>
            <span className="wh-day">{t(`schedule.day.${day}`)}</span>
            {/* Те же три состояния и тот же `aria-pressed`, что у пары Да|Нет
                у услуг: нажатость — состояние с тремя исходами, и «не
                отвечено» должно отличаться от «закрыто» на вид. */}
            <span className="avail-toggle wh-states" role="group" aria-label={t(`schedule.day.${day}`)}>
              {states.map((state) => (
                <button
                  key={state.key}
                  type="button"
                  aria-pressed={hours?.kind === state.key}
                  onClick={() =>
                    setDay(
                      day,
                      state.key === 'windows'
                        ? { kind: 'windows', windows: hours?.kind === 'windows' ? hours.windows : [{ from: '09:00', to: null }] }
                        : { kind: state.key },
                    )
                  }
                >
                  {state.label}
                </button>
              ))}
            </span>
            {index > 0 && (
              <button
                type="button"
                className="wh-copy"
                disabled={!week[WEEKDAYS[index - 1]!]}
                onClick={() => onChange(copyPreviousDay(week, day))}
              >
                {t('schedule.copyPrevious')}
              </button>
            )}
            {hours?.kind === 'windows' && (
              <WindowsEditor
                windows={hours.windows}
                idPrefix={`${props.idPrefix}-${day}`}
                onChange={(windows) => setDay(day, { kind: 'windows', windows })}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 6: Add the styles**

In `src/app/globals.css`, after the `.chip-row` rule, add (light values; then add the dark counterparts inside the existing `@media (prefers-color-scheme: dark)` block next to the `.pass2-card` dark rules):

```css
/* Недельная сетка расписаний. Строка дня — подпись, сегментный контрол
   состояний (общий вид с .avail-toggle) и, у состояния «по часам»,
   интервалы под ними. На узком экране всё это встаёт в столбик: три
   состояния и пара времени в одну строку 375px не помещаются. */
.wh { display: flex; flex-direction: column; gap: 10px; }
.wh-bulk { display: flex; flex-wrap: wrap; gap: 8px; }
.wh-row {
  display: grid;
  grid-template-columns: 7.5rem auto 1fr;
  align-items: center;
  gap: 8px 10px;
  padding: 8px 0;
  border-top: 1px solid #e4e6ea;
}
.wh-day { font-weight: 600; }
.wh-copy { font-size: 13px; }
.wh-windows { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 8px; }
.wh-window { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.wh-window label { font-size: 13px; opacity: .7; }
.wh-window input[type='time'] { width: auto; min-width: 8rem; }
.wh-drop { min-width: 44px; }
.wh-add { align-self: flex-start; font-size: 13px; }
.wh-legacy { border: 1px dashed #e4e6ea; border-radius: 8px; padding: 8px 10px; }
.wh-legacy-value { margin: 0; white-space: pre-wrap; }

@media (max-width: 640px) {
  .wh-row { grid-template-columns: 1fr; }
  .wh-states { display: flex; }
  .wh-states button { flex: 1 1 0; }
}
```

Dark counterparts (inside the existing dark block):

```css
  .wh-row { border-top-color: #2a2d34; }
  .wh-legacy { border-color: #2a2d34; }
```

- [ ] **Step 7: Run the web suite and typecheck**

Run: `npm run typecheck && npx vitest run src/web`
Expected: clean; all PASS.

- [ ] **Step 8: Break-verify**

Remove the `options.allDay ?` guard from `states` → the PEAK test fails (finds «24 hours»). Restore. Render `value={window.to ?? ''}` without the `endOfDay` branch → the end-of-day test fails (`value="24:00"` appears). Restore.

- [ ] **Step 9: Commit**

```bash
git add src/web/WindowsEditor.tsx src/web/WeekHoursEditor.tsx src/web/__tests__/scheduleEditors.test.tsx src/app/globals.css src/i18n/dictionaries.ts
git commit -m "feat(fill): недельная сетка часов — состояния дня, интервалы, быстрые действия

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Cleaning editor and wiring into `FieldInput`

**Files:**
- Create: `src/web/CleaningScheduleEditor.tsx`
- Modify: `src/web/FieldInput.tsx`
- Modify: `src/web/__tests__/scheduleEditors.test.tsx`

**Interfaces:**
- Consumes: Task 5's components and dictionary keys; `CADENCES`, `NTHS`, `WEEKDAYS`, `CLEANING_DAY_OPTIONS`, `switchCadence`, `cleaningProblem`, `type CleaningSchedule` from `@/form-schema`.
- Produces: `export function CleaningScheduleEditor(props: { value: unknown; onChange: (schedule: CleaningSchedule) => void; idPrefix: string }): React.JSX.Element`; `FieldInput` renders both schedule types.

- [ ] **Step 1: Write the failing tests**

Append to `src/web/__tests__/scheduleEditors.test.tsx`:

```tsx
import { fieldByKey } from '@/form-schema'
import { FieldInput } from '../FieldInput'
import { CleaningScheduleEditor } from '../CleaningScheduleEditor'

function renderCleaning(value: unknown): string {
  return renderToStaticMarkup(
    <LocaleProvider initial="en">
      <CleaningScheduleEditor value={value} onChange={() => {}} idPrefix="III.1.4" />
    </LocaleProvider>,
  )
}

describe('CleaningScheduleEditor', () => {
  it('четыре периодичности кнопками, выбранная помечена', () => {
    const html = renderCleaning({ cadence: 'daily', windows: [{ from: '02:00', to: '04:00' }] })
    for (const label of ['Daily', 'Weekly', 'Monthly', 'Quarterly']) expect(html).toContain(label)
    expect(html).toContain('aria-pressed="true"')
  })

  it('ежедневно — один список интервалов, без сетки дней', () => {
    const html = renderCleaning({ cadence: 'daily', windows: [{ from: '14:30', to: '15:00' }] })
    expect(html).toContain('value="14:30"')
    expect(html).not.toContain('class="wh-row"')
  })

  it('еженедельно — недельная сетка без «24 часа», пустое читается «No cleaning»', () => {
    const html = renderCleaning({ cadence: 'weekly', days: {} })
    expect(html.match(/class="wh-row"/g)).toHaveLength(7)
    expect(html).toContain('No cleaning')
    expect(html).not.toContain(UI['schedule.allDay'].en)
  })

  it('ежемесячно — выбор «какой по счёту» и дня недели плюс интервалы', () => {
    const html = renderCleaning({ cadence: 'monthly', nth: 1, weekday: 'mon', windows: [{ from: '22:00', to: '23:30' }] })
    expect(html).toContain(UI['schedule.nth'].en)
    expect(html).toContain(UI['schedule.weekday'].en)
    expect(html).toContain('value="22:00"')
  })

  it('старый текст показан с пометкой', () => {
    const html = renderCleaning('Every day: 14:30 – 15:00')
    expect(html).toContain('Every day: 14:30 – 15:00')
    expect(html).toContain(UI['form.freeFormAnswer'].en)
  })
})

describe('FieldInput отдаёт расписания своим редакторам', () => {
  const render = (key: string, value: unknown) =>
    renderToStaticMarkup(
      <LocaleProvider initial="en">
        <FieldInput field={fieldByKey(key)!} value={value} onChange={() => {}} />
      </LocaleProvider>,
    )

  it('III.1.1 — сетка с «24 часа» и «Closed»', () => {
    const html = render('III.1.1', {})
    expect(html).toContain(UI['schedule.allDay'].en)
    expect(html).toContain('Closed')
    expect(html).toContain('Lounge Operating Hours')
  })

  it('III.1.3 — та же сетка без «24 часа», пустое «No peak»', () => {
    const html = render('III.1.3', {})
    expect(html).not.toContain(UI['schedule.allDay'].en)
    expect(html).toContain('No peak')
  })

  it('III.1.4 — редактор уборки', () => {
    expect(render('III.1.4', { cadence: 'daily', windows: [] })).toContain(UI['schedule.cadence'].en)
  })

  it('отказ сервера рисуется тем же .fix-comment, что у остальных полей', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider initial="en">
        <FieldInput field={fieldByKey('III.1.1')!} value={{}} onChange={() => {}} error="Check the schedule" />
      </LocaleProvider>,
    )
    expect(html).toContain('class="fix-comment"')
    expect(html).toContain('Check the schedule')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/web/__tests__/scheduleEditors.test.tsx`
Expected: FAIL — cannot resolve `../CleaningScheduleEditor`.

- [ ] **Step 3: Implement `CleaningScheduleEditor`**

Create `src/web/CleaningScheduleEditor.tsx`:

```tsx
'use client'

import type React from 'react'
import {
  CADENCES,
  CLEANING_DAY_OPTIONS,
  NTHS,
  WEEKDAYS,
  cleaningProblem,
  switchCadence,
  type Cadence,
  type CleaningSchedule,
  type Nth,
  type Weekday,
} from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { WindowsEditor } from './WindowsEditor'
import { WeekHoursEditor } from './WeekHoursEditor'

/** Подписи периодичности и порядкового номера — в интерфейсе, а не в
 *  `schedule.ts`: там живут подписи КАНОНИЧЕСКОГО текста (короткие, для файла
 *  и экрана проверки), здесь — подписи кнопок. Совпадать они не обязаны, и
 *  сведение их в одну таблицу связало бы формулировку файла с формулировкой
 *  кнопки. */
const CADENCE_BUTTON: Record<Cadence, { en: string; ru: string }> = {
  daily: { en: 'Daily', ru: 'Ежедневно' },
  weekly: { en: 'Weekly', ru: 'Еженедельно' },
  monthly: { en: 'Monthly', ru: 'Ежемесячно' },
  quarterly: { en: 'Quarterly', ru: 'Ежеквартально' },
}

const NTH_BUTTON: Record<string, { en: string; ru: string }> = {
  '1': { en: '1st', ru: '1-й' }, '2': { en: '2nd', ru: '2-й' }, '3': { en: '3rd', ru: '3-й' },
  '4': { en: '4th', ru: '4-й' }, last: { en: 'last', ru: 'последний' },
}

function asSchedule(value: unknown): { schedule: CleaningSchedule | null; legacy: string | null } {
  if (typeof value === 'string' && value.trim() !== '') return { schedule: null, legacy: value }
  if (cleaningProblem(value) !== null) return { schedule: null, legacy: null }
  return { schedule: value as CleaningSchedule, legacy: null }
}

export function CleaningScheduleEditor(props: {
  value: unknown
  onChange: (schedule: CleaningSchedule) => void
  idPrefix: string
}): React.JSX.Element {
  const { t, pick } = useLocale()
  const { schedule, legacy } = asSchedule(props.value)

  return (
    <div className="wh">
      {legacy !== null && (
        <div className="wh-legacy">
          <p className="wh-legacy-value">{legacy}</p>
          <p className="field-hint">{t('form.freeFormAnswer')}</p>
        </div>
      )}

      <span className="wh-day">{t('schedule.cadence')}</span>
      <span className="chip-row" role="group" aria-label={t('schedule.cadence')}>
        {CADENCES.map((cadence) => (
          <button
            key={cadence}
            type="button"
            aria-pressed={schedule?.cadence === cadence}
            // Перенос интервалов при смене — правило схемы (`switchCadence`),
            // не решение кнопки: она передаёт туда текущее значение и кладёт
            // обратно то, что вернули.
            onClick={() => props.onChange(switchCadence(schedule, cadence))}
          >
            {pick(CADENCE_BUTTON[cadence])}
          </button>
        ))}
      </span>

      {schedule?.cadence === 'weekly' && (
        <WeekHoursEditor
          value={schedule.days}
          options={CLEANING_DAY_OPTIONS}
          idPrefix={props.idPrefix}
          onChange={(days) => props.onChange({ cadence: 'weekly', days })}
        />
      )}

      {(schedule?.cadence === 'monthly' || schedule?.cadence === 'quarterly') && (
        <div className="wh-window">
          <label htmlFor={`${props.idPrefix}-nth`}>{t('schedule.nth')}</label>
          <select
            id={`${props.idPrefix}-nth`}
            value={String(schedule.nth)}
            onChange={(e) =>
              props.onChange({ ...schedule, nth: (e.target.value === 'last' ? 'last' : Number(e.target.value)) as Nth })
            }
          >
            {NTHS.map((nth) => (
              <option key={String(nth)} value={String(nth)}>{pick(NTH_BUTTON[String(nth)]!)}</option>
            ))}
          </select>
          <label htmlFor={`${props.idPrefix}-weekday`}>{t('schedule.weekday')}</label>
          <select
            id={`${props.idPrefix}-weekday`}
            value={schedule.weekday}
            onChange={(e) => props.onChange({ ...schedule, weekday: e.target.value as Weekday })}
          >
            {WEEKDAYS.map((day) => (
              <option key={day} value={day}>{t(`schedule.day.${day}`)}</option>
            ))}
          </select>
        </div>
      )}

      {schedule && schedule.cadence !== 'weekly' && (
        <WindowsEditor
          windows={schedule.windows}
          idPrefix={props.idPrefix}
          onChange={(windows) => props.onChange({ ...schedule, windows })}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 4: Wire `FieldInput`**

In `src/web/FieldInput.tsx` add the imports (`WeekHoursEditor`, `CleaningScheduleEditor`) and, before `case 'textarea':`:

```tsx
    // Расписания: свой редактор на каждый из двух типов, обёртка та же, что у
    // всех полей (подпись, подсказка, значок провенанса, отказ сервера).
    // `field.example` здесь не рисуется: сетка и есть пример, а текстовый
    // пример рядом с ней противоречил бы ей.
    case 'weekHours':
      return (
        <div className="field">
          {label}
          {hint}
          {field.hoursOptions && (
            <WeekHoursEditor
              value={value}
              options={field.hoursOptions}
              idPrefix={field.key}
              onChange={onChange}
            />
          )}
          {errorNode}
        </div>
      )

    case 'cleaningSchedule':
      return (
        <div className="field">
          {label}
          {hint}
          <CleaningScheduleEditor value={value} idPrefix={field.key} onChange={onChange} />
          {errorNode}
        </div>
      )
```

- [ ] **Step 5: Run the web suite and typecheck**

Run: `npm run typecheck && npx vitest run src/web`
Expected: clean; all PASS. `fieldContract.test.ts` may need the new types added to a type-partition assertion — if it fails, read its intent first and extend the partition rather than loosening it; explain the change in the commit message.

- [ ] **Step 6: Break-verify**

Swap `CLEANING_DAY_OPTIONS` for the operating-hours options in the weekly branch → the «еженедельно без 24 часа» test fails. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/web/CleaningScheduleEditor.tsx src/web/FieldInput.tsx src/web/__tests__/scheduleEditors.test.tsx
git commit -m "feat(fill): график уборки — периодичность и её детали, оба расписания в FieldInput

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Export — a column per weekday

**Files:**
- Modify: `src/export/columns.ts` (`flatColumns`)
- Modify: `src/export/rows.ts` (field placement)
- Modify: `src/export/__tests__/columns.test.ts`

**Interfaces:**
- Consumes: `weekHoursCells`, `cleaningCells`, `WEEKDAYS` from `@/form-schema` (Task 3); field types from Task 4.
- Produces:
  - `export function scheduleColumnSuffixes(field: Field): readonly string[] | null` in `columns.ts` — `null` for ordinary fields; `['mon',…,'sun','free']` for `weekHours`; `['cadence','mon',…,'sun','free']` for `cleaningSchedule`
  - `export function renderFieldCells(fieldKey: string, value: unknown): Array<[string, ExportCell]>` in `rows.ts`
  - Column keys `III.1.1.mon`, `III.1.1.free`, `III.1.4.cadence`, …

- [ ] **Step 1: Update the column oracle tests (they must fail first)**

In `src/export/__tests__/columns.test.ts`: the `fields`-group oracle currently asserts one column per field key. Replace those two tests, keeping the golden fixture as the source of keys:

```ts
/**
 * Расписания (`weekHours`, `cleaningSchedule`) — единственные поля, у которых
 * колонок больше одной: получателю нужна ячейка на день недели, а не строка
 * «Mon–Sat …» (решение пользователя). Суффиксы перечислены здесь ЛИТЕРАЛЬНО,
 * а не взяты из `columns.ts`: оракул, выведенный из реализации, повторил бы
 * её ошибку. Ключи расписаний тоже литеральные — те же три, что закреплены в
 * `fields.test.ts`.
 */
const SCHEDULE_SUFFIXES: Record<string, string[]> = {
  'III.1.1': ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'free'],
  'III.1.3': ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'free'],
  'III.1.4': ['cadence', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'free'],
}

const expectedFieldKeys = sourceFieldKeys.flatMap((key) =>
  SCHEDULE_SUFFIXES[key] ? SCHEDULE_SUFFIXES[key]!.map((suffix) => `${key}.${suffix}`) : [key],
)

it('поля идут в порядке и составе исходной формы; у расписаний — колонка на день', () => {
  expect(keysOf(inGroup('fields'))).toEqual(expectedFieldKeys)
})

it('заголовок поля — его номер и дословная формулировка исходника, у расписания плюс день', () => {
  for (const key of sourceFieldKeys) {
    const suffixes = SCHEDULE_SUFFIXES[key]
    if (!suffixes) {
      expect(byKey(key)?.header, key).toBe(`${key} ${sourceFieldLabels[key]}`)
      continue
    }
    for (const suffix of suffixes) {
      const header = byKey(`${key}.${suffix}`)?.header
      expect(header, `${key}.${suffix}`).toBe(`${key} ${sourceFieldLabels[key]} — ${SUFFIX_HEADERS[suffix]}`)
    }
  }
})
```

and next to `SCHEDULE_SUFFIXES` add the header words (literal, so a renamed header fails loudly):

```ts
const SUFFIX_HEADERS: Record<string, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
  cadence: 'Cadence', free: 'Free text',
}
```

Update the `field_values` oracle's comment and assertion: the group is no longer one column per key, and the oracle's point (`value` is the only stored attribute) still holds. Replace the test body with:

```ts
  it('field_values хранит ровно один атрибут — value; новая колонка требует решения о выгрузке', () => {
    expect(storedFieldAttributes).toEqual(['value'])
  })

  // Хвост того же оракула: одна колонка на ключ ПЕРЕСТАЛА быть правилом —
  // расписания раскладывают своё единственное `value` на день недели
  // (`scheduleColumnSuffixes`). Утверждение теперь такое: колонок больше
  // одной ровно у расписаний, у всех прочих полей — по одной.
  it('несколько колонок на поле — только у расписаний', () => {
    for (const key of sourceFieldKeys) {
      const own = keysOf(inGroup('fields')).filter((k) => k === key || k.startsWith(`${key}.`))
      expect(own.length, key).toBe(SCHEDULE_SUFFIXES[key]?.length ?? 1)
    }
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/export/__tests__/columns.test.ts`
Expected: FAIL — `III.1.1` present as a single key, `III.1.1.mon` missing.

- [ ] **Step 3: Implement the columns**

In `src/export/columns.ts` add:

```ts
/**
 * Суффиксы колонок поля-расписания, или `null` у обычного поля (одна колонка,
 * ключ = ключ поля). Ячейка на день недели — решение получателя: «Mon–Sat
 * 09:00–18:00» в одной ячейке человек читает, а машина нет. `free` держит
 * старый свободный текст, чтобы он не потерялся и не смешался с часами.
 */
export function scheduleColumnSuffixes(field: Field): readonly string[] | null {
  if (field.type === 'weekHours') return [...WEEKDAYS, 'free']
  if (field.type === 'cleaningSchedule') return ['cadence', ...WEEKDAYS, 'free']
  return null
}

const SUFFIX_HEADER: Record<string, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
  cadence: 'Cadence', free: 'Free text',
}
```

and replace the `fields` mapping inside `flatColumns`:

```ts
  const fields: Column[] = FIELDS.flatMap((field) => {
    const suffixes = scheduleColumnSuffixes(field)
    if (!suffixes) {
      return [{ key: field.key, header: `${field.key} ${field.label.en}`, group: 'fields' as const }]
    }
    return suffixes.map((suffix) => ({
      key: `${field.key}.${suffix}`,
      header: `${field.key} ${field.label.en} — ${SUFFIX_HEADER[suffix]}`,
      group: 'fields' as const,
    }))
  })
```

with `WEEKDAYS` and `type Field` added to the `@/form-schema` import.

- [ ] **Step 4: Implement the row placement**

In `src/export/rows.ts` add, next to `renderField`:

```ts
/**
 * Ячейки ОДНОГО поля с их ключами колонок. У обычного поля пара одна — та же,
 * что раньше писал `put(fieldKey, renderField(...))`. У расписания их девять
 * или десять: раскладку считает схема (`weekHoursCells`/`cleaningCells`),
 * выгрузка только разносит по ключам, чтобы «какой день в какой колонке» не
 * было написано дважды.
 */
export function renderFieldCells(fieldKey: string, value: unknown): Array<[string, ExportCell]> {
  const field = fieldByKey(fieldKey)
  if (!field) return []

  if (field.type === 'weekHours') {
    if (!field.hoursOptions) return []
    const cells = weekHoursCells(value, field.hoursOptions)
    return Object.entries(cells).map(([suffix, cell]) => [`${fieldKey}.${suffix}`, cell])
  }
  if (field.type === 'cleaningSchedule') {
    const cells = cleaningCells(value)
    return Object.entries(cells).map(([suffix, cell]) => [`${fieldKey}.${suffix}`, cell])
  }
  return [[fieldKey, renderField(fieldKey, value)]]
}
```

and in `buildFlatRows` replace the field loop:

```ts
      for (const [fieldKey, value] of Object.entries(values.fields)) {
        for (const [columnKey, cell] of renderFieldCells(fieldKey, value)) put(columnKey, cell)
      }
```

with `weekHoursCells`, `cleaningCells` added to the `@/form-schema` import. `single.ts` is NOT changed: it prints one row per field via `renderField`, which now returns the canonical text through `formatFieldValue` — one line per schedule, which is what a per-questionnaire sheet wants.

- [ ] **Step 5: Run the export suite and typecheck**

Run: `npm run typecheck && npx vitest run src/export`
Expected: clean; all PASS (columns, rows, roundtrip).

- [ ] **Step 6: Break-verify**

Drop `'free'` from `scheduleColumnSuffixes` for `weekHours` → the column-oracle test fails naming `III.1.1.free`. Restore. Return `[[fieldKey, renderField(...)]]` for `weekHours` in `renderFieldCells` → roundtrip fails (the day columns stay empty). Restore.

- [ ] **Step 7: Commit**

```bash
git add src/export/columns.ts src/export/rows.ts src/export/__tests__/columns.test.ts
git commit -m "feat(export): расписания выгружаются колонкой на день недели плюс свободный текст

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Seed and the end-to-end scenario

**Files:**
- Modify: `scripts/seed-dev.ts` (`valueForField`)
- Modify: `e2e/fill.spec.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Teach the seed the new types**

In `scripts/seed-dev.ts`, `valueForField`, add before `case 'date':`:

```ts
    // Расписания: полная неделя, иначе анкета неполна (`fieldAnswered`) и
    // режимы `--complete`/`--submitted` не дошли бы до отправки. Часы работы —
    // до конца суток (`END_OF_DAY`), пиковые — два интервала в будни и «нет
    // пика» в выходные: сид показывает и разрывной день, и пустой.
    case 'weekHours': {
      const peak = field.key === 'III.1.3'
      return Object.fromEntries(
        WEEKDAYS.map((day) => {
          const weekend = day === 'sat' || day === 'sun'
          if (peak && weekend) return [day, { kind: 'none' }]
          if (peak) {
            return [day, { kind: 'windows', windows: [
              { from: '06:00', to: '09:00' }, { from: '17:00', to: '21:00' },
            ] }]
          }
          return [day, { kind: 'windows', windows: [{ from: weekend ? '03:00' : '00:00', to: END_OF_DAY }] }]
        }),
      )
    }

    case 'cleaningSchedule':
      return { cadence: 'daily', windows: [{ from: '14:30', to: '15:00' }] }
```

with `WEEKDAYS`, `END_OF_DAY` added to the `../src/form-schema` import.

- [ ] **Step 2: Run every seed mode**

Run:
```bash
docker compose up -d
npm run seed && npm run seed -- --complete && npm run seed -- --submitted && npm run seed -- --changes-requested
```
Expected: each prints a URL and exits 0. Then `npm run typecheck`.

- [ ] **Step 3: Write the e2e scenario**

Add to `e2e/fill.spec.ts`, after the contact-fields test:

```ts
/**
 * Структурированные расписания (spec 2026-09-04): сетка вместо свободного
 * текста, быстрые действия и разрывной день — целиком через настоящий путь
 * (клики, автосохранение, перезагрузка). Правила формы и сжатия дней
 * закреплены юнитами (`src/form-schema/__tests__/schedule.test.ts`); здесь —
 * что оператор может это собрать и что собранное доживает до сервера.
 */
test('расписание: неделя одним нажатием, разрывной день, закрытое воскресенье — и всё это переживает перезагрузку', async ({ page }) => {
  const url = seed()
  await page.goto(url)

  await clickNext(page, 2)
  await expect(page.getByRole('heading', { name: 'Operating Schedule', level: 1 })).toBeVisible()

  const hours = page.locator('.field').filter({ hasText: 'Lounge Operating Hours' })
  const dayRow = (label: string) => hours.locator('.wh-row').filter({ hasText: label })

  // Понедельник по часам: 01:00–11:00 и второй интервал 12:00–23:00.
  await dayRow('Monday').getByRole('button', { name: 'By hours' }).click()
  const monday = dayRow('Monday')
  await monday.locator('input[type="time"]').first().fill('01:00')
  await monday.locator('input[type="time"]').nth(1).fill('11:00')
  await monday.getByRole('button', { name: '+ interval' }).click()
  await monday.locator('input[type="time"]').nth(2).fill('12:00')
  await monday.locator('input[type="time"]').nth(3).fill('23:00')
  await expect(page.getByText('Saved')).toBeVisible()

  // Одна кнопка — вся неделя.
  await hours.getByRole('button', { name: 'Same all week' }).click()
  await expect(page.getByText('Saved')).toBeVisible()
  for (const day of ['Tuesday', 'Sunday']) {
    await expect(dayRow(day).locator('input[type="time"]').first()).toHaveValue('01:00')
  }

  // Воскресенье закрыто — и «Closed» нажато именно у него.
  await dayRow('Sunday').getByRole('button', { name: 'Closed' }).click()
  await expect(page.getByText('Saved')).toBeVisible()
  await expect(dayRow('Sunday').getByRole('button', { name: 'Closed' })).toHaveAttribute('aria-pressed', 'true')
  await expect(dayRow('Saturday').getByRole('button', { name: 'Closed' })).toHaveAttribute('aria-pressed', 'false')

  // Пиковые часы: у них нет круглосуточного состояния, а пустое читается иначе.
  const peak = page.locator('.field').filter({ hasText: 'Peak Hours' })
  await expect(peak.getByRole('button', { name: '24 hours' })).toHaveCount(0)
  await expect(peak.locator('.wh-row').first().getByRole('button', { name: 'No peak' })).toBeVisible()

  // Уборка: ежемесячно, первый понедельник, 22:00–23:30.
  const cleaning = page.locator('.field').filter({ hasText: 'Deep Cleaning Schedule' })
  await cleaning.getByRole('button', { name: 'Monthly' }).click()
  await cleaning.getByRole('button', { name: '+ interval' }).click()
  await cleaning.locator('input[type="time"]').first().fill('22:00')
  await cleaning.locator('input[type="time"]').nth(1).fill('23:30')
  await expect(page.getByText('Saved')).toBeVisible()

  // Перечитываем с сервера — структура сохранилась целиком.
  await page.reload()
  await clickNext(page, 2)
  const monAgain = page.locator('.field').filter({ hasText: 'Lounge Operating Hours' }).locator('.wh-row').filter({ hasText: 'Monday' })
  await expect(monAgain.locator('input[type="time"]')).toHaveCount(4)
  await expect(monAgain.locator('input[type="time"]').nth(2)).toHaveValue('12:00')
  await expect(
    page.locator('.field').filter({ hasText: 'Lounge Operating Hours' }).locator('.wh-row').filter({ hasText: 'Sunday' })
      .getByRole('button', { name: 'Closed' }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(
    page.locator('.field').filter({ hasText: 'Deep Cleaning Schedule' }).getByRole('button', { name: 'Monthly' }),
  ).toHaveAttribute('aria-pressed', 'true')
})
```

If a locator does not match what the app renders, read the component before changing the assertion, and explain every deviation in the test comment and the report. Do not change application code in this task; if the app is wrong, report BLOCKED with specifics.

- [ ] **Step 4: Run the new test, then the whole suite**

Run: `caffeinate -dimsu npx playwright test e2e/fill.spec.ts -g "расписание"`
Then: `caffeinate -dimsu npx playwright test`
Expected: PASS. Known flake: `review.spec.ts` «правка из устаревшей вкладки» has failed once under load and passed on rerun; if it alone fails, rerun that one test and report both outcomes.

Note: the review-cycle e2e tests submit a seeded questionnaire; if any of them now fail on completeness, the seed (Step 1) is the place to fix it, not the test.

- [ ] **Step 5: Break-verify**

Temporarily make `applyToAll` return the week unchanged → the «Same all week» assertions fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add scripts/seed-dev.ts e2e/fill.spec.ts
git commit -m "test(e2e): расписания — неделя одним нажатием, разрывной день, закрытый день, месячная уборка

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Gates, browser check, hand-off

**Files:** none new; verification only.

- [ ] **Step 1: Four gates, one at a time, dev server stopped**

```bash
npm run typecheck
caffeinate -dimsu npx vitest run
caffeinate -dimsu npm run build
caffeinate -dimsu npx playwright test
```
Expected: all green. Record counts.

- [ ] **Step 2: Browser check (Browser pane, `next-dev` from `.claude/launch.json`)**

1. `npm run seed` → open the fill URL → step 3 «Operating Schedule». Confirm: seven day rows with three state buttons; picking «By hours» reveals the time pair; «+ interval» adds a second; «until end of day» presses and empties the end field; «Same all week» fills every day; «Same as previous day» is absent on Monday and disabled while the previous day is unanswered.
2. Peak Hours: no «24 hours», empty state reads «No peak».
3. Deep Cleaning: switch Daily → Monthly, confirm the intervals carry over and the ordinal/weekday selects appear; switch to Weekly and back, confirm the grid appears and the interval list starts empty.
4. Mobile 375 px: rows stack, state buttons span the row, time inputs reachable, nothing overflows horizontally.
5. Dark theme: row separators and the legacy note border visible.
6. `npm run seed -- --submitted` → log in as `reviewer@easyto.travel` (`npx tsx scripts/dev-login-link.ts reviewer@easyto.travel`) → open the submission → block «Operating Schedule»: the three rows print canonical text (e.g. `Mon–Fri 00:00–24:00; Sat–Sun 03:00–24:00`). Pencil on the operating-hours row → the same grid appears in the editor → change Sunday to «Closed» → Save → the row's text updates and shows «Corrected by the team».
7. Download the xlsx from the submission (`Download xlsx`) and confirm the schedule rows print one line each; then check the flat export from the registry has the per-day columns.
8. Stop the dev server.

- [ ] **Step 3: Hand-off**

Report: gate counts, browser observations, any pins changed, and the deferred minors from the ledger. Then present the finishing menu (1 merge locally / 2 PR / 3 keep) and WAIT for the answer — never merge or push without it (user's explicit instruction of 2026-09-03).

---

## Self-review

- **Spec coverage.** Data model → Tasks 1–2. Server gate incl. `null`/legacy string → Task 4. Completeness incl. unfinished window, all-`none` week, `fieldAnswered` → Tasks 2, 4. Canonical text with day compression, both locales → Task 3. Export per-weekday + cadence + free text → Tasks 3, 7. Single-submission sheet prints one line → Task 7 Step 4 (explicitly unchanged, `renderField` routes through `formatFieldValue`). Editors, quick actions, cadence switch, legacy note, mobile/dark → Tasks 5, 6. All three `FieldInput` mounts (fill / fixes / review editor) get the grid because they share the component → Task 6, verified in Task 9 Step 2 item 6. Seed → Task 8. e2e → Task 8. No migration → no task, by design (stated in Task 4's field-type comment).
- **Placeholder scan.** None: every code step carries real code, every test step real assertions.
- **Type consistency.** `Window`, `DayHours`, `WeekHours`, `HoursOptions`, `CleaningSchedule`, `Weekday`, `Nth`, `Cadence`, `END_OF_DAY`, `windowsProblem`, `weekHoursProblem`, `cleaningProblem`, `windowsFinished`, `weekHoursComplete`, `cleaningComplete`, `applyToAll`, `applyToWeekdays`, `applyToWeekend`, `copyPreviousDay`, `switchCadence`, `formatWindows`, `formatDayHours`, `formatWeekHours`, `formatCleaning`, `weekHoursCells`, `cleaningCells`, `CLEANING_DAY_OPTIONS`, `WEEKDAY_WORKDAYS`, `WEEKDAY_WEEKEND`, `fieldAnswered`, `scheduleColumnSuffixes`, `renderFieldCells` are spelled identically everywhere they appear. `Field.hoursOptions` is `HoursOptions | null` in Tasks 4–7. Dictionary keys used in Tasks 5–6 are all declared in Task 5 Step 1.
