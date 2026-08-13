import type { ReactNode } from 'react'
import type { Viewport } from 'next'
import './globals.css'

export const metadata = { title: 'Lounge Onboarding' }

/* viewport-fit=cover — иначе env(safe-area-inset-bottom) у закреплённой
 * нижней панели формы (.shell-foot) всегда равен нулю и кнопки на iPhone
 * ложатся под полосу home-индикатора. width/initial-scale не задаются:
 * Next выставляет их по умолчанию (см. generate-viewport.md в
 * node_modules/next/dist/docs). */
export const viewport: Viewport = { viewportFit: 'cover' }

export default function RootLayout(props: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body>{props.children}</body>
    </html>
  )
}
