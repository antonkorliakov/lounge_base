import {
  FIELDS, SERVICE_ITEMS, PHOTO_SLOTS, formatFieldValue,
  type ServiceValueInput,
} from '@/form-schema'

/**
 * Одна строка экрана проверки в готовом к показу виде.
 *
 * `value` необязателен, и это не «может быть пусто», а «у этого вида строки
 * текстового значения нет вообще»: фото-слоты несут только подпись, а их
 * содержимое рисует `FieldRow` из URL-ов (`ReviewScreen`'s `photos`). Раньше
 * здесь для фото-слотов лежала строка со счётчиком снимков ("3"), которую
 * никто не мог показать — `FieldRow` игнорирует `value`, когда получил
 * `photos`, а `photos` для этих ключей передаётся всегда. Вычислять значение,
 * которое невозможно отобразить, опасно именно на пути показа: следующий
 * читатель принимает его за живой путь — так и появился исходный дефект
 * «ревьюер видит счётчик вместо снимка».
 *
 * Тип экспортируется, чтобы `ReviewScreen` импортировал его, а не объявлял
 * ту же форму у себя вторым независимым описанием — эта ветка уже несколько
 * раз чинила ровно такое расхождение (`SaveResult`, `FLAG_REASONS`).
 */
export type RenderedCell = { label: string; value?: string }

/**
 * Плоское представление одной позиции услуг для показа ревьюеру.
 *
 * Черновик этой функции показывал только `available`/`chargeType`/`price`+
 * `currency` — и тем самым прятал `details`, `slotMinutes` и
 * `bookingRequired` целиком. Это не косметика: у нескольких позиций
 * (`Conference Room`, `VIP / Private Meeting Room`, `Sleeping Area / Pods`
 * — все несут `hint: specifyCapacity`, "If yes, please specify the
 * capacity"; `Premium Alcohol` — "please specify drinks"; `Alcohol Service
 * Hours` — "please specify hours", см. `form-schema/services.ts`) сам ответ
 * на подсказку пишется именно в `details`, а не в одно из трёх показанных
 * полей. Ревьюер, глядящий только на старую тройку, увидел бы "yes ·
 * chargeable · 50 USD" и не смог бы проверить, действительно ли оператор
 * указал вместимость/напитки/часы — то есть ту самую вещь, которую вопрос
 * и просит уточнить. `slotMinutes`/`bookingRequired` — тот же случай для
 * позиций с записью на слот (массаж, спа). Все шесть атрибутов показаны
 * здесь ради этого — не ради полноты как таковой.
 */
function formatServiceValue(
  value: ServiceValueInput | undefined,
  locale: 'en' | 'ru',
): string {
  const parts = [
    value?.available ?? '—',
    value?.chargeType ?? null,
    value?.price !== null && value?.price !== undefined
      ? `${value.price} ${value.currency ?? ''}`.trim()
      : null,
    value?.slotMinutes !== null && value?.slotMinutes !== undefined
      ? `${value.slotMinutes} ${locale === 'ru' ? 'мин' : 'min'}`
      : null,
    value?.bookingRequired === true
      ? (locale === 'ru' ? 'нужна запись' : 'booking required')
      : null,
    value?.details ? value.details : null,
  ]
  return parts.filter(Boolean).join(' · ')
}

/**
 * Плоское представление значений для показа ревьюеру.
 *
 * Живёт в собственном модуле без `'use client'` — не в `ReviewScreen.tsx` —
 * потому что вызывается из `page.tsx` (серверный компонент). Раньше эта
 * функция была экспортирована прямо из `ReviewScreen.tsx`, и `'use client'`
 * в начале того файла помечает КАЖДЫЙ его экспорт клиентской ссылкой —
 * включая чистую, не-React функцию вроде этой. Рантайм-фикс-раунда:
 * `page.tsx` реально падал на `Error: Attempted to call renderValues() from
 * the server but renderValues is on the client` — не гипотетически, экран
 * проверки не открывался вообще ни для одной анкеты. Ни `tsc`, ни `next
 * build`, ни `npm test` этого не ловили: граница `'use client'` — это
 * ограничение времени выполнения RSC, а не типов, и ни один из трёх гейтов
 * не рендерит эту страницу по-настоящему (`next build` собирает динамический
 * маршрут, не выполняя его; `e2e/fill.spec.ts` вообще не заходит на
 * `/admin/...`). Обнаружено вручную запуском `next dev` и реальным заходом
 * на `/admin/s/<id>` при проверке `after()` для этого же раунда фиксов —
 * см. отчёт задачи.
 *
 * Само форматирование значения поля живёт в `@/form-schema` (`render.ts`) и
 * ОБЩЕЕ с плоской выгрузкой (`src/export/rows.ts`) — история о том, почему
 * оно не должно быть написано здесь вторым экземпляром, рассказана там.
 * Решения этого экрана, принятые ЗДЕСЬ: «ответа нет» — прочерк «—», шаблон
 * читается списком слотов (`template: 'slots'`), чтобы ревьюер видел, какой
 * именно слот пропущен.
 */
export function renderValues(input: {
  fields: Record<string, unknown>
  services: Record<string, ServiceValueInput>
  locale: 'en' | 'ru'
}): Record<string, RenderedCell> {
  const out: Record<string, RenderedCell> = {}

  for (const field of FIELDS) {
    const raw = input.fields[field.key]
    out[field.key] = {
      label: field.label[input.locale],
      value:
        formatFieldValue(field, raw, { locale: input.locale, template: 'slots' }) ?? '—',
    }
  }

  for (const item of SERVICE_ITEMS) {
    out[item.key] = {
      label: item.label[input.locale],
      value: formatServiceValue(input.services[item.key], input.locale),
    }
  }

  // Только подпись: сами снимки идут в `FieldRow` отдельным путём (см.
  // `RenderedCell`). Цикл нужен ради подписи — `ReviewScreen` берёт её
  // отсюда для всех 27 блоков одинаково, включая блок фото.
  for (const slot of PHOTO_SLOTS) {
    out[slot.key] = { label: slot.label[input.locale] }
  }

  return out
}
