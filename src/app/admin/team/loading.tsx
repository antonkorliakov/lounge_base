/**
 * Свой фолбэк сегмента /admin/team — по той же причине, что у
 * `/admin/password/loading.tsx`: без него переход из шапки реестра рисовал
 * бы скелет РЕЕСТРА (таблицу на весь экран) для страницы со списком из
 * нескольких человек. Классы `skl-*` — то же правило e2e-безопасности, что
 * у остальных скелетов (разметка без <table> и ролей).
 */
export default function Loading(): React.JSX.Element {
  return (
    <div className="skl-team" role="status">
      <span className="vh">Loading…</span>
      <span className="skl skl-team-title" aria-hidden="true" />
      <span className="skl skl-team-btn" aria-hidden="true" />
      <span className="skl skl-team-row" aria-hidden="true" />
      <span className="skl skl-team-row" aria-hidden="true" />
      <span className="skl skl-team-row" aria-hidden="true" />
    </div>
  )
}
