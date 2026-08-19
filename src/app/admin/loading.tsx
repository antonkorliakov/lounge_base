/**
 * Мгновенный скелет реестра — фолбэк Suspense-границы, в которую Next
 * оборачивает `page.tsx` этого сегмента (соглашение loading.js, см.
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md`).
 * Реестр — динамическая страница с четырьмя запросами к удалённому Postgres;
 * без фолбэка переход из анкеты назад в список — это секунды белого экрана
 * или замершая прежняя страница.
 *
 * Охват: loading.tsx сегмента накрывает и вложенные сегменты без
 * собственного файла. Ниже /admin их три: `s/[submissionId]` и `password`
 * несут СВОИ loading.tsx (скелет реестра на странице пароля был бы враньём
 * о том, что грузится), а `login` — статическая страница без данных: она
 * не подвисает, и фолбэк там не показывается вовсе.
 *
 * Классы только `skl-*` и ни одного класса или роли настоящего экрана —
 * намеренно: e2e ждёт `.registry-filters`, `getByRole('columnheader')`,
 * считает `tbody tr`. Скелет, повторяющий эти селекторы, стал бы ложным
 * совпадением для ожиданий тестов, поэтому здесь div-ы, а не <table>, и ни
 * одной текстовой подписи, которую можно принять за данные. Для скринридера
 * — visually-hidden «Loading…» через role="status", остальное aria-hidden.
 */
export default function Loading(): React.JSX.Element {
  return (
    <div className="skl-registry" role="status">
      <span className="vh">Loading…</span>
      {/* Шапка: заголовок, счётчик, ссылки выгрузки справа — та же
          раскладка, что .registry-top. */}
      <div className="skl-reg-top" aria-hidden="true">
        <span className="skl skl-reg-title" />
        <span className="skl skl-reg-count" />
        <span className="skl-reg-links">
          <span className="skl skl-reg-link" />
          <span className="skl skl-reg-link" />
          <span className="skl skl-reg-link" />
        </span>
      </div>
      {/* Кнопка «Добавить лаунж» и панель фильтров. */}
      <span className="skl skl-reg-btn" aria-hidden="true" />
      <div className="skl-reg-chips" aria-hidden="true">
        <span className="skl skl-chip" />
        <span className="skl skl-chip" />
        <span className="skl skl-chip" />
        <span className="skl skl-chip" />
        <span className="skl skl-chip" />
        <span className="skl skl-chip" />
      </div>
      {/* Таблица: полоса заголовка и 8 строк по 9 колонок — геометрия
          .registry-table, но div-ами (см. комментарий модуля). */}
      <div aria-hidden="true">
        <div className="skl-reg-row skl-reg-head">
          <span className="skl" /><span className="skl" /><span className="skl" />
          <span className="skl" /><span className="skl" /><span className="skl" />
          <span className="skl" /><span className="skl" /><span className="skl" />
        </div>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="skl-reg-row">
            <span className="skl" /><span className="skl" /><span className="skl" />
            <span className="skl" /><span className="skl" /><span className="skl" />
            <span className="skl" /><span className="skl" /><span className="skl" />
          </div>
        ))}
      </div>
    </div>
  )
}
