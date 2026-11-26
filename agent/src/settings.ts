import { EDITABLE } from "../agents";
import type { Bindings, ClientConfig, EditableSetting, JsonObject } from "./contracts";

// Editable settings: code defaults (clients/<client>/<agent>.json `settings`) overlaid with the overrides staff
// saved in the app (Dashboard `settings` table). Only keys an agent declares editable can ever be overridden.

const MAX_TEXT = 200;
const MAX_LIST = 20;

/** `field` names the setting key at fault, when one is. */
export class InvalidSetting extends Error {
  constructor(message: string, readonly field?: string) { super(message); }
}

/** Code defaults overlaid with stored overrides; overrides of keys that are not editable are ignored. */
export function effectiveSettings(client: ClientConfig, agent: string, editable: EditableSetting[], overrides: JsonObject): JsonObject {
  const keys = new Set(editable.map(e => e.key));
  return { ...client.agentSettings?.[agent], ...Object.fromEntries(Object.entries(overrides).filter(([key]) => keys.has(key))) };
}

/** The effective settings of one of the client's agents, read fresh from its dashboard. */
export async function agentSettings(bindings: Pick<Bindings, "DASHBOARD">, client: ClientConfig, agent: string): Promise<JsonObject> {
  const overrides = JSON.parse(await bindings.DASHBOARD.get(bindings.DASHBOARD.idFromName(client.id)).settingOverrides(agent)) as JsonObject;
  return effectiveSettings(client, agent, EDITABLE[agent] ?? [], overrides);
}

export const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => [k, canonical(v)]))
  : value;

/** sha256 of the settings as canonical JSON (keys sorted): a proposal remembers this, never the values. */
export async function settingsFingerprint(settings: JsonObject): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(settings))));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw new InvalidSetting(`${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT) throw new InvalidSetting(`${label} must be at most ${MAX_TEXT} characters.`);
  return trimmed;
};

function validate(setting: EditableSetting, value: unknown): unknown {
  const { label } = setting;
  switch (setting.type) {
    case "text": return text(value, label);
    case "url": {
      const raw = text(value, label);
      if (!raw) return raw; // clearing a URL is allowed
      let url: URL;
      try { url = new URL(raw); } catch { throw new InvalidSetting(`${label} must be a web address.`); }
      if (url.protocol !== "https:" || url.username || url.password) throw new InvalidSetting(`${label} must be an https:// address without a login in it.`);
      return raw;
    }
    case "number": {
      const { min = 0, max = 1_000_000 } = setting;
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new InvalidSetting(`${label} must be a whole number from ${min} to ${max}.`);
      return value;
    }
    case "list": {
      if (!Array.isArray(value) || value.length > MAX_LIST) throw new InvalidSetting(`${label} must be a list of at most ${MAX_LIST} items.`);
      return value.map(item => text(item, label)).filter(Boolean);
    }
    case "choice": {
      if (typeof value !== "string" || !setting.choices?.includes(value)) throw new InvalidSetting(`${label} must be one of: ${setting.choices?.join(", ")}.`);
      return value;
    }
  }
}

/** The validated override for each key in `body`; throws InvalidSetting for an unknown key or a bad value. */
export function validateSettings(editable: EditableSetting[], body: unknown): JsonObject {
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length === 0) throw new InvalidSetting("settings must be an object with at least one setting.");
  return Object.fromEntries(Object.entries(body).map(([key, value]) => {
    const setting = editable.find(e => e.key === key);
    if (!setting) throw new InvalidSetting(`"${key}" cannot be changed here.`, key);
    try { return [key, validate(setting, value)]; } catch (error) {
      throw error instanceof InvalidSetting ? new InvalidSetting(error.message, key) : error;
    }
  }));
}
