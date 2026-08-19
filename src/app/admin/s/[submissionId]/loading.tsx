/**
 * Мгновенный скелет экрана проверки — фолбэк Suspense-границы вокруг
 * `page.tsx` (соглашение loading.js, та же ссылка на доки, что в
 * `../../loading.tsx`). Это самый тяжёлый экран кабинета: сессия, join
 * анкеты с лаунжем, 129 значений, фото, замечания, прогресс блоков — на
 * удалённом Postgres клик по строке реестра давал видимые секунды без
 * какого-либо отклика.
 *
 * Геометрия — .review-screen: рейка навигации слева (точка + подпись, как
 * .nav-item), справа шапка (назад, заголовок, пилюля состояния, ряд кнопок)
 * и строки полей (ключ + значение, как .frow). Классы только `skl-*` — e2e
 * ждёт `.review-head`, `.nav-item`, `.review-screen`, и скелет не должен
 * уметь совпасть ни с одним селектором тестов (довод в `../../loading.tsx`).
 */
export default function Loading(): React.JSX.Element {
  return (
    <div className="skl-review" role="status">
      <span className="vh">Loading…</span>
      <div className="skl-rev-rail" aria-hidden="true">
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className="skl-rev-item">
            <span className="skl skl-rev-dot" />
            <span className="skl skl-rev-line" />
          </span>
        ))}
      </div>
      <section className="skl-rev-pane" aria-hidden="true">
        <div className="skl-rev-head">
          <span className="skl skl-rev-back" />
          <span className="skl skl-rev-title" />
          <span className="skl skl-rev-pill" />
          <span className="skl-rev-actions">
            <span className="skl skl-rev-btn" />
            <span className="skl skl-rev-btn" />
          </span>
        </div>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="skl-rev-frow">
            <span className="skl skl-rev-key" />
            <span className="skl skl-rev-value" />
          </div>
        ))}
      </section>
    </div>
  )
}
