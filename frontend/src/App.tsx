import { useCallback, useEffect, useState } from 'react'
import './App.css'
import { APP_TITLE, MRI_MODALITY } from './config/modalities'
import HomePage from './pages/HomePage'
import MriWorkbench from './pages/MriWorkbench'

type AppRoute = 'home' | 'mri'

function getRouteFromPath(pathname: string): AppRoute {
  const normalizedPath = pathname.replace(/\/+$/u, '') || '/'

  if (normalizedPath === MRI_MODALITY.path) {
    return 'mri'
  }

  return 'home'
}

function App() {
  const [route, setRoute] = useState<AppRoute>(() => getRouteFromPath(window.location.pathname))

  const navigate = useCallback((path: string): void => {
    if (window.location.pathname === path) {
      return
    }

    window.history.pushState({}, '', path)
    setRoute(getRouteFromPath(path))
    window.scrollTo(0, 0)
  }, [])

  useEffect(() => {
    const handlePopState = (): void => {
      setRoute(getRouteFromPath(window.location.pathname))
    }

    window.addEventListener('popstate', handlePopState)
    return () => {
      window.removeEventListener('popstate', handlePopState)
    }
  }, [])

  useEffect(() => {
    document.title = route === 'mri' ? `${MRI_MODALITY.label} | ${APP_TITLE}` : APP_TITLE
  }, [route])

  if (route === 'mri') {
    return <MriWorkbench onNavigateHome={() => navigate('/')} />
  }

  return <HomePage onOpenMri={() => navigate(MRI_MODALITY.path)} />
}

export default App
