/**
 * Свой фолбэк сегмента /admin/password — существует, чтобы ПЕРЕКРЫТЬ
 * родительский `/admin/loading.tsx`: без этого файла переход на страницу
 * пароля (обычный <a> из шапки реестра) сначала рисовал бы скелет РЕЕСТРА
 * — таблицу на весь экран для страницы с тремя полями. Loading.tsx сегмента
 * накрывает вложенные сегменты без собственного файла — это и есть способ
 * сузить охват (см. довод в `../loading.tsx`).
 *
 * Страница лёгкая (один индексированный select), поэтому скелет под стать:
 * узкая колонка формы, как .login/.pw. Классы `skl-*` — то же правило
 * e2e-безопасности, что у остальных скелетов.
 */
export default function Loading(): React.JSX.Element {
  return (
    <div className="skl-pw" role="status">
      <span className="vh">Loading…</span>
      <span className="skl skl-pw-title" aria-hidden="true" />
      <span className="skl skl-pw-field" aria-hidden="true" />
      <span className="skl skl-pw-field" aria-hidden="true" />
    </div>
  )
}
