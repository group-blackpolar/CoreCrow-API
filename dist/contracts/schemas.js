import { z } from "zod";
export const id = z.string().min(1).max(128);
export const date = z.string().datetime();
export const name = z.string().trim().min(2).max(100);
export const role = z.enum([
    "OWNER",
    "ADMIN",
    "BILLING_ADMIN",
    "MEMBER",
    "VIEWER",
]);
export const globalRole = z.enum(["USER", "DEVELOPER", "ADMIN", "SUPERADMIN"]);
export const accountStatus = z.enum(["ACTIVE", "SUSPENDED"]);
export const organizationStatus = z.enum(["ACTIVE", "SUSPENDED", "ARCHIVED"]);
export const orgParams = z.object({ organizationId: id }).strict();
export const memberParams = orgParams.extend({ userId: id });
export const org = z.object({
    id,
    name,
    slug: z.string(),
    status: organizationStatus,
    createdAt: date,
    updatedAt: date,
    homePanelId: id.nullable(),
});
export const user = z.object({
    id,
    name: z.string().nullable(),
    email: z.string().email(),
    role: globalRole,
    status: accountStatus,
    emailVerified: z.boolean(),
    passwordChangeRequired: z.boolean(),
    termsAcceptedAt: date.nullable(),
    termsVersion: z.string().nullable(),
    createdAt: date,
});
export const verificationEmailInput = z
    .object({ email: z.string().trim().email().max(254) })
    .strict();
export const verificationCodeInput = verificationEmailInput
    .extend({ code: z.string().regex(/^\d{6}$/) })
    .strict();
export const member = z.object({
    id,
    organizationId: id,
    userId: id,
    role,
    createdAt: date,
});
export const organizationGroup = z.object({
    id,
    organizationId: id,
    name,
    description: z.string().nullable(),
    createdAt: date,
    updatedAt: date,
});
export const invitationKind = z.enum(["EMAIL", "CODE"]);
export const invitationStatus = z.enum([
    "PENDING",
    "ACCEPTED",
    "REVOKED",
    "EXPIRED",
]);
export const invitation = z.object({
    id,
    organizationId: id,
    kind: invitationKind,
    email: z.string().email().nullable(),
    role,
    status: invitationStatus,
    expiresAt: date,
    acceptedAt: date.nullable(),
    revokedAt: date.nullable(),
    createdAt: date,
    groupIds: z.array(id),
    permissions: z.array(z.string()),
});
export const groupParams = orgParams.extend({ groupId: id });
export const groupMemberParams = groupParams.extend({ userId: id });
export const localizedText = z.record(z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/), z.string().trim().min(1).max(500));
export const northResourceKind = z.enum(["SYSTEM", "CONTENT"]);
export const northCategoryClass = z.enum(["SYSTEM", "TEMPLATE", "CUSTOM"]);
export const northResourceStatus = z.enum(["ACTIVE", "ARCHIVED"]);
export const northPanelStatus = z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]);
export const northAudienceType = z.enum(["ALL_MEMBERS", "ROLES", "GROUPS", "PERMISSIONS", "SPECIFIC_USERS"]);
export const northPermissionScope = z.enum(["PLATFORM", "ORGANIZATION", "CATEGORY", "SUBCATEGORY", "PANEL"]);
export const northMetadataInput = z.object({
    name: localizedText,
    description: localizedText.nullable().optional(),
    icon: z.string().trim().max(100).nullable().optional(),
    color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    slug: z.string().trim().min(1).max(100).optional(),
    order: z.number().int().min(0).max(100000).optional(),
    navigationHidden: z.boolean().optional(),
}).strict();
const northMetadata = z.object({
    id, organizationId: id, resourceKind: northResourceKind, name: localizedText,
    description: localizedText.nullable(), icon: z.string().nullable(), color: z.string().nullable(),
    slug: z.string(), order: z.number().int(), navigationHidden: z.boolean(), createdAt: date, updatedAt: date,
});
export const northCategory = northMetadata.extend({
    scope: z.enum(["PLATFORM", "ORGANIZATION", "PERSONAL"]),
    categoryClass: northCategoryClass, status: northResourceStatus,
    sourceTemplateId: id.nullable(), sourceTemplateVersion: z.number().int().nullable(),
});
export const northSubcategory = northMetadata.extend({ categoryId: id, status: northResourceStatus });
export const northPanel = northMetadata.extend({
    subcategoryId: id, status: northPanelStatus, audienceType: northAudienceType,
    publishedRevisionId: id.nullable(), draftRevisionId: id.nullable(),
});
export const northAssetStatus = z.enum(["UPLOADING", "PROCESSING", "READY", "REJECTED", "QUARANTINED"]);
export const northAsset = z.object({
    id,
    organizationId: id,
    ownerId: id,
    filename: z.string().min(1).max(255),
    mime: z.string(),
    size: z.number().int().min(1),
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
    status: northAssetStatus,
    confirmedAt: date.nullable(),
    deletedAt: date.nullable(),
    createdAt: date,
    updatedAt: date,
});
export const northSignedObjectRequest = z.object({
    url: z.string().url(),
    method: z.enum(["PUT", "GET"]),
    headers: z.record(z.string()),
    expiresAt: date,
});
export const plan = z.object({
    id,
    productId: id,
    code: z.string(),
    name,
    priceMinor: z.number().int().nonnegative(),
    currency: z.string(),
    interval: z.string(),
    features: z.array(z.string()),
    active: z.boolean(),
});
export const product = z.object({
    id,
    code: z.string(),
    name,
    active: z.boolean(),
    plans: z.array(plan).optional(),
});
export const invoice = z.object({
    id,
    subscriptionId: id,
    amountMinor: z.number().int(),
    currency: z.string(),
    status: z.string(),
    createdAt: date,
});
export const entitlement = z.object({
    id,
    organizationId: id,
    subscriptionId: id,
    productCode: z.string(),
    feature: z.string(),
    expiresAt: date,
    revokedAt: date.nullable(),
});
export const subscription = z.object({
    id,
    organizationId: id,
    planId: id,
    status: z.string(),
    startsAt: date,
    endsAt: date,
    createdAt: date,
    invoices: z.array(invoice).optional(),
    entitlements: z.array(entitlement).optional(),
});
export const auditEvent = z.object({
    id,
    actorId: id.nullable(),
    organizationId: id.nullable(),
    action: z.string(),
    targetType: z.string().nullable(),
    targetId: id.nullable(),
    requestId: z.string().nullable(),
    createdAt: date,
});
export const error = z.object({
    error: z.object({
        code: z.string(),
        message: z.string(),
        requestId: z.string(),
        currentRevision: z.number().int().min(1).optional(),
        currentETag: z.string().optional(),
    }),
});
export const health = z.object({
    status: z.enum(["operational", "degraded"]),
    apiVersion: z.literal("v1"),
    uptimeSeconds: z.number().int().nonnegative(),
    checkedAt: date,
    modules: z.array(z.object({
        name: z.string(),
        status: z.enum(["available", "unavailable"]),
    })),
    emailDelivery: z.enum(["configured", "not_configured"]),
    emailTransport: z.enum(["available", "unavailable", "not_configured"]),
    commerceMode: z.literal("contract_provisioning"),
});
export const statusWindow = z.enum(["1h", "6h", "24h"]);
export const statusSummaryQuery = z
    .object({ window: statusWindow.default("24h") })
    .strict();
const statusBucket = z.object({
    startedAt: date,
    requests: z.number().int().nonnegative(),
    averageLatencyMs: z.number().nonnegative().nullable(),
    errors4xx: z.number().int().nonnegative(),
    errors5xx: z.number().int().nonnegative(),
});
export const statusSummary = z.object({
    window: statusWindow,
    bucketSeconds: z.number().int().min(1),
    generatedAt: date,
    observedSince: date,
    coverageSeconds: z.number().int().min(1),
    uptimeSeconds: z.number().int().nonnegative(),
    requests: z.number().int().nonnegative(),
    requestsPerSecond: z.number().nonnegative(),
    latencyMs: z.object({
        average: z.number().nonnegative().nullable(),
        p50: z.number().nonnegative().nullable(),
        p95: z.number().nonnegative().nullable(),
    }),
    errors: z.object({
        client: z.number().int().nonnegative(),
        server: z.number().int().nonnegative(),
    }),
    series: z.array(statusBucket),
});
export const contactInput = z
    .object({
    name,
    email: z.string().email().max(254),
    organization: z.string().trim().min(1).max(150),
    country: z.string().min(1).max(100),
    project: z.string().min(1).max(100),
    message: z.string().max(5000),
    locale: z.enum(["es-lat", "en-us"]),
    consent: z.literal(true),
})
    .strict();
