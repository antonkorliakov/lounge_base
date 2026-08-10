/**
 * Одноразовое извлечение чернового form-schema из исходного xlsx.
 * Запуск:  npx tsx scripts/extract-form-schema.ts <путь-к-xlsx> > /tmp/fields.json
 * Вывод коммитится в src/form-schema/fields.ts и дальше правится вручную:
 * скрипт больше не запускается, источник правды — TypeScript.
 *
 * Also used (with --fixture) to regenerate the golden label fixture at
 * src/form-schema/__tests__/fixtures/source-field-labels.json — see
 * writeFixture() below and the regeneration-command comment at the top of
 * fields.test.ts.
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

/** Extracts plain text from a cell value, unwrapping ExcelJS rich-text objects. */
function cellText(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'object' && 'richText' in (value as Record<string, unknown>)) {
    const rich = (value as { richText: Array<{ text: string }> }).richText
    const text = rich.map((r) => r.text).join('')
    return text.trim() || null
  }
  return String(value).trim() || null
}

async function openSheet(path: string): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(path)
  const sheet = workbook.getWorksheet(SHEET)
  if (!sheet) throw new Error(`sheet not found: ${SHEET}`)
  return sheet
}

/**
 * The 67th field ("V. Lounge Validity …") has no `V.<n>` numbering, so
 * FIELD_RE never matches its row and extractDrafts() cannot see it. This
 * reads it directly and mechanically, so the fixture never has to carry a
 * hand-typed label for it either.
 */
export async function extractLoungeValidityLabel(path: string): Promise<string> {
  const sheet = await openSheet(path)
  let found: string | null = null
  sheet.eachRow((row) => {
    const label = cellText(row.getCell('A').value) ?? ''
    if (/^V\.\s/.test(label)) found = label.replace(/^V\.\s*/, '').trim()
  })
  if (!found) throw new Error('Lounge Validity row (V.) not found')
  return found
}

export async function extractDrafts(path: string): Promise<Draft[]> {
  const sheet = await openSheet(path)

  const drafts: Draft[] = []

  sheet.eachRow((row, rowNumber) => {
    const label = cellText(row.getCell('A').value) ?? ''
    if (!label || !FIELD_RE.test(label) || isSubsectionHeader(label)) return

    const answerCell = sheet.getCell(`B${rowNumber}`)
    const validation = answerCell.dataValidation
    const optionsRaw =
      validation?.type === 'list' && typeof validation.formulae?.[0] === 'string'
        ? validation.formulae[0].replace(/^"|"$/g, '')
        : null

    const bText = cellText(row.getCell('B').value)
    const hint = cellText(row.getCell('C').value)
    const example = cellText(row.getCell('F').value)
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

  return drafts
}

/**
 * Regenerates the golden label fixture (src/form-schema/__tests__/fixtures/
 * source-field-labels.json) straight from the workbook — key -> exact
 * English label, for all 67 fields. This is the independent verification
 * path: a reviewer with no access to the workbook can trust fields.ts
 * because this fixture was produced mechanically, not hand-typed, and
 * fields.test.ts asserts FIELDS agrees with it key-for-key.
 *
 * Usage:
 *   npx tsx scripts/extract-form-schema.ts <xlsx> --fixture <output.json>
 */
async function writeFixture(xlsxPath: string, outPath: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  const drafts = await extractDrafts(xlsxPath)
  const labels: Record<string, string> = {}
  for (const d of drafts) labels[d.key] = d.labelEn
  labels['V'] = await extractLoungeValidityLabel(xlsxPath)

  // Keep key order matching FIELDS' source-form order (I, II, III, IV, V)
  // rather than object-insertion order, so a diff of the fixture reads the
  // same way as a diff of fields.ts.
  const ordered: Record<string, string> = {}
  for (const key of Object.keys(labels).sort(sourceOrder)) ordered[key] = labels[key]!

  await writeFile(outPath, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8')
  process.stderr.write(`\nфикстура записана: ${outPath} (${Object.keys(ordered).length} ключей)\n`)
}

function sourceOrder(a: string, b: string): number {
  const rank = (k: string): number[] =>
    k.split('.').map((p) => (['I', 'II', 'III', 'IV', 'V'].includes(p) ? ['I', 'II', 'III', 'IV', 'V'].indexOf(p) : Number(p)))
  const ra = rank(a)
  const rb = rank(b)
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
    const diff = (ra[i] ?? -1) - (rb[i] ?? -1)
    if (diff !== 0) return diff
  }
  return 0
}

async function main(): Promise<void> {
  const path = process.argv[2]
  if (!path) throw new Error('usage: extract-form-schema.ts <xlsx> [--fixture <output.json>]')

  const fixtureFlagIndex = process.argv.indexOf('--fixture')
  if (fixtureFlagIndex !== -1) {
    const outPath = process.argv[fixtureFlagIndex + 1]
    if (!outPath) throw new Error('usage: --fixture <output.json>')
    await writeFixture(path, outPath)
    return
  }

  const drafts = await extractDrafts(path)

  process.stdout.write(JSON.stringify(drafts, null, 2))
  process.stderr.write(`\nизвлечено полей: ${drafts.length}\n`)
}

// Only run when executed directly (`npx tsx extract-form-schema.ts ...`), not
// when imported by another script (e.g. the one-off fields.ts generator) —
// otherwise importing this module for its exports re-runs the CLI using the
// importer's argv and dumps drafts JSON onto stdout as a side effect.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main()
}
