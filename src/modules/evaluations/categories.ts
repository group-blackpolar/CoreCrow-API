import { fail } from "../../shared/errors.js";
import { transaction } from "../../shared/transaction.js";
import { auditRepository as audit } from "../audit/repository.js";
import { authorize, resolvePermissions } from "../authorization/service.js";
import { northAssets } from "../north/asset-service.js";
import { evaluations } from "./service.js";

/**
 * ADR 032. Administrable, persistent evaluation categories. Reading needs evaluations.take or evaluations.read; writing needs
 * evaluations.manage. A category never decides who may take an exam (assignments do): the counts a person sees are computed from the
 * evaluations assigned to them. `ensure` is the idempotent initializer: it creates a missing category by key and never touches an existing one.
 */
export type CategoryInput = { name: string; description?: string | null; color?: string; imageAssetId?: string | null; position?: number; status?: "ACTIVE" | "ARCHIVED" };

const view = (row: { id: string; key: string; name: string; description: string | null; color: string; imageAssetId: string | null; status: string; position: number }) =>
  ({ id: row.id, key: row.key, name: row.name, description: row.description, color: row.color, imageAssetId: row.imageAssetId, status: row.status as "ACTIVE" | "ARCHIVED", position: row.position });

async function checkImage(tx: Parameters<typeof northAssets.validateReference>[3], userId: string, organizationId: string, assetId: string | null | undefined) {
  if (assetId && !(await northAssets.validateReference(userId, organizationId, assetId, tx))) fail(422, "CROSS_TENANT_RESOURCE", "Image is outside the organization or unavailable");
}

export const evaluationCategories = {
  /** Categories with the numbers of the caller (assigned exams, completed, in progress). Assigned exams without a category are reported separately. */
  async list(userId: string, organizationId: string, includeArchived = false) {
    const { permissions } = await transaction((tx) => resolvePermissions(tx, userId, organizationId));
    const has = (permission: string) => (permissions as readonly string[]).includes(permission);
    if (!has("evaluations.take") && !has("evaluations.read")) fail(403, "FORBIDDEN", "Not allowed");
    const assigned = has("evaluations.take") ? await evaluations.available(userId, organizationId) : [];
    const rows = await transaction((tx) => tx.evaluationCategory.findMany({ where: { organizationId, ...(includeArchived && has("evaluations.manage") ? {} : { status: "ACTIVE" }) }, orderBy: [{ position: "asc" }, { name: "asc" }], take: 100 }));
    const count = (list: typeof assigned) => ({ total: list.length, completed: list.filter((row) => row.state === "COMPLETED").length, inProgress: list.filter((row) => row.state === "IN_PROGRESS").length });
    return {
      categories: rows.map((row) => ({ ...view(row), counts: count(assigned.filter((exam) => exam.categoryId === row.id)) })),
      uncategorized: count(assigned.filter((exam) => !exam.categoryId || !rows.some((row) => row.id === exam.categoryId))),
    };
  },
  create(userId: string, organizationId: string, input: CategoryInput & { key: string }) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.manage");
      if (await tx.evaluationCategory.count({ where: { organizationId, key: input.key } })) fail(409, "EVALUATION_CATEGORY_KEY_TAKEN", "A category with this key already exists");
      await checkImage(tx, userId, organizationId, input.imageAssetId);
      const row = await tx.evaluationCategory.create({ data: { organizationId, key: input.key, name: input.name, description: input.description ?? null, color: input.color ?? "#4f46e5", imageAssetId: input.imageAssetId ?? null, position: input.position ?? 0, status: input.status ?? "ACTIVE", createdBy: userId } });
      await audit.append(tx, { actorId: userId, organizationId, action: "EVALUATION_CATEGORY_CREATED", targetType: "EvaluationCategory", targetId: row.id, metadata: { key: row.key } });
      return view(row);
    });
  },
  /** Idempotent initialization: creates the category if its key is absent, otherwise returns it untouched (its content then belongs to its editors). */
  async ensure(userId: string, organizationId: string, key: string, input: CategoryInput) {
    const existing = await transaction(async (tx) => { await authorize(tx, userId, organizationId, "evaluations.manage"); return tx.evaluationCategory.findFirst({ where: { organizationId, key } }); });
    if (existing) return { created: false, category: view(existing) };
    try { return { created: true, category: await evaluationCategories.create(userId, organizationId, { ...input, key }) }; }
    catch (error) { // a concurrent initializer won the race: the unique key makes the second one a no-op
      const again = await transaction((tx) => tx.evaluationCategory.findFirst({ where: { organizationId, key } }));
      if (again) return { created: false, category: view(again) };
      throw error;
    }
  },
  update(userId: string, organizationId: string, id: string, patch: Partial<CategoryInput>) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.manage");
      const current = (await tx.evaluationCategory.findFirst({ where: { id, organizationId } })) ?? fail(404, "NOT_FOUND", "Category not found");
      await checkImage(tx, userId, organizationId, patch.imageAssetId);
      const row = await tx.evaluationCategory.update({ where: { id: current.id }, data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}), ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.imageAssetId !== undefined ? { imageAssetId: patch.imageAssetId } : {}), ...(patch.position !== undefined ? { position: patch.position } : {}), ...(patch.status !== undefined ? { status: patch.status } : {}),
      } });
      await audit.append(tx, { actorId: userId, organizationId, action: "EVALUATION_CATEGORY_UPDATED", targetType: "EvaluationCategory", targetId: row.id, metadata: { fields: Object.keys(patch) } });
      return view(row);
    });
  },
};
