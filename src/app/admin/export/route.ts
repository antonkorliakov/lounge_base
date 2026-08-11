import { db } from '@/db/client'
import { requireSession } from '@/access/session'
import { buildFlatRows } from '@/export/rows'
import { flatWorkbook } from '@/export/workbook'
import { flatCsv } from '@/export/csv'
import { filtersFromSearchParams } from '@/registry/filters-url'

/**
 * Плоская выгрузка реестра — тем же фильтром, каким построен экран: ссылки
 * реестра несут его текущую строку запроса, и разбирается она тем же
 * `filtersFromSearchParams` (`src/registry/filters-url.ts` — НЕ клиентский
 * модуль; см. его комментарий, почему это существенно для route handler'а).
 *
 * Параметры собираются через `getAll`, а не `Object.fromEntries(entries())`:
 * у повторённого ключа `fromEntries` молча берёт ПОСЛЕДНЕЕ значение, а
 * контракт разборщика — первое (как у страницы, которой Next отдаёт массив).
 * Одна и та же строка запроса обязана давать одну и ту же выборку на экране
 * и в файле.
 *
 * Семантика `includeUnapproved` (и почему без галочки пользовательский
 * фильтр по статусу анкеты перекрывается) — целиком у `buildFlatRows`.
 *
 * ЗАДЕРЖКА РАСТЁТ ЛИНЕЙНО С РЕЕСТРОМ: `buildFlatRows` читает каждый лаунж
 * двумя последовательными запросами (2N+1 — его собственный комментарий
 * объясняет, почему это сознательный выбор, а не недосмотр) — при 816
 * лаунжах это ~1.6 тысячи обращений к базе друг за другом. С базой в том же
 * регионе это секунды; если маршрут упирается в `maxDuration` ниже — это
 * сигнал, что либо база не рядом, либо реестр перерос форму, и чинится это
 * записанным там же батч-люком (вынести маппинг из `loadSubmissionValues`,
 * три `inArray`-чтения), а не большей цифрой здесь.
 */

/**
 * Потолок времени для платформы деплоя (Vercel читает его из build output;
 * секунды — см. route-segment-config/maxDuration в docs Next). 60 — потому
 * что это максимум, который исполняет ЛЮБОЙ план Vercel (Hobby выше не
 * позволяет, Pro позволяет больше — но цифра, работающая везде одинаково,
 * не требует знать план), и потому что укладываться надо с запасом: выгрузка
 * с базой в том же регионе занимает секунды, а не десятки секунд.
 */
export const maxDuration = 60

export async function GET(request: Request): Promise<Response> {
  await requireSession()

  const url = new URL(request.url)
  const params: Record<string, string[]> = {}
  for (const key of url.searchParams.keys()) params[key] = url.searchParams.getAll(key)

  const built = await buildFlatRows(db(), {
    filters: filtersFromSearchParams(params),
    includeUnapproved: url.searchParams.get('includeUnapproved') === '1',
  })

  if (url.searchParams.get('format') === 'csv') {
    return new Response(flatCsv(built), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="lounges.csv"',
      },
    })
  }

  const buffer = await flatWorkbook(built)
  return new Response(new Uint8Array(buffer), {
    headers: {
      'content-type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="lounges.xlsx"',
    },
  })
}
