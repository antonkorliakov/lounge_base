'use client'

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { Localized } from '@/form-schema'
import { UI, type Locale, type UiKey } from './dictionaries'

type LocaleContextValue = {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: UiKey) => string
  pick: (value: Localized) => string
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function LocaleProvider(props: {
  initial?: Locale
  children: ReactNode
}): React.JSX.Element {
  const [locale, setLocale] = useState<Locale>(props.initial ?? 'en')

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key) => UI[key][locale],
      pick: (localized) => localized[locale],
    }),
    [locale],
  )

  return <LocaleContext.Provider value={value}>{props.children}</LocaleContext.Provider>
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext)
  if (!value) throw new Error('useLocale вне LocaleProvider')
  return value
}
