import { useState } from 'react'
import { setToken } from '../lib/auth.js'

export default function Login({ onLogin }) {
  const [value, setValue] = useState('')

  function submit(e) {
    e.preventDefault()
    if (!value.trim()) return
    setToken(value.trim())
    onLogin()
  }

  return (
    <form onSubmit={submit}>
      <label htmlFor="token">Bearer token</label>
      <input
        id="token"
        type="password"
        placeholder="Bearer token"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit">Sign in</button>
    </form>
  )
}
