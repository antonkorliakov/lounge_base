'use client'

import { useEffect, useMemo } from 'react'
import {
  fieldByKey,
  photoSlotByKey,
  serviceItemByKey,
  type Field,
  type PhotoSlot,
  type ServiceItem,
  type ServiceValueInput,
} from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { FieldInput } from './FieldInput'
import { ServiceItemCard } from './ServiceItemCard'
import { PhotoSlots } from './PhotoSlots'

export type Flag = { fieldKey: string; reason: string | null; comment: string }

/**
 * Which of the questionnaire's three kinds of question a flagged key names,
 * and therefore which control the fixes screen must open for it.
 *
 * This function is the seam the Critical defect at the end of P2 Task 7 lived
 * in. `isFlaggableKey` (`src/review/flags.ts`) accepts `FIELDS` +
 * `SERVICE_ITEMS` + `PHOTO_SLOTS`, and `ReviewScreen` puts a flag button on
 * every key of every block — 129 of them — but this screen used to resolve
 * only `FIELDS` (67) and render `{field && <FieldInput/>}`, i.e. a comment and
 * NOTHING for the other 62. Since `submitSubmission` gates on completeness and
 * not on open flags, the filler could resubmit unchanged, the reviewer saw the
 * same answer with the same flag, and the cycle never converged.
 *
 * Exported and total (`unknown` is a case, not a `null`) so the invariant
 * "every key `isFlaggableKey` accepts has a control here" can be pinned by a
 * test — see `__tests__/fixesOnly.test.tsx`. The three lookups are the
 * schema's own (`fieldByKey`/`serviceItemByKey`/`photoSlotByKey`), not local
 * scans, so a key can never resolve here differently from how it resolves
 * anywhere else.
 */
export type FixTarget =
  | { kind: 'field'; field: Field }
  | { kind: 'service'; item: ServiceItem }
  | { kind: 'photo'; slot: PhotoSlot }
  | { kind: 'unknown' }

export function fixTargetFor(key: string): FixTarget {
  const field = fieldByKey(key)
  if (field) return { kind: 'field', field }

  const item = serviceItemByKey(key)
  if (item) return { kind: 'service', item }

  const slot = photoSlotByKey(key)
  if (slot) return { kind: 'photo', slot }

  return { kind: 'unknown' }
}

/**
 * Возврат на правку: заполняющий видит только отмеченные ответы,
 * а не всю анкету заново.
 *
 * Every card carries the reviewer's comment plus the real control for that
 * kind of answer — the same control the main form uses, never a second copy
 * of it (`FieldInput`, `ServiceItemCard`, `PhotoSlots`).
 */
export function FixesOnly(props: {
  flags: Flag[]
  /** Значения плоских полей (`FIELDS`), см. `FillForm`'s `fields`. */
  fieldValues: Record<string, unknown>
  onFieldChange: (fieldKey: string, value: unknown) => void
  /** The server's refusal message for a flagged field's most recent save,
   *  keyed by field key (see `FillForm`'s `autosave.rejected`). Without this,
   *  a refusal on this screen only ever showed in the header status banner —
   *  not next to the specific answer that caused it, unlike the main form's
   *  `FieldInput` calls. */
  fieldErrors?: Record<string, string>
  services: Record<string, ServiceValueInput>
  onServiceChange: (itemKey: string, value: ServiceValueInput) => void
  /** Refusals for service items, keyed by item key — `FillForm`'s
   *  `serviceErrors` (the queue's `svc:` prefix already stripped). */
  serviceErrors?: Record<string, string>
  /** Фото загружаются не серверным действием, а `POST /api/photos`, которому
   *  нужен сам токен — см. `PhotoSlots`. */
  token: string
  photos: Record<string, string[]>
  onPhotoUploaded: (slot: string, url: string) => void
  /** Убрать снимок из накопительного слота — см. `PhotoSlots`'s `onRemoved`
   *  и `control`'s `photo` ветку ниже. */
  onPhotoRemoved: (slot: string, url: string) => void
  /**
   * Flagged keys the filler has actually edited in this session. Resubmitting
   * with flags still open is ALLOWED (the user's own decision: the filler must
   * never be trapped by a flag they disagree with or do not understand), so
   * this is not a gate — it is the difference between choosing to resubmit
   * unchanged and doing it by accident. A key counts as changed only when its
   * save was not refused: `fieldErrors`/`serviceErrors` veto the badge, since
   * a refused save left the stored answer, and therefore the flag, exactly as
   * it was.
   */
  touched: ReadonlySet<string>
}): React.JSX.Element {
  const { t } = useLocale()

  const targets = useMemo(
    () => props.flags.map((flag) => ({ flag, target: fixTargetFor(flag.fieldKey) })),
    [props.flags],
  )

  const unmatched = targets
    .filter((entry) => entry.target.kind === 'unknown')
    .map((entry) => entry.flag.fieldKey)

  // An unmatched key is a bug, not a state of the data (see `fixTargetFor`),
  // so it is worth a server/browser log and not only a visible card: the
  // filler can report the code, but nobody is watching their console. In an
  // effect rather than inline in the branch below so this stays out of render.
  useEffect(() => {
    if (unmatched.length === 0) return
    console.error(
      '[fixes] flagged key(s) with no control on the fixes screen — ' +
        'a flaggable category is missing a path here: ' +
        unmatched.join(', '),
    )
  }, [unmatched.join(',')])

  function errorFor(key: string, target: FixTarget): string | undefined {
    if (target.kind === 'field') return props.fieldErrors?.[key]
    if (target.kind === 'service') return props.serviceErrors?.[key]
    return undefined
  }

  function control(flag: Flag, target: FixTarget): React.JSX.Element {
    switch (target.kind) {
      case 'field':
        return (
          <FieldInput
            field={target.field}
            value={props.fieldValues[flag.fieldKey]}
            onChange={(value) => props.onFieldChange(flag.fieldKey, value)}
            error={props.fieldErrors?.[flag.fieldKey]}
          />
        )

      case 'service':
        // `withAvailability`: this screen is the only one the filler gets
        // while a flag is open, so the availability answer has to be
        // changeable here too — otherwise a flag on "you said you have this"
        // is itself unfixable. See `ServiceItemCard`'s doc comment.
        return (
          <ServiceItemCard
            item={target.item}
            value={props.services[flag.fieldKey]}
            onChange={(value) => props.onServiceChange(flag.fieldKey, value)}
            error={props.serviceErrors?.[flag.fieldKey]}
            withAvailability
          />
        )

      case 'photo':
        // Add vs replace is not re-decided here: `PhotoSlots` labels its
        // control from the schema's own rule (a named slot holds one photo and
        // is replaced, `additional` accumulates) — the same rule
        // `FillForm`'s `onUploaded` applies locally and `attachPhoto` enforces
        // server-side.
        //
        // `onPhotoRemoved` is passed HERE and nowhere else, and that is what
        // puts a Remove button on the accumulating slot's photos. Without it a
        // flag on `additional` had no truthful answer at all: adding a fourth
        // photo does not remove the one the reviewer called unusable, so the
        // filler could only either leave the flag standing or make the slot
        // worse. The named slots need nothing of the kind — replacing the photo
        // IS the answer there — so `PhotoSlots` derives that half from
        // `slot.extra` rather than from which screen it is on.
        return (
          <PhotoSlots
            token={props.token}
            uploaded={props.photos}
            onUploaded={props.onPhotoUploaded}
            onRemoved={props.onPhotoRemoved}
            slotKeys={[target.slot.key]}
          />
        )

      case 'unknown':
        return (
          <p className="fix-unmatched" data-unmatched={flag.fieldKey}>
            {t('fixes.noControl')} <code>{flag.fieldKey}</code>
          </p>
        )
    }
  }

  const changedCount = targets.filter(
    ({ flag, target }) =>
      props.touched.has(flag.fieldKey) && !errorFor(flag.fieldKey, target),
  ).length
  const stillOpen = targets.length - changedCount

  return (
    <section className="fixes">
      <h2>{t('fixes.title')}</h2>
      <p className="subtitle">{t('fixes.intro')}</p>

      {targets.map(({ flag, target }) => {
        const changed = props.touched.has(flag.fieldKey) && !errorFor(flag.fieldKey, target)
        return (
          <div key={flag.fieldKey} className="fix-card">
            <p className="fix-comment">{flag.comment}</p>
            {control(flag, target)}
            <p className={changed ? 'fix-changed' : 'fix-open'}>
              {changed ? t('fixes.changed') : t('fixes.stillOpen')}
            </p>
          </div>
        )
      })}

      {stillOpen > 0 && (
        <p className="fix-open">
          {t('fixes.stillOpenCount')}: {stillOpen} / {targets.length}
        </p>
      )}
    </section>
  )
}
