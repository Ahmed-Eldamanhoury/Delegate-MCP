import { useState, useEffect } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { getToken as authGetToken } from './lib/auth.js'
import NavBar from './components/NavBar.jsx'
import Login from './screens/Login.jsx'
import Overview from './screens/Overview.jsx'
import Jobs from './screens/Jobs.jsx'
import JobDetail from './screens/JobDetail.jsx'
import Metrics from './screens/Metrics.jsx'
import Submit from './screens/Submit.jsx'
import Models from './screens/Models.jsx'

function ProtectedLayout({ token, children }) {
  if (!token) return <Navigate to="/" replace />
  return (
    <>
      <NavBar />
      {children}
    </>
  )
}

export default function App() {
  const [token, setToken] = useState(authGetToken)

  useEffect(() => {
    const handler = () => setToken(null)
    window.addEventListener('delegate:unauthorized', handler)
    return () => window.removeEventListener('delegate:unauthorized', handler)
  }, [])

  return (
    <HashRouter>
      <Routes>
        <Route
          path="/"
          element={token ? <Navigate to="/overview" replace /> : <Login onLogin={() => setToken(authGetToken())} />}
        />
        <Route path="/overview" element={<ProtectedLayout token={token}><Overview /></ProtectedLayout>} />
        <Route path="/jobs" element={<ProtectedLayout token={token}><Jobs /></ProtectedLayout>} />
        <Route path="/jobs/:id" element={<ProtectedLayout token={token}><JobDetail /></ProtectedLayout>} />
        <Route path="/metrics" element={<ProtectedLayout token={token}><Metrics /></ProtectedLayout>} />
        <Route path="/submit" element={<ProtectedLayout token={token}><Submit /></ProtectedLayout>} />
        <Route path="/models" element={<ProtectedLayout token={token}><Models /></ProtectedLayout>} />
      </Routes>
    </HashRouter>
  )
}
