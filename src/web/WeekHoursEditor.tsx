'use client'

import type React from 'react'
import {
  WEEKDAYS,
  applyToAll,
  applyToWeekdays,
  applyToWeekend,
  copyPreviousDay,
  weekHoursProblem,
  type DayHours,
  type HoursOptions,
  type WeekHours,
  type Weekday,
} from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { WindowsEditor } from './WindowsEditor'

/** Сохранённое значение → сетка. Старый свободный текст (и любое значение, не
 *  прошедшее форму) сеткой не является: она начинается пустой, а текст
 *  показывается над ней с пометкой — ответ виден, и его есть чем заменить. */
function asWeek(value: unknown, options: HoursOptions): { week: WeekHours; legacy: string | null } {
  if (typeof value === 'string' && value.trim() !== '') return { week: {}, legacy: value }
  if (weekHoursProblem(value, options) !== null) return { week: {}, legacy: null }
  return { week: (value ?? {}) as WeekHours, legacy: null }
}

export function WeekHoursEditor(props: {
  value: unknown
  options: HoursOptions
  onChange: (week: WeekHours) => void
  idPrefix: string
}): React.JSX.Element {
  const { t, pick } = useLocale()
  const { options, onChange } = props
  const { week, legacy } = asWeek(props.value, options)

  const setDay = (day: Weekday, hours: DayHours): void => onChange({ ...week, [day]: hours })

  const states: { key: 'allDay' | 'none' | 'windows'; label: string }[] = [
    ...(options.allDay ? [{ key: 'allDay' as const, label: t('schedule.allDay') }] : []),
    { key: 'none' as const, label: pick(options.noneLabel) },
    { key: 'windows' as const, label: t('schedule.byHours') },
  ]

  return (
    <div className="wh">
      {legacy !== null && (
        <div className="wh-legacy">
          <p className="wh-legacy-value">{legacy}</p>
          <p className="field-hint">{t('form.freeFormAnswer')}</p>
        </div>
      )}

      <div className="wh-bulk">
        <button type="button" disabled={!week.mon} onClick={() => onChange(applyToAll(week, 'mon'))}>
          {t('schedule.sameAllWeek')}
        </button>
        <button type="button" disabled={!week.mon} onClick={() => onChange(applyToWeekdays(week, 'mon'))}>
          {t('schedule.copyToWorkdays')}
        </button>
        <button type="button" disabled={!week.mon} onClick={() => onChange(applyToWeekend(week, 'mon'))}>
          {t('schedule.copyToWeekend')}
        </button>
      </div>

      {WEEKDAYS.map((day, index) => {
        const hours = week[day]
        return (
          <div className="wh-row" key={day}>
            <span className="wh-day">{t(`schedule.day.${day}`)}</span>
            {/* Те же три состояния и тот же `aria-pressed`, что у пары Да|Нет
                у услуг: нажатость — состояние с тремя исходами, и «не
                отвечено» должно отличаться от «закрыто» на вид. */}
            <span className="avail-toggle wh-states" role="group" aria-label={t(`schedule.day.${day}`)}>
              {states.map((state) => (
                <button
                  key={state.key}
                  type="button"
                  aria-pressed={hours?.kind === state.key}
                  onClick={() =>
                    setDay(
                      day,
                      state.key === 'windows'
                        ? { kind: 'windows', windows: hours?.kind === 'windows' ? hours.windows : [{ from: '09:00', to: null }] }
                        : { kind: state.key },
                    )
                  }
                >
                  {state.label}
                </button>
              ))}
            </span>
            {index > 0 && (
              <button
                type="button"
                className="wh-copy"
                disabled={!week[WEEKDAYS[index - 1]!]}
                onClick={() => onChange(copyPreviousDay(week, day))}
              >
                {t('schedule.copyPrevious')}
              </button>
            )}
            {hours?.kind === 'windows' && (
              <WindowsEditor
                windows={hours.windows}
                idPrefix={`${props.idPrefix}-${day}`}
                onChange={(windows) => setDay(day, { kind: 'windows', windows })}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
