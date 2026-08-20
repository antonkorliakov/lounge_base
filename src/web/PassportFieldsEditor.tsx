'use client'

import { useEffect, useState } from 'react'
import type { Localized } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { normalizeIata } from '@/registry/iata'
import type { DirectoryEntry } from '@/registry/directory'
import { lookupIataAction } from '@/app/admin/actions'

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
const NOT_FOUND: Localized = {
  en: 'code not found in the directory — fill in manually',
  ru: 'код не найден в справочнике — заполните вручную',
}

/**
 * Шесть полей паспорта с подсказкой справочника аэропортов — общее ТЕЛО форм
 * «Add lounge» и «Править паспорт» (состояние, действия и кнопки остаются у
 * родителей: у них разные действия и разные результаты).
 *
 * Как работает справочник: как только набранный код становится ПОЛНЫМ
 * (нормализуется `normalizeIata` — та же единственная запись правила, что на
 * сервере), спрашивается `lookupIataAction`. Триггер — полнота кода, а не
 * blur и не таймер: три буквы — дискретное событие, второй запрос по тому же
 * коду не случается (guard по `lookup.code`), а честность «что будет
 * сохранено» не должна ждать ухода фокуса. Найден — тройка производных полей
 * заполняется значениями справочника и становится read-only с подписью
 * «из справочника: IST»; не найден — честное «код не найден в справочнике —
 * заполните вручную», и тройка остаётся редактируемой (справочник — не
 * истина в последней инстанции). Это ПОДСКАЗКА: сервер при сохранении
 * выводит тройку из справочника заново (`resolveIdentity` в
 * `registry/manage.ts`) — клиентский обход read-only ничего не даёт.
 *
 * `onPatch` — частичный патч через функциональный setState родителя, а не
 * полный снимок значений: ответ справочника приходит асинхронно, и патч,
 * собранный из снимка на момент запроса, молча откатил бы имя, донабранное
 * за время полёта запроса.
 *
 * Найденные значения ПИШУТСЯ в состояние родителя (а не только рисуются):
 * то, что уйдёт в действие, обязано быть тем, что на экране. Ответ на
 * УСТАРЕВШИЙ код (код сменили за время запроса) отбрасывается cleanup'ом
 * эффекта; пока код неполон, тройка остаётся редактируемой с последними
 * значениями — стирать набранное руками у неполного кода не за что.
 */
export function PassportFieldsEditor(props: {
  values: Record<PassportFieldKey, string>
  onPatch: (patch: Partial<Record<PassportFieldKey, string>>) => void
}): React.JSX.Element {
  const { pick } = useLocale()
  // Ответ справочника на последний ПОЛНЫЙ код: found === null — кода нет.
  const [lookup, setLookup] = useState<{ code: string; found: DirectoryEntry | null } | null>(null)

  const code = normalizeIata(props.values.iataCode)
  const { onPatch } = props

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

  return (
    <>
      {PASSPORT_FIELDS.map((field) => {
        const isDerived = derived && DERIVED_KEYS.has(field.key)
        return (
          <label key={field.key} className="al-field">
            {pick(field.label)}
            <input
              value={props.values[field.key]}
              readOnly={isDerived}
              className={isDerived ? 'al-derived' : undefined}
              onChange={(e) => onPatch({ [field.key]: e.target.value })}
            />
            {field.key === 'iataCode' && answered && (
              <span className="al-directory-note">
                {lookup.found ? `${pick(FROM_DIRECTORY)} ${code}` : pick(NOT_FOUND)}
              </span>
            )}
          </label>
        )
      })}
    </>
  )
}
