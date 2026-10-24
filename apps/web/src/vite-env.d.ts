/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WRITER_AGENT_MODE?: 'demo' | 'api'
  readonly VITE_WRITER_AGENT_PROJECT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
