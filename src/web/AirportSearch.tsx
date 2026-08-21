'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { Localized } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import type { AirportSearchResult, DirectoryRow } from '@/registry/directory'

const FIND_AIRPORT: Localized = { en: 'Find airport', ru: 'Найти аэропорт' }
const NOTHING_FOUND: Localized = { en: 'nothing found', ru: 'ничего не найдено' }
const REFINE: Localized = {
  en: 'more matches — refine your search',
  ru: 'есть ещё совпадения — уточните запрос',
}

/** Задержка между последним нажатием и запросом поиска. */
const SEARCH_DEBOUNCE_MS = 250

/** Подпись выбранного ряда в самом поле поиска: код + имя, без город/страны
 *  (они видны в полях паспорта/тройки рядом — здесь повтор был бы простынёй). */
const pickedLabel = (row: DirectoryRow): string => `${row.iata} — ${row.airport}`

/**
 * Комбобокс «Найти аэропорт»: поиск по справочнику от двух набранных знаков,
 * с задержкой SEARCH_DEBOUNCE_MS и отбрасыванием устаревших ответов (приём
 * stale-флага — ответ на перегнанный запрос не должен перерисовать список
 * позднего). Ярусы ранжирования (код → город-целиком → имя → город → страна,
 * prominent-сортировка) живут на сервере, см. `searchAirports`.
 *
 * Родился в `PassportFieldsEditor` (формы паспорта кабинета) и вынесен сюда,
 * когда исправление кода IATA появилось и на стороне заполнения (экран
 * правок): сам комбобокс одинаков, а вот СЕРВЕРНЫЙ вход у сторон разный —
 * кабинет ходит в `searchAirportsAction` (ворота — сессия), заполнение в
 * `searchAirportsFillAction` (ворота — fill-токен). Поэтому поиск приходит
 * ПРОПСОМ `search`, а не импортом: компонент не вправе выбирать, чьими
 * воротами ходить.
 *
 * Выбор ряда НЕ пишет ничего сам: он отдаёт ряд наверх (`onPick`), а что с
 * ним делать — патч формы кабинета или запись кода через серверные ворота —
 * решает родитель.
 *
 * Доступность — родной ARIA-комбобокс без библиотеки: role="combobox" с
 * aria-expanded/aria-activedescendant на инпуте, listbox с option'ами,
 * ↑/↓/Enter/Escape с клавиатуры, клик мимо закрывает список. Пустой ответ
 * от двух знаков — тихая строка «ничего не найдено», а не молчание;
 * усечённый — строка «уточните запрос» (сервер отдал more=true).
 */
export function AirportSearch(props: {
  onPick: (row: DirectoryRow) => void
  search: (query: string) => Promise<AirportSearchResult>
}): React.JSX.Element {
  const { pick } = useLocale()
  const baseId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  // Правда одного выбора: после клика по ряду текст в поле меняется
  // программно, и искать по нему («SAW — Sabiha Gokcen») не нужно —
  // флаг велит эффекту поиска пропустить ровно это одно изменение.
  const suppressRef = useRef(false)
  const [text, setText] = useState('')
  // null — списка нет (мало знаков, Escape, клик мимо, выбор сделан).
  const [found, setFound] = useState<AirportSearchResult | null>(null)
  const [active, setActive] = useState(0)

  const open = found !== null
  const rows = found?.rows ?? []
  const { search } = props

  useEffect(() => {
    if (suppressRef.current) return
    const query = text.trim()
    if (query.length < 2) {
      setFound(null)
      return
    }
    let stale = false
    const timer = setTimeout(() => {
      void search(query).then((result) => {
        if (stale) return
        setFound(result)
        setActive(0)
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [text, search])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setFound(null)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function choose(row: DirectoryRow): void {
    suppressRef.current = true
    setText(pickedLabel(row))
    setFound(null)
    props.onPick(row)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (!open) return
    if (event.key === 'ArrowDown' && rows.length > 0) {
      event.preventDefault()
      setActive((index) => Math.min(index + 1, rows.length - 1))
    } else if (event.key === 'ArrowUp' && rows.length > 0) {
      event.preventDefault()
      setActive((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter' && rows[active] !== undefined) {
      event.preventDefault()
      choose(rows[active]!)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setFound(null)
    }
  }

  const listId = `${baseId}-list`
  const optionId = (index: number): string => `${baseId}-opt-${index}`

  return (
    <div className="al-search" ref={rootRef}>
      <label className="al-field">
        {pick(FIND_AIRPORT)}
        <input
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && rows[active] !== undefined ? optionId(active) : undefined}
          autoComplete="off"
          value={text}
          onChange={(e) => {
            suppressRef.current = false
            setText(e.target.value)
          }}
          onKeyDown={onKeyDown}
        />
      </label>
      {open && (
        <ul className="al-search-list" role="listbox" id={listId} aria-label={pick(FIND_AIRPORT)}>
          {rows.map((row, index) => (
            <li
              key={row.iata}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              className={
                index === active ? 'al-search-option al-search-active' : 'al-search-option'
              }
              onClick={() => choose(row)}
              onPointerMove={() => setActive(index)}
            >
              {row.iata} — {row.airport} · {row.city}, {row.country}
            </li>
          ))}
          {/* Служебные строки — presentation, не option: клавиатуре и
              aria-activedescendant в них делать нечего. */}
          {rows.length === 0 && (
            <li className="al-search-note" role="presentation">
              {pick(NOTHING_FOUND)}
            </li>
          )}
          {found.more && (
            <li className="al-search-note" role="presentation">
              {pick(REFINE)}
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
