function namedKey(raw, name = "default") {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "";
  if (value.startsWith("sb_")) return value;
  try {
    const keys = JSON.parse(value);
    return typeof keys?.[name] === "string" ? keys[name].trim() : "";
  } catch {
    return "";
  }
}

export function resolveServiceApiKey({ secretKeys = "", serviceRoleKey = "", preferNew = false } = {}) {
  const current = namedKey(secretKeys);
  const legacy = String(serviceRoleKey || "").trim();
  return preferNew ? current || legacy : legacy || current;
}

export function resolvePublishableApiKey({ publishableKeys = "", anonKey = "", preferNew = false } = {}) {
  const current = namedKey(publishableKeys);
  const legacy = String(anonKey || "").trim();
  return preferNew ? current || legacy : legacy || current;
}

export function serviceApiHeaders(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) return { apikey: "" };
  if (key.startsWith("sb_secret_")) return { apikey: key };
  return { apikey: key, Authorization: `Bearer ${key}` };
}
