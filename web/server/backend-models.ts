import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getLegacyCodexHome, resolveCompanionCodexHome } from "./codex-home.js";
import type { BackendType } from "./session-types.js";

export interface BackendModelInfo {
  value: string;
  label: string;
  description: string;
}

/**
 * Used when the backend exposes no catalogue of its own — Claude ships no model list, and
 * Codex has no cache until it has run once. Mirrors the offline fallback the frontend keeps
 * in web/src/utils/backends.ts for when this endpoint itself is unreachable.
 */
const FALLBACK_MODELS: Record<BackendType, BackendModelInfo[]> = {
  claude: [
    { value: "claude-opus-4-6", label: "Opus 4.6", description: "" },
    { value: "claude-sonnet-4-6", label: "Sonnet 4.6", description: "" },
    { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5", description: "" },
  ],
  codex: [
    { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", description: "" },
    { value: "gpt-5.2-codex", label: "GPT-5.2 Codex", description: "" },
    { value: "gpt-5.1-codex-max", label: "GPT-5.1 Max", description: "" },
    { value: "gpt-5.2", label: "GPT-5.2", description: "" },
    { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Mini", description: "" },
  ],
};

interface CodexCacheModel {
  slug: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  priority?: number;
}

interface SessionModelRecord {
  model?: string;
  backendType?: BackendType;
  createdAt: number;
  cronJobId?: string;
  agentId?: string;
}

/**
 * Codex writes models_cache.json under whichever CODEX_HOME its app-server ran with, and
 * every Companion session gets its own home under ~/.companion/codex-home/<sessionId>.
 * prepareCodexHome only seeds *from* the legacy ~/.codex, never back, so the catalogue that
 * reflects this account lives in a session home; ~/.codex only holds one if the user ran the
 * Codex CLI directly. Newest first, since later sessions saw the newest entitlements.
 */
function codexCachePaths(): string[] {
  const companionHome = resolveCompanionCodexHome();
  const sessionCaches: { path: string; mtimeMs: number }[] = [];

  try {
    for (const entry of readdirSync(companionHome, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(companionHome, entry.name, "models_cache.json");
      try {
        sessionCaches.push({ path, mtimeMs: statSync(path).mtimeMs });
      } catch {
        // No cache in this session home yet.
      }
    }
  } catch {
    // Companion has never run a Codex session.
  }

  sessionCaches.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return [
    ...sessionCaches.map((c) => c.path),
    join(companionHome, "models_cache.json"),
    join(getLegacyCodexHome(), "models_cache.json"),
  ];
}

function parseCodexCache(path: string): BackendModelInfo[] | null {
  if (!existsSync(path)) return null;
  try {
    const cache = JSON.parse(readFileSync(path, "utf-8")) as { models?: CodexCacheModel[] };
    if (!Array.isArray(cache.models)) return null;
    return cache.models
      .filter((m) => m.visibility === "list")
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m) => ({
        value: m.slug,
        label: m.display_name || m.slug,
        description: m.description || "",
      }));
  } catch {
    return null;
  }
}

function readCodexModels(): BackendModelInfo[] | null {
  for (const path of codexCachePaths()) {
    const models = parseCodexCache(path);
    if (models?.length) return models;
  }
  return null;
}

function promote(models: BackendModelInfo[], preferred?: string): BackendModelInfo[] {
  if (!preferred) return models;
  const existing = models.find((m) => m.value === preferred);
  const rest = models.filter((m) => m.value !== preferred);
  return [existing ?? { value: preferred, label: preferred, description: "" }, ...rest];
}

/**
 * Models offered for a backend, `preferred` first so callers can treat entry 0 as the default.
 * A preferred model missing from the catalogue is added rather than dropped — the session it
 * came from is proof the account can use it.
 */
export function listBackendModels(backend: BackendType, preferred?: string): BackendModelInfo[] {
  const catalogue = backend === "codex" ? readCodexModels() : null;
  return promote(catalogue ?? FALLBACK_MODELS[backend], preferred);
}

/**
 * The model of the newest chat on this backend — what a new chat should open on. Sessions a
 * cron job or agent spawned are skipped: they run on whatever model their config names, which
 * says nothing about what the person at the keyboard is working with.
 */
export function lastUsedModel(
  sessions: SessionModelRecord[],
  backend: BackendType,
): string | undefined {
  return sessions
    .filter((s) => (s.backendType ?? "claude") === backend && !!s.model)
    .filter((s) => !s.cronJobId && !s.agentId)
    .sort((a, b) => b.createdAt - a.createdAt)[0]?.model;
}
