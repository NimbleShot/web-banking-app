/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The API's origin, set at build time (DP-4); unset means the page's own origin. Never a secret. */
  readonly VITE_API_URL?: string;
}
