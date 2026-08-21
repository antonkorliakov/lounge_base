'use client'

import type { Field } from '@/form-schema'
import type { AirportSearchResult, DirectoryRow } from '@/registry/directory'
import { useLocale } from '@/i18n/context'
import { AirportSearch } from './AirportSearch'

/**
 * Контрол исправления кода IATA на стороне ЗАПОЛНЕНИЯ — единственный способ
 * оператора изменить I.10 (а через него и производную тройку I.7–I.9):
 * текущий код показан только для чтения, новый ВЫБИРАЕТСЯ из справочника
 * комбобоксом (`AirportSearch`), свободного ввода кода нет. Это не «удобство
 * вместо поля», а честный показ серверного контракта: `saveOperatorField`
 * принимает только код из справочника и в одной транзакции переписывает
 * тройку — предлагать свободный ввод значило бы предлагать то, в чём сервер
 * почти всегда откажет. Промах справочника недостижим из UI по построению
 * (выбрать можно только существующий ряд); серверные ворота при этом никуда
 * не деваются — действие достижимо по сети напрямую.
 *
 * Рендерится в двух местах, с одним поведением: основной проход (I.10 без
 * замка предзаполнения — лаунж старше фичи или код уже правили) и карточки
 * экрана правок (замечание на I.10 или на любом из производных полей — у
 * последних исправление кода и ЕСТЬ исправление, см. `FixesOnly`).
 *
 * `onPick` отдаёт ВЕСЬ ряд справочника, не только код: родитель (`FillForm`)
 * пишет код через серверные ворота, а тройку в клиентском состоянии обновляет
 * из того же ряда — тем же значениям, что запишет сервер, — иначе read-only
 * поля тройки показывали бы устаревшие значения до перезагрузки.
 */
export function IataCorrection(props: {
  /** Поле I.10 из схемы — подпись и обязательность рисуются его собственными. */
  field: Field
  /** Текущий сохранённый код (ответ анкеты), для read-only показа. */
  value: unknown
  onPick: (row: DirectoryRow) => void
  search: (query: string) => Promise<AirportSearchResult>
  /** Отказ сервера по последней записи кода — тот же контракт, что у
   *  `FieldInput`'s `error`. */
  error?: string
}): React.JSX.Element {
  const { pick, t } = useLocale()

  return (
    <div className="field">
      <label className="field-label" htmlFor={props.field.key}>
        {pick(props.field.label)}
        {props.field.required && <span className="field-required">{t('form.required')}</span>}
      </label>
      <input
        id={props.field.key}
        type="text"
        className="field-locked"
        value={
          typeof props.value === 'string' || typeof props.value === 'number'
            ? String(props.value)
            : ''
        }
        readOnly
      />
      <p className="field-hint">{t('form.iataPickNote')}</p>
      <AirportSearch search={props.search} onPick={props.onPick} />
      {props.error && <p className="fix-comment">{props.error}</p>}
    </div>
  )
}
