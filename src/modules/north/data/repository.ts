import type {
  NorthDatasetAclEffect,
  NorthDatasetAclPrincipalType,
  NorthDatasetFieldStatus,
  NorthDatasetFieldType,
  NorthDatasetStatus,
  TenantRole,
} from "../../../lib/database.js";
import { Prisma } from "../../../lib/database.js";
import type { Transaction } from "../../../shared/transaction.js";
import type { Localized } from "./types.js";

const schemaVersionInclude = {
  fields: { orderBy: { ordinal: "asc" as const } },
};

export const northDataRepository = {
  organization(tx: Transaction, organizationId: string) {
    return tx.organization.findUnique({ where: { id: organizationId } });
  },
  membership(tx: Transaction, organizationId: string, userId: string) {
    return tx.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      include: {
        user: { select: { status: true } },
        groupMemberships: { select: { groupId: true } },
      },
    });
  },
  ownerMemberships(tx: Transaction, organizationId: string) {
    return tx.membership.findMany({
      where: { organizationId, role: "OWNER", user: { status: "ACTIVE" } },
      include: {
        user: { select: { status: true } },
        groupMemberships: { select: { groupId: true } },
      },
    });
  },
  async organizationCapabilityGrants(
    tx: Transaction,
    membership: { id: string; organizationId: string; role: TenantRole },
    capability: string,
  ) {
    const [role, group, direct] = await Promise.all([
      tx.northRoleGrant.count({
        where: { organizationId: membership.organizationId, role: membership.role, capability, scope: "ORGANIZATION" },
      }),
      tx.northGroupGrant.count({
        where: {
          organizationId: membership.organizationId,
          capability,
          scope: "ORGANIZATION",
          group: { memberships: { some: { membershipId: membership.id } } },
        },
      }),
      tx.northMembershipGrant.count({
        where: { organizationId: membership.organizationId, membershipId: membership.id, capability, scope: "ORGANIZATION" },
      }),
    ]);
    return role + group + direct > 0;
  },
  datasets(tx: Transaction, organizationId: string) {
    return tx.northDataset.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
    });
  },
  dataset(tx: Transaction, organizationId: string, datasetId: string) {
    return tx.northDataset.findFirst({
      where: { id: datasetId, organizationId },
      include: { currentSchemaVersion: { include: schemaVersionInclude } },
    });
  },
  datasetBySlug(tx: Transaction, organizationId: string, slug: string) {
    return tx.northDataset.findUnique({ where: { organizationId_slug: { organizationId, slug } } });
  },
  createDataset(tx: Transaction, input: {
    organizationId: string;
    name: Localized;
    description?: Localized | null;
    slug: string;
    createdBy: string;
  }) {
    return tx.northDataset.create({
      data: {
        ...input,
        description: input.description === null ? Prisma.DbNull : input.description,
      } as Prisma.NorthDatasetUncheckedCreateInput,
    });
  },
  updateDataset(tx: Transaction, datasetId: string, input: {
    name?: Localized;
    description?: Localized | null;
    slug?: string;
    status?: NorthDatasetStatus;
  }) {
    return tx.northDataset.update({
      where: { id: datasetId },
      data: {
        ...input,
        ...(input.description === null ? { description: Prisma.DbNull } : {}),
      } as Prisma.NorthDatasetUncheckedUpdateInput,
    });
  },
  fields(tx: Transaction, organizationId: string, datasetId: string) {
    return tx.northDatasetField.findMany({
      where: { organizationId, datasetId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  },
  fieldsByIds(tx: Transaction, organizationId: string, datasetId: string, ids: string[]) {
    return tx.northDatasetField.findMany({ where: { organizationId, datasetId, id: { in: ids } } });
  },
  field(tx: Transaction, organizationId: string, datasetId: string, fieldId: string) {
    return tx.northDatasetField.findFirst({ where: { id: fieldId, datasetId, organizationId } });
  },
  createField(tx: Transaction, input: {
    organizationId: string;
    datasetId: string;
    key: string;
    displayName: Localized;
    description?: Localized | null;
    canonicalType: NorthDatasetFieldType;
    semanticType?: string | null;
    nullable: boolean;
  }) {
    return tx.northDatasetField.create({
      data: {
        ...input,
        description: input.description === null ? Prisma.DbNull : input.description,
      } as Prisma.NorthDatasetFieldUncheckedCreateInput,
    });
  },
  updateField(tx: Transaction, fieldId: string, input: {
    displayName?: Localized;
    description?: Localized | null;
    semanticType?: string | null;
    nullable?: boolean;
    status?: NorthDatasetFieldStatus;
  }) {
    return tx.northDatasetField.update({
      where: { id: fieldId },
      data: {
        ...input,
        ...(input.description === null ? { description: Prisma.DbNull } : {}),
      } as Prisma.NorthDatasetFieldUncheckedUpdateInput,
    });
  },
  nextSchemaVersion(tx: Transaction, datasetId: string) {
    return tx.northDatasetSchemaVersion.aggregate({ where: { datasetId }, _max: { version: true } });
  },
  async createSchemaVersion(tx: Transaction, input: {
    organizationId: string;
    datasetId: string;
    version: number;
    createdBy: string;
    fields: Array<{
      datasetFieldId: string;
      canonicalType: NorthDatasetFieldType;
      semanticType: string | null;
      nullable: boolean;
      status: NorthDatasetFieldStatus;
      ordinal: number;
    }>;
  }) {
    const schema = await tx.northDatasetSchemaVersion.create({
      data: {
        organizationId: input.organizationId,
        datasetId: input.datasetId,
        version: input.version,
        createdBy: input.createdBy,
      },
    });
    await tx.northDatasetSchemaVersionField.createMany({
      data: input.fields.map((field) => ({
        organizationId: input.organizationId,
        datasetId: input.datasetId,
        schemaVersionId: schema.id,
        ...field,
      })),
    });
    return tx.northDatasetSchemaVersion.findUniqueOrThrow({
      where: { id: schema.id },
      include: schemaVersionInclude,
    });
  },
  pointCurrentSchema(tx: Transaction, datasetId: string, schemaVersionId: string) {
    return tx.northDataset.update({ where: { id: datasetId }, data: { currentSchemaVersionId: schemaVersionId } });
  },
  schemaVersions(tx: Transaction, organizationId: string, datasetId: string) {
    return tx.northDatasetSchemaVersion.findMany({
      where: { organizationId, datasetId },
      include: schemaVersionInclude,
      orderBy: { version: "desc" },
    });
  },
  schemaVersion(tx: Transaction, organizationId: string, datasetId: string, schemaVersionId: string) {
    return tx.northDatasetSchemaVersion.findFirst({
      where: { id: schemaVersionId, organizationId, datasetId },
      include: schemaVersionInclude,
    });
  },
  aclRules(tx: Transaction, organizationId: string, datasetId: string) {
    return tx.northDatasetAcl.findMany({
      where: { organizationId, datasetId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  },
  aclRule(tx: Transaction, organizationId: string, datasetId: string, aclId: string) {
    return tx.northDatasetAcl.findFirst({ where: { id: aclId, organizationId, datasetId } });
  },
  createAclRule(tx: Transaction, input: {
    organizationId: string;
    datasetId: string;
    effect: NorthDatasetAclEffect;
    principalType: NorthDatasetAclPrincipalType;
    membershipId?: string;
    groupId?: string;
    role?: TenantRole;
    capability?: string;
    createdBy: string;
  }) {
    return tx.northDatasetAcl.create({ data: input });
  },
  deleteAclRule(tx: Transaction, aclId: string) {
    return tx.northDatasetAcl.delete({ where: { id: aclId } });
  },
  membershipPrincipal(tx: Transaction, organizationId: string, membershipId: string) {
    return tx.membership.findFirst({ where: { id: membershipId, organizationId }, select: { id: true } });
  },
  groupPrincipal(tx: Transaction, organizationId: string, groupId: string) {
    return tx.organizationGroup.findFirst({ where: { id: groupId, organizationId }, select: { id: true } });
  },
};
