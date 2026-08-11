'use client'

import { useState } from 'react'
import { requestLoginAction } from './actions'

export default function LoginPage(): React.JSX.Element {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)

  if (sent) {
    return <main className="login"><p>Check your inbox for the sign-in link.</p></main>
  }

  return (
    <main className="login">
      <h1>Lounge Onboarding</h1>
      <label htmlFor="email">Work email</label>
      <input
        id="email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button
        type="button"
        onClick={async () => {
          await requestLoginAction(email)
          setSent(true)
        }}
      >
        Send sign-in link
      </button>
    </main>
  )
}
