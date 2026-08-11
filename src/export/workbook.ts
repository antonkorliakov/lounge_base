import ExcelJS from 'exceljs'
import type { Column } from './columns'
import type { ExportCell } from './rows'

/**
 * Плоская выгрузка в xlsx: один лист, первая строка — заголовки колонок
 * (`columns.ts` объясняет, почему их порядок — часть ответа), дальше строки
 * `rows.ts` как есть. `null` exceljs кладёт пустой ячейкой, а не строкой
 * «null» — закреплено тестом, потому что это свойство библиотеки, на которое
 * мы опираемся, а не нашего кода.
 *
 * ТИПИЗАЦИЯ ВОЗВРАТА — честная, без единого `as`. `writeBuffer()` в Node
 * действительно возвращает узловый `Buffer` (проверено на месте:
 * `Buffer.isBuffer(...) === true`), но ТИПОМ exceljs объявляет не его:
 * первая строка его `index.d.ts` — `declare interface Buffer extends
 * ArrayBuffer {}`, собственный пустой интерфейс, затеняющий узловый.
 * `Buffer.from(...)` закрывает разрыв без приведения: перегрузка
 * `from(ArrayBuffer)` принимает exceljs-тип структурно, а во время
 * выполнения `from` получает Uint8Array и копирует байты — одна копия на
 * редкую ручную выгрузку. Каст `as unknown as ArrayBuffer` из образца плана
 * не нужен ни здесь, ни при чтении (тест грузит настоящий `ArrayBuffer`).
 */
export async function flatWorkbook(input: {
  columns: Column[]
  rows: ExportCell[][]
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Lounges', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })

  sheet.addRow(input.columns.map((column) => column.header))
  sheet.getRow(1).font = { name: 'Arial', bold: true }

  for (const row of input.rows) sheet.addRow(row)

  return Buffer.from(await workbook.xlsx.writeBuffer())
}
