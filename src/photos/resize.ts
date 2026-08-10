'use client'

/**
 * Best-effort уменьшение снимка перед загрузкой. Пять фотографий с телефона
 * на аэропортовом Wi-Fi иначе просто не уходят — но сам ресайз не должен
 * стать новой причиной, по которой снимок не дойдёт вовсе. Поэтому функция
 * никогда не бросает исключение на обычном изображении: если ни один из
 * путей уменьшения не поддержан браузером (в первую очередь Safari/iOS до
 * 16.4, где нет `OffscreenCanvas`), она отдаёт исходный файл без изменений.
 * Полноразмерная загрузка, которая доходит, лучше уменьшенной, которая не
 * отправляется никогда; потолок размера на маршруте загрузки
 * (`MAX_PHOTO_BYTES` в `src/app/api/photos/route.ts`) остаётся барьером на
 * патологический случай — огромный оригинал без уменьшения.
 *
 * Порядок предпочтения:
 *  1. `createImageBitmap` + `OffscreenCanvas` — не блокирует основной поток.
 *  2. `createImageBitmap` + обычный `<canvas>` — когда `OffscreenCanvas`
 *     недоступен, но декодирование через `createImageBitmap` есть.
 *  3. Исходный `File` без изменений — когда ни `createImageBitmap`, ни
 *     canvas-путь не сработали.
 *
 * Браузерный код — юнит-тестами не покрыт: для него нужен реальный
 * браузерный движок, которого у Vitest (окружение `node`) нет. Сценарий
 * загрузки целиком проверяется сквозным тестом в Task 15.
 */
export async function resizeToJpeg(file: File, maxEdge = 1600): Promise<Blob> {
  if (typeof createImageBitmap === 'undefined') {
    return file
  }

  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    // Math.round может дать 0 при экстремальном соотношении сторон —
    // `new OffscreenCanvas(w, 0)` (и обычный canvas той же ширины) ведёт
    // себя непредсказуемо, поэтому обе стороны не меньше 1px.
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('2d context недоступен (OffscreenCanvas)')
      context.drawImage(bitmap, 0, 0, width, height)
      return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 })
    }

    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('2d context недоступен (canvas)')
      context.drawImage(bitmap, 0, 0, width, height)
      return await canvasToBlob(canvas, 0.82)
    }

    return file
  } catch {
    // Декодирование или отрисовка не удались (неподдерживаемый формат,
    // движок без нужного API и т.п.) — отдаём исходный файл, а не бросаем.
    return file
  } finally {
    bitmap?.close()
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob вернул null'))),
      'image/jpeg',
      quality,
    )
  })
}
