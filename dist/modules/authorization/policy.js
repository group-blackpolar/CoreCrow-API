export const permissions = [
    "organization.read",
    "organization.update",
    "members.read",
    "members.manage",
    "invitations.manage",
    "audit.read",
    "commerce.read",
];
const grants = {
    OWNER: permissions,
    ADMIN: permissions,
    MEMBER: ["organization.read", "members.read", "commerce.read"],
    VIEWER: ["organization.read", "members.read", "commerce.read"],
};
export function allows(role, permission) {
    return (!!role &&
        Object.hasOwn(grants, role) &&
        grants[role].includes(permission));
}
export function canManageRole(actorRole, targetRole, nextRole) {
    return (actorRole === "OWNER" ||
        (actorRole === "ADMIN" &&
            [targetRole, nextRole ?? "MEMBER"].every((role) => role === "MEMBER" || role === "VIEWER")));
}
