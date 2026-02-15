import { App } from './app'
import { AuthService, type AuthSession } from './services/auth'

interface SyncBootstrapConfig {
  baseUrl: string
  deviceId: string
  enabled?: boolean
  intervalMs?: number
}

declare global {
  interface Window {
    __ON_THE_BEACH_SYNC_CONFIG__?: Partial<SyncBootstrapConfig>
  }
}

const SESSION_STORAGE_KEY = 'otb.auth.session'

function parseStoredSession(): AuthSession | null {
  const raw = localStorage.getItem(SESSION_STORAGE_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Partial<AuthSession>
    if (
      typeof parsed.userId !== 'string' ||
      typeof parsed.accessToken !== 'string' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null
    }
    return {
      userId: parsed.userId,
      accessToken: parsed.accessToken,
      expiresAt: parsed.expiresAt,
    }
  } catch {
    return null
  }
}

function parseSyncConfig(): SyncBootstrapConfig | null {
  const config = window.__ON_THE_BEACH_SYNC_CONFIG__
  if (!config || config.enabled === false) return null

  if (typeof config.baseUrl !== 'string') return null
  if (typeof config.deviceId !== 'string' || config.deviceId.trim() === '') return null

  return {
    baseUrl: config.baseUrl,
    deviceId: config.deviceId,
    enabled: true,
    intervalMs: typeof config.intervalMs === 'number' ? config.intervalMs : undefined,
  }
}

async function bootstrap() {
  const syncConfig = parseSyncConfig()
  const app = (() => {
    if (!syncConfig) return new App()

    const authService = new AuthService({ baseUrl: syncConfig.baseUrl })
    const session = parseStoredSession()
    if (session) {
      authService.setSession(session)
    }

    return new App({
      sync: {
        authService,
        config: {
          baseUrl: syncConfig.baseUrl,
          deviceId: syncConfig.deviceId,
        },
        intervalMs: syncConfig.intervalMs,
      },
    })
  })()

  try {
    await app.initialize()
    console.log('[App] Initialized successfully')
  } catch (error) {
    console.error('[App] Failed to initialize:', error)
    document.getElementById('app')!.innerHTML = `
      <div class="error-screen">
        <h1>Failed to load</h1>
        <p>Could not initialize the database. Please refresh the page.</p>
        <pre>${error}</pre>
      </div>
    `
  }

  // Save on page unload
  window.addEventListener('beforeunload', () => {
    app.forceSave()
  })
}

bootstrap()
