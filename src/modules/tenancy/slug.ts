const reservedOrganizationSlugs = new Set([
  "admin",
  "api",
  "auth",
  "billing",
  "callback",
  "create",
  "dashboard",
  "desktop-auth",
  "health",
  "invitations",
  "login",
  "logout",
  "me",
  "organizations",
  "personal",
  "privacy",
  "register",
  "security",
  "settings",
  "sign-in",
  "sign-up",
  "support",
  "terms",
  "users",
  "v1",
  "verify",
  "workspace",
  "workspaces",
  "www",
]);

export function normalizeOrganizationSlug(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

export function isReservedOrganizationSlug(value: string) {
  return reservedOrganizationSlugs.has(value);
}

export const organizationSlugPolicy = {
  minLength: 2,
  maxLength: 60,
  reserved: [...reservedOrganizationSlugs].sort(),
};
