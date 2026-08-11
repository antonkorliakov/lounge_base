'use client'

import { BLOCKS } from '@/form-schema'
import type { BlockState } from '@/review/blocks'
import { useLocale } from '@/i18n/context'

export type NavMark = 'confirmed' | 'flagged' | 'untouched'
export type NavItem = { blockKey: string; mark: NavMark }

/**
 * Замечание перевешивает подтверждение: если блок был подтверждён, а потом
 * в нём нашлась проблема, ревьюер должен видеть проблему, а не галочку.
 */
export function navState(progress: BlockState[]): NavItem[] {
  return progress.map((block) => ({
    blockKey: block.blockKey,
    mark:
      block.openFlagCount > 0 ? 'flagged'
      : block.confirmed ? 'confirmed'
      : 'untouched',
  }))
}

export function BlockNav(props: {
  progress: BlockState[]
  current: string
  onSelect: (blockKey: string) => void
}): React.JSX.Element {
  const { pick } = useLocale()
  const items = navState(props.progress)
  const labels = new Map(BLOCKS.map((b) => [b.key, b.label]))

  return (
    <nav className="block-nav">
      {items.map((item) => {
        const label = labels.get(item.blockKey)
        return (
          <button
            key={item.blockKey}
            type="button"
            className={`nav-item nav-${item.mark} ${item.blockKey === props.current ? 'nav-current' : ''}`}
            onClick={() => props.onSelect(item.blockKey)}
          >
            <span className={`nav-dot nav-dot-${item.mark}`} />
            {label ? pick(label) : item.blockKey}
          </button>
        )
      })}
    </nav>
  )
}
