// Supabase's server runtime also exposes window; only a DOM identifies a browser.
if (typeof (globalThis as { document?: unknown }).document !== "undefined") {
  throw new Error("This module is server-only");
}

export {};
