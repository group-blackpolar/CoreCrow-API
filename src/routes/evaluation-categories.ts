import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { contract } from "../contracts/route.js";
import * as s from "../contracts/schemas.js";
import { evaluationCategories } from "../modules/evaluations/categories.js";

/** Evaluation categories (ADR 032) under /organizations/:organizationId/evaluation-categories. */
const key = z.string().regex(/^[a-z0-9][a-z0-9-]{0,78}$/);
const fields = {
  name: z.string().trim().min(1).max(80), description: z.string().max(500).nullable().optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  imageAssetId: z.string().min(1).max(128).nullable().optional(), position: z.number().int().min(0).max(1_000).optional(), status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
};
const counts = z.object({ total: z.number().int(), completed: z.number().int(), inProgress: z.number().int() });
const category = z.object({ id: s.id, key: z.string(), name: z.string(), description: z.string().nullable(), color: z.string(), imageAssetId: z.string().nullable(), status: z.enum(["ACTIVE", "ARCHIVED"]), position: z.number().int() });
const categoryParams = s.orgParams.extend({ categoryId: s.id });

export async function evaluationCategoryRoutes(app: FastifyInstance) {
  const base = "/organizations/:organizationId/evaluation-categories";
  const tag = "Evaluations";
  contract(app, { method: "GET", url: base, tag, summary: "Categories with the numbers of the caller: assigned exams, completed, in progress (needs evaluations.take or evaluations.read)", params: s.orgParams,
    query: z.object({ includeArchived: z.enum(["true", "false"]).optional() }).strict(),
    response: z.object({ categories: z.array(category.extend({ counts })), uncategorized: counts }),
    run: ({ user, params, query }) => evaluationCategories.list(user.id, params.organizationId, query.includeArchived === "true") });
  contract(app, { method: "GET", url: `${base}/:categoryId/image`, tag, summary: "Signed read of the category image (needs evaluations.take or evaluations.read; no north.asset.read required)", params: categoryParams,
    response: z.object({ download: s.northSignedObjectRequest }),
    run: ({ user, params }) => evaluationCategories.image(user.id, params.organizationId, params.categoryId) });
  contract(app, { method: "POST", url: base, tag, summary: "Create a category (needs evaluations.manage); 409 if the key exists", params: s.orgParams, status: 201,
    body: z.object({ key, ...fields }).strict(), response: category,
    run: ({ user, params, body }) => evaluationCategories.create(user.id, params.organizationId, body) });
  contract(app, { method: "PUT", url: `${base}/by-key/:key`, tag, summary: "Idempotent initializer: creates the category if the key is absent, otherwise returns it unchanged (needs evaluations.manage)", params: s.orgParams.extend({ key }),
    body: z.object(fields).strict(), response: z.object({ created: z.boolean(), category }),
    run: ({ user, params, body }) => evaluationCategories.ensure(user.id, params.organizationId, params.key, body) });
  contract(app, { method: "PATCH", url: `${base}/:categoryId`, tag, summary: "Edit name, description, color, image, order or status (needs evaluations.manage)", params: categoryParams,
    body: z.object({ ...fields, name: fields.name.optional() }).strict(), response: category,
    run: ({ user, params, body }) => evaluationCategories.update(user.id, params.organizationId, params.categoryId, body) });
}
