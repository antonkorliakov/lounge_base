'use client'

/**
 * Уменьшает снимок до загрузки. Пять фотографий с телефона на аэропортовом
 * Wi-Fi иначе просто не уходят.
 *
 * Браузерный код (createImageBitmap, OffscreenCanvas) — юнит-тестами не
 * покрыт: для него нужен реальный браузерный движок, которого у Vitest
 * (окружение `node`) нет. Сценарий загрузки целиком проверяется сквозным
 * тестом в Task 15.
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
