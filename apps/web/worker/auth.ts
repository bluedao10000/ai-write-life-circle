import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import type { D1Database, Fetcher } from '@cloudflare/workers-types'

export interface Env {
  GOOGLE_SITE_VERIFICATION?: string
  BING_SITE_VERIFICATION?: string
  AUTH_DB: D1Database
  ASSETS: Fetcher
  BETTER_AUTH_SECRET: string
  BETTER_AUTH_URL: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  WRITER_AGENT_AUTHOR_EMAILS: string
  WRITER_AGENT_API_TOKEN: string
  WRITER_AGENT_API_ORIGIN: string
  WRITER_AGENT_PROJECT_ID: string
}

export function authorAllowed(user: { email: string; emailVerified: boolean }, env: Env) {
  const emails = env.WRITER_AGENT_AUTHOR_EMAILS?.split(',').map(email => email.trim().toLowerCase()).filter(Boolean) ?? []
  return user.emailVerified === true && emails.includes(user.email.toLowerCase())
}

export function authConfigured(env: Env) {
  return Boolean(env.AUTH_DB && env.BETTER_AUTH_SECRET?.length >= 32 && env.GOOGLE_CLIENT_ID
    && env.GOOGLE_CLIENT_SECRET && env.WRITER_AGENT_AUTHOR_EMAILS?.trim()
    && env.BETTER_AUTH_URL?.startsWith('https://'))
}

export function createAuth(env: Env) {
  return betterAuth({
    appName: 'Writer Agent',
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: env.AUTH_DB,
    trustedOrigins: [env.BETTER_AUTH_URL],
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        redirectURI: `${env.BETTER_AUTH_URL}/api/auth/google/callback`,
        prompt: 'select_account',
        accessType: 'online',
      },
    },
    account: { accountLinking: { enabled: false }, encryptOAuthTokens: true },
    user: { validateUserInfo: async ({ user, source }) => {
      if (source.method !== 'oauth' || source.oauth?.providerId !== 'google'
        || !authorAllowed({ email: typeof user.email === 'string' ? user.email : '', emailVerified: user.emailVerified === true }, env)) {
        throw new APIError('FORBIDDEN', { message: '此 Google 账号没有作品访问权限。' })
      }
    } },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    advanced: { useSecureCookies: true, defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: true } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 60 },
    databaseHooks: {
      user: { create: { before: async user => {
        if (!authorAllowed(user, env)) throw new APIError('FORBIDDEN', { message: '此 Google 账号没有作品访问权限。' })
        return { data: user }
      } } },
    },
    logger: { disabled: true },
    telemetry: { enabled: false },
  })
}
