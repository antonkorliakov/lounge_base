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
 *
 * Рядом — кнопка-часики: она открывает РОДНОЙ выбор времени (на телефоне
 * барабаны, на компьютере список) через `showPicker()` скрытого
 * `<input type="time">`. Замена нативного контрола на текст отняла барабаны
 * у операторов с телефоном (Anton, 2026-09-13); кнопка возвращает их, не
 * отнимая у текста вставку и выделение. Выбранное время идёт тем же путём,
 * что набранное: sanitize → parse → commit. Скрытое поле не в табе и без
 * имени для диктора — граница одна, у неё одно имя (текстовое поле).
 */
export function ClockInput(props: {
  value: string
  bound: ClockBound
  onCommit: (value: string | null) => void
  id: string
  label: string
  placeholder: string
  /** Имя кнопки-часиков для диктора («Выбрать время»). */
  pickLabel: string
  inputRef?: Ref<HTMLInputElement>
}): JSX.Element {
  const [text, setText] = useState(props.value)
  const focused = useRef(false)
  const picker = useRef<HTMLInputElement>(null)

  const accept = (raw: string): void => {
    const next = sanitizeClockInput(raw)
    setText(next)
    props.onCommit(parseClockInput(next, props.bound))
  }

  const openPicker = (): void => {
    // `showPicker` есть в Chrome 99+, Safari 16+, Firefox 101+ и требует
    // жеста пользователя — он тут есть (клик по кнопке). Где метода нет или
    // он отказал, кнопка просто ничего не делает: переводить фокус на
    // скрытый `aria-hidden` контрол нельзя (диктор потеряет фокус), а
    // текстовое поле рядом остаётся полноценным способом ввода.
    try {
      picker.current?.showPicker()
    } catch {
      /* см. выше */
    }
  }

  useEffect(() => {
    if (!focused.current) setText(props.value)
  }, [props.value])

  const parsed = parseClockInput(text, props.bound)
  const invalid = text !== '' && parsed === null

  return (
    <span className="hr-clock-wrap">
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
        onChange={(e) => accept(e.target.value)}
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
      <button type="button" className="hr-pick" aria-label={props.pickLabel} onClick={openPicker}>
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </button>
      {/* Родной контрол живёт скрытым: видимое поле — текст, а это лишь то,
        что `showPicker()` раскрывает. Значение — последнее годное время в
        том виде, что лежит в `Range` (набранное «24:00» → «00:00»: голое
        «24:00» родной контрол не примет), чтобы барабаны открывались на
        нём, а не на 00:00. */}
      <input
        ref={picker}
        className="hr-clock-native"
        type="time"
        tabIndex={-1}
        aria-hidden="true"
        value={parsed ?? ''}
        onChange={(e) => accept(e.target.value)}
      />
    </span>
  )
}
