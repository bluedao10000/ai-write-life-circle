import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import type { D1Database, Fetcher } from '@cloudflare/workers-types'
import { identityConfigured } from './identity'

export interface Env {
  GOOGLE_SITE_VERIFICATION?: string
  BING_SITE_VERIFICATION?: string
  AUTH_DB: D1Database
  ASSETS: Fetcher
  BETTER_AUTH_SECRET: string
  BETTER_AUTH_URL: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  WRITER_AGENT_API_TOKEN: string
  /** Base64 PKCS#8 Ed25519 key signing per-request user assertions for Go. */
  WRITER_AGENT_IDENTITY_PRIVATE_KEY: string
  WRITER_AGENT_API_ORIGIN: string
  WRITER_AGENT_PROJECT_ID: string
}

/**
 * Sign-up is open to any Google account with a verified address. Access to
 * works is decided per user by the Go API (each account is its own author),
 * not by an allowlist here.
 */
export function verifiedGoogleUser(user: { email: string; emailVerified: boolean }) {
  return user.emailVerified === true && typeof user.email === 'string' && user.email.includes('@')
}

export function authConfigured(env: Env) {
  return Boolean(env.AUTH_DB && env.BETTER_AUTH_SECRET?.length >= 32 && env.GOOGLE_CLIENT_ID
    && env.GOOGLE_CLIENT_SECRET && identityConfigured(env.WRITER_AGENT_IDENTITY_PRIVATE_KEY)
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
        || !verifiedGoogleUser({ email: typeof user.email === 'string' ? user.email : '', emailVerified: user.emailVerified === true })) {
        throw new APIError('FORBIDDEN', { message: '请使用已验证邮箱的 Google 账号登录。' })
      }
    } },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    advanced: { useSecureCookies: true, defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: true } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 60 },
    databaseHooks: {
      user: { create: { before: async user => {
        if (!verifiedGoogleUser(user)) throw new APIError('FORBIDDEN', { message: '请使用已验证邮箱的 Google 账号登录。' })
        return { data: user }
      } } },
    },
    logger: { disabled: true },
    telemetry: { enabled: false },
  })
}
