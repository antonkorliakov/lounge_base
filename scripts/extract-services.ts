/**
 * One-off extraction of the services & F&B item matrix from the source xlsx.
 * Mirrors scripts/extract-form-schema.ts (Task 3) but reads the
 * `Services & Amenities` sheet, whose layout differs from the general-info
 * sheet: group header rows ("1. Comfort & Environment") interleave with
 * item rows ("1.1 Air Conditioning"), and the numbering restarts at 1 when
 * the sheet switches from amenities to food & beverages.
 *
 * Usage:
 *   npx tsx scripts/extract-services.ts <xlsx> --fixture <output.json>
 *
 * Output is a key -> exact English label map (bare keys for amenities,
 * `fb.`-prefixed keys for food), used to regenerate
 * src/form-schema/__tests__/fixtures/source-service-labels.json.
 */
import ExcelJS from 'exceljs'

const SHEET = 'Services & Amenities'
const ITEM_RE = /^(\d+)\.(\d+)\s+(.+)$/
const GROUP_HEADER_RE = /^(\d+)\.\s+(.+)$/
const FOOD_SECTION_RE = /^Food & Beverages/

export type ExtractedItem = {
  key: string // 'fb.'-prefixed for food, bare for amenity
  kind: 'amenity' | 'food'
  groupNum: number
  groupLabel: string
  labelEn: string
  hintEn: string | null
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

export async function extractItems(path: string): Promise<ExtractedItem[]> {
  const sheet = await openSheet(path)
  const items: ExtractedItem[] = []

  let kind: 'amenity' | 'food' = 'amenity'
  let groupNum = 0
  let groupLabel = ''

  sheet.eachRow((row) => {
    const a = cellText(row.getCell('A').value) ?? ''
    if (!a) return

    if (FOOD_SECTION_RE.test(a)) {
      kind = 'food'
      groupNum = 0
      groupLabel = ''
      return
    }

    const itemMatch = ITEM_RE.exec(a)
    if (itemMatch) {
      const [, , itemNum, labelEn] = itemMatch
      const hintEn = cellText(row.getCell('G').value)
      const bareKey = `${groupNum}.${itemNum}`
      items.push({
        key: kind === 'food' ? `fb.${bareKey}` : bareKey,
        kind,
        groupNum,
        groupLabel,
        labelEn: labelEn!,
        hintEn,
      })
      return
    }

    const groupMatch = GROUP_HEADER_RE.exec(a)
    if (groupMatch) {
      groupNum = Number(groupMatch[1])
      groupLabel = groupMatch[2]!
      return
    }

    // Anything else (instructions, the two "please mention ..." free-text
    // rows, header row) is not an item — deliberately ignored.
  })

  return items
}

async function writeFixture(xlsxPath: string, outPath: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  const items = await extractItems(xlsxPath)
  const labels: Record<string, string> = {}
  for (const item of items) labels[item.key] = item.labelEn

  await writeFile(outPath, `${JSON.stringify(labels, null, 2)}\n`, 'utf8')
  process.stderr.write(`\nфикстура записана: ${outPath} (${Object.keys(labels).length} ключей)\n`)
}

async function main(): Promise<void> {
  const path = process.argv[2]
  if (!path) throw new Error('usage: extract-services.ts <xlsx> [--fixture <output.json>]')

  const fixtureFlagIndex = process.argv.indexOf('--fixture')
  if (fixtureFlagIndex !== -1) {
    const outPath = process.argv[fixtureFlagIndex + 1]
    if (!outPath) throw new Error('usage: --fixture <output.json>')
    await writeFixture(path, outPath)
    return
  }

  const items = await extractItems(path)
  process.stdout.write(JSON.stringify(items, null, 2))
  process.stderr.write(`\nизвлечено позиций: ${items.length}\n`)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main()
}
