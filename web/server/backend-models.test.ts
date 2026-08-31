import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lastUsedModel, listBackendModels } from "./backend-models.js";

const homes = vi.hoisted(() => ({ companion: "", legacy: "" }));

vi.mock("./codex-home.js", () => ({
  resolveCompanionCodexHome: () => homes.companion,
  getLegacyCodexHome: () => homes.legacy,
}));

let tempDir: string;

function writeCache(dir: string, slugs: { slug: string; priority?: number; visibility?: string }[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "models_cache.json");
  writeFileSync(
    path,
    JSON.stringify({
      models: slugs.map((m) => ({
        slug: m.slug,
        display_name: m.slug.toUpperCase(),
        description: `${m.slug} description`,
        visibility: m.visibility ?? "list",
        priority: m.priority ?? 0,
      })),
    }),
  );
  return path;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "backend-models-test-"));
  homes.companion = join(tempDir, "companion-codex-home");
  homes.legacy = join(tempDir, "legacy-codex-home");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("listBackendModels — codex catalogue discovery", () => {
  // Companion runs every Codex session under its own CODEX_HOME and only ever seeds
  // *from* ~/.codex, so the catalogue reflecting this account lives in a session home.
  // Reading only the legacy home is what made the picker offer unusable models.
  it("reads the catalogue from a Companion session home", () => {
    writeCache(join(homes.companion, "session-a"), [{ slug: "gpt-5.6-sol" }]);

    const models = listBackendModels("codex");

    expect(models.map((m) => m.value)).toEqual(["gpt-5.6-sol"]);
  });

  it("prefers the most recently written session home over older ones", () => {
    const stale = writeCache(join(homes.companion, "session-old"), [{ slug: "stale-model" }]);
    writeCache(join(homes.companion, "session-new"), [{ slug: "fresh-model" }]);
    const longAgo = new Date("2020-01-01T00:00:00Z");
    utimesSync(stale, longAgo, longAgo);

    const models = listBackendModels("codex");

    expect(models.map((m) => m.value)).toEqual(["fresh-model"]);
  });

  it("filters hidden models and sorts the rest by priority", () => {
    writeCache(join(homes.companion, "session-a"), [
      { slug: "slow-model", priority: 10 },
      { slug: "fast-model", priority: 0 },
      { slug: "retired-model", priority: 1, visibility: "hide" },
    ]);

    const models = listBackendModels("codex");

    expect(models).toEqual([
      { value: "fast-model", label: "FAST-MODEL", description: "fast-model description" },
      { value: "slow-model", label: "SLOW-MODEL", description: "slow-model description" },
    ]);
  });

  it("falls back to the legacy ~/.codex cache when no session home has one", () => {
    writeCache(homes.legacy, [{ slug: "legacy-model" }]);

    const models = listBackendModels("codex");

    expect(models.map((m) => m.value)).toEqual(["legacy-model"]);
  });

  it("falls back to the static list when no cache exists anywhere", () => {
    const models = listBackendModels("codex");

    expect(models.length).toBeGreaterThan(0);
    expect(models.map((m) => m.value)).toContain("gpt-5.2-codex");
  });

  // A cache truncated mid-write must not take down the picker.
  it("skips a malformed cache and falls back", () => {
    mkdirSync(join(homes.companion, "session-a"), { recursive: true });
    writeFileSync(join(homes.companion, "session-a", "models_cache.json"), "not json{{{");

    const models = listBackendModels("codex");

    expect(models.map((m) => m.value)).toContain("gpt-5.2-codex");
  });
});

describe("listBackendModels — preferred model", () => {
  it("moves a preferred model to the front, keeping its label and description", () => {
    writeCache(join(homes.companion, "session-a"), [
      { slug: "first-model", priority: 0 },
      { slug: "wanted-model", priority: 5 },
    ]);

    const models = listBackendModels("codex", "wanted-model");

    expect(models[0]).toEqual({
      value: "wanted-model",
      label: "WANTED-MODEL",
      description: "wanted-model description",
    });
    expect(models).toHaveLength(2);
  });

  // The session it came from is proof the account can run it, so it is added rather
  // than dropped — otherwise the UI would silently fall back to a model that fails.
  it("adds a preferred model that the catalogue does not list", () => {
    writeCache(join(homes.companion, "session-a"), [{ slug: "listed-model" }]);

    const models = listBackendModels("codex", "unlisted-model");

    expect(models.map((m) => m.value)).toEqual(["unlisted-model", "listed-model"]);
  });

  it("serves claude models from the static list with the preferred model first", () => {
    const models = listBackendModels("claude", "claude-sonnet-4-6");

    expect(models[0].value).toBe("claude-sonnet-4-6");
    expect(models.map((m) => m.value)).toContain("claude-opus-4-6");
  });

  it("leaves the catalogue order alone when no model is preferred", () => {
    const models = listBackendModels("claude");

    expect(models[0].value).toBe("claude-opus-4-6");
  });
});

describe("lastUsedModel", () => {
  it("returns the model of the newest session on that backend", () => {
    const model = lastUsedModel(
      [
        { model: "older-model", backendType: "codex", createdAt: 1 },
        { model: "newest-model", backendType: "codex", createdAt: 3 },
        { model: "middle-model", backendType: "codex", createdAt: 2 },
      ],
      "codex",
    );

    expect(model).toBe("newest-model");
  });

  it("ignores sessions from the other backend", () => {
    const model = lastUsedModel(
      [
        { model: "claude-opus-4-6", backendType: "claude", createdAt: 5 },
        { model: "gpt-5.6-sol", backendType: "codex", createdAt: 1 },
      ],
      "codex",
    );

    expect(model).toBe("gpt-5.6-sol");
  });

  // Sessions persisted before backendType existed are Claude sessions.
  it("treats a session with no backendType as claude", () => {
    const model = lastUsedModel([{ model: "claude-opus-4-6", createdAt: 1 }], "claude");

    expect(model).toBe("claude-opus-4-6");
  });

  it("skips sessions that never recorded a model", () => {
    const model = lastUsedModel(
      [
        { backendType: "claude", createdAt: 9 },
        { model: "claude-sonnet-4-6", backendType: "claude", createdAt: 1 },
      ],
      "claude",
    );

    expect(model).toBe("claude-sonnet-4-6");
  });

  // A cron job or agent runs on whatever model its config names, which says nothing about
  // what the person at the keyboard is working with — a nightly Haiku job must not decide
  // what the next chat opens on.
  it("skips sessions spawned by a cron job or an agent", () => {
    const model = lastUsedModel(
      [
        { model: "cron-model", backendType: "claude", createdAt: 9, cronJobId: "job-1" },
        { model: "agent-model", backendType: "claude", createdAt: 8, agentId: "agent-1" },
        { model: "chat-model", backendType: "claude", createdAt: 1 },
      ],
      "claude",
    );

    expect(model).toBe("chat-model");
  });

  it("returns undefined when the backend has never been used", () => {
    expect(lastUsedModel([], "codex")).toBeUndefined();
  });
});
