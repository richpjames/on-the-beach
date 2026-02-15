export interface AuthSession {
  userId: string
  accessToken: string
  expiresAt: number
}

export interface RefreshResponse {
  userId: string
  accessToken: string
  expiresIn: number
}

export interface AuthServiceConfig {
  baseUrl: string
  refreshPath?: string
  clockSkewMs?: number
  fetchImpl?: typeof fetch
}

const DEFAULT_REFRESH_PATH = '/v1/auth/refresh'
const DEFAULT_CLOCK_SKEW_MS = 30_000
const DEFAULT_FETCH: typeof fetch = (input, init) => globalThis.fetch(input, init)

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  const normalizedPath = path.startsWith('/') ? path : `/${path}`

  if (!normalizedBase) return normalizedPath
  return `${normalizedBase}${normalizedPath}`
}

export class AuthService {
  private session: AuthSession | null = null
  private refreshInFlight: Promise<AuthSession | null> | null = null
  private readonly refreshPath: string
  private readonly clockSkewMs: number
  private readonly fetchImpl: typeof fetch

  constructor(private config: AuthServiceConfig) {
    this.refreshPath = config.refreshPath ?? DEFAULT_REFRESH_PATH
    this.clockSkewMs = config.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS
    this.fetchImpl = config.fetchImpl ?? DEFAULT_FETCH
  }

  setSession(session: AuthSession | null): void {
    this.session = session
  }

  getSession(): AuthSession | null {
    return this.session
  }

  clearSession(): void {
    this.session = null
  }

  isAuthenticated(): boolean {
    return this.session !== null
  }

  async getValidAccessToken(): Promise<string | null> {
    if (!this.session) return null

    if (!this.isExpiringSoon(this.session.expiresAt)) {
      return this.session.accessToken
    }

    const refreshed = await this.refreshSession()
    return refreshed?.accessToken ?? null
  }

  async authorizedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const token = await this.getValidAccessToken()

    const headers = new Headers(init.headers)
    if (token) {
      headers.set('Authorization', `Bearer ${token}`)
    }

    let response = await this.fetchImpl(input, {
      ...init,
      headers,
      credentials: init.credentials ?? 'include',
    })

    if (response.status !== 401) {
      return response
    }

    const refreshed = await this.refreshSession()
    if (!refreshed) {
      return response
    }

    headers.set('Authorization', `Bearer ${refreshed.accessToken}`)
    response = await this.fetchImpl(input, {
      ...init,
      headers,
      credentials: init.credentials ?? 'include',
    })

    return response
  }

  async refreshSession(): Promise<AuthSession | null> {
    if (this.refreshInFlight) {
      return this.refreshInFlight
    }

    this.refreshInFlight = this.doRefreshSession()

    try {
      return await this.refreshInFlight
    } finally {
      this.refreshInFlight = null
    }
  }

  private async doRefreshSession(): Promise<AuthSession | null> {
    const response = await this.fetchImpl(joinUrl(this.config.baseUrl, this.refreshPath), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
    })

    if (!response.ok) {
      this.clearSession()
      return null
    }

    const data = (await response.json()) as Partial<RefreshResponse>
    if (!this.isRefreshResponse(data)) {
      this.clearSession()
      return null
    }

    const session: AuthSession = {
      userId: data.userId,
      accessToken: data.accessToken,
      expiresAt: Date.now() + data.expiresIn * 1000,
    }

    this.session = session
    return session
  }

  private isExpiringSoon(expiresAt: number): boolean {
    return Date.now() >= expiresAt - this.clockSkewMs
  }

  private isRefreshResponse(value: Partial<RefreshResponse>): value is RefreshResponse {
    return (
      typeof value.userId === 'string' &&
      typeof value.accessToken === 'string' &&
      typeof value.expiresIn === 'number' &&
      Number.isFinite(value.expiresIn) &&
      value.expiresIn > 0
    )
  }
}
