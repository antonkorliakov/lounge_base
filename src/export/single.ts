import { eq } from 'drizzle-orm'
import ExcelJS from 'exceljs'
import {
  BLOCKS,
  FIELDS,
  PHOTO_SLOTS,
  SERVICE_ATTRIBUTES,
  SERVICE_GROUPS,
  SERVICE_ITEMS,
  type ServiceAttribute,
} from '@/form-schema'
import { submissions } from '@/db/schema'
import type { Db } from '@/db/types'
import { loadSubmissionValues } from '@/submissions/values'
import { listPhotos } from '@/photos/store'
import { renderField, serviceAttributeCell } from './rows'

/**
 * Заголовки колонок листа `Services & Amenities` — формулировки исходного
 * файла, дословно (у плоской выгрузки в `columns.ts` подписи свои, короткие,
 * потому что там они приклеены к названию позиции — это разные формулировки
 * по построению, а не два экземпляра одной).
 *
 * `Record<ServiceAttribute, string>` — полная запись: и строка заголовков, и
 * ячейки строк ниже получаются ОДНИМ проходом по `SERVICE_ATTRIBUTES`, так
 * что разъехаться им не из чего. Образец плана держал рядом рукописный
 * список из шести заголовков плюс пришитый седьмой — и писал `details`
 * дважды: раз из `SERVICE_ATTRIBUTES` (где он седьмой с Task 3), раз
 * довеском `value?.details ?? ''` — девять ячеек под восемью заголовками,
 * всё после `bookingRequired` со сдвигом. Новый атрибут без заголовка теперь
 * не собирается, вместо того чтобы уехать в файл безымянным.
 */
const SERVICE_ATTRIBUTE_HEADERS: Record<ServiceAttribute, string> = {
  available: 'Available (Yes/No)',
  chargeType: 'Complimentary/Chargeable/Both',
  price: 'Price (per person / per use)',
  currency: 'Currency',
  slotMinutes: 'Time Slot Duration (min)',
  bookingRequired: 'Booking Required (Yes/No)',
  details: 'Other Details (if any)',
}

/**
 * Одна анкета выгружается в структуре исходного файла: те же два листа, та
 * же нумерация и те же формулировки вопросов (закреплено тестом против
 * golden fixtures, снятых с исходного xlsx), чтобы получатель узнавал
 * документ.
 *
 * ЗНАЧЕНИЯ печатаются теми же правилами, что у плоской выгрузки: поля —
 * `renderField` (общий `formatFieldValue`, режим `phrase`, — не четвёртый
 * рукописный показ; образец плана здесь снова терял `slots.age` поля
 * `III.3.2` и печатал шаблонные поля голыми числами без единиц), атрибуты
 * услуг — `serviceAttributeCell`. Двухстрочной ячейки `option\ndetail` из
 * образца сознательно нет: в исходной форме ячейки ответов пусты, так что
 * «формулировки исходного файла» про формат ответа ничего не говорят, а
 * третий вариант показа одного значения — ровно то, от чего Task 4 ушёл
 * извлечением форматтера.
 *
 * Фото подписываются формулировкой формы (`PHOTO_SLOTS[..].label.en` —
 * 'Entrance', 'Additional Photos'), а не сырым ключом слота: ключ —
 * внутренний язык базы, получатель документа его не знает. Рядом с URL —
 * подпись оператора, если была. Порядок — порядок слотов формы, не порядок
 * строк таблицы.
 */
export async function singleSubmissionWorkbook(
  db: Db,
  submissionId: string,
): Promise<Buffer> {
  // Несуществующая анкета — ошибка, а не пустая книга: `loadSubmissionValues`
  // и `listPhotos` для чужого id вернули бы пустые наборы, и наружу уехал бы
  // правдоподобный файл со всеми вопросами и пустыми ответами — неотличимый
  // от анкеты, которую ещё не заполняли.
  const [known] = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
  if (!known) {
    throw new Error(`анкеты ${submissionId} не существует — выгружать нечего`)
  }

  const values = await loadSubmissionValues(db, submissionId)
  const uploaded = await listPhotos(db, submissionId)

  const workbook = new ExcelJS.Workbook()

  const general = workbook.addWorksheet('General Lounge Information')
  general.getColumn(1).width = 56
  general.getColumn(2).width = 46
  general.addRow([
    'Lounge Onboarding Form ** This form is required for each lounge individually.',
  ]).font = { name: 'Arial', bold: true }

  for (const block of BLOCKS.filter((b) => b.kind === 'fields')) {
    const heading = general.addRow([block.label.en])
    heading.font = { name: 'Arial', bold: true }

    for (const field of FIELDS.filter((f) => f.block === block.key)) {
      general.addRow([
        `${field.key}. ${field.label.en}`,
        renderField(field.key, values.fields[field.key]),
        field.hint?.en ?? '',
      ])
    }
  }

  const photoHeading = general.addRow(['Photos'])
  photoHeading.font = { name: 'Arial', bold: true }
  for (const slot of PHOTO_SLOTS) {
    for (const photo of uploaded.filter((p) => p.slot === slot.key)) {
      general.addRow([slot.label.en, photo.url, photo.caption ?? ''])
    }
  }

  const services = workbook.addWorksheet('Services & Amenities')
  services.getColumn(1).width = 46
  services.addRow([
    'Amenities Offered',
    ...SERVICE_ATTRIBUTES.map((attribute) => SERVICE_ATTRIBUTE_HEADERS[attribute]),
  ]).font = { name: 'Arial', bold: true }

  for (const group of SERVICE_GROUPS) {
    services.addRow([group.label.en]).font = { name: 'Arial', bold: true }

    for (const item of SERVICE_ITEMS.filter((i) => i.group === group.key)) {
      const value = values.services[item.key]
      services.addRow([
        item.label.en,
        // Тот же проход по SERVICE_ATTRIBUTES, что и у строки заголовков
        // выше, — выравнивание ячеек под заголовками по построению.
        ...SERVICE_ATTRIBUTES.map((attribute) => serviceAttributeCell(value?.[attribute])),
      ])
    }
  }

  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => {
      row.font = { name: 'Arial', ...(row.font?.bold ? { bold: true } : {}) }
      row.alignment = { vertical: 'top', wrapText: true }
    })
  }

  // `Buffer.from`, а не `as`: см. `flatWorkbook` — exceljs объявляет
  // писавшийся буфер СВОИМ типом `Buffer extends ArrayBuffer`, не узловым.
  return Buffer.from(await workbook.xlsx.writeBuffer())
}
