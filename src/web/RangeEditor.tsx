'use client'

import type React from 'react'
import { END_OF_DAY, FIRST_FLIGHT, LAST_FLIGHT, isClock, isNightRange, type HoursOptions, type Range } from '@/form-schema'
import { useLocale } from '@/i18n/context'

/**
 * Одна пара границ «с … до …». Граница — либо `<input type="time">`, либо
 * слово-маркер («с первого рейса») с возвратом к времени. Ссылка «или
 * первый рейс» стоит ПОСЛЕ поля времени и только где поле её допускает
 * (`options.flightBounds`): у пиковых часов рейсов нет.
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
 * полуночи»), не ночной перенос. Само поле `to` принимает и `'00:00'`
 * (диапазон недельных часов, конвенция `Range` — см. `collapseWeek`), и
 * буквальный `'24:00'` (`Window` графика уборки хранится без слоя `Range` и
 * может нести `END_OF_DAY` напрямую, например из сида) — оба показаны как
 * «00:00» в самом поле времени, единственном значении, которое
 * `<input type="time">` способен принять, и подписаны одинаково.
 */
export function RangeEditor(props: {
  range: Range
  options: HoursOptions
  onChange: (range: Range) => void
  id: string
  night?: boolean
}): React.JSX.Element {
  const { t } = useLocale()
  const { range, onChange } = props
  const night = props.night ?? true

  const bound = (key: 'from' | 'to', marker: string, word: string, orWord: string): React.JSX.Element => {
    // `<input type="time">` не принимает «24:00» (браузер санитизирует его до
    // пустого поля) — единственное значение, которое ему под силу показать
    // для конца суток, это «00:00»; буквальный `END_OF_DAY`, где бы он ни
    // пришёл (`Window` графика уборки), отображается тем же «00:00».
    const value = key === 'to' && range[key] === END_OF_DAY ? '00:00' : range[key]
    if (value === marker) {
      return (
        <span className="hr-marker">
          {word}
          <button
            type="button"
            className="hr-link"
            aria-label={t('schedule.useTime')}
            onClick={() => onChange({ ...range, [key]: key === 'from' ? '' : null })}
          >
            ×
          </button>
        </span>
      )
    }
    return (
      <span className="hr-bound">
        <input
          id={`${props.id}-${key}`}
          type="time"
          step={300}
          aria-label={t(key === 'from' ? 'schedule.from' : 'schedule.to')}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange({ ...range, [key]: key === 'to' && e.target.value === '' ? null : e.target.value })}
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
      <span className="hr-prep">{t('schedule.from')}</span>
      {bound('from', FIRST_FLIGHT, t('schedule.fromFirstFlight'), t('schedule.orFirstFlight'))}
      <span className="hr-prep">{t('schedule.to')}</span>
      {bound('to', LAST_FLIGHT, t('schedule.toLastFlight'), t('schedule.orLastFlight'))}
      {night && isNightRange(range) && range.to && <span className="hr-night">{t('schedule.nextDay').replace('{to}', range.to)}</span>}
      {/* Не гасится `night`: конец суток — законный ответ у обоих
          редакторов (см. WHY выше). `to === '00:00'` — конвенция `Range`
          недельных часов, `to === END_OF_DAY` — буквальное хранение окна
          графика уборки без слоя `Range`; оба читаются одинаково, и
          `isNightRange` уже исключает первое из ночи, так что подписи не
          пересекаются на одном диапазоне. */}
      {(range.to === '00:00' || range.to === END_OF_DAY) && isClock(range.from) && (
        <span className="hr-night">{t('schedule.endOfDay')}</span>
      )}
    </span>
  )
}
