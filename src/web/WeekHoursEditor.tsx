'use client'

import type React from 'react'
import {
  WEEKDAYS,
  applyToAll,
  applyToWeekdays,
  applyToWeekend,
  copyPreviousDay,
  dayCopyable,
  dayHoursProblem,
  dayRenderable,
  nextWindowStart,
  type DayHours,
  type HoursOptions,
  type WeekHours,
  type Weekday,
  type Window,
} from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { WindowsEditor } from './WindowsEditor'

/** Сохранённое значение → сетка. Старый свободный текст остаётся текстом:
 *  сетка тогда пустая, а текст показывается над ней с пометкой — ответ
 *  виден, и его есть чем заменить.
 *
 *  Для структурного значения дни разбираются ПО ОДНОМУ, а не всей неделей
 *  разом: испорченный день отбрасывается сам по себе (рендерится как «не
 *  отвечено», которое сетка и так честно показывает), а не гасит шесть
 *  хороших дней заодно с собой — одна плохая клетка не должна выглядеть как
 *  пропажа всех остальных ответов. Это не только про плохие данные:
 *  `hoursOptions` живут в схеме (`src/form-schema/fields.ts`) и читаются
 *  заново при каждом рендере, так что обычная будущая правка поля (например,
 *  запрет `allDay`) превращает уже сохранённые дни в `dayHoursProblem`, и
 *  тогда пропасть должна только эта клетка. Неизвестный ключ недели по той
 *  же причине не бросает исключение и не портит остальные дни — он просто
 *  игнорируется.
 *
 *  День остаётся в сетке, если `dayRenderable` (`schedule.ts`) говорит, что
 *  его можно нарисовать (Critical 2, сквозное ревью) — не только когда он
 *  безупречен или `'empty'`. `onChange` стреляет на каждое нажатие клавиши, и
 *  значение уже лежит в состоянии React в момент, когда конец интервала на
 *  секунду оказывается раньше начала или наезжает на соседний: раньше
 *  единственными пропущенными сюда тегами были `null`/`'empty'`, и любое из
 *  этих мимолётных состояний роняло день целиком — поля пропадали, фокус
 *  терялся, кнопки состояния гасли, а следующий клик оператора сохранял эту
 *  пропажу как «Сохранено». `dayRenderable` отсеивает только то, что
 *  действительно нельзя прочитать (`'shape'`, `'kind'`) — те же теги, что
 *  `dayCopyable` не умеет различить и посчитал бы день годным источником
 *  копирования, так что здесь день отбрасывается и копирование, и остальные
 *  шесть дней остаются целы.
 *
 *  M2: `'empty'` (`{ kind: 'windows', windows: [] }`) на дне — НЕ то, что
 *  оставляет оператор, набравший «+ интервал» и снявший единственный «×»:
 *  `setDayWindows` ниже удаляет день из недели целиком в этот самый момент,
 *  живого пути через ЭТОТ редактор к застрявшему `'empty'`-дню нет — ни у
 *  обычных недельных часов, ни у еженедельной сетки уборки (тот же
 *  `WeekHoursEditor`, тот же `setDayWindows`), и `validation.ts` отказывает
 *  сохранённому `'empty'`-дню `weekHours`-поля. Тег остаётся в списке
 *  рисуемых ради значений, до которых этот редактор не дотрагивался: сид
 *  (`scripts/seed-dev.ts`), более старая версия клиента, запись в обход UI.
 *  `dayRenderable` не различает происхождение — раз день можно прочитать, он
 *  рисуется. */
function asWeek(value: unknown, options: HoursOptions): { week: WeekHours; legacy: string | null } {
  if (typeof value === 'string' && value.trim() !== '') return { week: {}, legacy: value }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { week: {}, legacy: null }

  const week: WeekHours = {}
  for (const [day, hours] of Object.entries(value)) {
    if (!(WEEKDAYS as readonly string[]).includes(day)) continue
    if (dayRenderable(dayHoursProblem(hours, options))) week[day as Weekday] = hours as DayHours
  }
  return { week, legacy: null }
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

  // Список интервалов дня опустел (снят последний «×»): день возвращается в
  // «не отвечено», а не остаётся truthy-пустышкой `{kind:'windows',windows:[]}}`
  // — сервер такой день отвергает (`windowsProblem` → 'empty'), а с truthy-
  // пустышкой быстрые действия скопировали бы пустоту на другие дни (см.
  // `dayCopyable` в schedule.ts).
  const setDayWindows = (day: Weekday, windows: Window[]): void => {
    if (windows.length === 0) {
      const { [day]: _removed, ...rest } = week
      onChange(rest)
      return
    }
    setDay(day, { kind: 'windows', windows })
  }

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
        <button type="button" disabled={!dayCopyable(week.mon)} onClick={() => onChange(applyToAll(week, 'mon'))}>
          {t('schedule.sameAllWeek')}
        </button>
        <button type="button" disabled={!dayCopyable(week.mon)} onClick={() => onChange(applyToWeekdays(week, 'mon'))}>
          {t('schedule.copyToWorkdays')}
        </button>
        <button type="button" disabled={!dayCopyable(week.mon)} onClick={() => onChange(applyToWeekend(week, 'mon'))}>
          {t('schedule.copyToWeekend')}
        </button>
      </div>

      {WEEKDAYS.map((day, index) => {
        const hours = week[day]
        return (
          <div className="wh-row" key={day}>
            <span className="wh-day">{t(`schedule.day.${day}`)}</span>
            {/* I4: факт о ЗНАЧЕНИИ дня (отсутствует в сетке), видимый
                безусловно — не только когда отправка отказала (см. довод у
                `wh-window-unfinished` в WindowsEditor.tsx: не тащить
                состояние отправки внутрь редактора ради одной сетки). */}
            {hours === undefined && <span className="field-hint wh-day-unanswered">{t('schedule.dayUnanswered')}</span>}
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
                        ? {
                            kind: 'windows',
                            // Пустой день с нуля — тот же случай, что пустой
                            // список в `nextWindowStart`: 09:00 живёт одним
                            // местом, а не повторённым литералом. `!` тут
                            // безопасен: пустой список — первая ветка
                            // `nextWindowStart`, она всегда возвращает строку.
                            windows: hours?.kind === 'windows' ? hours.windows : [{ from: nextWindowStart([])!, to: null }],
                          }
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
                disabled={!dayCopyable(week[WEEKDAYS[index - 1]!])}
                onClick={() => onChange(copyPreviousDay(week, day))}
              >
                {t('schedule.copyPrevious')}
              </button>
            )}
            {hours?.kind === 'windows' && (
              <WindowsEditor
                windows={hours.windows}
                idPrefix={`${props.idPrefix}-${day}`}
                onChange={(windows) => setDayWindows(day, windows)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
