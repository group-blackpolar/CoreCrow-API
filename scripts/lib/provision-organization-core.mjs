// Declarative, idempotent organization provisioning on top of the NORMAL API surface (organizations, navigation taxonomy,
// landing policy). Nothing here is specific to an organization: the definition file is the data. `call(method, path, body, headers)`
// is the same contract scripts/provision-view.mjs uses (HTTP with a session, or the in-process services transport), so every
// authorization rule, validation and audit entry of the acting account applies.
//
// definition = {
//   organization: { slug, name, description? },
//   hideSystemHome?: boolean,                       // the empty system Home is not shown in the navigation
//   panelPerSubcategory?: { slug, note?: {es,en} }, // seed one published starter panel per subcategory (navigation lists only subcategories with a panel)
//   landing: { mode: "STANDARD" | "PANEL" | "NONE" }, // PANEL needs `panelSlug: [category, subcategory, panel]`
//   categories: [{ slug, name: {es,en}, icon?, color?, subcategories?: [{ slug, name: {es,en}, icon? }] }],
// }
// Re-running changes nothing that already matches and converges the declared entries back to the definition. Matched by slug, never deleted here
// (extra entries added by administrators are left alone).

const cell = { desktop: { x: 0, y: 0, w: 12, h: 2 }, tablet: { x: 0, y: 0, w: 12, h: 2 }, mobile: { x: 0, y: 0, w: 12, h: 2 } };
/** Starter content of a panel: the subcategory title and an optional note. Seeded once; later edits belong to administrators. */
const starterDocument = (title, note) => ({
  schemaVersion: 1, defaultLocale: "es", fallbackLocales: ["en"],
  sections: [{ id: "main", order: 0, layout: { variant: "grid", gap: "md" }, components: [
    { id: "title", type: "heading", schemaVersion: 1, props: { text: title, level: 1 }, bindings: {}, layout: cell, order: 0 },
    ...(note ? [{ id: "note", type: "card", schemaVersion: 1, props: { title: note.title ?? title, body: note.body }, bindings: {}, layout: { desktop: { x: 0, y: 2, w: 12, h: 3 }, tablet: { x: 0, y: 2, w: 12, h: 3 }, mobile: { x: 0, y: 2, w: 12, h: 3 } }, order: 1 }] : []),
  ] }],
});

// Key order is not significant (JSONB returns keys sorted).
const canonical = (value) => JSON.stringify(value ?? null, (_key, item) => (item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))) : item));
const same = (a, b) => canonical(a) === canonical(b);

export async function reconcileOrganization(call, definition, log = () => {}) {
  const wanted = definition.organization;
  const summary = { organizationCreated: false, organizationUpdated: false, categoriesCreated: 0, categoriesUpdated: 0, subcategoriesCreated: 0, subcategoriesUpdated: 0, panelsSeeded: 0, landingUpdated: false };

  let organization = (await call("GET", "/organizations")).json.find((item) => item.slug === wanted.slug);
  if (!organization) {
    organization = (await call("POST", "/organizations", { name: wanted.name, slug: wanted.slug })).json;
    summary.organizationCreated = true;
    log(`created organization ${wanted.slug}`);
  }
  const patch = {};
  if (organization.name !== wanted.name) patch.name = wanted.name;
  if (wanted.description !== undefined && (organization.description ?? null) !== wanted.description) patch.description = wanted.description;
  if (Object.keys(patch).length) {
    organization = (await call("PATCH", `/organizations/${organization.id}`, patch)).json;
    summary.organizationUpdated = true;
  }
  const base = `/organizations/${organization.id}`;

  const readTree = async () => { const tree = (await call("GET", `${base}/north/management-tree`)).json; return tree.categories ?? tree; };
  let tree = await readTree();

  if (definition.hideSystemHome) {
    const home = tree.find((item) => item.slug === "home" && item.resourceKind === "SYSTEM");
    if (home && !home.navigationHidden) await call("PATCH", `${base}/categories/${home.id}`, { navigationHidden: true });
  }

  for (const [categoryIndex, wantedCategory] of (definition.categories ?? []).entries()) {
    const metadata = (entry, order) => ({ name: entry.name, ...(entry.icon ? { icon: entry.icon } : {}), ...(entry.color ? { color: entry.color } : {}), order });
    let category = tree.find((item) => item.slug === wantedCategory.slug);
    if (!category) {
      category = (await call("POST", `${base}/categories`, { ...metadata(wantedCategory, categoryIndex), slug: wantedCategory.slug })).json;
      summary.categoriesCreated += 1;
    } else if (!same(category.name, wantedCategory.name) || (wantedCategory.icon && category.icon !== wantedCategory.icon) || category.order !== categoryIndex || category.navigationHidden) {
      await call("PATCH", `${base}/categories/${category.id}`, { ...metadata(wantedCategory, categoryIndex), navigationHidden: false });
      summary.categoriesUpdated += 1;
    }
    const existing = tree.find((item) => item.slug === wantedCategory.slug)?.subcategories ?? [];
    for (const [subIndex, wantedSub] of (wantedCategory.subcategories ?? []).entries()) {
      const current = existing.find((item) => item.slug === wantedSub.slug);
      if (!current) {
        await call("POST", `${base}/categories/${category.id}/subcategories`, { ...metadata(wantedSub, subIndex), slug: wantedSub.slug });
        summary.subcategoriesCreated += 1;
      } else if (!same(current.name, wantedSub.name) || (wantedSub.icon && current.icon !== wantedSub.icon) || current.order !== subIndex || current.navigationHidden) {
        await call("PATCH", `${base}/subcategories/${current.id}`, { ...metadata(wantedSub, subIndex), navigationHidden: false });
        summary.subcategoriesUpdated += 1;
      }
    }
  }

  if (definition.panelPerSubcategory) {
    tree = await readTree();
    for (const wantedCategory of definition.categories ?? []) {
      const category = tree.find((item) => item.slug === wantedCategory.slug);
      for (const wantedSub of wantedCategory.subcategories ?? []) {
        const subcategory = category?.subcategories?.find((item) => item.slug === wantedSub.slug);
        if (!subcategory) continue;
        const { slug, note } = definition.panelPerSubcategory;
        let panel = (subcategory.panels ?? []).find((item) => item.slug === slug);
        if (!panel) panel = (await call("POST", `${base}/subcategories/${subcategory.id}/panels`, { name: wantedSub.name, slug, order: 0 })).json;
        if (panel.status === "PUBLISHED") continue; // already seeded (or taken over by an administrator)
        const document = starterDocument(wantedSub.name, note && { body: note });
        let ifMatch;
        try { ifMatch = (await call("GET", `${base}/panels/${panel.id}/draft`)).etag; } catch (error) { if (error.status !== 404) throw error; }
        await call("PATCH", `${base}/panels/${panel.id}/draft`, { document, message: "Provisioned from definition" }, ifMatch ? { "if-match": ifMatch } : {});
        const report = (await call("POST", `${base}/panels/${panel.id}/draft/validate`)).json;
        if (!report.valid) throw new Error(`starter panel ${wantedCategory.slug}/${wantedSub.slug} is not valid: ${JSON.stringify(report.issues)}`);
        await call("POST", `${base}/panels/${panel.id}/publish`, undefined, { "if-match": report.etag });
        summary.panelsSeeded += 1;
      }
    }
  }

  if (definition.landing) {
    tree = await readTree();
    let defaultPanelId = null;
    if (definition.landing.mode === "PANEL") {
      const [categorySlug, subcategorySlug, panelSlug] = definition.landing.panelSlug ?? [];
      defaultPanelId = tree.find((c) => c.slug === categorySlug)?.subcategories?.find((s) => s.slug === subcategorySlug)?.panels?.find((p) => p.slug === panelSlug)?.id;
      if (!defaultPanelId) throw new Error("landing.panelSlug does not match a panel of this organization");
    }
    const current = (await call("GET", `${base}/landing`)).json;
    const wantedRules = definition.landing.rules ?? [];
    if (current.mode !== definition.landing.mode || (current.defaultPanelId ?? null) !== defaultPanelId || !same(current.rules.map(({ order: _o, ...rule }) => rule), wantedRules)) {
      await call("PUT", `${base}/landing`, { mode: definition.landing.mode, defaultPanelId, rules: wantedRules, expectedUpdatedAt: current.updatedAt });
      summary.landingUpdated = true;
    }
  }
  return { organizationId: organization.id, ...summary };
}
