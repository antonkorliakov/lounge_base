'use client'

import { Fragment, useEffect, useId, useRef, useState } from 'react'
import type { Localized } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { normalizeIata } from '@/registry/iata'
import type { AirportSearchResult, DirectoryEntry, DirectoryRow } from '@/registry/directory'
import { lookupIataAction, searchAirportsAction } from '@/app/admin/actions'

/**
 * Поля паспорта = обязательные колонки `lounges` + provider — ОДИН список на
 * обе формы кабинета («Add lounge» и правка паспорта, см. `AddLounge`/
 * `EditPassport`): второй рукописный разъезжался бы с первым (класс
 * расползания, который эта ветка ловит не первый раз). Жил в `AddLounge`,
 * переехал сюда вместе с рендером — теперь у полей есть общее ПОВЕДЕНИЕ
 * (справочник ниже), а не только общие подписи.
 *
 * ПОРЯДОК — часть контракта: имя и провайдер первыми (название
 * идентифицирует лаунж), дальше код IATA и за ним ТРИ ПРОИЗВОДНЫХ от него
 * поля — аэропорт → город → страна, от частного к общему. Аэропорт/город/
 * страна ЗАВИСЯТ от кода (решение пользователя), поэтому код стоит ДО них:
 * админ набирает код, а тройка заполняется справочником сама (см.
 * `PassportFieldsEditor`). Тот же порядок IATA → аэропорт → город → страна
 * носит блок I формы заполнения (`FillForm`'s `BLOCK_I_IATA_FIRST`).
 */
export const PASSPORT_FIELDS: { key: PassportFieldKey; label: Localized; required: boolean }[] = [
  { key: 'name', label: { en: 'Name*', ru: 'Название*' }, required: true },
  { key: 'provider', label: { en: 'Provider', ru: 'Провайдер' }, required: false },
  { key: 'iataCode', label: { en: 'IATA code*', ru: 'Код IATA*' }, required: true },
  { key: 'airport', label: { en: 'Airport*', ru: 'Аэропорт*' }, required: true },
  { key: 'city', label: { en: 'City*', ru: 'Город*' }, required: true },
  { key: 'country', label: { en: 'Country*', ru: 'Страна*' }, required: true },
]
export type PassportFieldKey =
  | 'name' | 'iataCode' | 'provider' | 'country' | 'city' | 'airport'

/** Поля, выводимые из кода IATA, — ровно то, что возвращает справочник. */
const DERIVED_KEYS: ReadonlySet<PassportFieldKey> = new Set(['airport', 'city', 'country'])

const FROM_DIRECTORY: Localized = { en: 'from directory:', ru: 'из справочника:' }
// Промах справочника — не приглашение набрать тройку руками (этот путь
// удалён), а объяснение отказа: сервер (`resolveIdentity`) неизвестный код
// не примет, и кнопка родителя выключена, пока справочник не ответил кодом.
const NOT_FOUND: Localized = {
  en: 'code not found in the airport directory — a lounge can only be created for an airport from the directory; new airports are added by updating the directory',
  ru: 'код не найден в справочнике аэропортов — лаунж можно завести только для аэропорта из справочника; новый аэропорт добавляется обновлением справочника',
}
const FIND_AIRPORT: Localized = { en: 'Find airport', ru: 'Найти аэропорт' }
const NOTHING_FOUND: Localized = { en: 'nothing found', ru: 'ничего не найдено' }
const REFINE: Localized = {
  en: 'more matches — refine your search',
  ru: 'есть ещё совпадения — уточните запрос',
}

/** Задержка между последним нажатием и запросом поиска. */
const SEARCH_DEBOUNCE_MS = 250

/** Подпись выбранного ряда в самом поле поиска: код + имя, без город/страны
 *  (они видны в четырёх полях ниже — здесь повтор был бы простынёй). */
const pickedLabel = (row: DirectoryRow): string => `${row.iata} — ${row.airport}`

/**
 * Комбобокс «Найти аэропорт» НАД полем кода: поиск по справочнику
 * (`searchAirportsAction` — ярусы код→город-целиком→имя→город→страна и
 * prominent-сортировка живут на сервере,
 * см. `searchAirports`) от двух набранных знаков, с задержкой
 * SEARCH_DEBOUNCE_MS и отбрасыванием устаревших ответов (тот же приём
 * stale-флага, что у эффекта справочника ниже, — ответ на перегнанный
 * запрос не должен перерисовать список позднего).
 *
 * Выбор ряда НЕ заполняет тройку сам: он лишь отдаёт код наверх
 * (`onPick` → onPatch({ iataCode })), а заполнение и замок производных
 * полей делает ТОТ ЖЕ эффект полного кода, что и при ручном наборе, —
 * одно правило заполнения, а не второе. Поэтому же ручной набор кода и
 * промах справочника (объяснение отказа, см. NOT_FOUND) этим полем не
 * затронуты.
 *
 * Доступность — родной ARIA-комбобокс без библиотеки: role="combobox" с
 * aria-expanded/aria-activedescendant на инпуте, listbox с option'ами,
 * ↑/↓/Enter/Escape с клавиатуры, клик мимо закрывает список. Пустой ответ
 * от двух знаков — тихая строка «ничего не найдено», а не молчание;
 * усечённый — строка «уточните запрос» (сервер отдал more=true).
 */
function AirportSearch(props: { onPick: (row: DirectoryRow) => void }): React.JSX.Element {
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

  useEffect(() => {
    if (suppressRef.current) return
    const query = text.trim()
    if (query.length < 2) {
      setFound(null)
      return
    }
    let stale = false
    const timer = setTimeout(() => {
      void searchAirportsAction(query).then((result) => {
        if (stale) return
        setFound(result)
        setActive(0)
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [text])

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

/**
 * Шесть полей паспорта с выводом из справочника аэропортов — общее ТЕЛО форм
 * «Add lounge» и «Править паспорт» (состояние, действия и кнопки остаются у
 * родителей: у них разные действия и разные результаты).
 *
 * Аэропорт/город/страна — ЧИСТЫЙ ПОКАЗ, не ввод: ручной путь удалён вместе с
 * этими полями в контракте действия (`CreateLoungeInput` в
 * `registry/manage.ts` их больше не принимает). Рисуются они прежними
 * визуальными боксами — теми же `<input>` в `<label>` (это сохраняет подписи,
 * доступные имена и раскладку формы), но НАВСЕГДА `readOnly`, без onChange и
 * с `tabIndex={-1}`: поле, в которое нельзя ввести, не должно быть
 * остановкой Tab, а значения из него никогда не уходят в действие — родители
 * шлют только имя/провайдер/код.
 *
 * Как работает справочник: как только набранный код становится ПОЛНЫМ
 * (нормализуется `normalizeIata` — та же единственная запись правила, что на
 * сервере), спрашивается `lookupIataAction`. Триггер — полнота кода, а не
 * blur и не таймер: три буквы — дискретное событие, второй запрос по тому же
 * коду не случается (guard по `lookup.code`), а честность «что будет
 * сохранено» не должна ждать ухода фокуса. Найден — тройка показывает
 * значения справочника с подписью «из справочника: IST»; не найден — подпись
 * объясняет ОТКАЗ (`NOT_FOUND` — то же правило, что скажет сервер), тройка
 * продолжает показывать прежние значения (у правки паспорта это текущие
 * колонки строки — стирать с экрана правду базы не за что), а Create/Save
 * родителя выключены через `onResolved` ниже. Это подсказка поверх ворот:
 * сервер выводит тройку из справочника заново и неизвестный код НЕ примет
 * (`resolveIdentity`) — клиентский обход ничего не даёт.
 *
 * `onResolved` — клиентская половина ворот для кнопок родителей: true ⟺
 * набранный код полон И найден справочником. Сообщается эффектом (ответ
 * справочника асинхронный), false при каждом недорешённом состоянии — код
 * неполон, запрос в пути, промах.
 *
 * `onPatch` — частичный патч через функциональный setState родителя, а не
 * полный снимок значений: ответ справочника приходит асинхронно, и патч,
 * собранный из снимка на момент запроса, молча откатил бы имя, донабранное
 * за время полёта запроса.
 *
 * Найденные значения ПИШУТСЯ в состояние родителя (а не только рисуются):
 * показ обязан переживать перерисовку родителя, а правка паспорта — начинать
 * с текущих колонок строки. В действие они всё равно не уходят. Ответ на
 * УСТАРЕВШИЙ код (код сменили за время запроса) отбрасывается cleanup'ом
 * эффекта.
 */
export function PassportFieldsEditor(props: {
  values: Record<PassportFieldKey, string>
  onPatch: (patch: Partial<Record<PassportFieldKey, string>>) => void
  onResolved: (resolved: boolean) => void
}): React.JSX.Element {
  const { pick } = useLocale()
  // Ответ справочника на последний ПОЛНЫЙ код: found === null — кода нет.
  const [lookup, setLookup] = useState<{ code: string; found: DirectoryEntry | null } | null>(null)

  const code = normalizeIata(props.values.iataCode)
  const { onPatch, onResolved } = props

  useEffect(() => {
    if (code === null) return
    let stale = false
    void lookupIataAction(code).then((result) => {
      if (stale) return
      setLookup({ code, found: result.found })
      if (result.found) {
        onPatch({
          airport: result.found.airport,
          city: result.found.city,
          country: result.found.country,
        })
      }
    })
    return () => {
      stale = true
    }
  }, [code, onPatch])

  const answered = lookup !== null && lookup.code === code
  const derived = answered && lookup.found !== null

  useEffect(() => {
    onResolved(derived)
  }, [derived, onResolved])

  return (
    <>
      {PASSPORT_FIELDS.map((field) => {
        const isDerived = DERIVED_KEYS.has(field.key)
        return (
          <Fragment key={field.key}>
            {/* Поиск — НАД полем кода (четвёрка ниже сохраняет свой порядок):
                выбор ряда ставит код через onPatch, дальше работает эффект
                полного кода ниже — тот же путь, что при ручном наборе. */}
            {field.key === 'iataCode' && (
              <AirportSearch onPick={(row) => onPatch({ iataCode: row.iata })} />
            )}
            <label className="al-field">
              {pick(field.label)}
              <input
                value={props.values[field.key]}
                readOnly={isDerived}
                tabIndex={isDerived ? -1 : undefined}
                className={isDerived ? 'al-derived' : undefined}
                onChange={isDerived ? undefined : (e) => onPatch({ [field.key]: e.target.value })}
              />
            </label>
            {/* Подпись — СОСЕДОМ label, не внутри него: текст внутри label
                склеивается в accessible name инпута («IATA code* from
                directory: IST»), и точные локаторы по подписи поля перестают
                находить его — имя поля не должно зависеть от ответа
                справочника. */}
            {field.key === 'iataCode' && answered && (
              <span className="al-directory-note">
                {lookup.found ? `${pick(FROM_DIRECTORY)} ${code}` : pick(NOT_FOUND)}
              </span>
            )}
          </Fragment>
        )
      })}
    </>
  )
}
