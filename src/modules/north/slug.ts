const reserved = new Set([
  "admin", "api", "assets", "auth", "billing", "health", "login", "logout",
  "profile", "settings", "workspace",
]);

export function normalizeNorthSlug(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)
    .replace(/-+$/g, "");
}

export function validateNorthSlug(value: string, system = false) {
  const slug = normalizeNorthSlug(value);
  if (slug.length < 2) return { slug, error: "NORTH_SLUG_INVALID" as const };
  if (!system && reserved.has(slug))
    return { slug, error: "NORTH_SLUG_RESERVED" as const };
  return { slug };
}

export const northReservedSlugs = [...reserved].sort();
