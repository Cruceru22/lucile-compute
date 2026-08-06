// Load environment variables from a local `.env` file BEFORE any other module
// reads `process.env` (Supabase + Gemini keys, PORT, etc.).
//
// This MUST be imported first in `index.ts`. ES module imports evaluate in
// order, so importing this module before the others guarantees the env is
// populated before they read it.
//
// In production there is usually no `.env` file — the platform injects env vars
// directly — so a missing file is a no-op, not an error.
try {
  process.loadEnvFile();
} catch {
  // No `.env` file present — env comes from the surrounding environment.
}
