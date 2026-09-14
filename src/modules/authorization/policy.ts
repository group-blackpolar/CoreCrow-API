export const permissions = [
  "organization.read",
  "organization.update",
  "members.read",
  "members.manage",
  "invitations.manage",
  "audit.read",
  "commerce.read",
] as const;
export type Permission = (typeof permissions)[number];
const grants: Record<string, readonly Permission[]> = {
  OWNER: permissions,
  ADMIN: permissions,
  MEMBER: ["organization.read", "members.read", "commerce.read"],
  VIEWER: ["organization.read", "members.read", "commerce.read"],
};
export function allows(role: string | undefined, permission: string): boolean {
  return (
    !!role &&
    Object.hasOwn(grants, role) &&
    grants[role]!.includes(permission as Permission)
  );
}
export function canManageRole(
  actorRole: string,
  targetRole: string,
  nextRole?: string,
) {
  return (
    actorRole === "OWNER" ||
    (actorRole === "ADMIN" &&
      [targetRole, nextRole ?? "MEMBER"].every(
        (role) => role === "MEMBER" || role === "VIEWER",
      ))
  );
}
