'use client'

import type React from 'react'
import {
  CADENCES,
  CLEANING_DAY_OPTIONS,
  NTHS,
  WEEKDAYS,
  canAddRange,
  cleaningProblem,
  nextWindowStart,
  scheduleRenderable,
  switchCadence,
  type Cadence,
  type CleaningSchedule,
  type Nth,
  type Weekday,
} from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { HoursRulesEditor } from './HoursRulesEditor'
import { RangeEditor } from './RangeEditor'

/** Подписи периодичности и порядкового номера — в интерфейсе, а не в
 *  `schedule.ts`: там живут подписи КАНОНИЧЕСКОГО текста (короткие, для файла
 *  и экрана проверки), здесь — подписи кнопок. Совпадать они не обязаны, и
 *  сведение их в одну таблицу связало бы формулировку файла с формулировкой
 *  кнопки. */
const CADENCE_BUTTON: Record<Cadence, { en: string; ru: string }> = {
  daily: { en: 'Daily', ru: 'Ежедневно' },
  weekly: { en: 'Weekly', ru: 'Еженедельно' },
  monthly: { en: 'Monthly', ru: 'Ежемесячно' },
  quarterly: { en: 'Quarterly', ru: 'Ежеквартально' },
}

const NTH_BUTTON: Record<string, { en: string; ru: string }> = {
  '1': { en: '1st', ru: '1-й' }, '2': { en: '2nd', ru: '2-й' }, '3': { en: '3rd', ru: '3-й' },
  '4': { en: '4th', ru: '4-й' }, last: { en: 'last', ru: 'последний' },
}

/** Сохранённое значение → расписание. Старый свободный текст остаётся
 *  текстом (см. `initialRules` в `HoursRulesEditor.tsx` — тот же приём и та же
 *  причина).
 *
 *  Рисуется, если `scheduleRenderable` (`schedule.ts`) говорит, что можно
 *  прочитать `cadence`/`nth`/`weekday`/`windows`/`days` — не только когда
 *  значение безупречно или `'empty'` (Critical 2, сквозное ревью). Раньше
 *  здесь стояла обратная проверка (`problem !== null && problem !== 'empty'`
 *  → расписание отбрасывается целиком), и она роняла ВЕСЬ график на любой
 *  мимолётной негодности одного интервала — конец раньше начала,
 *  пересечение соседних интервалов — потому что `onChange` стреляет на
 *  каждое нажатие клавиши и `cleaningProblem` этого же мгновенного значения
 *  уже не `null`/`'empty'`. Для еженедельной уборки это било вдвойне: один
 *  плохой день внутри `days` возвращает СВОЙ тег как тег всего графика
 *  (`weekHoursProblem` — см. её комментарий), так что одна опечатка на одном
 *  дне гасила все четыре кнопки периодичности и остальные шесть дней сразу.
 *
 *  `'empty'` остаётся особым случаем не потому, что он один законен, а
 *  потому что он самый частый: ровно то состояние, в которое попадает
 *  оператор через мгновение после выбора периодичности (`switchCadence(null,
 *  'daily')` и аналоги для `monthly`/`quarterly` дают `{ cadence, windows: []
 *  }`), и то же состояние остаётся после снятия «×» у последнего интервала.
 *  Прятать его значило бы, что нажатие кнопки «Daily» выглядит так, будто
 *  ничего не произошло. Для `weekly` этот тег на нетронутой сетке не
 *  возникает вовсе (`weekHoursProblem({}, …)` возвращает `null`) — но если
 *  один день внутри `days` несёт `'empty'` (через сам редактор недостижимо, но
 *  значение может прийти из сида или более старой версии клиента),
 *  `scheduleRenderable` пропускает и его: этот день — забота
 *  `HoursRulesEditor`'s `initialRules`, не этой функции.
 *
 *  Только по-настоящему нечитаемое значение (неизвестная/отсутствующая
 *  периодичность, битые `nth`/`weekday` у monthly/quarterly, форма верхнего
 *  уровня не объект) по-прежнему возвращает `schedule: null`: честнее
 *  показать четыре кнопки без нажатой, чем выдать требуемую форму за то, что
 *  было сохранено. */
function asSchedule(value: unknown): { schedule: CleaningSchedule | null; legacy: string | null } {
  if (typeof value === 'string' && value.trim() !== '') return { schedule: null, legacy: value }
  const problem = cleaningProblem(value)
  if (!scheduleRenderable(problem)) return { schedule: null, legacy: null }
  return { schedule: value as CleaningSchedule, legacy: null }
}

export function CleaningScheduleEditor(props: {
  value: unknown
  onChange: (schedule: CleaningSchedule) => void
  idPrefix: string
}): React.JSX.Element {
  const { t, pick } = useLocale()
  const { schedule, legacy } = asSchedule(props.value)

  return (
    <div className="wh">
      {legacy !== null && (
        <div className="hr-legacy">
          <p className="hr-legacy-value">{legacy}</p>
          <p className="field-hint">{t('form.freeFormAnswer')}</p>
        </div>
      )}

      <span className="cs-label">{t('schedule.cadence')}</span>
      <span className="chip-row" role="group" aria-label={t('schedule.cadence')}>
        {CADENCES.map((cadence) => (
          <button
            key={cadence}
            type="button"
            aria-pressed={schedule?.cadence === cadence}
            // Перенос интервалов при смене — правило схемы (`switchCadence`),
            // не решение кнопки: она передаёт туда текущее значение и кладёт
            // обратно то, что вернули.
            onClick={() => props.onChange(switchCadence(schedule, cadence))}
          >
            {pick(CADENCE_BUTTON[cadence])}
          </button>
        ))}
      </span>

      {schedule?.cadence === 'weekly' && (
        <HoursRulesEditor
          value={schedule.days}
          options={CLEANING_DAY_OPTIONS}
          idPrefix={props.idPrefix}
          onChange={(days) => props.onChange({ cadence: 'weekly', days })}
        />
      )}

      {(schedule?.cadence === 'monthly' || schedule?.cadence === 'quarterly') && (
        <div className="hr-row">
          <label htmlFor={`${props.idPrefix}-nth`}>{t('schedule.nth')}</label>
          <select
            id={`${props.idPrefix}-nth`}
            value={String(schedule.nth)}
            onChange={(e) =>
              props.onChange({ ...schedule, nth: (e.target.value === 'last' ? 'last' : Number(e.target.value)) as Nth })
            }
          >
            {NTHS.map((nth) => (
              <option key={String(nth)} value={String(nth)}>{pick(NTH_BUTTON[String(nth)]!)}</option>
            ))}
          </select>
          <label htmlFor={`${props.idPrefix}-weekday`}>{t('schedule.weekday')}</label>
          <select
            id={`${props.idPrefix}-weekday`}
            value={schedule.weekday}
            onChange={(e) => props.onChange({ ...schedule, weekday: e.target.value as Weekday })}
          >
            {WEEKDAYS.map((day) => (
              <option key={day} value={day}>{t(`schedule.day.${day}`)}</option>
            ))}
          </select>
        </div>
      )}

      {/* Ежедневно/ежемесячно/ежеквартально: один общий список интервалов,
          записанный напрямую в `windows` — БЕЗ `expandRules`. У графика
          уборки нет ночного режима (см. WHY у `RangeEditor`'s `night`), так
          что каждое окно — свой `RangeEditor` с `night={false}` и, когда окон
          больше одного, своим «×»; `options={CLEANING_DAY_OPTIONS}` гасит и
          «24 часа» (её здесь и не было), и «или первый/последний рейс» —
          уборка не привязана к рейсам. */}
      {schedule && schedule.cadence !== 'weekly' && (
        <div className="cs-windows">
          {schedule.windows.map((window, index) => (
            <div className="hr-row" key={index}>
              <RangeEditor
                id={`${props.idPrefix}-w${index}`}
                range={window}
                options={CLEANING_DAY_OPTIONS}
                night={false}
                onChange={(next) => {
                  const windows = schedule.windows.map((w, i) => (i === index ? next : w))
                  props.onChange({ ...schedule, windows })
                }}
              />
              {schedule.windows.length > 1 && (
                <button
                  type="button"
                  className="hr-x"
                  aria-label={t('schedule.removeWindow')}
                  onClick={() => props.onChange({ ...schedule, windows: schedule.windows.filter((_, i) => i !== index) })}
                >
                  ×
                </button>
              )}
            </div>
          ))}

          {/* `canAddRange` одна отвечает за «можно достроить ВТОРОЙ и далее
              интервал» — она смотрит на ПОСЛЕДНИЙ элемент и на пустом списке
              элемента нет, так что вернула бы false. Но пустой список —
              законное первое состояние периодичности (см. `asSchedule`'s
              комментарий выше: `switchCadence` кладёт `windows: []` в момент
              выбора «Daily»/«Monthly»/«Quarterly», это не порча), и первый
              интервал должно быть чем предложить — иначе кнопка периодичности
              выглядела бы так, будто нажатие ничего не дало. Отсюда явная
              вторая ветка `.length === 0`, а не одно `canAddRange`. */}
          {(schedule.windows.length === 0 || canAddRange(schedule.windows)) && (
            <button
              type="button"
              className="hr-link"
              onClick={() => {
                const start = nextWindowStart(schedule.windows)
                // `canAddRange`/пустой список уже гарантируют время (пустой
                // список — всегда '09:00', непустой прошёл `canAddRange`,
                // которая сама зовёт `nextWindowStart` на своей паре) —
                // проверка здесь только защищает TypeScript от `string | null`.
                if (start) props.onChange({ ...schedule, windows: [...schedule.windows, { from: start, to: null }] })
              }}
            >
              {t('schedule.addRange')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
