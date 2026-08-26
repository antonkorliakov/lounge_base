import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  /**
   * Бюджеты подняты с умолчаний (30 с на тест, 5 с на утверждение), и это не
   * «подождать подольше и повезёт», а поправка на то, ЧЕМ мы измеряем.
   *
   * Прогон без `--workers=1` поднимает пять воркеров против ОДНОГО
   * `next dev`, который компилирует маршруты по требованию. Под этой
   * конкуренцией серверное действие (а тем самым и любое утверждение, ждущее
   * его результата) отвечает секундами вместо десятков миллисекунд, и на
   * умолчаниях полный параллельный прогон падал 2–6 тестами КАЖДЫЙ раз,
   * всегда в разных местах и в файлах, которые правки не касались (проверено:
   * то же самое воспроизводится набором без `review.spec.ts` вовсе). Самые
   * длинные сценарии тут не «медленные», а просто большие: «принять анкету»
   * подтверждает все 27 блоков, то есть делает 27 серверных действий подряд —
   * в 30 с при пятикратной конкуренции он не укладывался.
   *
   * Ни одно утверждение от этого не ослабевает: все они авторетрайные, и
   * неверное значение от ожидания верным не становится — утверждения о
   * ОТСУТСТВИИ (`toHaveCount(0)`, `not.toHaveClass`) проходят в тот же
   * момент, что и раньше. Меняется только то, сколько харнесс готов ждать
   * прежде, чем назвать задержку компиляции провалом продукта. Места, где
   * ждать НЕЛЬЗЯ, свои бюджеты уже пиннят явно (`expectRendered`,
   * `fillEnabling`, `openRowEditor` — см. `e2e/review.spec.ts`), и эти
   * умолчания их не касаются.
   */
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: { baseURL: 'http://localhost:3000' },
  webServer: {
    command: 'npm run dev',
    // `url` (unlike `port`) requires a 2xx/3xx response to consider the
    // server "ready" — but this app has no root `page.tsx` (only `/f/
    // [token]` and the API route), so `/` always 404s and a `url`-based
    // check would spin for the full `timeout` every run. `port` only checks
    // that something is listening, which is all readiness means here.
    port: 3000,
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
