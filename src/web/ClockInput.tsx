'use client'

import { useEffect, useRef, useState, type JSX, type Ref } from 'react'
import { completeClockInput, parseClockInput, sanitizeClockInput, type ClockBound } from '@/form-schema'

/**
 * Текстовое поле времени с маской «ЧЧ:ММ». Заменяет `<input type="time">`:
 * у браузерного контрола часы и минуты — отдельные сегменты, в него нельзя
 * ни вставить «09:00» из буфера, ни выделить всё и перепечатать (Anton,
 * 2026-09-12). Правил формата здесь нет — они в `clockInput.ts`; компонент
 * решает только, когда что показывать и когда отдавать наверх.
 *
 * Текст живёт локально, в `Range` уходит только годное время (или `null`,
 * если границы пока нет): итог недели и подсказка «укажите время» видят то
 * же, что оператор. Пропс `value` переписывает текст только вне фокуса —
 * иначе снятие границы (`null` при неполном тексте) стирало бы то, что
 * оператор набирает. На blur обрезок достраивается (`completeClockInput`),
 * а годный текст заменяется тем, что легло в `Range`: «24:00» становится
 * «00:00» с подписью «до конца дня» — так поле после перезагрузки выглядит
 * ровно так же, как сразу после ввода. Негодный текст («25:00») остаётся
 * подсвеченным, в `Range` его нет.
 */
export function ClockInput(props: {
  value: string
  bound: ClockBound
  onCommit: (value: string | null) => void
  id: string
  label: string
  placeholder: string
  inputRef?: Ref<HTMLInputElement>
}): JSX.Element {
  const [text, setText] = useState(props.value)
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setText(props.value)
  }, [props.value])

  const invalid = text !== '' && parseClockInput(text, props.bound) === null

  return (
    <input
      id={props.id}
      ref={props.inputRef}
      className="hr-clock"
      type="text"
      inputMode="numeric"
      autoComplete="off"
      // Нет `maxLength`: браузер обрезал бы вставку ДО того, как её увидит
      // `onChange` (' 21:00 ' → '21:0' при maxLength=5) — `sanitizeClockInput`
      // уже сама режет лишнее, отдельный предел на длину только мешает
      // вставке (Important, whole-branch fix wave, Finding 1).
      placeholder={props.placeholder}
      aria-label={props.label}
      aria-invalid={invalid || undefined}
      value={text}
      onFocus={() => {
        focused.current = true
      }}
      onChange={(e) => {
        const next = sanitizeClockInput(e.target.value)
        setText(next)
        props.onCommit(parseClockInput(next, props.bound))
      }}
      onBlur={() => {
        focused.current = false
        const completed = completeClockInput(text)
        const parsed = parseClockInput(completed, props.bound)
        if (parsed === null) return
        setText(parsed)
        // Достроенное («9» → «09:00») наверх ещё не уходило; уже годное
        // («24:00» → «00:00») ушло на onChange, повторять его незачем.
        if (completed !== text) props.onCommit(parsed)
      }}
    />
  )
}
