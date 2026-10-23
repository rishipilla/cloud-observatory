import { describe, expect, it } from "vitest";

import { DEFAULT_PREFERENCES, loadPreferences, savePreferences } from "./preferences";
import { createMemoryStorage } from "./testStorage";

describe("dashboard preferences", () => {
  it("loads defaults and persists valid preferences", () => {
    const storage = createMemoryStorage();
    expect(loadPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
    const preferences = { theme: "forest" as const, refreshInterval: 300 as const };

    expect(savePreferences(preferences, storage)).toBe(true);
    expect(loadPreferences(storage)).toEqual(preferences);
  });

  it("ignores malformed or unsupported stored settings", () => {
    const storage = createMemoryStorage();
    storage.setItem("cloud-observatory.preferences.v1", "{bad json");
    expect(loadPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
    storage.setItem("cloud-observatory.preferences.v1", JSON.stringify({ theme: "neon", refreshInterval: 5 }));
    expect(loadPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
  });
});
