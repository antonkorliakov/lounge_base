'use client'

import { useState } from 'react'
import type { Localized } from '@/form-schema'
import { PHOTO_SLOTS } from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { UI } from '@/i18n/dictionaries'
import { resizeToJpeg } from '@/photos/resize'

/**
 * Narrows an already-parsed JSON value's `error` field to `Localized` — the
 * shape every route rejection now sends (see `src/app/api/photos/route.ts`).
 * Anything else (a body that isn't JSON at all, or JSON without a matching
 * `error` shape) falls back to `UI['photos.uploadFailed']` at the call site
 * rather than being trusted here.
 */
function isLocalized(value: unknown): value is Localized {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { en?: unknown }).en === 'string' &&
    typeof (value as { ru?: unknown }).ru === 'string'
  )
}

/**
 * Один пофайловый отказ слота. `fileName` есть только у отказа из
 * многофайловой пачки — см. комментарий у `errors` в компоненте.
 * `error` хранится как `Localized`, не как готовая строка: переключение
 * языка перерисовывает уже показанный отказ, как и всюду в форме.
 */
type SlotFailure = { fileName: string | null; error: Localized }

/**
 * `slotKeys` narrows which of `PHOTO_SLOTS` this renders; omitted, it renders
 * all four, as the photos step of the main form does.
 *
 * This is how the fixes screen (`FixesOnly`) reuses the upload control for a
 * flagged slot instead of getting its own copy. Everything that makes an
 * upload work — `resizeToJpeg`, the `FormData` shape `/api/photos` expects,
 * the per-slot error state, the success path that calls `onUploaded` — is
 * already per-slot here and keyed by slot, so the only thing the fixes screen
 * actually needed was "render one of these, not all four". A second component
 * would have had to restate every one of those, and the failure mode of
 * restating them is silent (an upload that posts a slightly different body,
 * or swallows a rejection) — the defect class this branch keeps hitting.
 *
 * Filtering `PHOTO_SLOTS` by key rather than accepting `PhotoSlot[]` objects
 * keeps the schema the single source of a slot's `label`/`required`/`extra`:
 * a caller cannot hand in a fabricated slot whose `extra` disagrees with what
 * `attachPhoto` will actually do on the server.
 *
 * `onRemoved` is what makes the per-photo Remove button appear, and only for
 * an `extra` slot — the two halves of "who may remove a photo" deliberately
 * live in different places. WHICH slot can offer it is derived from the schema
 * here (`slot.extra`): for a named slot a new upload replaces the old one
 * (`attachPhoto` deletes-then-inserts), so replace already covers every
 * operation the filler actually has on required content — a Remove button
 * there could only make the questionnaire incomplete, never fix anything,
 * while inviting accidental data loss right next to required photos. For
 * `additional` upload ADDS a row, so removal is the only way to get rid of a
 * bad shot. WHICH SCREEN offers it is the caller's choice — both callers now
 * pass `onRemoved` (`FixesOnly` and the main photos step in `FillForm`): a
 * stray photo in the extra slot is a problem while filling, not only after a
 * reviewer objects to it by name.
 */
export function PhotoSlots(props: {
  token: string
  uploaded: Record<string, string[]>
  onUploaded: (slot: string, url: string) => void
  /** Убрать снимок (см. выше): работает только у накопительного слота. */
  onRemoved?: (slot: string, url: string) => void
  slotKeys?: readonly string[]
}): React.JSX.Element {
  const { pick, t } = useLocale()
  const slots =
    props.slotKeys === undefined
      ? PHOTO_SLOTS
      : PHOTO_SLOTS.filter((slot) => props.slotKeys?.includes(slot.key))
  // Per-slot, not a single form-wide error: a rejection on one slot must
  // not blank out or get confused with whatever another slot is showing.
  //
  // A LIST per slot, not one Localized: the extra slot takes several files in
  // one pick, and each file succeeds or fails on its own — one failed file
  // must not hide the others' success (their thumbnails are already on
  // screen) nor be collapsed into a single anonymous "upload failed" that
  // doesn't say WHICH file to retry. `fileName` is set only when the batch
  // had several files — a lone upload's failure needs no name to be
  // unambiguous, and the named slots rename the file anyway.
  const [errors, setErrors] = useState<Record<string, SlotFailure[]>>({})
  /**
   * Пофайловый прогресс пачки: «Загрузка 2 / 3…» у слота, пока пачка в пути.
   * Заявленная среда — телефон на аэропортовом Wi-Fi: три снимка могут идти
   * десятки секунд, и без счётчика между выбором файлов и первой миниатюрой
   * экран выглядит зависшим. Ключ в `progress` заодно и защёлка: пока пачка
   * не закончена, input слота выключен — вторая пачка, запущенная поверх
   * первой, перемешала бы порядок снимков (см. довод у `uploadBatch`).
   */
  const [progress, setProgress] = useState<Record<string, { done: number; total: number }>>({})
  /**
   * Снимки, удаление которых уже в пути. Нужно потому, что заявленная среда —
   * телефон на аэропортовом Wi-Fi: между тапом и ответом сервера проходит
   * заметное время, кнопка всё это время на экране, и второй тап отправил бы
   * второй DELETE того же снимка. Первый бы прошёл, второй вернул бы «Фото не
   * найдено» — то есть заполняющий увидел бы ошибку про снимок, который как раз
   * успешно убран. Гасим на время запроса, а не спрашиваем подтверждение:
   * случайное удаление здесь восстановимо (снимок остаётся в телефоне, кнопка
   * «Добавить» рядом), а лишний диалог на каждый тап — нет.
   */
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set())

  /**
   * Один файл через существующий конвейер (resize → FormData → POST) —
   * возвращает отказ, а не пишет его в состояние сам: кто и как показывает
   * отказ, решает `uploadBatch`, которому для пачки нужен список пофайловых
   * отказов, а не последний затёрший остальные.
   */
  async function uploadOne(slot: string, file: File): Promise<Localized | null> {
    // `resizeToJpeg` and `fetch` were previously called outside any `try`:
    // a dropped connection (or a resize failure) threw an unhandled
    // rejection instead of reaching either branch below, so the operator
    // tapped Upload and nothing happened at all — no error, no retry
    // prompt, silence. Photos gate submission and the stated environment is
    // airport Wi-Fi, so this is the ordinary case, not an edge case (see
    // Important finding I8 in the whole-branch review).
    try {
      const resized = await resizeToJpeg(file)
      const body = new FormData()
      body.set('token', props.token)
      body.set('slot', slot)
      body.set('file', new File([resized], `${slot}.jpg`, { type: 'image/jpeg' }))

      const response = await fetch('/api/photos', { method: 'POST', body })

      if (!response.ok) {
        let error: Localized = UI['photos.uploadFailed']
        try {
          const data: unknown = await response.json()
          const candidate = (data as { error?: unknown }).error
          if (isLocalized(candidate)) error = candidate
        } catch {
          // Тело не JSON (или пустое) — используем общее сообщение выше.
        }
        return error
      }

      const data = (await response.json()) as { url: string }
      props.onUploaded(slot, data.url)
      return null
    } catch {
      // Network drop, a `resizeToJpeg` failure (corrupt image, decode
      // error), or anything else that throws before a response exists — all
      // the same to the operator: the upload didn't happen and needs a
      // visible, retryable error, not silence.
      return UI['photos.uploadFailed']
    }
  }

  /**
   * Пачка файлов одного слота — ПОСЛЕДОВАТЕЛЬНО, не параллельно, и это выбор,
   * а не лень:
   *  - порядок: снимки рендерятся в порядке вставки строк, и
   *    последовательная загрузка сохраняет порядок выбора сама собой —
   *    параллельная закончилась бы в порядке «кто быстрее» и потребовала бы
   *    отдельной машинерии упорядочивания;
   *  - среда: на аэропортовом Wi-Fi параллельные загрузки делят тонкий
   *    uplink — ВСЕ файлы едут долго и каждый дольше живёт под риском
   *    обрыва; последовательно первый снимок виден через секунды, и обрыв
   *    на третьем не теряет первые два;
   *  - сервер всё равно сериализует: `attachPhoto` берёт блокировку строки
   *    submissions, так что параллельность почти ничего не выигрывает даже
   *    на быстрой сети.
   *
   * У именованных слотов пачка всегда из одного файла (у их input нет
   * `multiple`) — это тот же путь, не второй.
   */
  async function uploadBatch(slot: string, files: readonly File[]): Promise<void> {
    if (files.length === 0 || progress[slot] !== undefined) return
    // Новая пачка снимает прежние отказы слота сразу: их файлы либо
    // перевыбраны в этой пачке, либо решено их не грузить — старый список
    // рядом с новым прогрессом только путал бы, чей отказ на экране.
    setErrors((prev) => {
      if (!(slot in prev)) return prev
      const next = { ...prev }
      delete next[slot]
      return next
    })
    setProgress((prev) => ({ ...prev, [slot]: { done: 0, total: files.length } }))

    const failures: SlotFailure[] = []
    try {
      for (const file of files) {
        const error = await uploadOne(slot, file)
        if (error) {
          failures.push({ fileName: files.length > 1 ? file.name : null, error })
        }
        setProgress((prev) => {
          const current = prev[slot]
          if (!current) return prev
          return { ...prev, [slot]: { ...current, done: current.done + 1 } }
        })
      }
    } finally {
      // И при неожиданном исключении тоже: незакрытый прогресс навсегда
      // запер бы input слота — тот же класс, что у `removing` ниже.
      setProgress((prev) => {
        if (!(slot in prev)) return prev
        const next = { ...prev }
        delete next[slot]
        return next
      })
      if (failures.length > 0) {
        setErrors((prev) => ({ ...prev, [slot]: failures }))
      }
    }
  }

  async function remove(slot: string, url: string): Promise<void> {
    if (removing.has(url)) return
    setRemoving((prev) => new Set(prev).add(url))
    try {
      const response = await fetch('/api/photos', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: props.token, slot, url }),
      })

      if (!response.ok) {
        let error: Localized = UI['photos.removeFailed']
        try {
          const data: unknown = await response.json()
          const candidate = (data as { error?: unknown }).error
          if (isLocalized(candidate)) error = candidate
        } catch {
          // Тело не JSON — общее сообщение выше, как и у загрузки.
        }
        setErrors((prev) => ({ ...prev, [slot]: [{ fileName: null, error }] }))
        return
      }

      setErrors((prev) => {
        if (!(slot in prev)) return prev
        const next = { ...prev }
        delete next[slot]
        return next
      })

      props.onRemoved?.(slot, url)
    } catch {
      // Ровно те же причины и та же цена, что у загрузки: без видимого отказа
      // заполняющий жмёт «Убрать» и не понимает, произошло ли что-нибудь.
      setErrors((prev) => ({
        ...prev,
        [slot]: [{ fileName: null, error: UI['photos.removeFailed'] }],
      }))
    } finally {
      // И после отказа тоже: иначе один сбой сети запирал бы этот снимок
      // навсегда — единственный правдивый ответ на замечание по слоту стал бы
      // недоступен до перезагрузки страницы.
      setRemoving((prev) => {
        if (!prev.has(url)) return prev
        const next = new Set(prev)
        next.delete(url)
        return next
      })
    }
  }

  return (
    <section className="photos">
      {slots.map((slot) => (
        <div key={slot.key} className="photo-slot">
          <h3>{pick(slot.label)}</h3>
          {(props.uploaded[slot.key] ?? []).map((url, index) => (
            // Номер снимка в подписях: у `additional` в слоте их несколько, и
            // без него пользователь скринридера слышит несколько одинаковых
            // «Additional Photos» и несколько одинаковых «Убрать» без способа
            // понять, какая кнопка убирает какой снимок — тот же довод, по
            // которому нумерация уже есть на экране проверки (`FieldRow`).
            <div key={url} className="photo-shot">
              <img src={url} alt={`${pick(slot.label)} ${index + 1}`} />
              {slot.extra && props.onRemoved && (
                <button
                  type="button"
                  className="photo-remove"
                  aria-label={`${t('photos.remove')}: ${pick(slot.label)} ${index + 1}`}
                  disabled={removing.has(url)}
                  onClick={() => void remove(slot.key, url)}
                >
                  {t('photos.remove')}
                </button>
              )}
            </div>
          ))}
          {slot.required && !props.uploaded[slot.key]?.length && (
            <p className="field-hint">{t('photos.missing')}</p>
          )}
          {/* role="status" — чтобы скринридер услышал смену счётчика без
              перевода фокуса; визуально это та же строка-подсказка, что и
              «Нет фото». Счётчик показывает НОМЕР ФАЙЛА В РАБОТЕ (done+1,
              с потолком total на последнем), одиночная загрузка обходится
              без счётчика — «1 / 1» читался бы как обещание продолжения. */}
          {progress[slot.key] && (
            <p className="field-hint" role="status">
              {progress[slot.key]!.total > 1
                ? `${t('photos.uploading')} ${Math.min(
                    progress[slot.key]!.done + 1,
                    progress[slot.key]!.total,
                  )} / ${progress[slot.key]!.total}…`
                : `${t('photos.uploading')}…`}
            </p>
          )}
          {errors[slot.key]?.map((failure) => (
            // Ключ — имя файла (у одиночного отказа оно null, но такой отказ
            // в списке один): двух отказов ОДНОГО имени в пачке не бывает
            // осмысленно различимых и для пользователя.
            <p key={failure.fileName ?? 'single'} className="fix-comment">
              {failure.fileName
                ? `${failure.fileName}: ${pick(failure.error)}`
                : pick(failure.error)}
            </p>
          ))}
          <label className="photo-upload">
            {/* Подпись читается по тому же правилу, по которому сервер
                действительно поступает со слотом, а не по «есть ли уже
                снимки»: накопительный слот (`extra`) всегда ДОБАВЛЯЕТ (см.
                `attachPhoto` и `FillForm`'s `photoUploaded`), поэтому у
                непустого `additional` подпись была «Заменить», а нажатие
                добавляло четвёртый снимок и оставляло непригодный на месте.
                Убрать его — отдельная кнопка выше. */}
            {slot.extra
              ? t('photos.add')
              : props.uploaded[slot.key]?.length
                ? t('photos.replace')
                : t('photos.upload')}
            {/* `multiple` — только у накопительного слота: именованный держит
                один снимок, и «выбрать несколько» там было бы обещанием,
                которое сервер не выполняет (замена оставила бы последний).

                `capture` у накопительного слота при этом СНЯТ, и это не
                случайная пара к `multiple`: на iOS Safari `capture` открывает
                сразу камеру, а камера отдаёт один кадр — `multiple` молча
                переставал бы работать ровно на телефоне, то есть в заявленной
                среде. Без `capture` открывается выбор «камера или галерея», и
                множественный выбор из галереи работает; именованные слоты
                (один свежий снимок конкретного места) камеру сохраняют. */}
            <input
              type="file"
              accept="image/*"
              capture={slot.extra ? undefined : 'environment'}
              multiple={slot.extra}
              disabled={progress[slot.key] !== undefined}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                // Сброс value — чтобы ПОВТОРНЫЙ выбор того же файла снова
                // вызвал change: после отказа сети «попробовать ещё раз» с тем
                // же снимком — обычный путь, а не краевой случай.
                e.target.value = ''
                if (files.length > 0) void uploadBatch(slot.key, files)
              }}
            />
          </label>
        </div>
      ))}
    </section>
  )
}
