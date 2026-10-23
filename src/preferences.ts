export type ThemePreference = "obsidian" | "forest";
export type RefreshInterval = 30 | 60 | 300;

export interface DashboardPreferences {
  theme: ThemePreference;
  refreshInterval: RefreshInterval;
}

export const DEFAULT_PREFERENCES: DashboardPreferences = {
  theme: "obsidian",
  refreshInterval: 60,
};

const STORAGE_KEY = "cloud-observatory.preferences.v1";

function isPreferences(value: unknown): value is DashboardPreferences {
  return typeof value === "object" && value !== null
    && "theme" in value && (value.theme === "obsidian" || value.theme === "forest")
    && "refreshInterval" in value && (value.refreshInterval === 30 || value.refreshInterval === 60 || value.refreshInterval === 300);
}

export function loadPreferences(storage: Storage = window.localStorage): DashboardPreferences {
  try {
    const saved = storage.getItem(STORAGE_KEY);
    if (!saved) return DEFAULT_PREFERENCES;
    const parsed: unknown = JSON.parse(saved);
    return isPreferences(parsed) ? parsed : DEFAULT_PREFERENCES;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(preferences: DashboardPreferences, storage: Storage = window.localStorage): boolean {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}
