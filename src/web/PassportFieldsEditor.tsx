'use client'

import { Fragment, useEffect, useState } from 'react'
import type { Localized } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { normalizeIata } from '@/registry/iata'
import type { DirectoryEntry } from '@/registry/directory'
import { lookupIataAction, searchAirportsAction } from '@/app/admin/actions'
import { AirportSearch } from './AirportSearch'

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

// Комбобокс «Найти аэропорт» вынесен в собственный модуль (`AirportSearch`):
// он теперь нужен и стороне заполнения (исправление кода IATA на экране
// правок), а серверный вход у сторон разный — поэтому поиск он принимает
// пропсом, и здесь им становится действие кабинета. Выбор ряда НЕ заполняет
// тройку сам: он лишь отдаёт код наверх (`onPick` → onPatch({ iataCode })),
// а заполнение и замок производных полей делает ТОТ ЖЕ эффект полного кода,
// что и при ручном наборе, — одно правило заполнения, а не второе.

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
              <AirportSearch
                search={searchAirportsAction}
                onPick={(row) => onPatch({ iataCode: row.iata })}
              />
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
