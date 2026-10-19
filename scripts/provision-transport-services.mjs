// In-process transport for scripts/provision-view.mjs: the same operations the provisioner performs over HTTP, executed through the
// SAME application services the routes call, as one named ACTOR (a real account that must be a member of the organization; every
// authorization rule, audit entry and validation applies to that actor exactly as for an HTTP request).
//
// Why it exists: an operator on the server has no browser session. Nothing here creates a session, bypasses authorization or
// writes SQL; it only avoids the HTTP hop. Use it only when the actor account's owner has authorized the run.
//
//   node scripts/provision-view.mjs <definition.mjs> --org <slug> --publish --in-process --actor <email> [--dist /app/dist]
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const fail = (status, message) => Object.assign(new Error(message), { status });
const asHttpError = (error) => {
  if (error && typeof error === "object" && "statusCode" in error) return Object.assign(new Error(`${error.code ?? "ERROR"} ${error.message}`), { status: error.statusCode });
  return error;
};

export async function servicesTransport({ dist, actorEmail }) {
  const load = (path) => import(pathToFileURL(resolve(dist, path)).href);
  const [{ prisma }, { tenants }, { northTaxonomy }, { northData }, { northAnalyticsBindings }, content, { northAssets }] = await Promise.all([
    load("lib/database.js"), load("modules/tenancy/service.js"), load("modules/north/service.js"), load("modules/north/data/service.js"),
    load("modules/north/data/binding-service.js"), load("modules/north/content-service.js"), load("modules/north/asset-service.js"),
  ]);
  const { northContent } = content;
  // The same reference resolvers buildApp() installs, so a draft's asset/binding references are validated exactly as over HTTP.
  content.configureNorthContentReferenceResolvers({
    validateAssetReference: (organizationId, assetId, actorId, tx) => northAssets.validateReference(actorId, organizationId, assetId, tx),
    validateBindingReference: (organizationId, binding, actorId, tx, panelId) => northAnalyticsBindings.validateReference(organizationId, binding, actorId, tx, panelId),
  });
  const actor = await prisma.user.findUnique({ where: { email: actorEmail }, select: { id: true, status: true } });
  if (!actor || actor.status !== "ACTIVE") throw fail(404, `Actor ${actorEmail} not found or not active`);
  const user = actor.id;
  const ok = (json, etag) => ({ json, etag: etag ?? null });

  const call = async (method, path, body, headers = {}) => {
    try {
      let match;
      if (method === "GET" && path === "/organizations") return ok(await tenants.list(user));
      if ((match = /^\/organizations\/([^/]+)\/datasets$/.exec(path)) && method === "GET") return ok(await northData.list(user, match[1]));
      if ((match = /^\/organizations\/([^/]+)\/datasets\/([^/]+)\/fields$/.exec(path)) && method === "GET") return ok(await northData.fields(user, match[1], match[2]));
      // Taxonomy creation (a definition may bring its own category, subcategories and panels): the same service calls the routes make.
      if (method === "POST" && (match = /^\/organizations\/([^/]+)\/categories$/.exec(path))) return ok(await northTaxonomy.createCategory(user, match[1], body));
      if (method === "POST" && (match = /^\/organizations\/([^/]+)\/categories\/([^/]+)\/subcategories$/.exec(path))) return ok(await northTaxonomy.createSubcategory(user, match[1], match[2], body));
      if (method === "POST" && (match = /^\/organizations\/([^/]+)\/subcategories\/([^/]+)\/panels$/.exec(path))) return ok(await northTaxonomy.createPanel(user, match[1], match[2], body));
      if (method === "PATCH" && (match = /^\/organizations\/([^/]+)\/categories\/([^/]+)$/.exec(path))) return ok(await northTaxonomy.updateCategory(user, match[1], match[2], body));
      if (method === "PATCH" && (match = /^\/organizations\/([^/]+)\/subcategories\/([^/]+)$/.exec(path))) return ok(await northTaxonomy.updateSubcategory(user, match[1], match[2], body));
      if (method === "PATCH" && (match = /^\/organizations\/([^/]+)\/panels\/([^/]+)$/.exec(path))) return ok(await northTaxonomy.updatePanel(user, match[1], match[2], body));
      if ((match = /^\/organizations\/([^/]+)\/north\/management-tree$/.exec(path)) && method === "GET") return ok(await northTaxonomy.managementTree(user, match[1]));
      if ((match = /^\/organizations\/([^/]+)\/panels\/([^/]+)\/analytics-bindings$/.exec(path))) {
        if (method === "GET") return ok(await northAnalyticsBindings.list(user, match[1], match[2]));
        if (method === "POST") return ok(await northAnalyticsBindings.create(user, match[1], match[2], body));
      }
      if ((match = /^\/organizations\/([^/]+)\/panels\/([^/]+)\/analytics-bindings\/([^/]+)$/.exec(path)) && method === "PUT") return ok(await northAnalyticsBindings.update(user, match[1], match[2], match[3], body));
      if ((match = /^\/organizations\/([^/]+)\/panels\/([^/]+)\/draft$/.exec(path))) {
        if (method === "GET") { const revision = await northContent.draft(user, match[1], match[2]); return ok(revision, revision.etag); }
        if (method === "PATCH") { const revision = await northContent.saveDraft(user, match[1], match[2], headers["if-match"], body); return ok(revision, revision.etag); }
      }
      if ((match = /^\/organizations\/([^/]+)\/panels\/([^/]+)\/draft\/validate$/.exec(path)) && method === "POST") return ok(await northContent.validateDraft(user, match[1], match[2]));
      if ((match = /^\/organizations\/([^/]+)\/panels\/([^/]+)\/publish$/.exec(path)) && method === "POST") { const revision = await northContent.publish(user, match[1], match[2], headers["if-match"]); return ok(revision, revision.etag); }
    } catch (error) { throw asHttpError(error); }
    throw fail(501, `In-process transport does not support ${method} ${path}; create missing categories/subcategories/panels first (this definition expects them to exist).`);
  };
  return { call, close: () => prisma.$disconnect() };
}
