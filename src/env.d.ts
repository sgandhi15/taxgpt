// Secrets are not listed in wrangler.jsonc, so `wrangler types` cannot see them.
interface Env {
  ANTHROPIC_API_KEY: string;
  TURNSTILE_SECRET_KEY: string;
}
