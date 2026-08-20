'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  FIELDS,
  blockOf,
  fieldByKey,
  photoSlotByKey,
  serviceItemByKey,
  type Field,
  type Localized,
  type ServiceValueInput,
} from '@/form-schema'
import type { SubmissionStatus } from '@/db/schema'
import type { MissingItems } from '@/submissions/completeness'
import { useLocale } from '@/i18n/context'
import { saveFieldAction, saveServiceAction, submitAction } from '@/app/f/[token]/actions'
import { useAutosave } from './useAutosave'
import { FormShell } from './FormShell'
import { FieldInput } from './FieldInput'
import { ServicesPass1 } from './ServicesPass1'
import { ServicesPass2 } from './ServicesPass2'
import { PhotoSlots } from './PhotoSlots'
import { FixesOnly, type Flag } from './FixesOnly'

/** Отправить можно только из состояний, где форма остаётся открытой
 *  заполняющему — то же множество, что `SUBMITTABLE` в transitions.ts. */
const EDITABLE_STATUSES: ReadonlySet<SubmissionStatus> = new Set(['draft', 'changes_requested'])

/**
 * ПРЕЗЕНТАЦИОННЫЙ порядок четырёх полей паспорта в блоке I — код IATA первым,
 * за ним производные от него аэропорт → город → страна (в `FIELDS` исходник
 * держит их наоборот: I.7 страна … I.10 код). Решение пользователя: аэропорт/
 * город/страна ВЫВОДЯТСЯ из кода (см. справочник — `registry/directory.ts`),
 * и оператор обязан видеть причину раньше следствий — тем же порядком, каким
 * админ набирает их в формах кабинета (`PassportFieldsEditor`). Обычно вся
 * четвёрка стоит под замком предзаполнения — но и замкнутые поля читаются
 * сверху вниз.
 *
 * Переставляется ТОЛЬКО ЗДЕСЬ, на шве формы заполнения, и это принципиально:
 * `FIELDS` остаётся в порядке исходной анкеты (нумерация I.7–I.10 — язык
 * ревьюера и золотых фикстур), экран проверки зеркалит исходный документ,
 * а выгрузка (`export/columns.ts`, `export/single.ts`) обязана байт в байт
 * повторять колонки исходного workbook — там перестановка была бы порчей
 * контракта, а не удобством. Другого места с собственным порядком показа
 * полей в системе нет и появляться не должно.
 */
export const BLOCK_I_IATA_FIRST: readonly string[] = ['I.10', 'I.9', 'I.8', 'I.7']

/**
 * Поля блока для показа на шаге формы: порядок `FIELDS`, поверх которого
 * четвёрка `BLOCK_I_IATA_FIRST` занимает СВОИ ЖЕ четыре позиции в новом
 * порядке — соседние поля (I.6 до, I.11 после) не сдвигаются. Если какого-то
 * из ключей четвёрки в блоке нет (не тот блок — обычный случай), исходный
 * порядок возвращается нетронутым: перестановка объявлена ровно для блока I.
 */
export function stepFields(blockKey: string): Field[] {
  const fields = FIELDS.filter((field) => field.block === blockKey)
  const positions = fields
    .map((field, index) => (BLOCK_I_IATA_FIRST.includes(field.key) ? index : -1))
    .filter((index) => index !== -1)
  if (positions.length !== BLOCK_I_IATA_FIRST.length) return fields

  const reordered = [...fields]
  BLOCK_I_IATA_FIRST.forEach((key, slot) => {
    reordered[positions[slot]!] = fields.find((field) => field.key === key)!
  })
  return reordered
}

export function FillForm(props: {
  token: string
  submissionId: string
  /** Статус анкеты на момент открытия ссылки — решает, что показывать: весь
   *  9-шаговый проход, экран правок по отмеченным полям (см. FixesOnly), или
   *  (для submitted/approved) закрытый экран только для просмотра статуса —
   *  форма закрыта заполняющему, см. design spec и `EDITABLE_STATUSES` выше. */
  status: SubmissionStatus
  /** Незакрытые отметки рецензента (`resolvedAt IS NULL`), если есть. */
  flags: Flag[]
  /** Поля блока I, предзаполненные при заведении лаунжа и показываемые в
   *  ОСНОВНОМ проходе только для чтения. Список считает сервер
   *  (`lockedIdentityKeys`, см. `src/registry/manage.ts`) — здесь нет своей
   *  копии правила. Экран правок (`FixesOnly`) этих замков сознательно НЕ
   *  видит: отмеченное ревьюером поле обязано быть исправимым, иначе цикл
   *  правок не сходится (замок — умолчание UX, не стена). */
  lockedKeys: string[]
  initialFields: Record<string, unknown>
  initialServices: Record<string, ServiceValueInput>
  initialPhotos: Record<string, string[]>
}): React.JSX.Element {
  const { t, pick, locale, setLocale } = useLocale()
  const [fields, setFields] = useState(props.initialFields)
  const [services, setServices] = useState(props.initialServices)
  const [photos, setPhotos] = useState(props.initialPhotos)
  const [submitError, setSubmitError] = useState<Localized | null>(null)
  const [submitMissing, setSubmitMissing] = useState<MissingItems | null>(null)
  const [submitted, setSubmitted] = useState(false)
  /**
   * Flagged answers the filler has actually edited in this session, for the
   * fixes screen's "not changed yet" marking (see `FixesOnly`'s `touched`).
   * Session-local by necessity: `props.flags` is what the server rendered at
   * page load, and a successful save clears its flag in a second transaction
   * without re-rendering this tree (see `clearFlagAfterSave`), so the card
   * stays on screen after being fixed and nothing else here can tell the two
   * apart.
   */
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set())

  const lockedKeys = useMemo(() => new Set(props.lockedKeys), [props.lockedKeys])

  function markTouched(key: string): void {
    setTouched((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
  }

  const autosave = useAutosave({
    submissionId: props.submissionId,
    // `useAutosave` (untouched by this fix) expects `SaveOutcome.error` to be
    // a plain string — it's only ever used internally for `rejected`
    // bookkeeping, never rendered (see its own file). `ActionResult.error` is
    // now the full `Localized` pair, so it's picked down to a string right
    // at this boundary rather than changing `useAutosave`'s shape.
    save: async (key, value) => {
      const result =
        key.startsWith('svc:')
          ? await saveServiceAction(props.token, key.slice(4), value as ServiceValueInput)
          : await saveFieldAction(props.token, key, value)
      return result.ok ? result : { ok: false, error: pick(result.error) }
    },
  })

  const statusText =
    autosave.status === 'offline' ? t('form.savingOffline')
    : autosave.status === 'rejected' ? t('form.rejected')
    : autosave.status === 'saved' ? t('form.saved')
    : ''

  // `useAutosave`'s queue keys services as `svc:<itemKey>` (see `changeService`
  // below) so they share the same rejected-tracking map as plain fields
  // without colliding on key namespaces. `ServicesPass2` only knows its own
  // item keys, so the prefix is stripped back off here, at the one place that
  // builds both namespaces.
  const serviceErrors = useMemo(() => {
    const out: Record<string, string> = {}
    for (const [key, message] of Object.entries(autosave.rejected)) {
      if (key.startsWith('svc:')) out[key.slice(4)] = message
    }
    return out
  }, [autosave.rejected])

  // Whatever `useAutosave` found still queued in local storage when it
  // mounted (the tab died, or the page reloaded, before the 600ms debounce
  // sent it) belongs back on screen, not only back on the wire — see
  // `recovered`'s own doc comment in useAutosave.ts. Runs once, right after
  // mount, when `autosave.recovered` first becomes non-empty; a later edit
  // never touches it again (`recovered` itself is never repopulated after
  // mount), so this can never clobber a newer answer with a stale one.
  useEffect(() => {
    const entries = Object.entries(autosave.recovered)
    if (entries.length === 0) return

    const recoveredFields: Record<string, unknown> = {}
    const recoveredServices: Record<string, ServiceValueInput> = {}
    for (const [key, value] of entries) {
      if (key.startsWith('svc:')) {
        recoveredServices[key.slice(4)] = value as ServiceValueInput
      } else {
        recoveredFields[key] = value
      }
    }

    if (Object.keys(recoveredFields).length > 0) {
      setFields((prev) => ({ ...prev, ...recoveredFields }))
    }
    if (Object.keys(recoveredServices).length > 0) {
      setServices((prev) => ({ ...prev, ...recoveredServices }))
    }
  }, [autosave.recovered])

  function changeField(key: string, value: unknown): void {
    setFields((prev) => ({ ...prev, [key]: value }))
    markTouched(key)
    autosave.push(key, value)
  }

  function changeService(key: string, value: ServiceValueInput): void {
    setServices((prev) => ({ ...prev, [key]: value }))
    markTouched(key)
    autosave.push(`svc:${key}`, value)
  }

  /**
   * Единственный обработчик успешной загрузки снимка — и для шага фото, и для
   * экрана правок, чтобы правило «именованный слот заменяется, `additional`
   * накапливается» существовало в одном месте.
   *
   * A named slot (entrance, reception, landmarks) answers one specific
   * question and holds exactly one photo — a new upload replaces it, matching
   * what the server actually does (`attachPhoto` deletes the previous row for
   * any non-`extra` slot; see `src/photos/store.ts`). Only the `extra` slot
   * (`additional`) accumulates. Appending unconditionally here used to show
   * two images for a named slot after "Replace" until the next reload — a lie
   * about what the server holds.
   */
  function photoUploaded(slotKey: string, url: string): void {
    const slotDef = photoSlotByKey(slotKey)
    setPhotos((prev) => ({
      ...prev,
      [slotKey]: slotDef?.extra ? [...(prev[slotKey] ?? []), url] : [url],
    }))
    markTouched(slotKey)
  }

  /**
   * Снимок убран (`DELETE /api/photos` уже прошёл — см. `PhotoSlots`'s
   * `remove`): убираем его и из локального состояния, чтобы плитка исчезла без
   * перезагрузки, и помечаем слот тронутым — на экране правок это то же
   * «Изменено», что и у перезалитого снимка, потому что для накопительного
   * слота именно удаление и есть исправление замечания.
   */
  function photoRemoved(slotKey: string, url: string): void {
    setPhotos((prev) => ({
      ...prev,
      [slotKey]: (prev[slotKey] ?? []).filter((existing) => existing !== url),
    }))
    markTouched(slotKey)
  }

  async function submit(): Promise<void> {
    const result = await submitAction(props.token)
    if (result.ok) {
      setSubmitError(null)
      setSubmitMissing(null)
      setSubmitted(true)
    } else {
      setSubmitError(result.error)
      setSubmitMissing(result.missing ?? null)
    }
  }

  /**
   * Renders the bare "N item(s) still need an answer" refusal alongside an
   * actual, readable list of which ones — using the schema's own labels via
   * `pick()`, the same convention every other schema string in this
   * component already goes through. On a 417-datapoint form a count alone
   * gives the operator nothing to act on (Important finding I7). No jump-to-
   * step navigation: a readable list is what was asked for, not a router.
   */
  function submitErrorNode(): React.JSX.Element | null {
    if (!submitError) return null
    return (
      <div className="fix-comment">
        <p>{pick(submitError)}</p>
        {submitMissing && (
          <ul>
            {/* Все три поиска — схемные (`fieldByKey`/`serviceItemByKey`/
                `photoSlotByKey`), а не локальные сканы по массивам: ключ не
                должен разрешаться здесь иначе, чем он разрешается на экране
                правок (`fixTargetFor`) или в маршруте загрузки. */}
            {submitMissing.fieldKeys.map((key) => {
              const field = fieldByKey(key)
              return <li key={`field:${key}`}>{field ? pick(field.label) : key}</li>
            })}
            {submitMissing.serviceKeys.map((key) => {
              const item = serviceItemByKey(key)
              return <li key={`service:${key}`}>{item ? pick(item.label) : key}</li>
            })}
            {submitMissing.photoSlots.map((key) => {
              const slot = photoSlotByKey(key)
              return <li key={`photo:${key}`}>{slot ? pick(slot.label) : key}</li>
            })}
          </ul>
        )}
      </div>
    )
  }

  if (submitted) {
    return (
      <div className="shell">
        <main className="shell-body">
          <p>{t('form.submitted')}</p>
        </main>
      </div>
    )
  }

  // A still-valid fill link reopened after the questionnaire moved past
  // `draft`/`changes_requested` (i.e. it is `submitted` or `approved`) must
  // not render the editable form at all — the design spec is explicit that
  // the form is closed to the filler once submitted, and `saveFieldValue`/
  // `saveServiceValue` already refuse writes in this state server-side (see
  // `assertEditable`). Without this gate the operator got the full form back
  // and, before Critical 2 was fixed, "Saved" for every refused write.
  if (!EDITABLE_STATUSES.has(props.status)) {
    return (
      <div className="shell">
        <main className="shell-body">
          <p>{t('form.closed')}</p>
        </main>
      </div>
    )
  }

  // A submission that came back with flagged fields gets a single-screen
  // "fix just these" view instead of the full form again — that is the
  // whole point of FixesOnly. The same `submitAction` that drives the
  // review step below resubmits it: `submitSubmission` already accepts
  // both draft -> submitted and changes_requested -> submitted (see
  // src/submissions/transitions.ts), so a separate "resubmit" action is
  // neither present in the codebase nor needed here.
  if (props.status === 'changes_requested' && props.flags.length > 0) {
    return (
      <div className="shell">
        <header className="shell-top">
          <div className="shell-top-row">
            <span className="shell-status">{statusText}</span>
            <button
              type="button"
              className="shell-locale"
              onClick={() => setLocale(locale === 'en' ? 'ru' : 'en')}
            >
              {locale === 'en' ? 'RU' : 'EN'}
            </button>
          </div>
        </header>
        <main className="shell-body">
          <FixesOnly
            flags={props.flags}
            fieldValues={fields}
            onFieldChange={changeField}
            fieldErrors={autosave.rejected}
            services={services}
            onServiceChange={changeService}
            serviceErrors={serviceErrors}
            token={props.token}
            photos={photos}
            onPhotoUploaded={photoUploaded}
            onPhotoRemoved={photoRemoved}
            touched={touched}
          />
          {submitErrorNode()}
        </main>
        {/* Та же закреплённая панель, что у 9-шагового прохода (см.
            `.shell-foot`): у этого экрана нет шагов, поэтому в ней стоит
            только отправка — но стоит она там же и выглядит так же, где бы
            заполняющий ни был по списку правок. Один вид нижней панели на обе
            формы анкеты, а не два поведения. */}
        <footer className="shell-foot">
          <button type="button" className="shell-primary" onClick={submit}>
            {t('form.submit')}
          </button>
        </footer>
      </div>
    )
  }

  return (
    <FormShell status={statusText} onSubmit={submit}>
      {(step) => {
        if (step.kind === 'fields') {
          // Шаг может нести несколько блоков схемы (слитый шаг — см.
          // MERGED_FIELD_GROUPS в FormShell.tsx). Слияние — презентация:
          // каждый блок внутри шага остаётся собой и подписан СВОИМ label —
          // теми же словами, которыми ревьюер подтверждает блок и ставит
          // замечания, — так что «Children Policy» из замечания находится на
          // экране дословно. Одноблочный шаг секцию не подписывает: его имя
          // уже стоит заголовком шелла, и второй heading с тем же accessible
          // name был бы дублем — тот же принцип, по которому проходы услуг
          // отдали свои <h2> шеллу (см. ServicesPass1).
          return step.blockKeys.map((blockKey) => {
            const block = blockOf(blockKey)
            return (
              <section key={blockKey} className="step-section">
                {step.blockKeys.length > 1 && (
                  <h2 className="step-section-title">{block ? pick(block.label) : blockKey}</h2>
                )}
                {/* Порядок показа — `stepFields`: блок I рисует код IATA
                    раньше производных от него полей (см. BLOCK_I_IATA_FIRST —
                    и почему НИГДЕ, кроме этого шва). */}
                {stepFields(blockKey).map((field) => (
                  <FieldInput
                    key={field.key}
                    field={field}
                    value={fields[field.key]}
                    onChange={(value) => changeField(field.key, value)}
                    error={autosave.rejected[field.key]}
                    // Замок — только здесь, в основном проходе. `FixesOnly`
                    // ниже рендерит свой `FieldInput` без этого пропа, и это
                    // его контракт: отмеченный ответ правится всегда.
                    locked={lockedKeys.has(field.key)}
                  />
                ))}
              </section>
            )
          })
        }

        if (step.kind === 'services1') {
          return <ServicesPass1 values={services} onChange={changeService} />
        }

        if (step.kind === 'services2') {
          return <ServicesPass2 values={services} onChange={changeService} errors={serviceErrors} />
        }

        if (step.kind === 'photos') {
          return (
            <PhotoSlots token={props.token} uploaded={photos} onUploaded={photoUploaded} />
          )
        }

        // Сама кнопка отправки живёт в закреплённой панели шелла (см.
        // `FormShell`'s footer и его проп `onSubmit`) — здесь остаётся тело
        // шага: что происходит при отправке, и список недостающих ответов,
        // если сервер отказал.
        return (
          <div className="review">
            <p>{t('form.reviewHint')}</p>
            {submitErrorNode()}
          </div>
        )
      }}
    </FormShell>
  )
}
