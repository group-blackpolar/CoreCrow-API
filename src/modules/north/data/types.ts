import type {
  NorthDatasetAclEffect,
  NorthDatasetFieldStatus,
  NorthDatasetFieldType,
  NorthDatasetStatus,
  TenantRole,
} from "../../../lib/database.js";

export type Localized = Record<string, string>;

export type DatasetCreateInput = {
  name: Localized;
  description?: Localized | null;
  slug: string;
};

export type DatasetUpdateInput = {
  name?: Localized;
  description?: Localized | null;
  slug?: string;
  status?: NorthDatasetStatus;
};

export type DatasetFieldCreateInput = {
  key: string;
  displayName: Localized;
  description?: Localized | null;
  canonicalType: NorthDatasetFieldType;
  semanticType?: string | null;
  nullable?: boolean;
};

export type DatasetFieldUpdateInput = {
  displayName?: Localized;
  description?: Localized | null;
  semanticType?: string | null;
  nullable?: boolean;
  status?: NorthDatasetFieldStatus;
};

export type DatasetSchemaCreateInput = {
  fields: Array<{ fieldId: string; ordinal: number }>;
};

export type DatasetAclCreateInput =
  | { effect: NorthDatasetAclEffect; principalType: "ALL_MEMBERS" }
  | { effect: NorthDatasetAclEffect; principalType: "MEMBERSHIP"; membershipId: string }
  | { effect: NorthDatasetAclEffect; principalType: "GROUP"; groupId: string }
  | { effect: NorthDatasetAclEffect; principalType: "ROLE"; role: TenantRole }
  | { effect: NorthDatasetAclEffect; principalType: "CAPABILITY"; capability: string };
