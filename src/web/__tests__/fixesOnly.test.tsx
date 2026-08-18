import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  BLOCKS,
  FIELDS,
  OPTION_LISTS,
  PHOTO_SLOTS,
  SERVICE_ITEMS,
  isBinaryAvailability,
  keysOfBlock,
  serviceItemByKey,
} from '@/form-schema'
import { isFlaggableKey } from '@/review/flags'
import { LocaleProvider } from '@/i18n/context'
import { UI, FLAG_REASON_LABELS } from '@/i18n/dictionaries'
import { FixesOnly, fixTargetFor, type Flag } from '../FixesOnly'
import type { ServiceValueInput } from '@/form-schema'

/**
 * THE invariant this file exists for: **every key the reviewer can flag has a
 * working control on the fixes screen.**
 *
 * It had none for 62 of 129 keys — all 58 service items and all 4 photo slots
 * — and that survived a task, a review round and a Critical-hunting pass
 * because nothing anywhere connected the FLAGGABLE set to the FIXABLE set.
 * `FixesOnly` rendered `{field && <FieldInput/>}`: a flagged service item
 * produced a card with the reviewer's comment and no input at all, and since
 * `submitSubmission` gates on completeness rather than on open flags, the
 * filler could resubmit unchanged forever. Nothing crashed and nothing looked
 * broken, which is why only reading the code found it.
 *
 * Two independent enumerations meet here on purpose:
 *  - `keysOfBlock` over every block (`src/form-schema/blocks.ts`'s registry) —
 *    literally what `ReviewScreen` maps over to place its flag buttons, so
 *    this is the reviewer's real reach, not a restatement of it.
 *  - `isFlaggableKey` (`src/review/flags.ts`'s own `FLAGGABLE` set) — what
 *    `raiseFlag` will actually accept.
 * Asserting the screen covers the first, and that the first and second agree,
 * pins the whole reviewer → filler correspondence rather than one half of it.
 *
 * The rendering is real (`renderToStaticMarkup`, the same technique
 * `src/i18n/__tests__/context.test.tsx` uses — Vitest runs in the `node`
 * environment here, there is no DOM), so this cannot pass by agreeing with a
 * lookup table that has itself drifted: it fails unless a real `<input>`,
 * `<select>` or `<textarea>` comes out of the real component tree.
 */

const REVIEWABLE_KEYS: string[] = BLOCKS.flatMap((block) => keysOfBlock(block.key))

// `button` joined the list when binary service items' availability became a
// Yes|No toggle-button pair (see `ServiceAvailabilityInput`): an unanswered
// binary item's card renders BUTTONS and nothing else — no input, select or
// textarea — and that is a working control, not a missing one. This does not
// weaken the unknown-key assertions below: `FixesOnly` renders no buttons of
// its own outside the controls, so an unmatched card still matches nothing.
const CONTROL_RE = /<(?:input|select|textarea|button)\b/

function flagFor(key: string): Flag {
  return { fieldKey: key, reason: null, comment: `please fix ${key}` }
}

function renderFixes(
  flags: Flag[],
  options: {
    fieldValues?: Record<string, unknown>
    services?: Record<string, ServiceValueInput>
    photos?: Record<string, string[]>
    touched?: ReadonlySet<string>
    fieldErrors?: Record<string, string>
    serviceErrors?: Record<string, string>
  } = {},
): string {
  return renderToStaticMarkup(
    <LocaleProvider initial="en">
      <FixesOnly
        flags={flags}
        fieldValues={options.fieldValues ?? {}}
        onFieldChange={() => {}}
        fieldErrors={options.fieldErrors}
        services={options.services ?? {}}
        onServiceChange={() => {}}
        serviceErrors={options.serviceErrors}
        token="test-token"
        photos={options.photos ?? {}}
        onPhotoUploaded={() => {}}
        onPhotoRemoved={() => {}}
        touched={options.touched ?? new Set()}
      />
    </LocaleProvider>,
  )
}

describe('каждый отмечаемый ключ имеет контрол на экране правок', () => {
  // Anti-vacuity, first: if `keysOfBlock` returned nothing (a renamed block
  // key, a registry that stopped being populated) every loop below would pass
  // without looking at anything. This is the same "passes because it never
  // actually looked" failure the lock-order guard's own sanity check exists
  // for, and the reason the count is spelled out from the three source arrays
  // rather than hardcoded as 129.
  it('перечисление ключей не пусто и покрывает все три категории', () => {
    expect(REVIEWABLE_KEYS.length).toBe(
      FIELDS.length + SERVICE_ITEMS.length + PHOTO_SLOTS.length,
    )
    expect(new Set(REVIEWABLE_KEYS).size).toBe(REVIEWABLE_KEYS.length)
    expect(FIELDS.length).toBeGreaterThan(0)
    expect(SERVICE_ITEMS.length).toBeGreaterThan(0)
    expect(PHOTO_SLOTS.length).toBeGreaterThan(0)
  })

  // The two sets could drift in either direction, and both directions are
  // bugs: a key the review screen offers but `raiseFlag` refuses gives the
  // reviewer a button that errors, and a key `raiseFlag` accepts but no block
  // lists is a flag the reviewer can never see again.
  it('всё, что показывает экран проверки, принимает raiseFlag — и наоборот', () => {
    const notFlaggable = REVIEWABLE_KEYS.filter((key) => !isFlaggableKey(key))
    expect(notFlaggable).toEqual([])

    const allSchemaKeys = [
      ...FIELDS.map((f) => f.key),
      ...SERVICE_ITEMS.map((i) => i.key),
      ...PHOTO_SLOTS.map((s) => s.key),
    ]
    const reviewable = new Set(REVIEWABLE_KEYS)
    const unreachable = allSchemaKeys.filter(
      (key) => isFlaggableKey(key) && !reviewable.has(key),
    )
    expect(unreachable).toEqual([])
  })

  it('у каждого из них экран правок рисует настоящий контрол', () => {
    const withoutControl: string[] = []
    const unmatched: string[] = []

    for (const key of REVIEWABLE_KEYS) {
      // One key per render, so a failure names the offending key instead of
      // reporting "somewhere in 129 cards there is no input".
      const html = renderFixes([flagFor(key)])
      if (html.includes('data-unmatched')) unmatched.push(key)
      if (!CONTROL_RE.test(html)) withoutControl.push(key)
    }

    expect(unmatched).toEqual([])
    expect(withoutControl).toEqual([])
  })

  // `fixTargetFor` must not quietly answer "field" for a photo slot: a control
  // is necessary but not sufficient, the control has to be the RIGHT one.
  it('ключ попадает в контрол своей категории, а не в чужой', () => {
    const kinds = REVIEWABLE_KEYS.map((key) => fixTargetFor(key).kind)
    const counted = {
      field: kinds.filter((k) => k === 'field').length,
      service: kinds.filter((k) => k === 'service').length,
      photo: kinds.filter((k) => k === 'photo').length,
      unknown: kinds.filter((k) => k === 'unknown').length,
    }
    expect(counted).toEqual({
      field: FIELDS.length,
      service: SERVICE_ITEMS.length,
      photo: PHOTO_SLOTS.length,
      unknown: 0,
    })
  })
})

describe('контрол отмеченной позиции услуг', () => {
  // '2.1' (Wifi Access) is a real `yesNo` item — the same key the e2e suite
  // and `offeredKeys`' unit tests use, so it stays a faithful stand-in.
  const WIFI = '2.1'

  it('позиция, на которую никогда не отвечали, всё равно получает контрол наличия', () => {
    // The reviewer's most common reason code is `empty`, so the flagged item
    // is usually the one with NO row in `service_values` and therefore no
    // entry in the `services` map at all. `ServicesPass2`'s old
    // `if (!value) return null` would have rendered nothing here. Wifi is a
    // binary (`yesNo`) item, so its control is the toggle-button pair — one
    // button per option of the item's OWN list, labelled by that list.
    const html = renderFixes([flagFor(WIFI)], { services: {} })
    expect(html).toContain(UI['services.available'].en)
    for (const option of OPTION_LISTS[serviceItemByKey(WIFI)!.availabilityList]) {
      expect(html, option.id).toContain(`>${option.label.en}</button>`)
    }
  })

  /**
   * The Important this control was rebuilt for (I2): as a checkbox,
   * `checked={value?.available === 'yes'}` drew "no" and "nothing said at
   * all" identically. On the fixes screen that is the whole response surface
   * for the flag — and "no" is the truthful correction for the most common
   * reason code (`empty`) — so the filler's only way to state it was to check
   * the box and uncheck it, with nothing on screen distinguishing the result
   * from having ignored the flag.
   *
   * The toggle pair must not regress to that: a stated "no" is a PRESSED No
   * button (`aria-pressed="true"` — the exact attribute assistive tech and
   * the stylesheet both key on), silence is a pair with NEITHER pressed.
   * Asserted on the rendered markup, i.e. what the filler sees, not what the
   * component was handed.
   */
  it('«нет» видно как сказанное «нет», а не как молчание', () => {
    const stated = renderFixes([flagFor(WIFI)], {
      services: {
        [WIFI]: {
          available: 'no', chargeType: null, price: null,
          currency: null, slotMinutes: null, bookingRequired: null, details: null,
        },
      },
    })
    expect(stated).toContain(`aria-pressed="true">${OPTION_LISTS.yesNo[1]!.label.en}</button>`)
    expect(stated).toContain(`aria-pressed="false">${OPTION_LISTS.yesNo[0]!.label.en}</button>`)

    const silent = renderFixes([flagFor(WIFI)], { services: {} })
    expect(silent).not.toContain('aria-pressed="true"')
    expect(silent).toContain(`aria-pressed="false">${OPTION_LISTS.yesNo[0]!.label.en}</button>`)
    expect(silent).toContain(`aria-pressed="false">${OPTION_LISTS.yesNo[1]!.label.en}</button>`)
    // И это два РАЗНЫХ экрана, а не одна и та же разметка: ровно то, чего
    // чекбокс дать не мог.
    expect(stated).not.toBe(silent)
  })

  it('у предлагаемой позиции открыт весь набор атрибутов, а не только наличие', () => {
    const html = renderFixes([flagFor(WIFI)], {
      services: {
        [WIFI]: {
          available: 'yes', chargeType: null, price: null,
          currency: null, slotMinutes: null, bookingRequired: null, details: null,
        },
      },
    })
    expect(html).toContain(UI['services.charge'].en)
    expect(html).toContain(UI['services.slot'].en)
    expect(html).toContain(UI['services.booking'].en)
    expect(html).toContain(UI['services.details'].en)
  })

  it('«платно» открывает цену и валюту — то же правило, что на основной форме', () => {
    const html = renderFixes([flagFor(WIFI)], {
      services: {
        [WIFI]: {
          available: 'yes', chargeType: 'chargeable', price: null,
          currency: null, slotMinutes: null, bookingRequired: null, details: null,
        },
      },
    })
    expect(html).toContain(UI['services.price'].en)
    expect(html).toContain(UI['services.currency'].en)
  })

  it('закрытая позиция («нет») не спрашивает детали — как и на основной форме', () => {
    const html = renderFixes([flagFor(WIFI)], {
      services: {
        [WIFI]: {
          available: 'no', chargeType: null, price: null,
          currency: null, slotMinutes: null, bookingRequired: null, details: null,
        },
      },
    })
    expect(html).not.toContain(UI['services.charge'].en)
    // Наличие остаётся: именно его и правят, если ревьюер спорит с «нет».
    expect(html).toContain(UI['services.available'].en)
  })

  /**
   * Каждый список наличия, который вообще встречается в схеме, а не только
   * `yesNo`: 57 позиций из 58 бинарные, и позицию со своим списком (`8.3`,
   * Vaping policy) легко не заметить глазами ни на одном экране. Перечисление
   * идёт от самих позиций, так что третий список, добавленный в схему,
   * попадёт сюда сам.
   *
   * Какого вида контрол ожидается — решает `isBinaryAvailability`, тот же
   * предикат схемы, по которому `ServiceAvailabilityInput` выбирает
   * отрисовку (пара кнопок против дропдауна), а не список имён рядом с ним:
   * этот предикат читает СОДЕРЖИМОЕ списка (ровно два варианта), так что
   * новый двухвариантный список получит пару кнопок и здесь, и на экране —
   * согласованно. В обеих ветках проверяется, что на экран пришёл ВЕСЬ
   * список: у пары — обе подписи как кнопки с aria-pressed, у дропдауна —
   * каждый вариант как <option> плюс пустой «—».
   */
  it('каждый список наличия из схемы приходит на экран целиком — своим контролом', () => {
    const lists = [...new Set(SERVICE_ITEMS.map((item) => item.availabilityList))]
    expect(lists.length).toBeGreaterThan(1)

    for (const list of lists) {
      const item = SERVICE_ITEMS.find((i) => i.availabilityList === list)!
      const html = renderFixes([flagFor(item.key)])
      expect(html, list).toContain(UI['services.available'].en)
      if (isBinaryAvailability(item)) {
        for (const option of OPTION_LISTS[list]) {
          expect(html, `${list}/${option.id}`).toContain(
            `aria-pressed="false">${option.label.en}</button>`,
          )
        }
        // Никакого дропдауна у неотвеченной бинарной позиции: единственный
        // <select> в её карточке был бы контролом наличия, а он теперь пара.
        expect(html, list).not.toContain('<select')
      } else {
        expect(html, list).toContain('<select')
        // `selected=""` — потому что позиция не отвечена и select стоит на
        // `—`; проверяется просто наличие пустого варианта.
        expect(html, list).toContain('<option value=""')
        for (const option of OPTION_LISTS[list]) {
          expect(html, `${list}/${option.id}`).toContain(`value="${option.id}"`)
        }
      }
    }
  })

  it('показывает подсказку позиции из схемы, а не свою копию', () => {
    const hinted = SERVICE_ITEMS.find((item) => item.hint !== null)
    expect(hinted, 'в схеме нет ни одной позиции с hint — тест потерял смысл').toBeDefined()
    const html = renderFixes([flagFor(hinted!.key)], {
      services: {
        [hinted!.key]: {
          available: 'yes', chargeType: null, price: null,
          currency: null, slotMinutes: null, bookingRequired: null, details: null,
        },
      },
    })
    expect(html).toContain(hinted!.hint!.en)
  })
})

/**
 * Отмеченный multi_select (сегодня одно поле — III.6.6, зоны; перечисление
 * идёт от `FIELDS`, так что второе такое поле попадёт сюда само) приходит на
 * экран правок ЧИПАМИ — теми же кнопками с `aria-pressed`, что и на основной
 * форме: `FixesOnly` рендерит тот же `FieldInput`, отдельной ветки у него
 * нет, и этот describe пришпиливает, что так и осталось.
 */
describe('контрол отмеченного multi_select поля — чипы', () => {
  const multiFields = FIELDS.filter((f) => f.type === 'multi_select')

  it('в схеме есть multi_select-поля (иначе проверки ниже пусты)', () => {
    expect(multiFields.length).toBeGreaterThan(0)
  })

  it('каждый вариант списка — кнопка-чип, чекбоксов больше нет', () => {
    for (const field of multiFields) {
      const html = renderFixes([flagFor(field.key)])
      for (const option of OPTION_LISTS[field.optionList!]) {
        expect(html, `${field.key}/${option.id}`).toContain(
          `aria-pressed="false">${option.label.en}</button>`,
        )
      }
      expect(html, field.key).not.toContain('type="checkbox"')
    }
  })

  it('членство видно как нажатость: выбранный вариант нажат, остальные нет', () => {
    for (const field of multiFields) {
      const [first, ...rest] = OPTION_LISTS[field.optionList!]
      const html = renderFixes([flagFor(field.key)], {
        fieldValues: { [field.key]: [first!.id] },
      })
      expect(html, field.key).toContain(`aria-pressed="true">${first!.label.en}</button>`)
      for (const option of rest) {
        expect(html, `${field.key}/${option.id}`).toContain(
          `aria-pressed="false">${option.label.en}</button>`,
        )
      }
    }
  })

  // Тот же инвариант, что у строк первого прохода (`servicesPass1.test.tsx`,
  // ловушка b): <label> переадресует активацию первому labelable-потомку, а
  // <button> — labelable, значит НИ ОДНА кнопка не должна оказаться внутри
  // label — иначе клик по заголовку поля нажимал бы первый чип. Поэтому
  // заголовок multi_select в `FieldInput` — <span>, не общий <label htmlFor>.
  it('ни одна кнопка-чип не внутри label, и заголовок поля — не label', () => {
    for (const field of multiFields) {
      const html = renderFixes([flagFor(field.key)])
      for (const chunk of html.split('<label').slice(1)) {
        const inside = chunk.slice(0, chunk.indexOf('</label>'))
        expect(inside, field.key).not.toContain('<button')
      }
      expect(html, field.key).toContain(`class="field-label">${field.label.en}<`)
      expect(html, field.key).not.toContain(`<label class="field-label" for="${field.key}"`)
    }
  })
})

describe('контрол отмеченного слота фото', () => {
  it('рисует загрузку именно этого слота и не тянет остальные три', () => {
    const html = renderFixes([flagFor('entrance')])
    expect(html).toContain('type="file"')

    const entrance = PHOTO_SLOTS.find((s) => s.key === 'entrance')!
    expect(html).toContain(entrance.label.en)
    for (const other of PHOTO_SLOTS.filter((s) => s.key !== 'entrance')) {
      expect(html, other.key).not.toContain(other.label.en)
    }
  })

  it('показывает, что в слоте лежит сейчас, и предлагает замену', () => {
    const html = renderFixes([flagFor('entrance')], {
      photos: { entrance: ['https://example.test/entrance.jpg'] },
    })
    expect(html).toContain('https://example.test/entrance.jpg')
    // «Заменить», а не «Загрузить»: именованный слот держит один снимок, и
    // `attachPhoto` действительно заменяет его на сервере.
    expect(html).toContain(UI['photos.replace'].en)
    expect(html).not.toContain(UI['photos.upload'].en)
    // И убрать снимок у именованного слота нельзя: замена и есть ответ на
    // замечание, а удаление обязательного снимка только сделало бы анкету
    // неполной.
    expect(html).not.toContain(UI['photos.remove'].en)
  })

  /**
   * Накопительный слот. Подпись выбиралась по «есть ли уже снимки», так что
   * непустой `additional` читался как «Заменить» — но `attachPhoto` пропускает
   * DELETE для `slot.extra`, а `FillForm.photoUploaded` дописывает в конец, то
   * есть нажатие ДОБАВЛЯЛО четвёртый снимок и оставляло тот, который ревьюер
   * назвал непригодным. Слот достижим: `keysOfBlock('photos')` включает
   * `additional`, и замечание по нему поставить можно.
   *
   * Проверяется на слоте, взятом из схемы по `extra`, а не по имени
   * `'additional'`: правило — «накопительный слот», а не «слот с таким
   * ключом».
   */
  describe('накопительный слот', () => {
    const extra = PHOTO_SLOTS.find((slot) => slot.extra)!
    const named = PHOTO_SLOTS.find((slot) => !slot.extra)!

    it('в схеме есть и накопительный слот, и именованный', () => {
      expect(extra, 'нет ни одного extra-слота — проверки ниже пусты').toBeDefined()
      expect(named, 'нет ни одного именованного слота').toBeDefined()
    })

    it('подпись говорит «добавить», а не «заменить» — потому что добавляет', () => {
      const html = renderFixes([flagFor(extra.key)], {
        photos: { [extra.key]: ['https://example.test/a1.jpg'] },
      })
      expect(html).toContain(UI['photos.add'].en)
      expect(html).not.toContain(UI['photos.replace'].en)
    })

    it('и с пустым слотом подпись та же: пустота ничего не меняет в поведении', () => {
      const html = renderFixes([flagFor(extra.key)], { photos: {} })
      expect(html).toContain(UI['photos.add'].en)
      expect(html).not.toContain(UI['photos.replace'].en)
    })

    // Без этой кнопки у замечания по накопительному слоту не было ПРАВДИВОГО
    // ответа: четвёртый снимок не убирает непригодный третий.
    it('каждый снимок можно убрать — по кнопке на снимок', () => {
      const html = renderFixes([flagFor(extra.key)], {
        photos: { [extra.key]: ['https://example.test/a1.jpg', 'https://example.test/a2.jpg'] },
      })
      const buttons = html.match(/class="photo-remove"/g) ?? []
      expect(buttons).toHaveLength(2)
      // Нумерация в доступном имени: три кнопки «Убрать» подряд иначе
      // неразличимы для скринридера (тот же довод, что у `FieldRow`).
      expect(html).toContain(`${UI['photos.remove'].en}: ${extra.label.en} 1`)
      expect(html).toContain(`${UI['photos.remove'].en}: ${extra.label.en} 2`)
    })
  })
})

/**
 * Замечание из одной причины (комментарий '') — с тех пор как `raiseFlag`
 * принимает причину без текста, это обычная карточка, а не вырожденный
 * случай: код причины показан жирным, и никакого пустого красного абзаца
 * после него не остаётся (комментарий и код живут в ОДНОМ `<p
 * class="fix-comment">`, так что пустой текст ничего не добавляет).
 */
describe('замечание без комментария — только причина', () => {
  it('карточка показывает код причины и не рисует пустой абзац', () => {
    const key = FIELDS[0]!.key
    const html = renderFixes([{ fieldKey: key, reason: 'empty', comment: '' }])
    expect(html).toContain(`<b>${FLAG_REASON_LABELS.empty.en}</b>`)
    expect(html).not.toContain('<p class="fix-comment"></p>')
    // И контрол на месте — карточка остаётся действенной, а не только читаемой.
    expect(CONTROL_RE.test(html)).toBe(true)
  })
})

describe('ключ, которому ничего не соответствует', () => {
  // The point of the whole task: an unmatched key must be LOUD. Silence is
  // what hid the defect — `{field && …}` rendered a comment and nothing else,
  // which looks like a screen that works.
  it('рисует видимую ошибку, а не пустую карточку', () => {
    const html = renderFixes([flagFor('no.such.key')])
    expect(html).toContain('data-unmatched="no.such.key"')
    expect(html).toContain(UI['fixes.noControl'].en)
    expect(html).toContain('fix-unmatched')
  })

  it('не выдаёт себя за поле и не молчит', () => {
    expect(fixTargetFor('no.such.key')).toEqual({ kind: 'unknown' })
    const html = renderFixes([flagFor('no.such.key')])
    expect(CONTROL_RE.test(html)).toBe(false)
  })
})

describe('какие карточки заполняющий уже правил', () => {
  const FIRST_FIELD = FIELDS[0]!.key

  it('нетронутая карточка помечена как ещё не изменённая, и есть общий счёт', () => {
    const html = renderFixes([flagFor(FIRST_FIELD), flagFor('entrance')])
    expect(html).toContain(UI['fixes.stillOpen'].en)
    expect(html).toContain(`${UI['fixes.stillOpenCount'].en}: 2 / 2`)
  })

  it('изменённая карточка помечена как изменённая и уходит из счёта', () => {
    const html = renderFixes([flagFor(FIRST_FIELD), flagFor('entrance')], {
      touched: new Set([FIRST_FIELD]),
    })
    expect(html).toContain(UI['fixes.changed'].en)
    expect(html).toContain(`${UI['fixes.stillOpenCount'].en}: 1 / 2`)
  })

  // Отказ сервера означает, что сохранения не было, значит и замечание не
  // снято — «изменено» здесь было бы прямой ложью в ту сторону, из-за которой
  // заполняющий отправил бы анкету, считая правку принятой.
  it('отклонённое сохранение не считается изменением', () => {
    const html = renderFixes([flagFor(FIRST_FIELD)], {
      touched: new Set([FIRST_FIELD]),
      fieldErrors: { [FIRST_FIELD]: 'This field is required' },
    })
    expect(html).toContain(UI['fixes.stillOpen'].en)
    expect(html).not.toContain(UI['fixes.changed'].en)
  })

  it('то же для позиции услуг', () => {
    const key = serviceItemByKey('2.1')!.key
    const html = renderFixes([flagFor(key)], {
      touched: new Set([key]),
      serviceErrors: { [key]: 'Price is required for a chargeable service' },
    })
    expect(html).toContain(UI['fixes.stillOpen'].en)
    expect(html).not.toContain(UI['fixes.changed'].en)
  })
})
