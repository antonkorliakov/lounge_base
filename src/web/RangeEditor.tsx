'use client'

import type React from 'react'
import { FIRST_FLIGHT, LAST_FLIGHT, isNightRange, type HoursOptions, type Range } from '@/form-schema'
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
    const value = range[key]
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
    </span>
  )
}
