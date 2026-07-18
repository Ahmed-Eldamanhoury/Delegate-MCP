import { Link } from 'react-router-dom'
import { clearToken } from '../lib/auth.js'

const LINKS = [
  { to: '/overview', label: 'Overview' },
  { to: '/jobs', label: 'Jobs' },
  { to: '/submit', label: 'Submit' },
  { to: '/metrics', label: 'Metrics' },
  { to: '/models', label: 'Models' },
]

export default function NavBar() {
  function handleSignOut() {
    clearToken()
    window.dispatchEvent(new CustomEvent('delegate:unauthorized'))
  }

  return (
    <nav aria-label="Main navigation">
      <ul>
        {LINKS.map(({ to, label }) => (
          <li key={to}><Link to={to}>{label}</Link></li>
        ))}
      </ul>
      <button type="button" onClick={handleSignOut} aria-label="Sign out">Sign Out</button>
    </nav>
  )
}
