'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { BLOCKS, blockOf, type Localized } from '@/form-schema'
import { UI } from '@/i18n/dictionaries'
import { useLocale } from '@/i18n/context'

export type StepKind = 'fields' | 'services1' | 'services2' | 'photos' | 'review'

export type Step = {
  key: string
  kind: StepKind
  /** Блоки схемы, которые рендерит этот шаг, в порядке показа: у шага полей
   *  их один или несколько (слитый шаг — см. MERGED_FIELD_GROUPS), у шага
   *  фото — ровно `['photos']`, у проходов услуг и итогового экрана — ни
   *  одного. Одноблочный шаг — просто список из одного элемента, а не
   *  отдельный случай. */
  blockKeys: string[]
}

/**
 * Слитые шаги — ПРЕЗЕНТАЦИЯ, не структура. Единица проверки остаётся блоком:
 * `block_reviews` в продовой БД ключуется по ключу блока, ревьюер
 * подтверждает поблочно, одобрение считает 27 подтверждений, замечания
 * раскладываются по `blockKeyOf` — ничего из этого слияние не трогает. Здесь
 * решается только, сколько экранов листает заполняющий: четыре контактных
 * блока — одна анкета «кто на связи», три блока правил — один экран правил,
 * шесть блоков про место — один экран про место.
 *
 * Список — буквальный перечень ключей блоков, в одном месте. Его полнота
 * закреплена тестом (`steps.test.ts`): каждый fields-блок из BLOCKS обязан
 * попасть ровно в один шаг, поэтому новый блок схемы ломает тест громко, и
 * автор сам решает, в какой шаг блок попадает, — а не тихо получает 28-й
 * экран или, хуже, блок без экрана.
 *
 * Имя слитого шага — своё (`form.step*` в словаре): подпись одного из блоков
 * не может называть экран, где этих блоков несколько. Подписи самих блоков
 * никуда не деваются — они стоят заголовками секций внутри шага (см.
 * рендер полей в `FillForm`), так что язык ревьюера («Children Policy» в
 * замечании) остаётся дословно виден и заполняющему.
 */
export const MERGED_FIELD_GROUPS: readonly {
  key: string
  title: Localized
  blocks: readonly string[]
}[] = [
  { key: 'contacts', title: UI['form.stepContacts'], blocks: ['II.1', 'II.2', 'II.3', 'II.4'] },
  { key: 'access', title: UI['form.stepAccess'], blocks: ['III.2', 'III.3', 'III.4'] },
  {
    key: 'location',
    title: UI['form.stepLocation'],
    blocks: ['III.5', 'III.6', 'III.7', 'III.8', 'IV', 'V'],
  },
]

/**
 * Порядок прохождения формы. Блоки полей идут в порядке BLOCKS, слитые
 * группы занимают место своего первого блока. Услуги идут двумя проходами:
 * сначала отбор всех 58 позиций одним списком, потом детали только по
 * отмеченным.
 */
export function buildSteps(): Step[] {
  const groupOfBlock = new Map<string, (typeof MERGED_FIELD_GROUPS)[number]>()
  for (const group of MERGED_FIELD_GROUPS) {
    for (const blockKey of group.blocks) groupOfBlock.set(blockKey, group)
  }

  const fieldSteps: Step[] = []
  const emitted = new Set<string>()
  for (const block of BLOCKS) {
    if (block.kind !== 'fields') continue
    const group = groupOfBlock.get(block.key)
    if (!group) {
      fieldSteps.push({ key: `fields:${block.key}`, kind: 'fields', blockKeys: [block.key] })
    } else if (!emitted.has(group.key)) {
      emitted.add(group.key)
      fieldSteps.push({ key: `fields:${group.key}`, kind: 'fields', blockKeys: [...group.blocks] })
    }
  }

  return [
    ...fieldSteps,
    { key: 'services:pass1', kind: 'services1', blockKeys: [] },
    { key: 'services:pass2', kind: 'services2', blockKeys: [] },
    { key: 'photos', kind: 'photos', blockKeys: ['photos'] },
    { key: 'review', kind: 'review', blockKeys: [] },
  ]
}

/**
 * Имя шага — для заголовка шелла и для навигатора, из ОДНОГО места, чтобы
 * пункт списка не мог называться иначе, чем экран, который он открывает.
 * Ни одной новой копии названий: шаг с ОДНИМ блоком берёт подпись самого
 * блока (как `.shell-title` делал и раньше), слитый шаг — своё имя из
 * MERGED_FIELD_GROUPS (тот же объект словаря, не копия текста), проходы по
 * услугам — те же ключи словаря, что их экраны использовали в собственных
 * <h2> (теперь снятых — см. `ServicesPass1`/`ServicesPass2`: заголовок
 * переехал сюда, а не удвоился). Итоговый шаг — `form.review`: у него имени
 * не было вовсе, а безымянным в списке из 9 пунктов быть нельзя никому.
 */
export function stepTitle(step: Step): Localized {
  const group = MERGED_FIELD_GROUPS.find((g) => step.key === `fields:${g.key}`)
  if (group) return group.title
  if (step.blockKeys.length === 1) {
    const block = blockOf(step.blockKeys[0]!)
    if (block) return block.label
  }
  if (step.kind === 'services1') return UI['services.pass1Title']
  if (step.kind === 'services2') return UI['services.pass2Title']
  return UI['form.review']
}

export function FormShell(props: {
  children: (step: Step) => ReactNode
  status: string
  /** Отправка на проверку — живёт у `FillForm` (единственного вызывающего),
   *  а рендерится здесь: главное действие последнего шага стоит в той же
   *  закреплённой панели, что и «Далее» на всех остальных, — одна панель,
   *  одно место для главного действия, а не кнопка, спрятанная в теле шага. */
  onSubmit: () => void
}): React.JSX.Element {
  const steps = buildSteps()
  const [index, setIndex] = useState(0)
  const [navOpen, setNavOpen] = useState(false)
  const navRef = useRef<HTMLDivElement>(null)
  const { t, pick, locale, setLocale } = useLocale()
  const step = steps[index]!

  /**
   * Единственный способ сменить шаг — и для Back/Next, и для навигатора.
   * Прыжок на произвольный шаг безопасен по устройству формы: автосохранение
   * принимает частичные ответы по одному ключу за раз, а полноту проверяет
   * только отправка (`submitSubmission` в src/submissions/transitions.ts) —
   * поэтому никакого гейтинга шагов здесь нет намеренно.
   *
   * `scrollTo(0, 0)`: с закреплённой нижней панелью «Далее» нажимается из
   * любой точки длинного шага (58 строк первого прохода), и без сброса
   * прокрутки следующий шаг открывался бы с середины — как будто его начало
   * потерялось.
   */
  function goTo(next: number): void {
    setIndex(Math.min(steps.length - 1, Math.max(0, next)))
    setNavOpen(false)
    window.scrollTo(0, 0)
  }

  // Панель шагов закрывается по клику мимо неё и по Escape — как любой
  // раскрывающийся список. Слушатели висят только пока она открыта.
  useEffect(() => {
    if (!navOpen) return
    function onPointerDown(event: PointerEvent): void {
      if (!navRef.current) return
      if (event.target instanceof Node && navRef.current.contains(event.target)) return
      setNavOpen(false)
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setNavOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [navOpen])

  return (
    <div className="shell">
      <header className="shell-top">
        <div className="shell-top-row">
          <span className="shell-progress">
            {index + 1} / {steps.length}
          </span>
          <span className="shell-status">{props.status}</span>
          <button
            type="button"
            className="shell-locale"
            onClick={() => setLocale(locale === 'en' ? 'ru' : 'en')}
          >
            {locale === 'en' ? 'RU' : 'EN'}
          </button>
        </div>
        {/* Ход по форме — 9 сегментов вместо сплошной полосы, чтобы полоса
            читалась как шаги, а не как процент. По-прежнему aria-hidden и
            НЕ кликается: сегмент 34×4px не может быть честной тап-целью
            (44px-правило этого файла стилей); интерактивный путь к шагам —
            список под заголовком, он и озвучивается. */}
        <div className="shell-bar" aria-hidden="true">
          {steps.map((s, i) => (
            <div key={s.key} className={i <= index ? 'shell-seg shell-seg-done' : 'shell-seg'} />
          ))}
        </div>
        {/* Заголовок шага и навигатор — одно целое, намеренно: `.shell-title`
            уже называл текущий шаг, так что кнопка «открыть список шагов» с
            собственным названием рядом с ним удвоила бы имя шага. Кнопка
            живёт ВНУТРИ h1 — роль заголовка и его accessible name (имя шага,
            шеврон скрыт от имени) сохраняются, на них стоят e2e-проверки.
            Раньше заголовок был только у шагов с блоком схемы; теперь имя
            есть у каждого (см. stepTitle) — навигатору безымянные шаги не
            позволены, и проходы по услугам отдали сюда свои <h2>. */}
        <div className="shell-nav" ref={navRef}>
          <h1 className="shell-title">
            <button
              type="button"
              className="shell-title-btn"
              aria-expanded={navOpen}
              onClick={() => setNavOpen((open) => !open)}
            >
              {pick(stepTitle(step))}
              <span className="shell-title-chevron" aria-hidden="true">
                {navOpen ? '▴' : '▾'}
              </span>
            </button>
          </h1>
          {navOpen && (
            <nav className="shell-steps" aria-label={t('form.steps')}>
              <ol>
                {steps.map((s, i) => (
                  <li key={s.key}>
                    <button
                      type="button"
                      className={i === index ? 'shell-step shell-step-here' : 'shell-step'}
                      aria-current={i === index ? 'step' : undefined}
                      // Панель может быть длиннее своего окна прокрутки
                      // (9 × 44px на коротком вьюпорте); при открытии текущий
                      // шаг должен быть в кадре, иначе с последних шагов
                      // список выглядит открытым «не там».
                      ref={i === index ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                      onClick={() => goTo(i)}
                    >
                      <span className="shell-step-num">{i + 1}</span>
                      {pick(stepTitle(s))}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
          )}
        </div>
      </header>

      <main className="shell-body">{props.children(step)}</main>

      <footer className="shell-foot">
        <button type="button" disabled={index === 0} onClick={() => goTo(index - 1)}>
          {/* Pass 2's item list is built from pass 1's answers, so the one
              place "Back" needs a more specific label than the generic
              form.back is the step right after pass 1 — that is exactly
              what services.backToPass1 names. */}
          {step.kind === 'services2' ? t('services.backToPass1') : t('form.back')}
        </button>
        {/* Главное действие шага — одна кнопка справа, с акцентной заливкой:
            на всех шагах это «Далее», на итоговом — сама отправка (раньше она
            лежала в теле шага, а «Далее» стоял рядом выключенным — две кнопки
            там, где действие одно). */}
        {step.kind === 'review' ? (
          <button type="button" className="shell-primary" onClick={props.onSubmit}>
            {t('form.submit')}
          </button>
        ) : (
          <button type="button" className="shell-primary" onClick={() => goTo(index + 1)}>
            {t('form.next')}
          </button>
        )}
      </footer>
    </div>
  )
}
