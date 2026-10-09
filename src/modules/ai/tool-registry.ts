import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Permission } from "../authorization/policy.js";
import { authorizeAI } from "./authorization.js";
import { tenants } from "../tenancy/service.js";
import { identities } from "../identity/repository.js";
import { fail } from "../../shared/errors.js";
import type { AIProviderTool } from "./provider.types.js";

export type AIToolContext = {
  userId: string;
  organizationId: string;
  application: "north";
};

export type RegisteredAITool = {
  name: string;
  description: string;
  application: "north";
  risk: "read" | "mutation";
  requiredPermissions: readonly Permission[];
  input: z.ZodTypeAny;
  handler: (context: AIToolContext, input: unknown) => Promise<unknown>;
};

export function aiUserProfile(user: { id: string; email: string; name: string | null }) {
  return { id: user.id, email: user.email, name: user.name };
}

/** The caller's own authorization summary: role and permission names only, never other members' data. */
export function aiUserPermissions(tenant: { member: { role: string }; permissions: readonly string[] }) {
  return { role: tenant.member.role, permissions: [...tenant.permissions] };
}

export function aiOrganization<T extends {
  id: string;
  name: string;
  slug: string;
  status: string;
}>(organization: T) {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    status: organization.status,
  };
}

export function aiOrganizationMembers<T extends { userId: string; role: string }>(
  memberships: T[],
) {
  return memberships.map((membership) => ({
    userId: membership.userId,
    role: membership.role,
  }));
}

const noInput = z.object({}).strict();
const tools: RegisteredAITool[] = [
  {
    name: "organization.current",
    description: "Read the active organization selected for this conversation.",
    application: "north",
    risk: "read",
    requiredPermissions: ["organization.read"],
    input: noInput,
    handler: async (context) => {
      const organization = await tenants.read(context.userId, context.organizationId);
      if (!organization) fail(404, "NOT_FOUND", "Organization not found");
      return aiOrganization(organization);
    },
  },
  {
    name: "organization.members.list",
    description: "List up to 100 members of the active organization.",
    application: "north",
    risk: "read",
    requiredPermissions: ["members.read"],
    input: noInput,
    handler: async (context) =>
      aiOrganizationMembers(await tenants.members(context.userId, context.organizationId)),
  },
  {
    name: "user.permissions",
    description: "Read the authenticated user's own role and effective permissions in the active organization. Use it before explaining what the user can or cannot do.",
    application: "north",
    risk: "read",
    requiredPermissions: ["organization.read"],
    input: noInput,
    handler: async (context) => {
      const tenant = await authorizeAI(context.userId, context.organizationId, ["organization.read"]);
      return aiUserPermissions(tenant);
    },
  },
  {
    name: "user.me",
    description: "Read the authenticated user's non-secret identity profile.",
    application: "north",
    risk: "read",
    requiredPermissions: ["organization.read"],
    input: noInput,
    handler: async (context) => {
      await authorizeAI(context.userId, context.organizationId, ["organization.read"]);
      const user = await identities.get(context.userId);
      if (!user) fail(404, "NOT_FOUND", "User not found");
      return aiUserProfile(user);
    },
  },
];

export class AIToolRegistry {
  constructor(
    private readonly registered = tools,
    private readonly authorizer: typeof authorizeAI = authorizeAI,
  ) {}

  async available(context: AIToolContext) {
    const tenant = await this.authorizer(context.userId, context.organizationId, []);
    return this.registered.filter((tool) =>
      tool.application === context.application &&
      tool.requiredPermissions.every((permission) => tenant.permissions.includes(permission)),
    );
  }

  providerTools(available: RegisteredAITool[]): AIProviderTool[] {
    return available.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.input, { target: "openApi3", $refStrategy: "none" }) as Record<string, unknown>,
    }));
  }

  async execute(context: AIToolContext, name: string, rawInput: unknown) {
    const available = await this.available(context);
    const tool = available.find((candidate) => candidate.name === name);
    if (!tool) fail(422, "AI_TOOL_UNAVAILABLE", "AI tool is unavailable");
    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) fail(422, "AI_INVALID_TOOL_CALL", "AI tool arguments are invalid");
    if (tool.risk !== "read")
      fail(409, "AI_CONFIRMATION_REQUIRED", "AI mutation requires confirmation");
    await this.authorizer(context.userId, context.organizationId, tool.requiredPermissions);
    return { tool, result: await tool.handler(context, parsed.data) };
  }

  find(name: string) { return this.registered.find((tool) => tool.name === name); }
}

export const aiTools = new AIToolRegistry();

