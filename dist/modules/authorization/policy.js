export const permissions = [
    "organization.read",
    "organization.update",
    "members.read",
    "members.manage",
    "invitations.manage",
    "groups.read",
    "groups.manage",
    "permissions.manage",
    "audit.read",
    "commerce.read",
    "billing.read",
    "billing.manage",
];
export const northCapabilities = [
    "north.category.read",
    "north.category.create",
    "north.category.update",
    "north.category.archive",
    "north.subcategory.read",
    "north.subcategory.create",
    "north.subcategory.update",
    "north.subcategory.archive",
    "north.panel.read",
    "north.panel.create",
    "north.panel.update",
    "north.panel.preview",
    "north.panel.publish",
    "north.panel.archive",
    "north.content.read",
    "north.content.update",
    "north.asset.read",
    "north.asset.create",
    "north.asset.delete",
    "north.permission.read",
    "north.permission.manage",
    "north.template.read",
    "north.template.create",
    "north.template.apply",
    "north.template.manage",
    "north.audit.read",
    "north.platform.manage",
    "north.organization.manage_all",
    "north.content.manage_all_tenants",
    "north.template.manage_global",
];
export const northGlobalCapabilities = [
    "north.platform.manage",
    "north.organization.manage_all",
    "north.content.manage_all_tenants",
    "north.template.manage_global",
];
const northCapabilitySet = new Set(northCapabilities);
export const northTenantCapabilities = northCapabilities.filter((capability) => !northGlobalCapabilities.includes(capability));
export function isNorthCapability(value) {
    return northCapabilitySet.has(value);
}
const grants = {
    OWNER: permissions,
    ADMIN: permissions,
    BILLING_ADMIN: [
        "organization.read",
        "members.read",
        "groups.read",
        "commerce.read",
        "billing.read",
        "billing.manage",
    ],
    MEMBER: [
        "organization.read",
        "members.read",
        "groups.read",
        "commerce.read",
    ],
    VIEWER: [
        "organization.read",
        "members.read",
        "groups.read",
        "commerce.read",
    ],
};
const permissionSet = new Set(permissions);
export function isPermission(value) {
    return permissionSet.has(value);
}
export function effectivePermissions(role, groupGrants = [], directGrants = []) {
    const resolved = new Set(role && Object.hasOwn(grants, role) ? grants[role] : []);
    for (const permission of [...groupGrants, ...directGrants])
        if (isPermission(permission))
            resolved.add(permission);
    // Registry order makes resolution stable regardless of query or insertion order.
    return permissions.filter((permission) => resolved.has(permission));
}
export function allows(role, permission) {
    return isPermission(permission) && effectivePermissions(role).includes(permission);
}
export function canManageRole(actorRole, targetRole, nextRole) {
    return (actorRole === "OWNER" ||
        (actorRole === "ADMIN" &&
            [targetRole, nextRole ?? "MEMBER"].every((role) => role === "BILLING_ADMIN" || role === "MEMBER" || role === "VIEWER")));
}
