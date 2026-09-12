'use client'

import type React from 'react'
import { END_OF_DAY, FIRST_FLIGHT, LAST_FLIGHT, isNightRange, rangeToWindow, type HoursOptions, type Range } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { ClockInput } from './ClockInput'

/**
 * Одна пара границ «с … до …». Граница — либо текстовое поле времени
 * (`ClockInput`, маска ЧЧ:ММ), либо слово-маркер («первого рейса») в такой же
 * рамке, с возвратом к времени. Оба состояния — «рамка + ссылка справа»: у
 * времени ссылка «или первый рейс», у маркера — «или время». Одинаковая
 * форма нужна, чтобы строка не меняла ширину при переключении и чип «24h»
 * не перескакивал на другую строку (Anton, 2026-09-13). Ссылка стоит ПОСЛЕ
 * поля времени и только где поле её допускает (`options.flightBounds`): у пиковых часов
 * рейсов нет.
 *
 * Правил тут нет: ночной диапазон распознаёт `isNightRange`, разбивает по
 * суткам `expandRules`; компонент лишь подписывает его оператору.
 *
 * `night` (по умолчанию true) гасит только подпись «след. дня»: график
 * уборки (`CleaningScheduleEditor`) пишет `windows` напрямую, без
 * `expandRules`, так что у него `to < from` не раскладывается на завтра — это
 * просто негодный интервал, который `windowsProblem` отклонит с
 * `INVALID_CLEANING`, а не переход через полночь. Подпись, обещающая перенос,
 * которого не будет, здесь была бы ложью.
 *
 * Подпись «до конца дня» (Critical, Task 5) показана в ОБОИХ редакторах, `night`
 * её не гасит: у графика уборки конец суток — законный ответ («уборка до
 * полуночи»), не ночной перенос. `rangeToWindow` (I1, сквозное ревью:
 * единственное место, решающее «что значит "00:00" как конец») отвечает и на
 * этот вопрос — само поле `to` в `Range` всегда `'00:00'`, а не буквальный
 * `END_OF_DAY`: оба писателя (`expandRules` и уборка) отдают сюда диапазон
 * уже через `windowToRange`, так что `ClockInput` показывает ровно то, что
 * лежит в `Range` — набранный оператором «24:00» `parseClockInput` переводит
 * в «00:00» ещё до того, как он попадёт в `Range`, так что буквальный
 * `'24:00'` здесь проверять незачем.
 */
export function RangeEditor(props: {
  range: Range
  options: HoursOptions
  onChange: (range: Range) => void
  id: string
  night?: boolean
  /** Ref на `<input>` поля «с» — только для того диапазона, куда `HoursRulesEditor`
   *  переводит фокус после `splitDay`/«другие часы» (I5). Не задан у всех
   *  остальных диапазонов. */
  fromRef?: React.Ref<HTMLInputElement>
}): React.JSX.Element {
  const { t } = useLocale()
  const { range, onChange } = props
  const night = props.night ?? true

  const bound = (key: 'from' | 'to', marker: string, word: string, orWord: string): React.JSX.Element => {
    const value = range[key]
    if (value === marker) {
      return (
        <span className="hr-bound">
          <span className="hr-marker">{word}</span>
          <button type="button" className="hr-link" onClick={() => onChange({ ...range, [key]: key === 'from' ? '' : null })}>
            {t('schedule.useTime')}
          </button>
        </span>
      )
    }
    return (
      <span className="hr-bound">
        <ClockInput
          id={`${props.id}-${key}`}
          inputRef={key === 'from' ? props.fromRef : undefined}
          bound={key}
          value={typeof value === 'string' ? value : ''}
          label={t(key === 'from' ? 'schedule.from' : 'schedule.to')}
          placeholder={t('schedule.clockPlaceholder')}
          onCommit={(next) => onChange({ ...range, [key]: key === 'from' ? (next ?? '') : next })}
        />
        {props.options.flightBounds && (
          <button type="button" className="hr-link" onClick={() => onChange({ ...range, [key]: marker })}>
            {orWord}
          </button>
        )}
      </span>
    )
  }

  return (
    <span className="hr-range">
      {/* Предлог и его граница — один неразрывный узел: при переносе на узком
          экране «до» не остаётся висеть в конце строки отдельно от рамки. */}
      <span className="hr-part">
        <span className="hr-prep">{t('schedule.from')}</span>
        {bound('from', FIRST_FLIGHT, t('schedule.fromFirstFlight'), t('schedule.orFirstFlight'))}
      </span>
      <span className="hr-part">
        <span className="hr-prep">{t('schedule.to')}</span>
        {bound('to', LAST_FLIGHT, t('schedule.toLastFlight'), t('schedule.orLastFlight'))}
      </span>
      {night && isNightRange(range) && range.to && <span className="hr-night">{t('schedule.nextDay').replace('{to}', range.to)}</span>}
      {/* Не гасится `night`: конец суток — законный ответ у обоих
          редакторов (см. WHY выше). `rangeToWindow` — единственное место,
          решающее «до 00:00» ли это (I1, часовое ИЛИ маркерное начало
          — маркер после I3/I1 тоже может значить «до конца суток»);
          `isNightRange` уже исключает этот же диапазон из ночи, так что
          подписи не пересекаются на одном диапазоне. */}
      {rangeToWindow(range).to === END_OF_DAY && <span className="hr-night">{t('schedule.endOfDay')}</span>}
    </span>
  )
}
