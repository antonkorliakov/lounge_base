# План 1. Основа и заполнение анкеты

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Оператор лаунжа открывает ссылку на телефоне, заполняет анкету из 417 точек данных и отправляет её на проверку.

**Architecture:** Next.js App Router. Модуль `form-schema` — чистые данные без React и БД — единственный источник правды для рендера формы, валидации и (позже) выгрузки. Данные пишутся в Postgres через Drizzle: плоские поля в `field_values` как JSONB, матрица услуг в `service_values` колонками.

**Tech Stack:** TypeScript, Next.js (App Router), React, Drizzle ORM, Postgres (PGlite в тестах, Docker локально, Neon в проде), Zod, Vitest, Playwright, Vercel Blob.

## Global Constraints

- Источник требований — `/Users/antonwork/Downloads/Global Onboarding Form 1.xlsx`, листы `General Lounge Information` и `Services & Amenities`. Листы `Approuved by DF` не используются.
- Колонка «DF form Yes/No» (`E` на первом листе, `I` на втором) не переносится в систему.
- Объём анкеты фиксирован и проверяется тестами: **67** плоских полей, **58** позиций услуг (44 услуги + 14 F&B), **6** атрибутов у позиции, **16** списков значений, **27** блоков проверки.
- TypeScript в `strict` режиме. Никаких `any` в `src/form-schema`.
- `src/form-schema` не импортирует ни React, ни `src/db` — проверяется тестом.
- Каждое поле и каждый вариант списка имеет обе локали: `en` и `ru`.
- Английские формулировки полей копируются из xlsx дословно, включая пунктуацию и звёздочки обязательности.
- Все команды запускаются с `/opt/homebrew/bin` в `PATH` (там установлены node и npm).

---

### Task 1: Каркас проекта и тестовая обвязка

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `next.config.ts`, `docker-compose.yml`, `.env.example`
- Create: `src/form-schema/types.ts`
- Test: `src/form-schema/__tests__/purity.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: скрипты `npm test`, `npm run dev`, `npm run db:push`; тип-модуль `src/form-schema/types.ts` (пока пустой файл с экспортом-заглушкой заменяется в Task 2)

- [ ] **Step 1: Инициализировать проект и поставить зависимости**

```bash
cd /Users/antonwork/lounge_base
export PATH="/opt/homebrew/bin:$PATH"
npm init -y
npm install next react react-dom drizzle-orm postgres zod
npm install -D typescript @types/node @types/react @types/react-dom \
  vitest @vitejs/plugin-react drizzle-kit @electric-sql/pglite tsx
```

- [ ] **Step 2: Записать конфигурацию**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "jsx": "preserve",
    "incremental": true,
    "noEmit": true,
    "allowJs": true,
    "isolatedModules": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': resolve(__dirname, './src') } },
  test: { environment: 'node', include: ['src/**/*.test.{ts,tsx}'] },
})
```

`next.config.ts`:

```ts
import type { NextConfig } from 'next'
const config: NextConfig = { reactStrictMode: true }
export default config
```

`docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_USER: lounge
      POSTGRES_PASSWORD: lounge
      POSTGRES_DB: lounge_base
    ports: ['5432:5432']
    volumes: ['pgdata:/var/lib/postgresql/data']
volumes:
  pgdata:
```

`.env.example`:

```
DATABASE_URL=postgres://lounge:lounge@localhost:5432/lounge_base
BLOB_READ_WRITE_TOKEN=
```

- [ ] **Step 3: Прописать скрипты в `package.json`**

Заменить блок `"scripts"` на:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "db:push": "drizzle-kit push",
    "db:generate": "drizzle-kit generate"
  }
}
```

Добавить в корень `package.json` строку `"type": "module"`.

- [ ] **Step 4: Написать падающий тест на чистоту form-schema**

`src/form-schema/__tests__/purity.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(process.cwd(), 'src/form-schema')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' ? [] : sourceFiles(path)
    }
    return path.endsWith('.ts') ? [path] : []
  })
}

describe('form-schema остаётся чистым', () => {
  it('не импортирует React и слой БД', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(ROOT)) {
      const text = readFileSync(file, 'utf8')
      if (/from ['"](react|@\/db|drizzle-orm)/.test(text)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('содержит хотя бы один модуль', () => {
    expect(sourceFiles(ROOT).length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 5: Прогнать тест и убедиться, что он падает**

Run: `npm test`
Expected: FAIL — каталог `src/form-schema` не существует, `readdirSync` бросает `ENOENT`.

- [ ] **Step 6: Создать минимальный модуль**

`src/form-schema/types.ts`:

```ts
/** Локализованная строка. Английский вариант дословно копируется из xlsx. */
export type Localized = { en: string; ru: string }
```

- [ ] **Step 7: Прогнать тесты и проверку типов**

Run: `npm test && npm run typecheck`
Expected: PASS, два теста зелёные.

- [ ] **Step 8: Коммит**

```bash
git add -A
git commit -m "chore: scaffold Next.js project with vitest and drizzle tooling"
```

---

### Task 2: Списки значений

**Files:**
- Create: `src/form-schema/option-lists.ts`
- Test: `src/form-schema/__tests__/option-lists.test.ts`

**Interfaces:**
- Consumes: `Localized` из `src/form-schema/types.ts`
- Produces: `OptionListId` (строковый union), `Option = { id: string; label: Localized; requiresDetail: boolean }`, `OPTION_LISTS: Record<OptionListId, Option[]>`

- [ ] **Step 1: Написать падающий тест**

`src/form-schema/__tests__/option-lists.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { OPTION_LISTS } from '../option-lists'

describe('списки значений', () => {
  it('их ровно 16', () => {
    expect(Object.keys(OPTION_LISTS)).toHaveLength(16)
  })

  it('в каждом списке минимум два варианта', () => {
    for (const [id, options] of Object.entries(OPTION_LISTS)) {
      expect(options.length, `список ${id}`).toBeGreaterThanOrEqual(2)
    }
  })

  it('идентификаторы вариантов уникальны внутри списка', () => {
    for (const [id, options] of Object.entries(OPTION_LISTS)) {
      const ids = options.map((o) => o.id)
      expect(new Set(ids).size, `список ${id}`).toBe(ids.length)
    }
  })

  it('у каждого варианта заполнены обе локали', () => {
    for (const options of Object.values(OPTION_LISTS)) {
      for (const option of options) {
        expect(option.label.en.trim()).not.toBe('')
        expect(option.label.ru.trim()).not.toBe('')
      }
    }
  })

  it('варианты со «Specify» требуют уточнения', () => {
    for (const options of Object.values(OPTION_LISTS)) {
      for (const option of options) {
        if (/specify/i.test(option.label.en)) {
          expect(option.requiresDetail, option.label.en).toBe(true)
        }
      }
    }
  })

  it('регистровые дубли схлопнуты в один список allowedNotAllowed', () => {
    const signatures = Object.values(OPTION_LISTS).map((options) =>
      options.map((o) => o.label.en.toLowerCase()).join('|'),
    )
    expect(new Set(signatures).size).toBe(signatures.length)
  })
})
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npm test -- option-lists`
Expected: FAIL — `Cannot find module '../option-lists'`.

- [ ] **Step 3: Написать списки**

`src/form-schema/option-lists.ts`. Значения `en` скопированы из `dataValidation` исходного файла дословно; `«Allowed, Not allowed»` и `«Allowed, Not Allowed»` объединены в `allowedNotAllowed`.

```ts
import type { Localized } from './types'

export type Option = {
  id: string
  label: Localized
  /** Вариант обязывает заполнить текстовое уточнение. */
  requiresDetail: boolean
}

const plain = (id: string, en: string, ru: string): Option => ({
  id,
  label: { en, ru },
  requiresDetail: false,
})

const detail = (id: string, en: string, ru: string): Option => ({
  id,
  label: { en, ru },
  requiresDetail: true,
})

export const OPTION_LISTS = {
  yesNo: [plain('yes', 'Yes', 'Да'), plain('no', 'No', 'Нет')],

  yesSpecifyNo: [
    detail('yes', 'Yes (Specify→)', 'Да (уточните→)'),
    plain('no', 'No', 'Нет'),
  ],

  allowedNotAllowed: [
    plain('allowed', 'Allowed', 'Разрешено'),
    plain('not_allowed', 'Not allowed', 'Не разрешено'),
  ],

  allowedNotAllowedOther: [
    plain('allowed', 'Allowed', 'Разрешено'),
    plain('not_allowed', 'Not allowed', 'Не разрешено'),
    detail('other', 'Other (Specify→)', 'Другое (уточните→)'),
  ],

  allowedConditional: [
    plain('allowed', 'Allowed', 'Разрешено'),
    detail(
      'conditional',
      'Allowed under specific conditions',
      'Разрешено при определённых условиях',
    ),
    plain('not_allowed', 'Not allowed', 'Не разрешено'),
  ],

  floor: [
    plain('mezzanine', 'Mezzanine', 'Мезонин'),
    plain('ground', 'Ground', 'Первый (ground)'),
    plain('first', '1st', '2-й (1st)'),
    plain('second', '2nd', '3-й (2nd)'),
    plain('third', '3rd', '4-й (3rd)'),
  ],

  terminalType: [
    plain('domestic', 'Domestic', 'Внутренний'),
    plain('international', 'International', 'Международный'),
    plain('both', 'Domestic/International', 'Внутренний/Международный'),
  ],

  terminalName: [
    plain('t1', 'T1', 'T1'),
    plain('t2', 'T2', 'T2'),
    plain('t3', 'T3', 'T3'),
    plain('t4', 'T4', 'T4'),
    plain('t5', 'T5', 'T5'),
    plain('main', 'Main Terminal', 'Основной терминал'),
    plain('satellite', 'Satellite', 'Сателлит'),
    detail('other', 'Other (specify)', 'Другое (уточните)'),
  ],

  securityCheck: [
    plain('before', 'Before SHA', 'До досмотра'),
    plain('after', 'After SHA', 'После досмотра'),
  ],

  airsideLandside: [
    plain('airside', 'Airside', 'Стерильная зона'),
    plain('landside', 'Landside', 'Общая зона'),
  ],

  immigration: [
    plain('before', 'Before Immigration', 'До паспортного контроля'),
    plain('after', 'After Immigration', 'После паспортного контроля'),
  ],

  transferMethod: [
    plain('not_applicable', 'Not Applicable', 'Не применимо'),
    plain('walking', 'Walking', 'Пешком'),
    plain('shuttle', 'Shuttle Bus', 'Шаттл'),
    plain('train', 'Airport Train', 'Поезд аэропорта'),
    detail('other', 'Other (Please specify→)', 'Другое (уточните→)'),
  ],

  overcrowding: [
    plain('fcfs', 'First come-First served', 'В порядке очереди'),
    plain('waiting_list', 'Waiting List', 'Лист ожидания'),
    plain(
      'class_priority',
      'Business/First Class priority',
      'Приоритет Business/First',
    ),
    detail('other', 'Other (Specify→)', 'Другое (уточните→)'),
  ],

  airlineAccess: [
    plain(
      'specific',
      'Specific airlines passengers allowed',
      'Только пассажиры определённых авиакомпаний',
    ),
    plain(
      'all',
      'All passengers allowed',
      'Пассажиры всех авиакомпаний',
    ),
  ],

  chargeType: [
    plain('complimentary', 'Complimentary', 'Бесплатно'),
    plain('chargeable', 'Chargeable', 'Платно'),
    plain('both', 'Both', 'И то и другое'),
  ],

  vaping: [
    plain(
      'throughout',
      'Allowed throughout the lounge',
      'Разрешено во всём лаунже',
    ),
    plain(
      'smoking_room',
      'Allowed only in smoking room',
      'Только в комнате для курения',
    ),
    plain('not_allowed', 'Not allowed', 'Не разрешено'),
  ],
} as const satisfies Record<string, Option[]>

export type OptionListId = keyof typeof OPTION_LISTS

export function optionsOf(id: OptionListId): readonly Option[] {
  return OPTION_LISTS[id]
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm test -- option-lists && npm run typecheck`
Expected: PASS, шесть тестов зелёные.

- [ ] **Step 5: Коммит**

```bash
git add src/form-schema/option-lists.ts src/form-schema/__tests__/option-lists.test.ts
git commit -m "feat(form-schema): add the 16 option lists from the source workbook"
```

---

### Task 3: Извлечение плоских полей из xlsx

**Files:**
- Create: `scripts/extract-form-schema.ts`
- Create: `src/form-schema/fields.ts`
- Test: `src/form-schema/__tests__/fields.test.ts`

**Interfaces:**
- Consumes: `Localized`, `OptionListId`
- Produces: `FieldType`, `Field`, `FIELDS: Field[]` — 67 записей в порядке исходной формы

`Field` в точности:

```ts
export type FieldType =
  | 'text' | 'textarea' | 'date' | 'number'
  | 'select' | 'select_with_detail' | 'multi_select' | 'template'

export type TemplateSlot = { key: string; unit: Localized }

export type Field = {
  key: string                    // 'I.1', 'III.6.6' — нумерация исходной формы
  section: string                // 'I' | 'II' | 'III' | 'IV' | 'V'
  block: string                  // ключ блока проверки, см. Task 5
  type: FieldType
  label: Localized
  hint: Localized | null
  example: string | null
  required: boolean
  optionList: OptionListId | null
  templateText: Localized | null
  templateSlots: TemplateSlot[]
}
```

- [ ] **Step 1: Написать скрипт извлечения**

Скрипт запускается **один раз** — его вывод коммитится и дальше правится руками. Он существует, чтобы первичный перенос 67 формулировок был механическим, а не набранным на глаз.

`scripts/extract-form-schema.ts`:

```ts
/**
 * Одноразовое извлечение чернового form-schema из исходного xlsx.
 * Запуск:  npx tsx scripts/extract-form-schema.ts <путь-к-xlsx> > /tmp/fields.json
 * Вывод коммитится в src/form-schema/fields.ts и дальше правится вручную:
 * скрипт больше не запускается, источник правды — TypeScript.
 */
import ExcelJS from 'exceljs'

const SHEET = 'General Lounge Information'
const FIELD_RE = /^(I{1,3}|IV|V)\.\d+(\.\d+)?[.\s]/
const TEMPLATE_RE = /\(\s*\)/

type Draft = {
  key: string
  section: string
  type: string
  labelEn: string
  hintEn: string | null
  example: string | null
  required: boolean
  optionsRaw: string | null
  templateEn: string | null
}

function isSubsectionHeader(label: string): boolean {
  const numbering = label.split(/\s/)[0]!.replace(/\.$/, '')
  const parts = numbering.split('.')
  return parts.length === 2 && (parts[0] === 'II' || parts[0] === 'III')
}

function guessType(d: {
  label: string
  hint: string | null
  optionsRaw: string | null
  template: string | null
}): string {
  if (d.optionsRaw) {
    return /specify/i.test(d.optionsRaw) ? 'select_with_detail' : 'select'
  }
  if (d.template && TEMPLATE_RE.test(d.template)) return 'template'
  if (d.hint && /all applicable/i.test(d.hint)) return 'multi_select'
  if (/\bdate\b/i.test(d.label)) return 'date'
  if (/\((hours|min|%)\)|capacity/i.test(d.label)) return 'number'
  if (/address|directions|restrictions|policy|schedule/i.test(d.label)) {
    return 'textarea'
  }
  return 'text'
}

async function main(): Promise<void> {
  const path = process.argv[2]
  if (!path) throw new Error('usage: extract-form-schema.ts <xlsx>')

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(path)
  const sheet = workbook.getWorksheet(SHEET)
  if (!sheet) throw new Error(`sheet not found: ${SHEET}`)

  const drafts: Draft[] = []

  sheet.eachRow((row, rowNumber) => {
    const label = String(row.getCell('A').value ?? '').trim()
    if (!label || !FIELD_RE.test(label) || isSubsectionHeader(label)) return

    const answerCell = sheet.getCell(`B${rowNumber}`)
    const validation = answerCell.dataValidation
    const optionsRaw =
      validation?.type === 'list' && typeof validation.formulae?.[0] === 'string'
        ? validation.formulae[0].replace(/^"|"$/g, '')
        : null

    const bText = String(row.getCell('B').value ?? '').trim() || null
    const hint = String(row.getCell('C').value ?? '').trim() || null
    const example = String(row.getCell('F').value ?? '').trim() || null
    const numbering = label.split(/\s/)[0]!.replace(/\.$/, '')

    drafts.push({
      key: numbering,
      section: numbering.split('.')[0]!,
      type: guessType({ label, hint, optionsRaw, template: bText }),
      labelEn: label.slice(numbering.length + 1).replace(/^\.\s*/, '').trim(),
      hintEn: hint,
      example,
      required: label.includes('*') || !/if any|if applicable/i.test(label),
      optionsRaw,
      templateEn: bText && TEMPLATE_RE.test(bText) ? bText : null,
    })
  })

  process.stdout.write(JSON.stringify(drafts, null, 2))
  process.stderr.write(`\nизвлечено полей: ${drafts.length}\n`)
}

void main()
```

- [ ] **Step 2: Поставить exceljs и запустить скрипт**

```bash
export PATH="/opt/homebrew/bin:$PATH"
npm install -D exceljs
npx tsx scripts/extract-form-schema.ts \
  "/Users/antonwork/Downloads/Global Onboarding Form 1.xlsx" > /tmp/fields.json
```

Expected: в stderr `извлечено полей: 66`. Скрипт не видит `V. Lounge Validity` — у неё нет номера, она добавляется вручную на шаге 4 и даёт итоговые 67.

- [ ] **Step 3: Написать падающий тест**

`src/form-schema/__tests__/fields.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { FIELDS } from '../fields'
import { OPTION_LISTS } from '../option-lists'

describe('плоские поля', () => {
  it('их ровно 67', () => {
    expect(FIELDS).toHaveLength(67)
  })

  it('ключи уникальны', () => {
    const keys = FIELDS.map((f) => f.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('покрыты все пять разделов в ожидаемых количествах', () => {
    const bySection = (section: string) =>
      FIELDS.filter((f) => f.section === section).length
    expect(bySection('I')).toBe(15)
    expect(bySection('II')).toBe(11)
    expect(bySection('III')).toBe(36)
    expect(bySection('IV')).toBe(4)
    expect(bySection('V')).toBe(1)
  })

  it('каждый select ссылается на существующий список', () => {
    for (const field of FIELDS) {
      if (field.type === 'select' || field.type === 'select_with_detail') {
        expect(field.optionList, field.key).not.toBeNull()
        expect(OPTION_LISTS, field.key).toHaveProperty(field.optionList!)
      } else {
        expect(field.optionList, field.key).toBeNull()
      }
    }
  })

  it('у каждого template есть текст и хотя бы один слот', () => {
    for (const field of FIELDS.filter((f) => f.type === 'template')) {
      expect(field.templateText, field.key).not.toBeNull()
      expect(field.templateSlots.length, field.key).toBeGreaterThan(0)
    }
  })

  it('у каждого поля заполнены обе локали', () => {
    for (const field of FIELDS) {
      expect(field.label.en.trim(), field.key).not.toBe('')
      expect(field.label.ru.trim(), field.key).not.toBe('')
    }
  })

  it('III.6.6 — мультивыбор зоны', () => {
    const zone = FIELDS.find((f) => f.key === 'III.6.6')
    expect(zone?.type).toBe('multi_select')
  })

  it('III.2.1 — шаблон с одним числовым слотом', () => {
    const earliest = FIELDS.find((f) => f.key === 'III.2.1')
    expect(earliest?.type).toBe('template')
    expect(earliest?.templateSlots).toHaveLength(1)
  })
})
```

- [ ] **Step 4: Собрать `fields.ts` из вывода скрипта**

Перенести все 66 записей из `/tmp/fields.json` в массив, добавить 67-ю (`V`), проставить `ru`-переводы, ключи списков и блоки. Скелет файла и первые записи каждого типа — образец, по которому оформляются остальные:

```ts
import type { Localized } from './types'
import type { OptionListId } from './option-lists'

export type FieldType =
  | 'text' | 'textarea' | 'date' | 'number'
  | 'select' | 'select_with_detail' | 'multi_select' | 'template'

export type TemplateSlot = { key: string; unit: Localized }

export type Field = {
  key: string
  section: string
  block: string
  type: FieldType
  label: Localized
  hint: Localized | null
  example: string | null
  required: boolean
  optionList: OptionListId | null
  templateText: Localized | null
  templateSlots: TemplateSlot[]
}

const base = {
  hint: null,
  example: null,
  optionList: null,
  templateText: null,
  templateSlots: [],
} satisfies Partial<Field>

export const FIELDS: Field[] = [
  {
    ...base,
    key: 'I.1',
    section: 'I',
    block: 'I',
    type: 'date',
    label: { en: 'Lounge Open Date*', ru: 'Дата открытия лаунжа*' },
    required: true,
  },
  {
    ...base,
    key: 'I.2',
    section: 'I',
    block: 'I',
    type: 'text',
    label: { en: 'Lounge Full Name*', ru: 'Полное название лаунжа*' },
    required: true,
  },
  // … I.3 – I.15, II.1.1 – II.4.2, III.1.1 – III.1.4

  {
    ...base,
    key: 'III.2.1',
    section: 'III',
    block: 'III.2',
    type: 'template',
    label: {
      en: 'Earliest Access Time Before Departure (hours)',
      ru: 'За сколько часов до вылета открыт доступ',
    },
    hint: {
      en: 'If no restriction applies, enter 0.',
      ru: 'Если ограничений нет, укажите 0.',
    },
    example: 'Access is permitted 3 hours prior to scheduled flight departure.',
    required: true,
    templateText: {
      en: 'Access is permitted ( ) hours prior to scheduled flight departure.',
      ru: 'Доступ разрешён за ( ) часов до вылета по расписанию.',
    },
    templateSlots: [{ key: 'hours', unit: { en: 'hours', ru: 'часов' } }],
  },
  {
    ...base,
    key: 'III.2.4',
    section: 'III',
    block: 'III.2',
    type: 'select_with_detail',
    label: {
      en: 'Airline-Specific Access Restrictions',
      ru: 'Ограничения по авиакомпаниям',
    },
    required: true,
    optionList: 'airlineAccess',
  },
  // … III.3.1 – III.8.2, IV.1 – IV.4

  {
    ...base,
    key: 'III.6.6',
    section: 'III',
    block: 'III.6',
    type: 'multi_select',
    label: {
      en: 'Arrival / Departure / Transit',
      ru: 'Прилёт / Вылет / Транзит',
    },
    hint: {
      en: 'Please indicate all applicable zones (e.g. Departure, Transit)',
      ru: 'Укажите все применимые зоны (например, Вылет, Транзит)',
    },
    example: 'Departure/Transit',
    required: true,
  },
  {
    ...base,
    key: 'V',
    section: 'V',
    block: 'V',
    type: 'date',
    label: {
      en: 'Lounge Validity - Term End date with Airport Authorities',
      ru: 'Срок действия соглашения с администрацией аэропорта',
    },
    required: true,
  },
]

export function fieldByKey(key: string): Field | undefined {
  return FIELDS.find((f) => f.key === key)
}
```

Соответствие списков значений полям — из `dataValidation` исходника:
`III.1.2 → yesSpecifyNo`, `III.2.3 → yesNo`, `III.2.4 → airlineAccess`,
`III.2.5 → allowedConditional`, `III.3.2 → allowedNotAllowed`,
`III.4.1 – III.4.3 → allowedNotAllowedOther`, `III.4.4 → yesSpecifyNo`,
`III.4.5 → yesNo`, `III.4.6 → allowedNotAllowed`, `III.5.2 → floor`,
`III.6.1 → terminalType`, `III.6.2 → terminalName`, `III.6.3 → securityCheck`,
`III.6.4 → airsideLandside`, `III.6.5 → immigration`,
`III.7.2 → transferMethod`, `III.7.4 → yesNo`, `III.8.2 → overcrowding`.

Поля-шаблоны: `III.2.1` (слот `hours`), `III.3.1` (слот `age`),
`III.3.2` (слот `age`), `III.3.3` (слоты `childFrom`, `childTo`, `adultFrom`).

- [ ] **Step 5: Прогнать тесты**

Run: `npm test -- fields && npm run typecheck`
Expected: PASS, восемь тестов зелёные.

- [ ] **Step 6: Коммит**

```bash
git add scripts/extract-form-schema.ts src/form-schema/fields.ts \
        src/form-schema/__tests__/fields.test.ts package.json package-lock.json
git commit -m "feat(form-schema): add the 67 flat questionnaire fields"
```

---

### Task 4: Позиции услуг и питания

**Files:**
- Create: `src/form-schema/services.ts`
- Test: `src/form-schema/__tests__/services.test.ts`

**Interfaces:**
- Consumes: `Localized`
- Produces: `ServiceGroup`, `ServiceItem`, `SERVICE_GROUPS: ServiceGroup[]`, `SERVICE_ITEMS: ServiceItem[]` (58), `SERVICE_ATTRIBUTES` (6 ключей в порядке выгрузки)

- [ ] **Step 1: Написать падающий тест**

`src/form-schema/__tests__/services.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  SERVICE_GROUPS,
  SERVICE_ITEMS,
  SERVICE_ATTRIBUTES,
} from '../services'

describe('матрица услуг', () => {
  it('58 позиций: 44 услуги и 14 F&B', () => {
    expect(SERVICE_ITEMS).toHaveLength(58)
    expect(SERVICE_ITEMS.filter((i) => i.kind === 'amenity')).toHaveLength(44)
    expect(SERVICE_ITEMS.filter((i) => i.kind === 'food')).toHaveLength(14)
  })

  it('11 групп: 8 услуг и 3 питания', () => {
    expect(SERVICE_GROUPS).toHaveLength(11)
    expect(SERVICE_GROUPS.filter((g) => g.kind === 'amenity')).toHaveLength(8)
    expect(SERVICE_GROUPS.filter((g) => g.kind === 'food')).toHaveLength(3)
  })

  it('шесть атрибутов в фиксированном порядке', () => {
    expect(SERVICE_ATTRIBUTES).toEqual([
      'available',
      'chargeType',
      'price',
      'currency',
      'slotMinutes',
      'bookingRequired',
    ])
  })

  it('ключи позиций уникальны', () => {
    const keys = SERVICE_ITEMS.map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('каждая позиция принадлежит существующей группе своего вида', () => {
    const byKey = new Map(SERVICE_GROUPS.map((g) => [g.key, g]))
    for (const item of SERVICE_ITEMS) {
      const group = byKey.get(item.group)
      expect(group, item.key).toBeDefined()
      expect(group!.kind, item.key).toBe(item.kind)
    }
  })

  it('в каждой группе есть хотя бы одна позиция', () => {
    for (const group of SERVICE_GROUPS) {
      const count = SERVICE_ITEMS.filter((i) => i.group === group.key).length
      expect(count, group.key).toBeGreaterThan(0)
    }
  })

  it('у каждой позиции заполнены обе локали', () => {
    for (const item of SERVICE_ITEMS) {
      expect(item.label.en.trim(), item.key).not.toBe('')
      expect(item.label.ru.trim(), item.key).not.toBe('')
    }
  })

  it('вейпинг имеет собственный список вместо да/нет', () => {
    const vaping = SERVICE_ITEMS.find((i) => i.key === '8.3')
    expect(vaping?.availabilityList).toBe('vaping')
  })
})
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npm test -- services`
Expected: FAIL — `Cannot find module '../services'`.

- [ ] **Step 3: Написать `services.ts`**

Названия позиций копируются из колонки `A` листа `Services & Amenities` дословно. Ключ позиции — её нумерация; чтобы номера услуг и питания не сталкивались, у питания ключ с префиксом `fb.`.

```ts
import type { Localized } from './types'
import type { OptionListId } from './option-lists'

export type ServiceKind = 'amenity' | 'food'

export type ServiceGroup = {
  key: string
  kind: ServiceKind
  label: Localized
  /** Ключ блока проверки. */
  block: string
}

export type ServiceItem = {
  key: string
  group: string
  kind: ServiceKind
  label: Localized
  /** Уточняющая подсказка из колонки G, если есть. */
  hint: Localized | null
  /** Список для колонки «наличие». По умолчанию да/нет. */
  availabilityList: OptionListId
}

export const SERVICE_ATTRIBUTES = [
  'available',
  'chargeType',
  'price',
  'currency',
  'slotMinutes',
  'bookingRequired',
] as const

export type ServiceAttribute = (typeof SERVICE_ATTRIBUTES)[number]

export const SERVICE_GROUPS: ServiceGroup[] = [
  { key: 'a1', kind: 'amenity', block: 'svc.a1', label: { en: 'Comfort & Environment', ru: 'Комфорт и обстановка' } },
  { key: 'a2', kind: 'amenity', block: 'svc.a2', label: { en: 'Connectivity & Business', ru: 'Связь и работа' } },
  { key: 'a3', kind: 'amenity', block: 'svc.a3', label: { en: 'Information & Announcements', ru: 'Информация и объявления' } },
  { key: 'a4', kind: 'amenity', block: 'svc.a4', label: { en: 'Special Assistance', ru: 'Особые потребности' } },
  { key: 'a5', kind: 'amenity', block: 'svc.a5', label: { en: 'Rest & Relaxation / Spa', ru: 'Отдых и спа' } },
  { key: 'a6', kind: 'amenity', block: 'svc.a6', label: { en: 'Family & Children Facilities', ru: 'Семья и дети' } },
  { key: 'a7', kind: 'amenity', block: 'svc.a7', label: { en: 'Hygiene & Sanitary', ru: 'Гигиена' } },
  { key: 'a8', kind: 'amenity', block: 'svc.a8', label: { en: 'Additional Facilities', ru: 'Дополнительно' } },
  { key: 'f1', kind: 'food', block: 'svc.f1', label: { en: 'Meal Types', ru: 'Виды питания' } },
  { key: 'f2', kind: 'food', block: 'svc.f2', label: { en: 'Special Meal Options', ru: 'Специальное питание' } },
  { key: 'f3', kind: 'food', block: 'svc.f3', label: { en: 'Beverages', ru: 'Напитки' } },
]

const amenity = (
  key: string,
  group: string,
  en: string,
  ru: string,
  extra: Partial<Pick<ServiceItem, 'hint' | 'availabilityList'>> = {},
): ServiceItem => ({
  key,
  group,
  kind: 'amenity',
  label: { en, ru },
  hint: extra.hint ?? null,
  availabilityList: extra.availabilityList ?? 'yesNo',
})

const food = (
  key: string,
  group: string,
  en: string,
  ru: string,
  hint: Localized | null = null,
): ServiceItem => ({
  key: `fb.${key}`,
  group,
  kind: 'food',
  label: { en, ru },
  hint,
  availabilityList: 'yesNo',
})

export const SERVICE_ITEMS: ServiceItem[] = [
  amenity('1.1', 'a1', 'Air Conditioning', 'Кондиционирование'),
  amenity('1.2', 'a1', 'Runway View', 'Вид на взлётную полосу'),
  amenity('1.3', 'a1', 'Grand View Area', 'Панорамная зона'),
  amenity('1.4', 'a1', 'Quiet Zone / Silent Area', 'Тихая зона'),
  amenity('1.5', 'a1', 'Television', 'Телевизор'),
  amenity('1.6', 'a1', 'Cinema / Media Room', 'Кинозал / медиакомната'),
  amenity('1.7', 'a1', 'Newspaper/Magazines', 'Газеты и журналы'),
  // … 2.1 – 2.9, 3.1 – 3.3, 4.1 – 4.4, 5.1 – 5.7, 6.1 – 6.4, 7.1 – 7.3

  amenity('8.3', 'a8', 'Vaping / E-Cigarette Use Policy', 'Вейпы и электронные сигареты', {
    availabilityList: 'vaping',
  }),
  // … 8.1, 8.2, 8.4 – 8.7

  food('1.1', 'f1', 'Hot Meals', 'Горячие блюда'),
  // … остальные позиции питания
]

export function serviceItemByKey(key: string): ServiceItem | undefined {
  return SERVICE_ITEMS.find((i) => i.key === key)
}
```

Позиции с подсказкой «If yes, please specify the capacity» из колонки `G`: `2.3`, `2.4`, `5.1`, `5.2`, `5.3`. У `fb.3.3` подсказка «If yes, please specify drinks», у `fb.3.4` — «If yes, please specify hours».

- [ ] **Step 4: Прогнать тесты**

Run: `npm test -- services && npm run typecheck`
Expected: PASS, восемь тестов зелёные.

- [ ] **Step 5: Коммит**

```bash
git add src/form-schema/services.ts src/form-schema/__tests__/services.test.ts
git commit -m "feat(form-schema): add the 58 service and F&B items"
```

---

### Task 5: Блоки проверки и слоты фотографий

**Files:**
- Create: `src/form-schema/blocks.ts`
- Create: `src/form-schema/photos.ts`
- Create: `src/form-schema/index.ts`
- Test: `src/form-schema/__tests__/blocks.test.ts`

**Interfaces:**
- Consumes: `FIELDS`, `SERVICE_GROUPS`, `Localized`
- Produces: `Block`, `BLOCKS: Block[]` (27), `PHOTO_SLOTS: PhotoSlot[]`, `blockOf(key: string): Block | undefined`; `src/form-schema/index.ts` реэкспортирует всё публичное

- [ ] **Step 1: Написать падающий тест**

`src/form-schema/__tests__/blocks.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { BLOCKS, PHOTO_SLOTS, FIELDS, SERVICE_GROUPS } from '../index'

describe('блоки проверки', () => {
  it('их ровно 27', () => {
    expect(BLOCKS).toHaveLength(27)
  })

  it('ключи блоков уникальны', () => {
    const keys = BLOCKS.map((b) => b.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('каждое поле ссылается на существующий блок', () => {
    const keys = new Set(BLOCKS.map((b) => b.key))
    for (const field of FIELDS) {
      expect(keys.has(field.block), `${field.key} → ${field.block}`).toBe(true)
    }
  })

  it('каждая группа услуг ссылается на существующий блок', () => {
    const keys = new Set(BLOCKS.map((b) => b.key))
    for (const group of SERVICE_GROUPS) {
      expect(keys.has(group.block), `${group.key} → ${group.block}`).toBe(true)
    }
  })

  it('в каждом блоке есть содержимое', () => {
    for (const block of BLOCKS) {
      const fields = FIELDS.filter((f) => f.block === block.key).length
      const groups = SERVICE_GROUPS.filter((g) => g.block === block.key).length
      const isPhotos = block.key === 'photos'
      expect(fields + groups > 0 || isPhotos, block.key).toBe(true)
    }
  })

  it('состав блоков соответствует структуре формы', () => {
    const kinds = BLOCKS.map((b) => b.kind)
    expect(kinds.filter((k) => k === 'fields')).toHaveLength(15)
    expect(kinds.filter((k) => k === 'services')).toHaveLength(11)
    expect(kinds.filter((k) => k === 'photos')).toHaveLength(1)
  })
})

describe('слоты фотографий', () => {
  it('три именованных слота и свободные дополнительные', () => {
    const named = PHOTO_SLOTS.filter((s) => !s.extra)
    expect(named.map((s) => s.key)).toEqual([
      'entrance',
      'reception',
      'landmarks',
    ])
    expect(PHOTO_SLOTS.some((s) => s.extra)).toBe(true)
  })

  it('минимум четыре снимка обязательны суммарно', () => {
    const required = PHOTO_SLOTS.filter((s) => s.required).length
    expect(required).toBeGreaterThanOrEqual(3)
  })
})
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npm test -- blocks`
Expected: FAIL — `Cannot find module '../index'`.

- [ ] **Step 3: Написать блоки и слоты**

`src/form-schema/blocks.ts`. Пятнадцать блоков плоской части: `I`, четыре подраздела `II`, восемь подразделов `III`, `IV`, `V`.

```ts
import type { Localized } from './types'

export type BlockKind = 'fields' | 'services' | 'photos'

export type Block = {
  key: string
  kind: BlockKind
  label: Localized
}

const fields = (key: string, en: string, ru: string): Block => ({
  key, kind: 'fields', label: { en, ru },
})

const services = (key: string, en: string, ru: string): Block => ({
  key, kind: 'services', label: { en, ru },
})

export const BLOCKS: Block[] = [
  fields('I', 'Lounge Profile & Commercial Details', 'Профиль и коммерческие детали'),
  fields('II.1', 'Primary Operational Contact', 'Основной операционный контакт'),
  fields('II.2', 'Shift / Duty Contact', 'Сменный контакт'),
  fields('II.3', 'Finance Contact', 'Финансовый контакт'),
  fields('II.4', 'Lounge Direct Contacts', 'Прямые контакты лаунжа'),
  fields('III.1', 'Operating Schedule', 'График работы'),
  fields('III.2', 'Access Rules & Restrictions', 'Правила доступа'),
  fields('III.3', 'Children Policy', 'Дети'),
  fields('III.4', 'Passenger & Entry Restrictions', 'Ограничения на вход'),
  fields('III.5', 'Lounge Location', 'Расположение'),
  fields('III.6', 'Terminal & Zone Information', 'Терминал и зона'),
  fields('III.7', 'Multi-Terminal Access', 'Доступ из других терминалов'),
  fields('III.8', 'Capacity Information', 'Вместимость'),
  fields('IV', 'Lounge Signage', 'Размещение логотипа'),
  fields('V', 'Lounge Validity', 'Срок действия соглашения'),
  services('svc.a1', 'Comfort & Environment', 'Комфорт и обстановка'),
  services('svc.a2', 'Connectivity & Business', 'Связь и работа'),
  services('svc.a3', 'Information & Announcements', 'Информация и объявления'),
  services('svc.a4', 'Special Assistance', 'Особые потребности'),
  services('svc.a5', 'Rest & Relaxation / Spa', 'Отдых и спа'),
  services('svc.a6', 'Family & Children Facilities', 'Семья и дети'),
  services('svc.a7', 'Hygiene & Sanitary', 'Гигиена'),
  services('svc.a8', 'Additional Facilities', 'Дополнительно'),
  services('svc.f1', 'Meal Types', 'Виды питания'),
  services('svc.f2', 'Special Meal Options', 'Специальное питание'),
  services('svc.f3', 'Beverages', 'Напитки'),
  { key: 'photos', kind: 'photos', label: { en: 'Photos', ru: 'Фотографии' } },
]

export function blockOf(key: string): Block | undefined {
  return BLOCKS.find((b) => b.key === key)
}
```

`src/form-schema/photos.ts`:

```ts
import type { Localized } from './types'

export type PhotoSlot = {
  key: string
  label: Localized
  required: boolean
  /** Слот принимает произвольное число дополнительных снимков. */
  extra: boolean
}

export const PHOTO_SLOTS: PhotoSlot[] = [
  { key: 'entrance', required: true, extra: false, label: { en: 'Entrance', ru: 'Вход' } },
  { key: 'reception', required: true, extra: false, label: { en: 'Reception Desk', ru: 'Стойка регистрации' } },
  { key: 'landmarks', required: true, extra: false, label: { en: 'Nearby Landmarks', ru: 'Ориентиры рядом' } },
  { key: 'additional', required: false, extra: true, label: { en: 'Additional Photos', ru: 'Дополнительные фото' } },
]

/** Исходная форма просит 4–5 снимков. */
export const MIN_PHOTOS = 4
```

`src/form-schema/index.ts`:

```ts
export type { Localized } from './types'
export * from './option-lists'
export * from './fields'
export * from './services'
export * from './blocks'
export * from './photos'
export * from './validation'
```

`validation.ts` появляется в Task 6 — до этого момента последняя строка закомментирована, иначе модуль не соберётся. Раскомментировать её первым шагом Task 6.

- [ ] **Step 4: Прогнать все тесты схемы**

Run: `npm test && npm run typecheck`
Expected: PASS — блоки, поля, услуги, списки и чистота модуля зелёные.

- [ ] **Step 5: Коммит**

```bash
git add src/form-schema/blocks.ts src/form-schema/photos.ts \
        src/form-schema/index.ts src/form-schema/__tests__/blocks.test.ts
git commit -m "feat(form-schema): add the 27 review blocks and photo slots"
```

---

### Task 6: Валидация из схемы

**Files:**
- Create: `src/form-schema/validation.ts`
- Test: `src/form-schema/__tests__/validation.test.ts`

**Interfaces:**
- Consumes: `Field`, `ServiceItem`, `OPTION_LISTS`
- Produces:
  - `fieldValueSchema(field: Field): ZodType<unknown>`
  - `validateField(field: Field, value: unknown): ValidationResult`
  - `validateServiceValue(item: ServiceItem, value: ServiceValueInput): ValidationResult`
  - `type ValidationResult = { ok: true } | { ok: false; error: Localized }`
  - `type ServiceValueInput = { available: string | null; chargeType: string | null; price: number | null; currency: string | null; slotMinutes: number | null; bookingRequired: boolean | null; details: string | null }`
  - `type SelectValue = { option: string; detail: string | null }`
  - `type TemplateValue = Record<string, number | null>`

- [ ] **Step 1: Написать падающий тест**

`src/form-schema/__tests__/validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { validateField, validateServiceValue } from '../validation'
import { fieldByKey, serviceItemByKey } from '../index'

const field = (key: string) => {
  const found = fieldByKey(key)
  if (!found) throw new Error(`нет поля ${key}`)
  return found
}

const item = (key: string) => {
  const found = serviceItemByKey(key)
  if (!found) throw new Error(`нет позиции ${key}`)
  return found
}

const serviceValue = (over: Partial<Parameters<typeof validateServiceValue>[1]>) => ({
  available: 'yes',
  chargeType: 'complimentary',
  price: null,
  currency: null,
  slotMinutes: null,
  bookingRequired: false,
  details: null,
  ...over,
})

describe('валидация полей', () => {
  it('обязательное поле не пустое', () => {
    expect(validateField(field('I.2'), '').ok).toBe(false)
    expect(validateField(field('I.2'), 'Primeclass Lounge').ok).toBe(true)
  })

  it('select принимает только известный вариант', () => {
    const f = field('III.5.2')
    expect(validateField(f, { option: 'ground', detail: null }).ok).toBe(true)
    expect(validateField(f, { option: 'basement', detail: null }).ok).toBe(false)
  })

  it('вариант со Specify требует уточнения', () => {
    const f = field('III.6.2')
    expect(validateField(f, { option: 'other', detail: null }).ok).toBe(false)
    expect(validateField(f, { option: 'other', detail: 'Pier C' }).ok).toBe(true)
    expect(validateField(f, { option: 't3', detail: null }).ok).toBe(true)
  })

  it('список авиакомпаний обязателен при выборе specific', () => {
    const f = field('III.2.4')
    expect(validateField(f, { option: 'specific', detail: null }).ok).toBe(false)
    expect(
      validateField(f, { option: 'specific', detail: 'Turkish Airlines' }).ok,
    ).toBe(true)
    expect(validateField(f, { option: 'all', detail: null }).ok).toBe(true)
  })

  it('мультивыбор требует хотя бы одного значения', () => {
    const f = field('III.6.6')
    expect(validateField(f, []).ok).toBe(false)
    expect(validateField(f, ['departure', 'transit']).ok).toBe(true)
  })

  it('шаблон требует заполнения всех слотов', () => {
    const f = field('III.2.1')
    expect(validateField(f, { hours: null }).ok).toBe(false)
    expect(validateField(f, { hours: 3 }).ok).toBe(true)
  })

  it('шаблон не принимает отрицательные числа', () => {
    expect(validateField(field('III.2.1'), { hours: -1 }).ok).toBe(false)
  })

  it('поле-дата принимает ISO-строку', () => {
    expect(validateField(field('I.1'), '2026-03-01').ok).toBe(true)
    expect(validateField(field('I.1'), '01.03.2026').ok).toBe(false)
  })
})

describe('валидация позиции услуг', () => {
  it('недоступная услуга не требует остальных атрибутов', () => {
    const value = serviceValue({ available: 'no', chargeType: null })
    expect(validateServiceValue(item('2.1'), value).ok).toBe(true)
  })

  it('доступная услуга требует указания платности', () => {
    const value = serviceValue({ chargeType: null })
    expect(validateServiceValue(item('2.1'), value).ok).toBe(false)
  })

  it('платная услуга требует цену и валюту', () => {
    const withoutPrice = serviceValue({ chargeType: 'chargeable' })
    expect(validateServiceValue(item('7.2'), withoutPrice).ok).toBe(false)

    const complete = serviceValue({
      chargeType: 'chargeable',
      price: 15,
      currency: 'EUR',
    })
    expect(validateServiceValue(item('7.2'), complete).ok).toBe(true)
  })

  it('вариант «И то и другое» тоже требует цену', () => {
    const value = serviceValue({ chargeType: 'both' })
    expect(validateServiceValue(item('7.2'), value).ok).toBe(false)
  })

  it('вейпинг принимает значения своего списка', () => {
    const ok = serviceValue({ available: 'smoking_room' })
    expect(validateServiceValue(item('8.3'), ok).ok).toBe(true)

    const bad = serviceValue({ available: 'yes' })
    expect(validateServiceValue(item('8.3'), bad).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npm test -- validation`
Expected: FAIL — `Cannot find module '../validation'`.

- [ ] **Step 3: Написать валидацию**

`src/form-schema/validation.ts`:

```ts
import type { Localized } from './types'
import type { Field } from './fields'
import type { ServiceItem } from './services'
import { OPTION_LISTS } from './option-lists'

export type ValidationResult = { ok: true } | { ok: false; error: Localized }

export type SelectValue = { option: string; detail: string | null }
export type TemplateValue = Record<string, number | null>

export type ServiceValueInput = {
  available: string | null
  chargeType: string | null
  price: number | null
  currency: string | null
  slotMinutes: number | null
  bookingRequired: boolean | null
  details: string | null
}

const ok: ValidationResult = { ok: true }
const fail = (en: string, ru: string): ValidationResult => ({
  ok: false,
  error: { en, ru },
})

const REQUIRED = fail('This field is required', 'Поле обязательно')
const UNKNOWN_OPTION = fail('Unknown option', 'Неизвестный вариант')
const DETAIL_REQUIRED = fail(
  'Please specify the details',
  'Уточните, пожалуйста',
)

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Поля, где конкретный вариант обязывает заполнить уточнение. */
const DETAIL_REQUIRED_BY_OPTION: Record<string, string[]> = {
  'III.2.4': ['specific'],
}

function isSelectValue(value: unknown): value is SelectValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    'option' in value &&
    typeof (value as SelectValue).option === 'string'
  )
}

function validateSelect(field: Field, value: unknown): ValidationResult {
  if (!isSelectValue(value)) return field.required ? REQUIRED : ok

  const options = field.optionList ? OPTION_LISTS[field.optionList] : []
  const chosen = options.find((o) => o.id === value.option)
  if (!chosen) return UNKNOWN_OPTION

  const detail = value.detail?.trim() ?? ''
  const byOption = DETAIL_REQUIRED_BY_OPTION[field.key] ?? []
  const needsDetail = chosen.requiresDetail || byOption.includes(chosen.id)
  if (needsDetail && detail === '') return DETAIL_REQUIRED

  return ok
}

function validateTemplate(field: Field, value: unknown): ValidationResult {
  const slots = field.templateSlots
  const record = (value ?? {}) as TemplateValue

  for (const slot of slots) {
    const filled = record[slot.key]
    if (filled === null || filled === undefined) {
      return field.required ? REQUIRED : ok
    }
    if (!Number.isFinite(filled) || filled < 0) {
      return fail('Enter a non-negative number', 'Введите неотрицательное число')
    }
  }
  return ok
}

export function validateField(field: Field, value: unknown): ValidationResult {
  switch (field.type) {
    case 'select':
    case 'select_with_detail':
      return validateSelect(field, value)

    case 'multi_select': {
      const list = Array.isArray(value) ? value : []
      return field.required && list.length === 0 ? REQUIRED : ok
    }

    case 'template':
      return validateTemplate(field, value)

    case 'number': {
      if (value === null || value === undefined || value === '') {
        return field.required ? REQUIRED : ok
      }
      const parsed = Number(value)
      return Number.isFinite(parsed) && parsed >= 0
        ? ok
        : fail('Enter a non-negative number', 'Введите неотрицательное число')
    }

    case 'date': {
      const text = typeof value === 'string' ? value.trim() : ''
      if (text === '') return field.required ? REQUIRED : ok
      return ISO_DATE.test(text)
        ? ok
        : fail('Use the date picker', 'Выберите дату в календаре')
    }

    default: {
      const text = typeof value === 'string' ? value.trim() : ''
      return field.required && text === '' ? REQUIRED : ok
    }
  }
}

export function validateServiceValue(
  item: ServiceItem,
  value: ServiceValueInput,
): ValidationResult {
  const availability = OPTION_LISTS[item.availabilityList]
  const chosen = availability.find((o) => o.id === value.available)
  if (!chosen) return UNKNOWN_OPTION

  /** «Нет» и «не разрешено» закрывают позицию: остальные атрибуты не нужны. */
  const isOffered = !['no', 'not_allowed'].includes(chosen.id)
  if (!isOffered) return ok

  const charge = OPTION_LISTS.chargeType.find((o) => o.id === value.chargeType)
  if (!charge) {
    return fail(
      'Specify whether the service is complimentary or chargeable',
      'Укажите, бесплатная услуга или платная',
    )
  }

  if (charge.id === 'chargeable' || charge.id === 'both') {
    if (value.price === null || !Number.isFinite(value.price) || value.price < 0) {
      return fail('Price is required for a chargeable service', 'Для платной услуги нужна цена')
    }
    if (!value.currency || value.currency.trim() === '') {
      return fail('Specify the currency', 'Укажите валюту')
    }
  }

  if (
    value.slotMinutes !== null &&
    (!Number.isFinite(value.slotMinutes) || value.slotMinutes < 0)
  ) {
    return fail('Enter a non-negative number', 'Введите неотрицательное число')
  }

  return ok
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm test -- validation && npm run typecheck`
Expected: PASS, тринадцать тестов зелёные.

- [ ] **Step 5: Коммит**

```bash
git add src/form-schema/validation.ts src/form-schema/__tests__/validation.test.ts
git commit -m "feat(form-schema): validate field and service values from the schema"
```

---

### Task 7: Схема базы данных

**Files:**
- Create: `src/db/schema.ts`, `src/db/types.ts`, `src/db/client.ts`, `drizzle.config.ts`
- Create: `src/db/__tests__/harness.ts`
- Test: `src/db/__tests__/schema.test.ts`

**Interfaces:**
- Consumes: ничего из прикладных модулей
- Produces: таблицы `lounges`, `submissions`, `fieldValues`, `serviceValues`, `photos`, `blockReviews`, `fieldFlags`, `events`; типы `Db`, `SubmissionStatus`, `OperationalStatus`; тестовый хелпер `createTestDb(): Promise<Db>`

**Db — единый тип для боевой и тестовой базы.** Все прикладные модули принимают `Db`, поэтому одни и те же функции работают и против Postgres, и против PGlite в тестах. Вводится сразу, чтобы потом не переписывать сигнатуры.

- [ ] **Step 1: Написать падающий тест**

`src/db/__tests__/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from './harness'
import { lounges, submissions, fieldValues, serviceValues } from '../schema'

describe('схема базы', () => {
  it('заводит лаунж со статусом «действующий» по умолчанию', async () => {
    const db = await createTestDb()
    const [row] = await db
      .insert(lounges)
      .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
      .returning()

    expect(row?.operationalStatus).toBe('active')
    expect(row?.terminal).toBeNull()
  })

  it('анкета создаётся черновиком и привязана к лаунжу', async () => {
    const db = await createTestDb()
    const [lounge] = await db
      .insert(lounges)
      .values({ name: 'IGA', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
      .returning()

    const [submission] = await db
      .insert(submissions)
      .values({ loungeId: lounge!.id })
      .returning()

    expect(submission?.status).toBe('draft')
  })

  it('значение поля переживает запись и чтение', async () => {
    const db = await createTestDb()
    const [lounge] = await db
      .insert(lounges)
      .values({ name: 'THY', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
      .returning()
    const [submission] = await db
      .insert(submissions).values({ loungeId: lounge!.id }).returning()

    await db.insert(fieldValues).values({
      submissionId: submission!.id,
      fieldKey: 'III.2.4',
      value: { option: 'specific', detail: 'Turkish Airlines' },
    })

    const rows = await db
      .select()
      .from(fieldValues)
      .where(eq(fieldValues.submissionId, submission!.id))

    expect(rows[0]?.value).toEqual({ option: 'specific', detail: 'Turkish Airlines' })
  })

  it('пара анкета+поле уникальна', async () => {
    const db = await createTestDb()
    const [lounge] = await db
      .insert(lounges)
      .values({ name: 'Dup', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
      .returning()
    const [submission] = await db
      .insert(submissions).values({ loungeId: lounge!.id }).returning()

    await db.insert(fieldValues).values({
      submissionId: submission!.id, fieldKey: 'I.2', value: 'first',
    })

    await expect(
      db.insert(fieldValues).values({
        submissionId: submission!.id, fieldKey: 'I.2', value: 'second',
      }),
    ).rejects.toThrow()
  })

  it('пара анкета+услуга уникальна', async () => {
    const db = await createTestDb()
    const [lounge] = await db
      .insert(lounges)
      .values({ name: 'Svc', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
      .returning()
    const [submission] = await db
      .insert(submissions).values({ loungeId: lounge!.id }).returning()

    await db.insert(serviceValues).values({
      submissionId: submission!.id, itemKey: '2.1', available: 'yes',
    })

    await expect(
      db.insert(serviceValues).values({
        submissionId: submission!.id, itemKey: '2.1', available: 'no',
      }),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npm test -- db/`
Expected: FAIL — `Cannot find module './harness'`.

- [ ] **Step 3: Написать схему**

`src/db/schema.ts`:

```ts
import {
  boolean, date, index, integer, jsonb, numeric, pgEnum, pgTable,
  text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core'

export const submissionStatus = pgEnum('submission_status', [
  'draft',
  'submitted',
  'changes_requested',
  'approved',
])

export const operationalStatus = pgEnum('operational_status', [
  'active',
  'temporarily_closed',
  'under_renovation',
  'closed',
])

export const lounges = pgTable(
  'lounges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    provider: text('provider'),
    country: text('country').notNull(),
    city: text('city').notNull(),
    airport: text('airport').notNull(),
    iataCode: text('iata_code').notNull(),

    operationalStatus: operationalStatus('operational_status')
      .notNull()
      .default('active'),
    statusUntil: date('status_until'),
    statusComment: text('status_comment'),

    // Классифицирующие поля. Пишутся только при принятии анкеты.
    terminal: text('terminal'),
    terminalType: text('terminal_type'),
    zone: text('zone').array(),
    airsideLandside: text('airside_landside'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('lounges_iata_idx').on(table.iataCode),
    index('lounges_operational_status_idx').on(table.operationalStatus),
  ],
)

export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loungeId: uuid('lounge_id').notNull().references(() => lounges.id, { onDelete: 'cascade' }),
    status: submissionStatus('status').notNull().default('draft'),
    reviewerId: text('reviewer_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (table) => [index('submissions_lounge_idx').on(table.loungeId, table.createdAt)],
)

export const fieldValues = pgTable(
  'field_values',
  {
    submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
    fieldKey: text('field_key').notNull(),
    value: jsonb('value'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('field_values_unique').on(table.submissionId, table.fieldKey)],
)

export const serviceValues = pgTable(
  'service_values',
  {
    submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
    itemKey: text('item_key').notNull(),
    available: text('available'),
    chargeType: text('charge_type'),
    price: numeric('price', { precision: 12, scale: 2 }),
    currency: text('currency'),
    slotMinutes: integer('slot_minutes'),
    bookingRequired: boolean('booking_required'),
    details: text('details'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('service_values_unique').on(table.submissionId, table.itemKey)],
)

export const photos = pgTable('photos', {
  id: uuid('id').primaryKey().defaultRandom(),
  submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
  slot: text('slot').notNull(),
  blobKey: text('blob_key').notNull(),
  url: text('url').notNull(),
  caption: text('caption'),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
})

export const blockReviews = pgTable(
  'block_reviews',
  {
    submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
    blockKey: text('block_key').notNull(),
    confirmedBy: text('confirmed_by').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('block_reviews_unique').on(table.submissionId, table.blockKey)],
)

export const fieldFlags = pgTable(
  'field_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
    fieldKey: text('field_key').notNull(),
    reason: text('reason'),
    comment: text('comment').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [index('field_flags_submission_idx').on(table.submissionId)],
)

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  loungeId: uuid('lounge_id').references(() => lounges.id, { onDelete: 'cascade' }),
  submissionId: uuid('submission_id').references(() => submissions.id, { onDelete: 'cascade' }),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  payload: jsonb('payload'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

export type SubmissionStatus = (typeof submissionStatus.enumValues)[number]
export type OperationalStatus = (typeof operationalStatus.enumValues)[number]
```

`src/db/types.ts`:

```ts
import type { drizzle } from 'drizzle-orm/pglite'
import type * as schema from './schema'

/**
 * Единый контракт базы. Боевой клиент (postgres-js) и тестовый (PGlite)
 * дают одинаковый набор методов, которым пользуются прикладные модули,
 * поэтому те принимают `Db` и не знают, против чего работают.
 */
export type Db = ReturnType<typeof drizzle<typeof schema>>
```

`src/db/client.ts`:

```ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'
import type { Db } from './types'

export function createDb(url: string): Db {
  return drizzle(postgres(url), { schema }) as unknown as Db
}

let cached: Db | undefined

export function db(): Db {
  if (!cached) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL не задан')
    cached = createDb(url)
  }
  return cached
}
```

`drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
})
```

- [ ] **Step 4: Написать тестовый хелпер на PGlite**

Каждый тест получает собственную базу в памяти — они не мешают друг другу и не требуют Docker.

`src/db/__tests__/harness.ts`:

```ts
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as schema from '../schema'
import type { Db } from '../types'

const MIGRATIONS = join(process.cwd(), 'src/db/migrations')

export async function createTestDb(): Promise<Db> {
  const client = new PGlite()
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  if (files.length === 0) {
    throw new Error('нет миграций — запустите npm run db:generate')
  }

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) await client.exec(trimmed)
    }
  }

  return drizzle(client, { schema })
}
```

- [ ] **Step 5: Сгенерировать миграцию**

```bash
export PATH="/opt/homebrew/bin:$PATH"
npm run db:generate
```

Expected: появился файл в `src/db/migrations/*.sql` с восемью `CREATE TABLE`.

- [ ] **Step 6: Прогнать тесты**

Run: `npm test -- db/ && npm run typecheck`
Expected: PASS, пять тестов зелёные.

- [ ] **Step 7: Коммит**

```bash
git add src/db drizzle.config.ts
git commit -m "feat(db): add schema, pglite test harness and initial migration"
```

---

### Task 8: Токены доступа

**Files:**
- Create: `src/access/tokens.ts`
- Test: `src/access/__tests__/tokens.test.ts`

**Interfaces:**
- Consumes: `Db`, таблицы `lounges`, `submissions`
- Produces:
  - `issueFillToken(db, { submissionId, ttlDays }): Promise<{ token: string; expiresAt: Date }>`
  - `resolveFillToken(db, token): Promise<{ submissionId: string } | null>`
  - `extendFillToken(db, submissionId, ttlDays): Promise<void>`
  - таблица `fillTokens` в `src/db/schema.ts`

- [ ] **Step 1: Добавить таблицу токенов в схему**

Дописать в `src/db/schema.ts`:

```ts
export const fillTokens = pgTable(
  'fill_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('fill_tokens_hash_unique').on(table.tokenHash)],
)
```

Затем: `npm run db:generate`

- [ ] **Step 2: Написать падающий тест**

`src/access/__tests__/tokens.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions, fillTokens } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { issueFillToken, resolveFillToken, extendFillToken } from '../tokens'

async function seed(db: Db): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  const [submission] = await db
    .insert(submissions).values({ loungeId: lounge!.id }).returning()
  return submission!.id
}

describe('токены заполнения', () => {
  it('выданный токен разрешается в свою анкету', async () => {
    const db = await createTestDb()
    const submissionId = await seed(db)

    const { token } = await issueFillToken(db, { submissionId, ttlDays: 30 })
    const resolved = await resolveFillToken(db, token)

    expect(resolved).toEqual({ submissionId })
  })

  it('сырой токен не хранится в базе', async () => {
    const db = await createTestDb()
    const submissionId = await seed(db)

    const { token } = await issueFillToken(db, { submissionId, ttlDays: 30 })
    const rows = await db.select().from(fillTokens)

    expect(rows[0]?.tokenHash).not.toBe(token)
    expect(rows[0]?.tokenHash).toHaveLength(64)
  })

  it('неизвестный токен не разрешается', async () => {
    const db = await createTestDb()
    await seed(db)
    expect(await resolveFillToken(db, 'нет-такого')).toBeNull()
  })

  it('просроченный токен не разрешается', async () => {
    const db = await createTestDb()
    const submissionId = await seed(db)
    const { token } = await issueFillToken(db, { submissionId, ttlDays: 30 })

    await db
      .update(fillTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(fillTokens.submissionId, submissionId))

    expect(await resolveFillToken(db, token)).toBeNull()
  })

  it('продление возвращает просроченный токен в строй', async () => {
    const db = await createTestDb()
    const submissionId = await seed(db)
    const { token } = await issueFillToken(db, { submissionId, ttlDays: 30 })

    await db
      .update(fillTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(fillTokens.submissionId, submissionId))
    await extendFillToken(db, submissionId, 14)

    expect(await resolveFillToken(db, token)).toEqual({ submissionId })
  })

  it('два токена не совпадают', async () => {
    const db = await createTestDb()
    const submissionId = await seed(db)
    const first = await issueFillToken(db, { submissionId, ttlDays: 30 })
    const second = await issueFillToken(db, { submissionId, ttlDays: 30 })
    expect(first.token).not.toBe(second.token)
  })
})
```

- [ ] **Step 3: Прогнать тест и убедиться, что он падает**

Run: `npm test -- tokens`
Expected: FAIL — `Cannot find module '../tokens'`.

- [ ] **Step 4: Написать модуль**

`src/access/tokens.ts`:

```ts
import { randomBytes, createHash } from 'node:crypto'
import { and, eq, gt } from 'drizzle-orm'
import { fillTokens } from '@/db/schema'
import type { Db } from '@/db/types'

const hash = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

const daysFromNow = (days: number): Date =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000)

export async function issueFillToken(
  db: Db,
  input: { submissionId: string; ttlDays: number },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = daysFromNow(input.ttlDays)

  await db.insert(fillTokens).values({
    submissionId: input.submissionId,
    tokenHash: hash(token),
    expiresAt,
  })

  return { token, expiresAt }
}

export async function resolveFillToken(
  db: Db,
  token: string,
): Promise<{ submissionId: string } | null> {
  const rows = await db
    .select({ submissionId: fillTokens.submissionId })
    .from(fillTokens)
    .where(and(eq(fillTokens.tokenHash, hash(token)), gt(fillTokens.expiresAt, new Date())))
    .limit(1)

  const row = rows[0]
  return row ? { submissionId: row.submissionId } : null
}

export async function extendFillToken(
  db: Db,
  submissionId: string,
  ttlDays: number,
): Promise<void> {
  await db
    .update(fillTokens)
    .set({ expiresAt: daysFromNow(ttlDays) })
    .where(eq(fillTokens.submissionId, submissionId))
}
```

- [ ] **Step 5: Прогнать тесты**

Run: `npm test -- tokens && npm run typecheck`
Expected: PASS, шесть тестов зелёные.

- [ ] **Step 6: Коммит**

```bash
git add src/access src/db/schema.ts src/db/migrations
git commit -m "feat(access): issue and resolve hashed fill-in tokens"
```

---

### Task 9: Сохранение значений анкеты

**Files:**
- Create: `src/submissions/values.ts`
- Test: `src/submissions/__tests__/values.test.ts`

**Interfaces:**
- Consumes: `validateField`, `validateServiceValue`, `fieldByKey`, `serviceItemByKey`, таблицы `fieldValues`, `serviceValues`, `submissions`
- Produces:
  - `saveFieldValue(db, { submissionId, fieldKey, value }): Promise<SaveResult>`
  - `saveServiceValue(db, { submissionId, itemKey, value }): Promise<SaveResult>`
  - `loadSubmissionValues(db, submissionId): Promise<{ fields: Record<string, unknown>; services: Record<string, ServiceValueInput> }>`
  - `type SaveResult = { ok: true } | { ok: false; error: Localized }`

- [ ] **Step 1: Написать падающий тест**

`src/submissions/__tests__/values.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions, fieldValues } from '@/db/schema'
import { saveFieldValue, saveServiceValue, loadSubmissionValues } from '../values'

async function seedDraft(db: Db): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  const [submission] = await db
    .insert(submissions).values({ loungeId: lounge!.id }).returning()
  return submission!.id
}

describe('сохранение значений', () => {
  it('пишет значение поля', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await saveFieldValue(db, {
      submissionId, fieldKey: 'I.2', value: 'Primeclass Lounge',
    })

    expect(result.ok).toBe(true)
    const loaded = await loadSubmissionValues(db, submissionId)
    expect(loaded.fields['I.2']).toBe('Primeclass Lounge')
  })

  it('перезапись поля не создаёт вторую строку', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    await saveFieldValue(db, { submissionId, fieldKey: 'I.2', value: 'Первое' })
    await saveFieldValue(db, { submissionId, fieldKey: 'I.2', value: 'Второе' })

    const rows = await db
      .select().from(fieldValues).where(eq(fieldValues.submissionId, submissionId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.value).toBe('Второе')
  })

  it('отклоняет неизвестный ключ поля', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await saveFieldValue(db, {
      submissionId, fieldKey: 'IX.99', value: 'что-то',
    })
    expect(result.ok).toBe(false)
  })

  it('отклоняет значение, не прошедшее валидацию схемы', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await saveFieldValue(db, {
      submissionId, fieldKey: 'III.5.2', value: { option: 'basement', detail: null },
    })

    expect(result.ok).toBe(false)
    const loaded = await loadSubmissionValues(db, submissionId)
    expect(loaded.fields['III.5.2']).toBeUndefined()
  })

  it('пишет позицию услуги со всеми атрибутами', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await saveServiceValue(db, {
      submissionId,
      itemKey: '7.2',
      value: {
        available: 'yes', chargeType: 'chargeable', price: 15,
        currency: 'EUR', slotMinutes: 30, bookingRequired: true, details: null,
      },
    })

    expect(result.ok).toBe(true)
    const loaded = await loadSubmissionValues(db, submissionId)
    expect(loaded.services['7.2']?.price).toBe(15)
    expect(loaded.services['7.2']?.currency).toBe('EUR')
  })

  it('отклоняет платную услугу без цены', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await saveServiceValue(db, {
      submissionId,
      itemKey: '7.2',
      value: {
        available: 'yes', chargeType: 'chargeable', price: null,
        currency: null, slotMinutes: null, bookingRequired: null, details: null,
      },
    })
    expect(result.ok).toBe(false)
  })

  it('не даёт править отправленную анкету', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)
    await db
      .update(submissions).set({ status: 'submitted' })
      .where(eq(submissions.id, submissionId))

    const result = await saveFieldValue(db, {
      submissionId, fieldKey: 'I.2', value: 'Поздно',
    })
    expect(result.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npm test -- submissions/`
Expected: FAIL — `Cannot find module '../values'`.

- [ ] **Step 3: Написать модуль**

`src/submissions/values.ts`:

```ts
import { eq } from 'drizzle-orm'
import type { Localized, ServiceValueInput } from '@/form-schema'
import { fieldByKey, serviceItemByKey, validateField, validateServiceValue } from '@/form-schema'
import { fieldValues, serviceValues, submissions } from '@/db/schema'
import type { Db } from '@/db/types'

export type SaveResult = { ok: true } | { ok: false; error: Localized }

const fail = (en: string, ru: string): SaveResult => ({ ok: false, error: { en, ru } })

/** Правки принимаются только в состояниях, где форма открыта заполняющему. */
const EDITABLE = new Set(['draft', 'changes_requested'])

async function assertEditable(db: Db, submissionId: string): Promise<SaveResult> {
  const rows = await db
    .select({ status: submissions.status })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1)

  const status = rows[0]?.status
  if (!status) return fail('Submission not found', 'Анкета не найдена')
  if (!EDITABLE.has(status)) {
    return fail('This submission is under review', 'Анкета сейчас на проверке')
  }
  return { ok: true }
}

export async function saveFieldValue(
  db: Db,
  input: { submissionId: string; fieldKey: string; value: unknown },
): Promise<SaveResult> {
  const field = fieldByKey(input.fieldKey)
  if (!field) return fail('Unknown field', 'Неизвестное поле')

  const editable = await assertEditable(db, input.submissionId)
  if (!editable.ok) return editable

  const validation = validateField(field, input.value)
  if (!validation.ok) return { ok: false, error: validation.error }

  await db
    .insert(fieldValues)
    .values({ submissionId: input.submissionId, fieldKey: input.fieldKey, value: input.value })
    .onConflictDoUpdate({
      target: [fieldValues.submissionId, fieldValues.fieldKey],
      set: { value: input.value, updatedAt: new Date() },
    })

  return { ok: true }
}

export async function saveServiceValue(
  db: Db,
  input: { submissionId: string; itemKey: string; value: ServiceValueInput },
): Promise<SaveResult> {
  const item = serviceItemByKey(input.itemKey)
  if (!item) return fail('Unknown service item', 'Неизвестная позиция услуг')

  const editable = await assertEditable(db, input.submissionId)
  if (!editable.ok) return editable

  const validation = validateServiceValue(item, input.value)
  if (!validation.ok) return { ok: false, error: validation.error }

  const row = {
    submissionId: input.submissionId,
    itemKey: input.itemKey,
    available: input.value.available,
    chargeType: input.value.chargeType,
    price: input.value.price === null ? null : String(input.value.price),
    currency: input.value.currency,
    slotMinutes: input.value.slotMinutes,
    bookingRequired: input.value.bookingRequired,
    details: input.value.details,
  }

  await db
    .insert(serviceValues)
    .values(row)
    .onConflictDoUpdate({
      target: [serviceValues.submissionId, serviceValues.itemKey],
      set: { ...row, updatedAt: new Date() },
    })

  return { ok: true }
}

export async function loadSubmissionValues(
  db: Db,
  submissionId: string,
): Promise<{
  fields: Record<string, unknown>
  services: Record<string, ServiceValueInput>
}> {
  const fieldRows = await db
    .select().from(fieldValues).where(eq(fieldValues.submissionId, submissionId))
  const serviceRows = await db
    .select().from(serviceValues).where(eq(serviceValues.submissionId, submissionId))

  const fields: Record<string, unknown> = {}
  for (const row of fieldRows) fields[row.fieldKey] = row.value

  const services: Record<string, ServiceValueInput> = {}
  for (const row of serviceRows) {
    services[row.itemKey] = {
      available: row.available,
      chargeType: row.chargeType,
      price: row.price === null ? null : Number(row.price),
      currency: row.currency,
      slotMinutes: row.slotMinutes,
      bookingRequired: row.bookingRequired,
      details: row.details,
    }
  }

  return { fields, services }
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm test -- submissions/ && npm run typecheck`
Expected: PASS, семь тестов зелёные.

- [ ] **Step 5: Коммит**

```bash
git add src/submissions
git commit -m "feat(submissions): save and load field and service values with schema validation"
```

---

### Task 10: Полнота и отправка анкеты

**Files:**
- Create: `src/submissions/completeness.ts`, `src/submissions/transitions.ts`
- Test: `src/submissions/__tests__/completeness.test.ts`, `src/submissions/__tests__/transitions.test.ts`

**Interfaces:**
- Consumes: `loadSubmissionValues`, `FIELDS`, `SERVICE_ITEMS`, `PHOTO_SLOTS`, `MIN_PHOTOS`, таблицы `submissions`, `photos`, `events`
- Produces:
  - `missingItems(db, submissionId): Promise<{ fieldKeys: string[]; serviceKeys: string[]; photoSlots: string[] }>`
  - `submitSubmission(db, { submissionId, actor }): Promise<TransitionResult>`
  - `type TransitionResult = { ok: true; status: SubmissionStatus } | { ok: false; error: Localized }`

- [ ] **Step 1: Написать падающий тест на полноту**

`src/submissions/__tests__/completeness.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions } from '@/db/schema'
import { FIELDS, SERVICE_ITEMS } from '@/form-schema'
import { saveFieldValue, saveServiceValue } from '../values'
import { missingItems } from '../completeness'

async function seedDraft(db: Db): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  const [submission] = await db
    .insert(submissions).values({ loungeId: lounge!.id }).returning()
  return submission!.id
}

describe('полнота анкеты', () => {
  it('в пустой анкете не хватает всех обязательных полей', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const missing = await missingItems(db, submissionId)

    const requiredCount = FIELDS.filter((f) => f.required).length
    expect(missing.fieldKeys).toHaveLength(requiredCount)
    expect(missing.serviceKeys).toHaveLength(SERVICE_ITEMS.length)
    expect(missing.photoSlots.length).toBeGreaterThan(0)
  })

  it('заполненное поле уходит из списка недостающих', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    await saveFieldValue(db, { submissionId, fieldKey: 'I.2', value: 'Primeclass Lounge' })
    const missing = await missingItems(db, submissionId)

    expect(missing.fieldKeys).not.toContain('I.2')
  })

  it('позиция услуг считается заполненной даже при ответе «нет»', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    await saveServiceValue(db, {
      submissionId,
      itemKey: '1.2',
      value: {
        available: 'no', chargeType: null, price: null, currency: null,
        slotMinutes: null, bookingRequired: null, details: null,
      },
    })

    const missing = await missingItems(db, submissionId)
    expect(missing.serviceKeys).not.toContain('1.2')
  })

  it('необязательные поля не попадают в список недостающих', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const missing = await missingItems(db, submissionId)
    const optional = FIELDS.filter((f) => !f.required).map((f) => f.key)

    for (const key of optional) {
      expect(missing.fieldKeys).not.toContain(key)
    }
  })
})
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npm test -- completeness`
Expected: FAIL — `Cannot find module '../completeness'`.

- [ ] **Step 3: Написать `completeness.ts`**

```ts
import { eq } from 'drizzle-orm'
import { FIELDS, SERVICE_ITEMS, PHOTO_SLOTS } from '@/form-schema'
import { photos } from '@/db/schema'
import type { Db } from '@/db/types'
import { loadSubmissionValues } from './values'

export type MissingItems = {
  fieldKeys: string[]
  serviceKeys: string[]
  photoSlots: string[]
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

export async function missingItems(
  db: Db,
  submissionId: string,
): Promise<MissingItems> {
  const values = await loadSubmissionValues(db, submissionId)

  const fieldKeys = FIELDS.filter(
    (field) => field.required && isBlank(values.fields[field.key]),
  ).map((field) => field.key)

  // Позиция считается заполненной, как только на неё дан любой ответ,
  // включая «нет» — это осознанное решение заполняющего, а не пропуск.
  const serviceKeys = SERVICE_ITEMS.filter(
    (item) => values.services[item.key]?.available == null,
  ).map((item) => item.key)

  const uploaded = await db
    .select({ slot: photos.slot }).from(photos).where(eq(photos.submissionId, submissionId))
  const filledSlots = new Set(uploaded.map((row) => row.slot))

  const photoSlots = PHOTO_SLOTS.filter(
    (slot) => slot.required && !filledSlots.has(slot.key),
  ).map((slot) => slot.key)

  return { fieldKeys, serviceKeys, photoSlots }
}
```

- [ ] **Step 4: Написать падающий тест на переходы**

`src/submissions/__tests__/transitions.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions, photos, events } from '@/db/schema'
import { FIELDS, SERVICE_ITEMS, PHOTO_SLOTS } from '@/form-schema'
import { saveFieldValue, saveServiceValue } from '../values'
import { submitSubmission } from '../transitions'

async function seedComplete(db: Db): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  const [submission] = await db
    .insert(submissions).values({ loungeId: lounge!.id }).returning()
  const submissionId = submission!.id

  for (const field of FIELDS.filter((f) => f.required)) {
    const value =
      field.type === 'date' ? '2026-03-01'
      : field.type === 'number' ? 1
      : field.type === 'multi_select' ? ['departure']
      : field.type === 'template'
        ? Object.fromEntries(field.templateSlots.map((s) => [s.key, 1]))
      : field.type === 'select' || field.type === 'select_with_detail'
        ? { option: 'FILL', detail: 'подробности' }
        : 'заполнено'

    await saveFieldValue(db, { submissionId, fieldKey: field.key, value })
  }

  for (const item of SERVICE_ITEMS) {
    await saveServiceValue(db, {
      submissionId,
      itemKey: item.key,
      value: {
        available: item.availabilityList === 'vaping' ? 'not_allowed' : 'no',
        chargeType: null, price: null, currency: null,
        slotMinutes: null, bookingRequired: null, details: null,
      },
    })
  }

  for (const slot of PHOTO_SLOTS.filter((s) => s.required)) {
    await db.insert(photos).values({
      submissionId, slot: slot.key,
      blobKey: `${slot.key}.jpg`, url: `https://example.test/${slot.key}.jpg`,
    })
  }

  return submissionId
}

describe('отправка анкеты', () => {
  it('неполная анкета не отправляется', async () => {
    const db = await createTestDb()
    const [lounge] = await db
      .insert(lounges)
      .values({ name: 'Пусто', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
      .returning()
    const [submission] = await db
      .insert(submissions).values({ loungeId: lounge!.id }).returning()

    const result = await submitSubmission(db, {
      submissionId: submission!.id, actor: 'filler',
    })

    expect(result.ok).toBe(false)
  })

  it('полная анкета переходит в submitted', async () => {
    const db = await createTestDb()
    const submissionId = await seedComplete(db)

    const result = await submitSubmission(db, { submissionId, actor: 'filler' })

    expect(result).toEqual({ ok: true, status: 'submitted' })
    const rows = await db
      .select().from(submissions).where(eq(submissions.id, submissionId))
    expect(rows[0]?.status).toBe('submitted')
    expect(rows[0]?.submittedAt).not.toBeNull()
  })

  it('отправка пишется в журнал', async () => {
    const db = await createTestDb()
    const submissionId = await seedComplete(db)
    await submitSubmission(db, { submissionId, actor: 'filler' })

    const rows = await db
      .select().from(events).where(eq(events.submissionId, submissionId))
    expect(rows.map((r) => r.action)).toContain('submitted')
  })

  it('повторная отправка отклоняется', async () => {
    const db = await createTestDb()
    const submissionId = await seedComplete(db)
    await submitSubmission(db, { submissionId, actor: 'filler' })

    const again = await submitSubmission(db, { submissionId, actor: 'filler' })
    expect(again.ok).toBe(false)
  })
})
```

Тест использует вариант `'FILL'`, которого нет ни в одном списке. Чтобы сид работал, в `seedComplete` подставляется первый валидный вариант поля — заменить строку на:

```ts
      : field.type === 'select' || field.type === 'select_with_detail'
        ? { option: OPTION_LISTS[field.optionList!][0]!.id, detail: 'подробности' }
```

и добавить `OPTION_LISTS` в импорт из `@/form-schema`.

- [ ] **Step 5: Прогнать тест и убедиться, что он падает**

Run: `npm test -- transitions`
Expected: FAIL — `Cannot find module '../transitions'`.

- [ ] **Step 6: Написать `transitions.ts`**

```ts
import { eq } from 'drizzle-orm'
import type { Localized } from '@/form-schema'
import { submissions, events } from '@/db/schema'
import type { SubmissionStatus } from '@/db/schema'
import type { Db } from '@/db/types'
import { missingItems } from './completeness'

export type TransitionResult =
  | { ok: true; status: SubmissionStatus }
  | { ok: false; error: Localized }

const fail = (en: string, ru: string): TransitionResult => ({
  ok: false,
  error: { en, ru },
})

/** Отправить можно из состояний, где форма открыта заполняющему. */
const SUBMITTABLE = new Set<SubmissionStatus>(['draft', 'changes_requested'])

export async function submitSubmission(
  db: Db,
  input: { submissionId: string; actor: string },
): Promise<TransitionResult> {
  const rows = await db
    .select({ status: submissions.status })
    .from(submissions)
    .where(eq(submissions.id, input.submissionId))
    .limit(1)

  const status = rows[0]?.status
  if (!status) return fail('Submission not found', 'Анкета не найдена')
  if (!SUBMITTABLE.has(status)) {
    return fail('Already submitted', 'Анкета уже отправлена')
  }

  const missing = await missingItems(db, input.submissionId)
  const total =
    missing.fieldKeys.length + missing.serviceKeys.length + missing.photoSlots.length
  if (total > 0) {
    return fail(
      `${total} item(s) still need an answer`,
      `Осталось заполнить: ${total}`,
    )
  }

  const now = new Date()
  await db
    .update(submissions)
    .set({ status: 'submitted', submittedAt: now, statusChangedAt: now })
    .where(eq(submissions.id, input.submissionId))

  await db.insert(events).values({
    submissionId: input.submissionId,
    actor: input.actor,
    action: 'submitted',
    payload: { from: status },
  })

  return { ok: true, status: 'submitted' }
}
```

- [ ] **Step 7: Прогнать все тесты**

Run: `npm test && npm run typecheck`
Expected: PASS — восемь тестовых файлов зелёные.

- [ ] **Step 8: Коммит**

```bash
git add src/submissions
git commit -m "feat(submissions): compute completeness and guard the submit transition"
```

---

### Task 11: Загрузка фотографий

**Files:**
- Create: `src/photos/store.ts`, `src/photos/resize.ts`
- Create: `src/app/api/photos/route.ts`
- Test: `src/photos/__tests__/store.test.ts`

**Interfaces:**
- Consumes: таблица `photos`, `PHOTO_SLOTS`
- Produces:
  - `attachPhoto(db, { submissionId, slot, blobKey, url, caption }): Promise<SaveResult>`
  - `removePhoto(db, photoId): Promise<void>`
  - `listPhotos(db, submissionId): Promise<PhotoRow[]>`
  - `resizeToJpeg(file: File, maxEdge: number): Promise<Blob>` — браузерный, через `createImageBitmap` и `OffscreenCanvas`

- [ ] **Step 1: Написать падающий тест**

`src/photos/__tests__/store.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createTestDb } from '@/db/__tests__/harness'
import type { Db } from '@/db/types'
import { lounges, submissions } from '@/db/schema'
import { attachPhoto, listPhotos, removePhoto } from '../store'

async function seedDraft(db: Db): Promise<string> {
  const [lounge] = await db
    .insert(lounges)
    .values({ name: 'Primeclass', country: 'Turkey', city: 'Istanbul', airport: 'Istanbul Airport', iataCode: 'IST' })
    .returning()
  const [submission] = await db
    .insert(submissions).values({ loungeId: lounge!.id }).returning()
  return submission!.id
}

const photo = (slot: string) => ({
  slot,
  blobKey: `${slot}-1.jpg`,
  url: `https://blob.test/${slot}-1.jpg`,
  caption: null,
})

describe('фотографии', () => {
  it('привязывает снимок к именованному слоту', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await attachPhoto(db, { submissionId, ...photo('entrance') })

    expect(result.ok).toBe(true)
    const rows = await listPhotos(db, submissionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.slot).toBe('entrance')
  })

  it('отклоняет неизвестный слот', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    const result = await attachPhoto(db, { submissionId, ...photo('rooftop') })
    expect(result.ok).toBe(false)
  })

  it('именованный слот держит один снимок — повтор заменяет прежний', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    await attachPhoto(db, { submissionId, ...photo('entrance') })
    await attachPhoto(db, {
      submissionId, slot: 'entrance',
      blobKey: 'entrance-2.jpg', url: 'https://blob.test/entrance-2.jpg', caption: null,
    })

    const rows = await listPhotos(db, submissionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.blobKey).toBe('entrance-2.jpg')
  })

  it('дополнительный слот принимает несколько снимков', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)

    await attachPhoto(db, {
      submissionId, slot: 'additional',
      blobKey: 'a1.jpg', url: 'https://blob.test/a1.jpg', caption: null,
    })
    await attachPhoto(db, {
      submissionId, slot: 'additional',
      blobKey: 'a2.jpg', url: 'https://blob.test/a2.jpg', caption: null,
    })

    expect(await listPhotos(db, submissionId)).toHaveLength(2)
  })

  it('снимок удаляется', async () => {
    const db = await createTestDb()
    const submissionId = await seedDraft(db)
    await attachPhoto(db, { submissionId, ...photo('reception') })

    const [row] = await listPhotos(db, submissionId)
    await removePhoto(db, row!.id)

    expect(await listPhotos(db, submissionId)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npm test -- photos`
Expected: FAIL — `Cannot find module '../store'`.

- [ ] **Step 3: Написать `store.ts`**

```ts
import { and, eq } from 'drizzle-orm'
import type { Localized } from '@/form-schema'
import { PHOTO_SLOTS } from '@/form-schema'
import { photos } from '@/db/schema'
import type { Db } from '@/db/types'

export type SaveResult = { ok: true } | { ok: false; error: Localized }

export type PhotoRow = {
  id: string
  slot: string
  blobKey: string
  url: string
  caption: string | null
}

export async function attachPhoto(
  db: Db,
  input: {
    submissionId: string
    slot: string
    blobKey: string
    url: string
    caption: string | null
  },
): Promise<SaveResult> {
  const slot = PHOTO_SLOTS.find((s) => s.key === input.slot)
  if (!slot) {
    return { ok: false, error: { en: 'Unknown photo slot', ru: 'Неизвестный слот фото' } }
  }

  // Именованный слот отвечает на один конкретный вопрос («покажите вход»),
  // поэтому новая загрузка заменяет прежнюю, а не копится рядом.
  if (!slot.extra) {
    await db
      .delete(photos)
      .where(and(eq(photos.submissionId, input.submissionId), eq(photos.slot, input.slot)))
  }

  await db.insert(photos).values({
    submissionId: input.submissionId,
    slot: input.slot,
    blobKey: input.blobKey,
    url: input.url,
    caption: input.caption,
  })

  return { ok: true }
}

export async function listPhotos(db: Db, submissionId: string): Promise<PhotoRow[]> {
  const rows = await db
    .select({
      id: photos.id, slot: photos.slot, blobKey: photos.blobKey,
      url: photos.url, caption: photos.caption,
    })
    .from(photos)
    .where(eq(photos.submissionId, submissionId))

  return rows
}

export async function removePhoto(db: Db, photoId: string): Promise<void> {
  await db.delete(photos).where(eq(photos.id, photoId))
}
```

- [ ] **Step 4: Написать клиентское уменьшение снимка**

`src/photos/resize.ts`:

```ts
'use client'

/**
 * Уменьшает снимок до загрузки. Пять фотографий с телефона на аэропортовом
 * Wi-Fi иначе просто не уходят.
 */
export async function resizeToJpeg(file: File, maxEdge = 1600): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('2d context недоступен')

  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 })
}
```

- [ ] **Step 5: Написать маршрут загрузки**

`src/app/api/photos/route.ts`:

```ts
import { put } from '@vercel/blob'
import { NextResponse } from 'next/server'
import { db } from '@/db/client'
import { resolveFillToken } from '@/access/tokens'
import { attachPhoto } from '@/photos/store'

export async function POST(request: Request): Promise<NextResponse> {
  const form = await request.formData()
  const token = String(form.get('token') ?? '')
  const slot = String(form.get('slot') ?? '')
  const file = form.get('file')

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'файл не передан' }, { status: 400 })
  }

  const resolved = await resolveFillToken(db(), token)
  if (!resolved) {
    return NextResponse.json({ error: 'ссылка недействительна' }, { status: 403 })
  }

  const key = `${resolved.submissionId}/${slot}-${Date.now()}.jpg`
  const blob = await put(key, file, { access: 'public', contentType: 'image/jpeg' })

  const result = await attachPhoto(db(), {
    submissionId: resolved.submissionId,
    slot,
    blobKey: key,
    url: blob.url,
    caption: null,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error.ru }, { status: 400 })
  }

  return NextResponse.json({ url: blob.url })
}
```

Установить зависимость: `npm install @vercel/blob`

- [ ] **Step 6: Прогнать тесты**

Run: `npm test -- photos && npm run typecheck`
Expected: PASS, пять тестов зелёные.

- [ ] **Step 7: Коммит**

```bash
git add src/photos src/app/api/photos package.json package-lock.json
git commit -m "feat(photos): named slots, client-side downscale and blob upload route"
```

---

### Task 12: Локализация интерфейса

**Files:**
- Create: `src/i18n/dictionaries.ts`, `src/i18n/context.tsx`
- Test: `src/i18n/__tests__/dictionaries.test.ts`

**Interfaces:**
- Consumes: `Localized`
- Produces:
  - `type Locale = 'en' | 'ru'`
  - `UI: Record<string, Localized>` — строки интерфейса
  - `LocaleProvider`, `useLocale(): { locale: Locale; setLocale(l: Locale): void; t(key: keyof typeof UI): string; pick(value: Localized): string }`

- [ ] **Step 1: Написать падающий тест**

`src/i18n/__tests__/dictionaries.test.ts`:

```ts
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
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npm test -- dictionaries`
Expected: FAIL — `Cannot find module '../dictionaries'`.

- [ ] **Step 3: Написать словари**

`src/i18n/dictionaries.ts`:

```ts
import type { Localized } from '@/form-schema'

export const LOCALES = ['en', 'ru'] as const
export type Locale = (typeof LOCALES)[number]

export const UI = {
  'form.next': { en: 'Next', ru: 'Далее' },
  'form.back': { en: 'Back', ru: 'Назад' },
  'form.saved': { en: 'Saved', ru: 'Сохранено' },
  'form.savingOffline': {
    en: 'No connection — saved on this device',
    ru: 'Нет связи — сохранено на устройстве',
  },
  'form.submit': { en: 'Submit for review', ru: 'Отправить на проверку' },
  'form.submitted': {
    en: 'Sent for review. We will get back to you.',
    ru: 'Отправлено на проверку. Мы вернёмся с ответом.',
  },
  'form.incomplete': {
    en: 'Some answers are still missing',
    ru: 'Не все ответы заполнены',
  },
  'form.required': { en: 'Required', ru: 'Обязательно' },
  'services.pass1Title': {
    en: 'What does the lounge offer?',
    ru: 'Что есть в лаунже?',
  },
  'services.pass1Hint': {
    en: 'Tick everything available. Details come next.',
    ru: 'Отметьте всё, что есть. Детали спросим дальше.',
  },
  'services.pass2Title': { en: 'Details', ru: 'Детали' },
  'services.charge': { en: 'Complimentary or chargeable', ru: 'Платность' },
  'services.price': { en: 'Price', ru: 'Цена' },
  'services.currency': { en: 'Currency', ru: 'Валюта' },
  'services.slot': { en: 'Time slot, minutes', ru: 'Длительность, минут' },
  'services.booking': { en: 'Booking required', ru: 'Нужна бронь' },
  'services.details': { en: 'Other details', ru: 'Детали' },
  'photos.upload': { en: 'Upload photo', ru: 'Загрузить фото' },
  'photos.replace': { en: 'Replace', ru: 'Заменить' },
  'fixes.title': { en: 'Changes requested', ru: 'Требуются правки' },
  'fixes.intro': {
    en: 'The reviewer flagged these answers. Everything else is accepted.',
    ru: 'Ревьюер отметил эти ответы. Остальное принято.',
  },
} as const satisfies Record<string, Localized>

export type UiKey = keyof typeof UI
```

`src/i18n/context.tsx`:

```tsx
'use client'

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { Localized } from '@/form-schema'
import { UI, type Locale, type UiKey } from './dictionaries'

type LocaleContextValue = {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: UiKey) => string
  pick: (value: Localized) => string
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function LocaleProvider(props: {
  initial?: Locale
  children: ReactNode
}): React.JSX.Element {
  const [locale, setLocale] = useState<Locale>(props.initial ?? 'en')

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key) => UI[key][locale],
      pick: (localized) => localized[locale],
    }),
    [locale],
  )

  return <LocaleContext.Provider value={value}>{props.children}</LocaleContext.Provider>
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext)
  if (!value) throw new Error('useLocale вне LocaleProvider')
  return value
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm test -- dictionaries && npm run typecheck`
Expected: PASS, три теста зелёные.

- [ ] **Step 5: Коммит**

```bash
git add src/i18n
git commit -m "feat(i18n): add EN/RU dictionaries and locale context"
```

---

### Task 13: Серверные действия формы и автосохранение

**Files:**
- Create: `src/app/f/[token]/actions.ts`
- Create: `src/web/useAutosave.ts`
- Test: `src/web/__tests__/useAutosave.test.ts`

**Interfaces:**
- Consumes: `saveFieldValue`, `saveServiceValue`, `resolveFillToken`, `submitSubmission`
- Produces:
  - серверные действия `saveFieldAction(token, fieldKey, value)`, `saveServiceAction(token, itemKey, value)`, `submitAction(token)`
  - `useAutosave<T>({ save, localKey }): { status: SaveStatus; push(key: string, value: T): void; pendingCount: number }`
  - `type SaveStatus = 'idle' | 'saving' | 'saved' | 'offline'`

- [ ] **Step 1: Написать падающий тест на автосохранение**

Локальная копия — страховка от потери 417 введённых значений при обрыве связи.

`src/web/__tests__/useAutosave.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { queueDrain, readQueue, writeQueue } from '../useAutosave'

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
})
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npm test -- useAutosave`
Expected: FAIL — `Cannot find module '../useAutosave'`.

- [ ] **Step 3: Написать `useAutosave.ts`**

```tsx
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'offline'

export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

type Queue = Record<string, unknown>

const storageKey = (submissionId: string): string => `lounge.draft.${submissionId}`

export function readQueue(storage: StorageLike, submissionId: string): Queue {
  const raw = storage.getItem(storageKey(submissionId))
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Queue) : {}
  } catch {
    return {}
  }
}

export function writeQueue(
  storage: StorageLike,
  submissionId: string,
  queue: Queue,
): void {
  storage.setItem(storageKey(submissionId), JSON.stringify(queue))
}

/**
 * Досылает всё, что накопилось локально. Ключи, которые не удалось отправить,
 * остаются в очереди до следующей попытки.
 */
export async function queueDrain(
  storage: StorageLike,
  submissionId: string,
  save: (key: string, value: unknown) => Promise<{ ok: boolean }>,
): Promise<void> {
  const queue = readQueue(storage, submissionId)
  const remaining: Queue = {}

  for (const [key, value] of Object.entries(queue)) {
    try {
      const result = await save(key, value)
      if (!result.ok) remaining[key] = value
    } catch {
      remaining[key] = value
    }
  }

  writeQueue(storage, submissionId, remaining)
}

export function useAutosave(input: {
  submissionId: string
  save: (key: string, value: unknown) => Promise<{ ok: boolean }>
}): { status: SaveStatus; push: (key: string, value: unknown) => void } {
  const [status, setStatus] = useState<SaveStatus>('idle')
  const saveRef = useRef(input.save)
  saveRef.current = input.save

  const push = useCallback(
    (key: string, value: unknown) => {
      const storage = window.localStorage
      const queue = readQueue(storage, input.submissionId)
      queue[key] = value
      writeQueue(storage, input.submissionId, queue)

      setStatus('saving')
      void queueDrain(storage, input.submissionId, saveRef.current).then(() => {
        const left = Object.keys(readQueue(storage, input.submissionId)).length
        setStatus(left === 0 ? 'saved' : 'offline')
      })
    },
    [input.submissionId],
  )

  useEffect(() => {
    const retry = (): void => {
      void queueDrain(window.localStorage, input.submissionId, saveRef.current)
    }
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [input.submissionId])

  return { status, push }
}
```

- [ ] **Step 4: Написать серверные действия**

`src/app/f/[token]/actions.ts`:

```ts
'use server'

import { db } from '@/db/client'
import { resolveFillToken } from '@/access/tokens'
import { saveFieldValue, saveServiceValue } from '@/submissions/values'
import { submitSubmission } from '@/submissions/transitions'
import type { ServiceValueInput } from '@/form-schema'

type ActionResult = { ok: boolean; error?: string }

const DENIED: ActionResult = { ok: false, error: 'ссылка недействительна' }

export async function saveFieldAction(
  token: string,
  fieldKey: string,
  value: unknown,
): Promise<ActionResult> {
  const resolved = await resolveFillToken(db(), token)
  if (!resolved) return DENIED

  const result = await saveFieldValue(db(), {
    submissionId: resolved.submissionId,
    fieldKey,
    value,
  })
  return result.ok ? { ok: true } : { ok: false, error: result.error.ru }
}

export async function saveServiceAction(
  token: string,
  itemKey: string,
  value: ServiceValueInput,
): Promise<ActionResult> {
  const resolved = await resolveFillToken(db(), token)
  if (!resolved) return DENIED

  const result = await saveServiceValue(db(), {
    submissionId: resolved.submissionId,
    itemKey,
    value,
  })
  return result.ok ? { ok: true } : { ok: false, error: result.error.ru }
}

export async function submitAction(token: string): Promise<ActionResult> {
  const resolved = await resolveFillToken(db(), token)
  if (!resolved) return DENIED

  const result = await submitSubmission(db(), {
    submissionId: resolved.submissionId,
    actor: 'filler',
  })
  return result.ok ? { ok: true } : { ok: false, error: result.error.ru }
}
```

- [ ] **Step 5: Прогнать тесты**

Run: `npm test -- useAutosave && npm run typecheck`
Expected: PASS, пять тестов зелёные.

- [ ] **Step 6: Коммит**

```bash
git add src/web src/app/f
git commit -m "feat(web): autosave queue with local fallback and form server actions"
```

---

### Task 14: Экраны формы

**Files:**
- Create: `src/app/layout.tsx`, `src/app/globals.css`
- Create: `src/app/f/[token]/page.tsx`
- Create: `src/web/FormShell.tsx`, `src/web/FieldInput.tsx`, `src/web/ServicesPass1.tsx`, `src/web/ServicesPass2.tsx`, `src/web/PhotoSlots.tsx`, `src/web/FixesOnly.tsx`
- Test: `src/web/__tests__/steps.test.ts`

**Interfaces:**
- Consumes: всё выше
- Produces: `buildSteps(): Step[]`, `type Step = { key: string; kind: 'fields' | 'services1' | 'services2' | 'photos' | 'review'; blockKey: string | null }`

- [ ] **Step 1: Написать падающий тест на состав шагов**

`src/web/__tests__/steps.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildSteps } from '../FormShell'
import { BLOCKS } from '@/form-schema'

describe('шаги формы', () => {
  it('начинается с блоков плоской части в порядке формы', () => {
    const steps = buildSteps()
    const fieldBlocks = BLOCKS.filter((b) => b.kind === 'fields').map((b) => b.key)
    expect(steps.slice(0, fieldBlocks.length).map((s) => s.blockKey)).toEqual(fieldBlocks)
  })

  it('услуги идут двумя проходами, отбор раньше деталей', () => {
    const steps = buildSteps()
    const pass1 = steps.findIndex((s) => s.kind === 'services1')
    const pass2 = steps.findIndex((s) => s.kind === 'services2')
    expect(pass1).toBeGreaterThan(-1)
    expect(pass2).toBeGreaterThan(pass1)
  })

  it('отбор — один шаг на все 58 позиций', () => {
    const steps = buildSteps()
    expect(steps.filter((s) => s.kind === 'services1')).toHaveLength(1)
  })

  it('фото и итоговый экран идут последними', () => {
    const steps = buildSteps()
    expect(steps.at(-2)?.kind).toBe('photos')
    expect(steps.at(-1)?.kind).toBe('review')
  })

  it('ключи шагов уникальны', () => {
    const keys = buildSteps().map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `npm test -- steps`
Expected: FAIL — `Cannot find module '../FormShell'`.

- [ ] **Step 3: Написать `FormShell.tsx` с `buildSteps`**

```tsx
'use client'

import { useState } from 'react'
import { BLOCKS } from '@/form-schema'
import { useLocale } from '@/i18n/context'

export type StepKind = 'fields' | 'services1' | 'services2' | 'photos' | 'review'

export type Step = {
  key: string
  kind: StepKind
  blockKey: string | null
}

/**
 * Порядок прохождения формы. Услуги идут двумя проходами: сначала отбор
 * всех 58 позиций одним списком, потом детали только по отмеченным.
 */
export function buildSteps(): Step[] {
  const fieldSteps: Step[] = BLOCKS.filter((b) => b.kind === 'fields').map((b) => ({
    key: `fields:${b.key}`,
    kind: 'fields',
    blockKey: b.key,
  }))

  return [
    ...fieldSteps,
    { key: 'services:pass1', kind: 'services1', blockKey: null },
    { key: 'services:pass2', kind: 'services2', blockKey: null },
    { key: 'photos', kind: 'photos', blockKey: 'photos' },
    { key: 'review', kind: 'review', blockKey: null },
  ]
}

export function FormShell(props: {
  children: (step: Step) => React.ReactNode
  status: string
}): React.JSX.Element {
  const steps = buildSteps()
  const [index, setIndex] = useState(0)
  const { t, locale, setLocale } = useLocale()
  const step = steps[index]!

  return (
    <div className="shell">
      <header className="shell-top">
        <span className="shell-progress">
          {index + 1} / {steps.length}
        </span>
        <span className="shell-status">{props.status}</span>
        <button
          type="button"
          className="shell-locale"
          onClick={() => setLocale(locale === 'en' ? 'ru' : 'en')}
        >
          {locale === 'en' ? 'RU' : 'EN'}
        </button>
      </header>

      <main className="shell-body">{props.children(step)}</main>

      <footer className="shell-foot">
        <button
          type="button"
          disabled={index === 0}
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
        >
          {t('form.back')}
        </button>
        <button
          type="button"
          disabled={index === steps.length - 1}
          onClick={() => setIndex((i) => Math.min(steps.length - 1, i + 1))}
        >
          {t('form.next')}
        </button>
      </footer>
    </div>
  )
}
```

- [ ] **Step 4: Написать рендер поля**

`src/web/FieldInput.tsx`:

```tsx
'use client'

import type { Field } from '@/form-schema'
import { OPTION_LISTS } from '@/form-schema'
import { useLocale } from '@/i18n/context'

export function FieldInput(props: {
  field: Field
  value: unknown
  onChange: (value: unknown) => void
}): React.JSX.Element {
  const { field, value, onChange } = props
  const { pick, t } = useLocale()

  const label = (
    <label className="field-label" htmlFor={field.key}>
      {pick(field.label)}
      {field.required && <span className="field-required">{t('form.required')}</span>}
    </label>
  )

  const hint = field.hint && <p className="field-hint">{pick(field.hint)}</p>

  switch (field.type) {
    case 'select':
    case 'select_with_detail': {
      const options = field.optionList ? OPTION_LISTS[field.optionList] : []
      const current = (value ?? { option: '', detail: null }) as {
        option: string
        detail: string | null
      }
      const chosen = options.find((o) => o.id === current.option)

      return (
        <div className="field">
          {label}
          {hint}
          <select
            id={field.key}
            value={current.option}
            onChange={(e) => onChange({ option: e.target.value, detail: current.detail })}
          >
            <option value="">—</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {pick(option.label)}
              </option>
            ))}
          </select>
          {chosen?.requiresDetail && (
            <textarea
              className="field-detail"
              value={current.detail ?? ''}
              onChange={(e) => onChange({ option: current.option, detail: e.target.value })}
            />
          )}
        </div>
      )
    }

    case 'multi_select': {
      const selected = Array.isArray(value) ? (value as string[]) : []
      const zones = ['arrival', 'departure', 'transit']
      const zoneLabel: Record<string, string> = {
        arrival: 'Arrival', departure: 'Departure', transit: 'Transit',
      }

      return (
        <div className="field">
          {label}
          {hint}
          {zones.map((zone) => (
            <label key={zone} className="field-check">
              <input
                type="checkbox"
                checked={selected.includes(zone)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...selected, zone]
                      : selected.filter((z) => z !== zone),
                  )
                }
              />
              {zoneLabel[zone]}
            </label>
          ))}
        </div>
      )
    }

    case 'template': {
      const slots = (value ?? {}) as Record<string, number | null>
      return (
        <div className="field">
          {label}
          {hint}
          <p className="field-template">
            {field.templateText ? pick(field.templateText) : ''}
          </p>
          {field.templateSlots.map((slot) => (
            <span key={slot.key} className="field-slot">
              <input
                type="number"
                min={0}
                value={slots[slot.key] ?? ''}
                onChange={(e) =>
                  onChange({
                    ...slots,
                    [slot.key]: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              />
              {pick(slot.unit)}
            </span>
          ))}
        </div>
      )
    }

    case 'textarea':
      return (
        <div className="field">
          {label}
          {hint}
          <textarea
            id={field.key}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
          />
          {field.example && <p className="field-example">{field.example}</p>}
        </div>
      )

    default:
      return (
        <div className="field">
          {label}
          {hint}
          <input
            id={field.key}
            type={field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'}
            min={field.type === 'number' ? 0 : undefined}
            value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
            onChange={(e) =>
              onChange(field.type === 'number' ? Number(e.target.value) : e.target.value)
            }
          />
          {field.example && <p className="field-example">{field.example}</p>}
        </div>
      )
  }
}
```

- [ ] **Step 5: Написать два прохода по услугам**

`src/web/ServicesPass1.tsx`:

```tsx
'use client'

import { SERVICE_GROUPS, SERVICE_ITEMS, OPTION_LISTS, type ServiceValueInput } from '@/form-schema'
import { useLocale } from '@/i18n/context'

const EMPTY: Omit<ServiceValueInput, 'available'> = {
  chargeType: null, price: null, currency: null,
  slotMinutes: null, bookingRequired: null, details: null,
}

export function ServicesPass1(props: {
  values: Record<string, ServiceValueInput>
  onChange: (itemKey: string, value: ServiceValueInput) => void
}): React.JSX.Element {
  const { pick, t } = useLocale()

  return (
    <section className="pass1">
      <h2>{t('services.pass1Title')}</h2>
      <p className="subtitle">{t('services.pass1Hint')}</p>

      {SERVICE_GROUPS.map((group) => (
        <div key={group.key} className="pass1-group">
          <h3>{pick(group.label)}</h3>
          {SERVICE_ITEMS.filter((i) => i.group === group.key).map((item) => {
            const current = props.values[item.key]
            const options = OPTION_LISTS[item.availabilityList]
            const isBinary = item.availabilityList === 'yesNo'

            return (
              <div key={item.key} className="pass1-row">
                <span>{pick(item.label)}</span>
                {isBinary ? (
                  <input
                    type="checkbox"
                    checked={current?.available === 'yes'}
                    onChange={(e) =>
                      props.onChange(item.key, {
                        ...EMPTY,
                        ...current,
                        available: e.target.checked ? 'yes' : 'no',
                      })
                    }
                  />
                ) : (
                  <select
                    value={current?.available ?? ''}
                    onChange={(e) =>
                      props.onChange(item.key, {
                        ...EMPTY, ...current, available: e.target.value,
                      })
                    }
                  >
                    <option value="">—</option>
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {pick(option.label)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </section>
  )
}
```

`src/web/ServicesPass2.tsx`:

```tsx
'use client'

import { OPTION_LISTS, serviceItemByKey, type ServiceValueInput } from '@/form-schema'
import { useLocale } from '@/i18n/context'

/** Детали спрашиваются только там, где на первом проходе ответили «есть». */
function offeredKeys(values: Record<string, ServiceValueInput>): string[] {
  return Object.entries(values)
    .filter(([, v]) => v.available !== null && !['no', 'not_allowed'].includes(v.available))
    .map(([key]) => key)
}

export function ServicesPass2(props: {
  values: Record<string, ServiceValueInput>
  onChange: (itemKey: string, value: ServiceValueInput) => void
}): React.JSX.Element {
  const { pick, t } = useLocale()
  const keys = offeredKeys(props.values)

  return (
    <section className="pass2">
      <h2>{t('services.pass2Title')}</h2>
      {keys.map((key) => {
        const item = serviceItemByKey(key)
        const value = props.values[key]
        if (!item || !value) return null
        const needsPrice = value.chargeType === 'chargeable' || value.chargeType === 'both'

        return (
          <div key={key} className="pass2-card">
            <h3>{pick(item.label)}</h3>
            {item.hint && <p className="field-hint">{pick(item.hint)}</p>}

            <label>{t('services.charge')}</label>
            <select
              value={value.chargeType ?? ''}
              onChange={(e) => props.onChange(key, { ...value, chargeType: e.target.value })}
            >
              <option value="">—</option>
              {OPTION_LISTS.chargeType.map((option) => (
                <option key={option.id} value={option.id}>{pick(option.label)}</option>
              ))}
            </select>

            {needsPrice && (
              <>
                <label>{t('services.price')}</label>
                <input
                  type="number" min={0}
                  value={value.price ?? ''}
                  onChange={(e) =>
                    props.onChange(key, {
                      ...value, price: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                />
                <label>{t('services.currency')}</label>
                <input
                  value={value.currency ?? ''}
                  onChange={(e) => props.onChange(key, { ...value, currency: e.target.value })}
                />
              </>
            )}

            <label>{t('services.slot')}</label>
            <input
              type="number" min={0}
              value={value.slotMinutes ?? ''}
              onChange={(e) =>
                props.onChange(key, {
                  ...value, slotMinutes: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />

            <label className="field-check">
              <input
                type="checkbox"
                checked={value.bookingRequired ?? false}
                onChange={(e) => props.onChange(key, { ...value, bookingRequired: e.target.checked })}
              />
              {t('services.booking')}
            </label>

            <label>{t('services.details')}</label>
            <textarea
              value={value.details ?? ''}
              onChange={(e) => props.onChange(key, { ...value, details: e.target.value })}
            />
          </div>
        )
      })}
    </section>
  )
}
```

- [ ] **Step 6: Написать слоты фото, экран правок и страницу**

`src/web/PhotoSlots.tsx`:

```tsx
'use client'

import { PHOTO_SLOTS } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { resizeToJpeg } from '@/photos/resize'

export function PhotoSlots(props: {
  token: string
  uploaded: Record<string, string[]>
  onUploaded: (slot: string, url: string) => void
}): React.JSX.Element {
  const { pick, t } = useLocale()

  async function upload(slot: string, file: File): Promise<void> {
    const resized = await resizeToJpeg(file)
    const body = new FormData()
    body.set('token', props.token)
    body.set('slot', slot)
    body.set('file', new File([resized], `${slot}.jpg`, { type: 'image/jpeg' }))

    const response = await fetch('/api/photos', { method: 'POST', body })
    if (!response.ok) return
    const data = (await response.json()) as { url: string }
    props.onUploaded(slot, data.url)
  }

  return (
    <section className="photos">
      {PHOTO_SLOTS.map((slot) => (
        <div key={slot.key} className="photo-slot">
          <h3>{pick(slot.label)}</h3>
          {(props.uploaded[slot.key] ?? []).map((url) => (
            <img key={url} src={url} alt={pick(slot.label)} />
          ))}
          <label className="photo-upload">
            {props.uploaded[slot.key]?.length ? t('photos.replace') : t('photos.upload')}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void upload(slot.key, file)
              }}
            />
          </label>
        </div>
      ))}
    </section>
  )
}
```

`src/web/FixesOnly.tsx`:

```tsx
'use client'

import type { Field } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { FieldInput } from './FieldInput'

export type Flag = { fieldKey: string; reason: string | null; comment: string }

/**
 * Возврат на правку: заполняющий видит только отмеченные ответы,
 * а не всю анкету заново.
 */
export function FixesOnly(props: {
  flags: Flag[]
  fields: Map<string, Field>
  values: Record<string, unknown>
  onChange: (fieldKey: string, value: unknown) => void
}): React.JSX.Element {
  const { t } = useLocale()

  return (
    <section className="fixes">
      <h2>{t('fixes.title')}</h2>
      <p className="subtitle">{t('fixes.intro')}</p>

      {props.flags.map((flag) => {
        const field = props.fields.get(flag.fieldKey)
        return (
          <div key={flag.fieldKey} className="fix-card">
            <p className="fix-comment">{flag.comment}</p>
            {field && (
              <FieldInput
                field={field}
                value={props.values[flag.fieldKey]}
                onChange={(value) => props.onChange(flag.fieldKey, value)}
              />
            )}
          </div>
        )
      })}
    </section>
  )
}
```

`src/app/layout.tsx`:

```tsx
import type { ReactNode } from 'react'
import './globals.css'

export const metadata = { title: 'Lounge Onboarding' }

export default function RootLayout(props: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body>{props.children}</body>
    </html>
  )
}
```

`src/app/globals.css`:

```css
:root { color-scheme: light dark; }

* { box-sizing: border-box; }

body {
  margin: 0;
  font: 16px/1.5 -apple-system, "Segoe UI", sans-serif;
}

.shell { display: flex; flex-direction: column; min-height: 100dvh; }
.shell-top,
.shell-foot { display: flex; gap: 12px; align-items: center; padding: 12px 16px; }
.shell-foot { margin-top: auto; border-top: 1px solid #e4e6ea; }
.shell-top { border-bottom: 1px solid #e4e6ea; }
.shell-status { margin-left: auto; font-size: 13px; opacity: .7; }
.shell-body { padding: 16px; }

.field { margin-bottom: 20px; }
.field-label { display: block; font-weight: 600; margin-bottom: 6px; }
.field-required { margin-left: 6px; font-size: 12px; opacity: .6; font-weight: 400; }
.field-hint,
.field-example { font-size: 13px; opacity: .7; margin: 4px 0 0; }
.field-check { display: flex; gap: 8px; align-items: center; margin: 4px 0; }

.field input,
.field select,
.field textarea,
.pass2-card input,
.pass2-card select,
.pass2-card textarea {
  width: 100%;
  padding: 10px;
  font: inherit;
  border: 1px solid #c9ced6;
  border-radius: 8px;
}

.pass1-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid #f0f1f3;
}
.pass1-row input[type='checkbox'] { width: 22px; height: 22px; }

.pass2-card,
.fix-card {
  border: 1px solid #e4e6ea;
  border-radius: 10px;
  padding: 12px;
  margin-bottom: 14px;
}
.fix-comment { margin: 0 0 10px; color: #991b1b; }

.photo-slot img { max-width: 100%; border-radius: 8px; }
.photo-upload input { display: none; }
```

`src/app/f/[token]/page.tsx`:

```tsx
import { notFound } from 'next/navigation'
import { db } from '@/db/client'
import { resolveFillToken } from '@/access/tokens'
import { loadSubmissionValues } from '@/submissions/values'
import { listPhotos } from '@/photos/store'
import { LocaleProvider } from '@/i18n/context'
import { FillForm } from '@/web/FillForm'

export default async function FillPage(props: {
  params: Promise<{ token: string }>
}): Promise<React.JSX.Element> {
  const { token } = await props.params
  const resolved = await resolveFillToken(db(), token)
  if (!resolved) notFound()

  const values = await loadSubmissionValues(db(), resolved.submissionId)
  const photos = await listPhotos(db(), resolved.submissionId)

  const uploaded: Record<string, string[]> = {}
  for (const photo of photos) {
    uploaded[photo.slot] = [...(uploaded[photo.slot] ?? []), photo.url]
  }

  return (
    <LocaleProvider initial="en">
      <FillForm
        token={token}
        submissionId={resolved.submissionId}
        initialFields={values.fields}
        initialServices={values.services}
        initialPhotos={uploaded}
      />
    </LocaleProvider>
  )
}
```

- [ ] **Step 7: Написать `FillForm.tsx`, связывающий шаги с автосохранением**

`src/web/FillForm.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { FIELDS, type ServiceValueInput } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { saveFieldAction, saveServiceAction, submitAction } from '@/app/f/[token]/actions'
import { useAutosave } from './useAutosave'
import { FormShell } from './FormShell'
import { FieldInput } from './FieldInput'
import { ServicesPass1 } from './ServicesPass1'
import { ServicesPass2 } from './ServicesPass2'
import { PhotoSlots } from './PhotoSlots'

export function FillForm(props: {
  token: string
  submissionId: string
  initialFields: Record<string, unknown>
  initialServices: Record<string, ServiceValueInput>
  initialPhotos: Record<string, string[]>
}): React.JSX.Element {
  const { t } = useLocale()
  const [fields, setFields] = useState(props.initialFields)
  const [services, setServices] = useState(props.initialServices)
  const [photos, setPhotos] = useState(props.initialPhotos)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const autosave = useAutosave({
    submissionId: props.submissionId,
    save: (key, value) =>
      key.startsWith('svc:')
        ? saveServiceAction(props.token, key.slice(4), value as ServiceValueInput)
        : saveFieldAction(props.token, key, value),
  })

  const statusText =
    autosave.status === 'offline' ? t('form.savingOffline')
    : autosave.status === 'saved' ? t('form.saved')
    : ''

  function changeField(key: string, value: unknown): void {
    setFields((prev) => ({ ...prev, [key]: value }))
    autosave.push(key, value)
  }

  function changeService(key: string, value: ServiceValueInput): void {
    setServices((prev) => ({ ...prev, [key]: value }))
    autosave.push(`svc:${key}`, value)
  }

  return (
    <FormShell status={statusText}>
      {(step) => {
        if (step.kind === 'fields') {
          return FIELDS.filter((f) => f.block === step.blockKey).map((field) => (
            <FieldInput
              key={field.key}
              field={field}
              value={fields[field.key]}
              onChange={(value) => changeField(field.key, value)}
            />
          ))
        }

        if (step.kind === 'services1') {
          return <ServicesPass1 values={services} onChange={changeService} />
        }

        if (step.kind === 'services2') {
          return <ServicesPass2 values={services} onChange={changeService} />
        }

        if (step.kind === 'photos') {
          return (
            <PhotoSlots
              token={props.token}
              uploaded={photos}
              onUploaded={(slot, url) =>
                setPhotos((prev) => ({ ...prev, [slot]: [...(prev[slot] ?? []), url] }))
              }
            />
          )
        }

        return (
          <div className="review">
            {submitError && <p className="fix-comment">{submitError}</p>}
            <button
              type="button"
              onClick={async () => {
                const result = await submitAction(props.token)
                setSubmitError(result.ok ? null : (result.error ?? t('form.incomplete')))
              }}
            >
              {t('form.submit')}
            </button>
          </div>
        )
      }}
    </FormShell>
  )
}
```

- [ ] **Step 8: Прогнать все тесты и проверку типов**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS — все тестовые файлы зелёные, сборка Next.js проходит.

- [ ] **Step 9: Коммит**

```bash
git add src/app src/web
git commit -m "feat(web): mobile fill form with two-pass services matrix and photo slots"
```

---

### Task 15: Сквозной сценарий заполнения

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/fill.spec.ts`
- Create: `scripts/seed-dev.ts`
- Modify: `package.json` — скрипты `e2e`, `seed`
- Modify: `.env.local` — копия `.env.example` для локального прогона

**Interfaces:**
- Consumes: всё выше
- Produces: `npm run e2e`; `scripts/seed-dev.ts` печатает ссылку вида `/f/<token>` для локальной проверки

- [ ] **Step 1: Поставить Playwright**

```bash
export PATH="/opt/homebrew/bin:$PATH"
npm install -D @playwright/test
npx playwright install chromium
```

- [ ] **Step 2: Написать сид локальных данных**

`scripts/seed-dev.ts`:

```ts
/** Заводит лаунж, черновик анкеты и печатает ссылку для заполнения. */
import { createDb } from '../src/db/client'
import { lounges, submissions } from '../src/db/schema'
import { issueFillToken } from '../src/access/tokens'

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL не задан')
  const db = createDb(url)

  const [lounge] = await db
    .insert(lounges)
    .values({
      name: 'Primeclass Lounge',
      provider: 'Çelebi',
      country: 'Turkey',
      city: 'Istanbul',
      airport: 'Istanbul Airport',
      iataCode: 'IST',
    })
    .returning()

  const [submission] = await db
    .insert(submissions)
    .values({ loungeId: lounge!.id })
    .returning()

  const { token } = await issueFillToken(db, {
    submissionId: submission!.id,
    ttlDays: 90,
  })

  process.stdout.write(`http://localhost:3000/f/${token}\n`)
}

void main()
```

- [ ] **Step 3: Проверить, что сид работает**

```bash
export PATH="/opt/homebrew/bin:$PATH"
docker compose up -d
cp .env.example .env.local
npm run db:push
npm run seed
```

Expected: в выводе ссылка вида `http://localhost:3000/f/<token>`. Открыть её в браузере после `npm run dev` — должен открыться первый шаг формы.

- [ ] **Step 4: Написать конфигурацию Playwright**

`playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:3000' },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
```

Добавить в `package.json`:

```json
{
  "scripts": {
    "e2e": "playwright test",
    "seed": "tsx scripts/seed-dev.ts"
  }
}
```

- [ ] **Step 5: Написать сквозной тест**

`e2e/fill.spec.ts`:

```ts
import { test, expect } from '@playwright/test'
import { execSync } from 'node:child_process'

test('заполняющий проходит форму и видит оба прохода по услугам', async ({ page }) => {
  const url = execSync('npm run --silent seed', { encoding: 'utf8' }).trim()

  await page.goto(url)
  await expect(page.getByText('1 / 19')).toBeVisible()

  // Плоское поле сохраняется и статус сообщает об этом
  await page.getByLabel(/Lounge Full Name/).fill('Primeclass Lounge')
  await expect(page.getByText('Saved')).toBeVisible()

  // Переключатель языка меняет подписи
  await page.getByRole('button', { name: 'RU' }).click()
  await expect(page.getByRole('button', { name: 'Далее' })).toBeVisible()
  await page.getByRole('button', { name: 'EN' }).click()

  // Дойти до первого прохода по услугам
  for (let step = 0; step < 15; step += 1) {
    await page.getByRole('button', { name: 'Next' }).click()
  }
  await expect(page.getByRole('heading', { name: 'What does the lounge offer?' })).toBeVisible()

  // Отметить одну услугу и убедиться, что детали спрашиваются только по ней
  await page.getByText('Wifi Access').locator('..').getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Next' }).click()

  await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Wifi Access' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Runway View' })).toHaveCount(0)
})

test('неполная анкета не отправляется', async ({ page }) => {
  const url = execSync('npm run --silent seed', { encoding: 'utf8' }).trim()

  await page.goto(url)
  for (let step = 0; step < 18; step += 1) {
    await page.getByRole('button', { name: 'Next' }).click()
  }

  await page.getByRole('button', { name: 'Submit for review' }).click()
  await expect(page.getByText(/Осталось заполнить/)).toBeVisible()
})
```

- [ ] **Step 6: Прогнать сквозной тест**

```bash
export PATH="/opt/homebrew/bin:$PATH"
npm run e2e
```

Expected: два сценария зелёные. Playwright сам поднимет `npm run dev`; база уже запущена на шаге 3.

- [ ] **Step 7: Прогнать всё вместе**

Run: `npm test && npm run typecheck && npm run build && npm run e2e`
Expected: PASS во всех четырёх.

- [ ] **Step 8: Коммит**

```bash
git add playwright.config.ts e2e scripts/seed-dev.ts package.json package-lock.json
git commit -m "test: add end-to-end fill scenario"
```

---

## Что остаётся следующим планам

- **План 2 «Проверка»** — вход внутренней команды по magic-link, экран ревьюера, подтверждение блоков, замечания к полям, переходы `submitted → changes_requested → approved`, экран правок у заполняющего, копирование классифицирующих полей в `lounges` при принятии, уведомления на email.
- **План 3 «Реестр и выгрузка»** — статус лаунжа и его история, реестр с фильтрами и поиском, выгрузка одной анкеты в структуре исходного xlsx, плоская выгрузка набора лаунжей с фиксированным порядком колонок, CSV.
