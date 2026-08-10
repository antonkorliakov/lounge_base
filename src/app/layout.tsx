import type { ReactNode } from 'react'
import './globals.css'

export const metadata = { title: 'Lounge Onboarding' }

export default function RootLayout(props: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body>{props.children}</body>
    </html>
  )
}
