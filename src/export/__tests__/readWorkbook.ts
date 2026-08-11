import ExcelJS from 'exceljs'

/**
 * Чтение собранной книги обратно — без единого приведения типов. `xlsx.load`
 * объявлен принимающим НЕ узловый `Buffer`, а собственный exceljs-овский
 * `interface Buffer extends ArrayBuffer {}` (первая строка его `index.d.ts`)
 * — образец плана закрывал этот разрыв кастом `buffer as unknown as
 * ArrayBuffer`, тем самым классом приведения, который эта ветка выпалывала
 * уже пять раз. Честный путь — отдать `load` настоящий `ArrayBuffer`:
 * `new Uint8Array(buffer)` копирует байты в свежий несёженный буфер (тот же
 * приём, с тем же обоснованием, что у `createTestDb` в
 * `db/__tests__/harness.ts`: подложка узлового `Buffer` — `ArrayBufferLike`,
 * срез её мог бы быть и `SharedArrayBuffer`), и exceljs его принимает и
 * типом, и на деле — проверено до того, как тесты на это оперлись.
 *
 * Общий для `workbook.test.ts` и `roundtrip.test.ts`: правило чтения одно, и
 * второй его экземпляр — то самое место, куда каст вполз бы обратно.
 */
export async function read(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new Uint8Array(buffer).buffer)
  return workbook
}
