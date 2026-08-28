'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  FIELDS,
  SERVICE_ITEMS,
  fieldByKey,
  photoSlotByKey,
  serviceItemByKey,
  type Field,
  type PhotoSlot,
  type ServiceItem,
  type ServiceValueInput,
} from '@/form-schema'
import { useLocale } from '@/i18n/context'
import { FLAG_REASON_LABELS } from '@/i18n/dictionaries'
import type { FlagReason } from '@/review/flags'
// Листовой `registry/identity`, не `manage`: клиентскому бандлу нельзя тащить
// drizzle и схему БД — см. довод в самом модуле.
import { DERIVED_FIELD_KEYS, IATA_FIELD_KEY } from '@/registry/identity'
import type { AirportSearchResult, DirectoryRow } from '@/registry/directory'
import { FieldInput } from './FieldInput'
import { IataCorrection } from './IataCorrection'
import { ServiceItemCard } from './ServiceItemCard'
import { PhotoSlots } from './PhotoSlots'

/**
 * `reason` — то же поле, что и у `FlagRow` (`src/review/flags.ts`), с тем же
 * сузенным типом, а не `string | null`: строка приняла бы код, которого нет в
 * `FLAG_REASONS`, и подпись к нему молча не нашлась бы. Сужение делает
 * `toFlagReason` — единственное место, где строка из базы становится кодом, —
 * и `src/app/f/[token]/page.tsx` получает эти строки через `openFlags`, чтобы
 * сторона заполнения и сторона проверки читали одни и те же строки одинаково.
 * Оба импорта здесь — только типы плюс чистый словарь, слой БД в клиентский
 * бандл не попадает.
 */
export type Flag = { fieldKey: string; reason: FlagReason | null; comment: string }

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
  /** Поиск по справочнику для контрола исправления кода IATA — токен-скоупное
   *  действие стороны заполнения, пробрасывается из `FillForm` (см. его
   *  `searchAirports`). */
  searchAirports: (query: string) => Promise<AirportSearchResult>
  /** Выбор аэропорта из справочника — ЕДИНСТВЕННЫЙ путь правки I.10 и
   *  производной тройки I.7–I.9 на этом экране: `FillForm.pickAirport` пишет
   *  код через серверные ворота и обновляет всю четвёрку в состоянии. */
  onAirportPick: (row: DirectoryRow) => void
  /**
   * Ключи, чью последнюю правку внесла КОМАНДА во время проверки, — контрол
   * карточки несёт значок «исправлено командой» (`answer.teamEdited`).
   * Обычный случай на этом экране: команда исправила ответ сама и тут же
   * отметила его заново («проверьте — мы поправили»), так что карточка
   * показывает и замечание, и чьё значение сейчас в поле.
   *
   * Ключ из этого набора БЕЗ открытого замечания получает СВОЮ карточку — в
   * группе «команда исправила эти ответы» ниже отмеченных. До этой группы
   * такие правки были невидимы оператору в принципе: `editAnswerDuringReview`
   * снимает замечание правленого ключа, `requestChanges` требует хотя бы
   * одного ДРУГОГО открытого, а этот экран — единственный, который оператор
   * получает после возврата, — рисовал по карточке только на открытое
   * замечание. Ответы, которые команда переписала, не имели ни карточки, ни
   * значка, ни значения — под вступлением, утверждавшим «остальное принято».
   * Карточка группы РАБОЧАЯ, не read-only (см. `teamCorrectedControl`).
   */
  teamEdited?: ReadonlySet<string>
}): React.JSX.Element {
  const { t, pick } = useLocale()

  const targets = useMemo(
    () => props.flags.map((flag) => ({ flag, target: fixTargetFor(flag.fieldKey) })),
    [props.flags],
  )

  /**
   * Группа «команда исправила эти ответы»: teamEdited-ключи БЕЗ открытого
   * замечания (у отмеченных карточка уже есть — выше, с тем же значком).
   *
   * Состав ЗАМОРОЖЕН на монтировании (`useState`-инициализатор), а не выводится
   * из живого `props.teamEdited`: правка оператора оптимистично снимает ключ
   * из набора (`clearTeamEdited` в `FillForm`) — живая группа размонтировала
   * бы карточку ПОД ПЕРВЫМ ЖЕ нажатием клавиши, унося редактор из-под рук.
   * Значок внутри карточки при этом читает живой набор и гаснет сразу — сама
   * карточка остаётся, с отметкой «Изменено» (те же слова, что у отмеченных).
   * Порядок — порядок схемы (поля, затем позиции), как их читает человек, а
   * не порядок строк выборки.
   */
  const [teamCorrected] = useState<{ key: string; target: FixTarget }[]>(() => {
    const flagged = new Set(props.flags.map((flag) => flag.fieldKey))
    const schemaOrder = [
      ...FIELDS.map((field) => field.key),
      ...SERVICE_ITEMS.map((item) => item.key),
    ]
    return schemaOrder
      .filter((key) => (props.teamEdited?.has(key) ?? false) && !flagged.has(key))
      .map((key) => ({ key, target: fixTargetFor(key) }))
  })

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
    if (target.kind === 'field') {
      // Четвёрка паспорта пишется ТОЛЬКО через код: отказ последней записи
      // живёт под ключом I.10, и карточка отмеченного I.7 обязана видеть его
      // тоже — иначе «Изменено» появилось бы на карточке, чью правку сервер
      // отверг.
      if (key === IATA_FIELD_KEY || DERIVED_FIELD_KEYS.includes(key)) {
        return props.fieldErrors?.[IATA_FIELD_KEY] ?? props.fieldErrors?.[key]
      }
      return props.fieldErrors?.[key]
    }
    if (target.kind === 'service') return props.serviceErrors?.[key]
    return undefined
  }

  function control(key: string, target: FixTarget): React.JSX.Element {
    const teamEdited = props.teamEdited?.has(key) ?? false
    switch (target.kind) {
      case 'field':
        // Код IATA: правится ВЫБОРОМ из справочника (`IataCorrection`), не
        // свободным вводом, — тот же контракт, что в основном проходе:
        // сервер (`saveOperatorField`) принимает только код из справочника
        // и одной транзакцией переписывает производную тройку.
        if (key === IATA_FIELD_KEY) {
          return (
            <IataCorrection
              field={target.field}
              value={props.fieldValues[key]}
              onPick={props.onAirportPick}
              search={props.searchAirports}
              error={props.fieldErrors?.[IATA_FIELD_KEY]}
              teamEdited={teamEdited}
            />
          )
        }
        // Производное поле (I.7–I.9): его значение показывается только для
        // чтения, а РАБОЧИЙ контрол карточки — исправление КОДА в ней же:
        // страна/город/аэропорт выводятся из кода, и ответ на замечание
        // «не та страна» — правильный код, после которого сервер снимает
        // замечания всей четвёрки (`savedKeys` в `saveOperatorField`).
        // Тупика нет: карточка отвечаема, просто её ручка — код.
        if (DERIVED_FIELD_KEYS.includes(key)) {
          const iataField = fieldByKey(IATA_FIELD_KEY)
          return (
            <>
              <FieldInput
                field={target.field}
                value={props.fieldValues[key]}
                onChange={() => {}}
                locked
                lockedNote={t('form.derivedFromCode')}
                teamEdited={teamEdited}
              />
              {iataField && (
                <IataCorrection
                  field={iataField}
                  value={props.fieldValues[IATA_FIELD_KEY]}
                  onPick={props.onAirportPick}
                  search={props.searchAirports}
                  error={props.fieldErrors?.[IATA_FIELD_KEY]}
                  // Значок у контрола кода — про сам I.10 (четвёрку команда
                  // правит только через него), а не про отмеченный I.7 карточки.
                  teamEdited={props.teamEdited?.has(IATA_FIELD_KEY) ?? false}
                />
              )}
            </>
          )
        }
        return (
          <FieldInput
            field={target.field}
            value={props.fieldValues[key]}
            onChange={(value) => props.onFieldChange(key, value)}
            error={props.fieldErrors?.[key]}
            teamEdited={teamEdited}
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
            value={props.services[key]}
            onChange={(value) => props.onServiceChange(key, value)}
            error={props.serviceErrors?.[key]}
            withAvailability
            teamEdited={teamEdited}
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
          <p className="fix-unmatched" data-unmatched={key}>
            {t('fixes.noControl')} <code>{key}</code>
          </p>
        )
    }
  }

  /**
   * Контрол карточки группы «команда исправила эти ответы» — те же контролы,
   * что у отмеченных карточек (`control` выше), с одним отличием: производная
   * тройка здесь read-only БЕЗ комбобокса кода. Провенанс четвёрки ставится
   * всегда целиком (`editAnswerDuringReview` пишет все четыре ключа), так что
   * рядом в этой же группе — или выше, среди отмеченных, — уже стоит карточка
   * самого I.10 с настоящим контролом; три копии комбобокса были бы шумом.
   * Карточка РАБОЧАЯ по решению задачи: ответ принадлежит оператору, окно —
   * его (`changes_requested`), сервер принимает его запись любого ключа, и
   * несогласие с правкой команды — или правка команды, оставившая позицию
   * незаполненной («yes» без типа оплаты), — исправимы здесь же. Read-only
   * группа оставляла бы структурный тупик: отказ отправки называет
   * незаполненную позицию, а контрола для неё не было бы нигде.
   */
  function teamCorrectedControl(key: string, target: FixTarget): React.JSX.Element {
    if (target.kind === 'field' && DERIVED_FIELD_KEYS.includes(key)) {
      return (
        <FieldInput
          field={target.field}
          value={props.fieldValues[key]}
          onChange={() => {}}
          locked
          lockedNote={t('form.derivedFromCode')}
          teamEdited={props.teamEdited?.has(key) ?? false}
        />
      )
    }
    // Фото и неизвестные ключи в teamEdited не бывают по построению
    // (`loadSubmissionValues` читает только field_values/service_values, а
    // правка фото командой отказана сервером); если ключ всё же не
    // разрешился — `control` покажет ту же честную «нет контрола», что и у
    // отмеченных.
    return control(key, target)
  }

  const changedCount = targets.filter(
    ({ flag, target }) =>
      props.touched.has(flag.fieldKey) && !errorFor(flag.fieldKey, target),
  ).length
  const stillOpen = targets.length - changedCount

  return (
    <section className="fixes">
      <h2>{t('fixes.title')}</h2>
      {/* «Остальное принято» — правда только пока команда ничего не правила
          мимо замечаний; иначе вступление честно называет группу ниже (тем же
          условием оговорку несёт письмо — `changesRequestedMail`). */}
      <p className="subtitle">
        {t(teamCorrected.length > 0 ? 'fixes.introTeamEdited' : 'fixes.intro')}
      </p>

      {targets.map(({ flag, target }) => {
        const changed = props.touched.has(flag.fieldKey) && !errorFor(flag.fieldKey, target)
        return (
          <div key={flag.fieldKey} className="fix-card">
            {/* Код замечания — над текстом, а не вместо него: это
                классификация в одно слово («неверный формат», «нужна
                расшифровка»), и она отвечает на вопрос «что от меня хотят»
                до чтения прозы. Пока её не показывали, выбор ревьюера из
                четырёх кодов доезжал до заполняющего и пропадал, а разница
                между ними для него как раз практическая: «не заполнено» —
                ответить, «неверный формат» — переписать то же самое иначе,
                «противоречит другому полю» — идти сверять ДРУГОЙ ответ, а не
                править этот, «нужна расшифровка» — добавить к ответу деталей.
                Комментарий ревьюера остаётся ниже как конкретика; в нём этой
                разницы может не быть вообще (комментарий бывает в два слова, а
                у 129 карточек его ещё и надо прочесть все).
                `<b>` внутри `.fix-comment` — та же разметка, что у
                `.frow-comment` на экране проверки, так что ревьюер и
                заполняющий видят один и тот же код в одном и том же месте
                карточки. `reason` необязателен: `raiseFlag` принимает
                замечание и без кода. */}
            <p className="fix-comment">
              {flag.reason !== null && <b>{pick(FLAG_REASON_LABELS[flag.reason])}</b>}
              {flag.comment}
            </p>
            {control(flag.fieldKey, target)}
            <p className={changed ? 'fix-changed' : 'fix-open'}>
              {changed ? t('fixes.changed') : t('fixes.stillOpen')}
            </p>
          </div>
        )
      })}

      {teamCorrected.length > 0 && (
        <>
          <h3 className="fixes-team-title">{t('fixes.teamCorrectedTitle')}</h3>
          <p className="subtitle">{t('fixes.teamCorrectedHint')}</p>
          {teamCorrected.map(({ key, target }) => {
            const changed = props.touched.has(key) && !errorFor(key, target)
            return (
              <div key={key} className="fix-card fix-card-team">
                {teamCorrectedControl(key, target)}
                {/* «Изменено» — теми же словами, что у отмеченных карточек;
                    немой карточки достаточно в исходном состоянии: менять её
                    не требуется, это предложение, а не долг. */}
                {changed && <p className="fix-changed">{t('fixes.changed')}</p>}
              </div>
            )
          })}
        </>
      )}

      {stillOpen > 0 && (
        <p className="fix-open">
          {t('fixes.stillOpenCount')}: {stillOpen} / {targets.length}
        </p>
      )}
    </section>
  )
}
