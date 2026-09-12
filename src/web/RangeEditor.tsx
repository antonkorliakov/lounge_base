'use client'

import type React from 'react'
import { END_OF_DAY, FIRST_FLIGHT, LAST_FLIGHT, isNightRange, rangeToWindow, type HoursOptions, type Range } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { ClockInput } from './ClockInput'

/**
 * Одна пара границ «с … до …» — две колонки, у каждой подпись и ряд
 * управления. Где поле допускает рейсы (`options.flightBounds`), ряд
 * начинается переключателем «Время | Первый рейс» (или «Последний рейс»):
 * нажатая кнопка и есть ответ, при рейсе поле времени не рисуется вовсе —
 * подпись рядом дублировала бы кнопку (Anton, 2026-09-13, макет). Где рейсов
 * нет (пиковые часы, уборка), остаётся одно поле времени (`ClockInput`).
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
 * Подпись «до конца дня» показана в ОБОИХ редакторах, `night` её не гасит:
 * у графика уборки конец суток — законный ответ («уборка до полуночи»), не
 * ночной перенос. `rangeToWindow` (I1: единственное место, решающее «что
 * значит "00:00" как конец») отвечает и на этот вопрос — `Range.to` держит
 * ровно одно представление конца суток, `'00:00'`, а не буквальный
 * `END_OF_DAY`: набранное «24:00» `parseClockInput` переводит в него ещё до
 * `Range`, так что отдельной проверки на `'24:00'` здесь нет.
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

  const bound = (key: 'from' | 'to', marker: string, markerWord: string): React.JSX.Element => {
    const value = range[key]
    const isMarker = value === marker
    // «Не задано» у двух границ пишется по-разному — так было и до этого
    // редактора: `from: ''`, `to: null` (`Range`).
    const unset = key === 'from' ? '' : null
    const label = t(key === 'from' ? 'schedule.from' : 'schedule.to')
    return (
      <div className="hr-col">
        <p className="hr-col-label">{label}</p>
        <div className="hr-col-row">
          {/* Маркер без переключателя — например, у дня с двумя окнами, одно из
              которых рейс (старые данные, до правила «рейсы только у
              единственного интервала»): значение должно быть ВИДНО, иначе
              колонка пуста, а сервер отказывает непонятно чему. Сменить его
              здесь нельзя — только убрать интервал. */}
          {!props.options.flightBounds && isMarker && <span className="hr-static">{markerWord}</span>}
          {props.options.flightBounds && (
            <span className="hr-seg" role="group" aria-label={`${label} — ${t('schedule.timeMode')} / ${markerWord}`}>
              <button type="button" aria-pressed={!isMarker} onClick={() => isMarker && onChange({ ...range, [key]: unset })}>
                {t('schedule.timeMode')}
              </button>
              <button type="button" aria-pressed={isMarker} onClick={() => !isMarker && onChange({ ...range, [key]: marker })}>
                {markerWord}
              </button>
            </span>
          )}
          {!isMarker && (
            <ClockInput
              id={`${props.id}-${key}`}
              inputRef={key === 'from' ? props.fromRef : undefined}
              bound={key}
              value={typeof value === 'string' ? value : ''}
              label={t(key === 'from' ? 'schedule.from' : 'schedule.to')}
              placeholder={t('schedule.clockPlaceholder')}
              pickLabel={t('schedule.pickTime')}
              onCommit={(next) => onChange({ ...range, [key]: key === 'from' ? (next ?? '') : next })}
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="hr-range">
      <div className="hr-cols">
        {bound('from', FIRST_FLIGHT, t('schedule.firstFlight'))}
        {bound('to', LAST_FLIGHT, t('schedule.lastFlight'))}
      </div>
      {night && isNightRange(range) && range.to && <p className="hr-note">{t('schedule.nextDay').replace('{to}', range.to)}</p>}
      {/* Не гасится `night`: конец суток — законный ответ у обоих
          редакторов (см. WHY выше). `rangeToWindow` — единственное место,
          решающее «до 00:00» ли это (I1); `isNightRange` уже исключает этот
          же диапазон из ночи, так что подписи не пересекаются. */}
      {rangeToWindow(range).to === END_OF_DAY && <p className="hr-note">{t('schedule.endOfDay')}</p>}
    </div>
  )
}
