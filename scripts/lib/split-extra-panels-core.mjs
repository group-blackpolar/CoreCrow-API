// Legacy cleanup for ADR 031 (a subcategory is its page): subcategories that still hold several panels keep ONE (their page) and every
// other panel moves to a NEW subcategory of the same category, with its content, revisions, permissions and bindings untouched
// (only `subcategoryId` changes). Nothing is deleted. Pure planning + an apply step over any `call(method, path, body)` transport.

const active = (item) => item.status !== "ARCHIVED";

/** The panel that stays: the one sharing the subcategory slug, else a SYSTEM panel, else the first by order (id breaks ties). */
export function pickPage(subcategory, panels) {
  return panels.find((panel) => panel.slug === subcategory.slug)
    ?? panels.find((panel) => panel.resourceKind === "SYSTEM")
    ?? [...panels].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id)))[0];
}

/** @returns {Array<{ category, subcategory, keep, moves: Array<{ panel, slug }> }>} one entry per subcategory with more than one active panel. */
export function planSplits(categories) {
  const plan = [];
  for (const category of categories) {
    const taken = new Set((category.subcategories ?? []).map((item) => item.slug));
    for (const subcategory of category.subcategories ?? []) {
      const panels = (subcategory.panels ?? []).filter(active);
      if (panels.length < 2) continue;
      const keep = pickPage(subcategory, panels);
      const moves = [];
      for (const panel of panels.filter((item) => item.id !== keep.id)) {
        let slug = panel.slug;
        for (let n = 2; taken.has(slug); n += 1) slug = `${panel.slug}-${n}`;
        taken.add(slug);
        moves.push({ panel, slug });
      }
      plan.push({ category, subcategory, keep, moves });
    }
  }
  return plan;
}

/** Executes the plan. Each extra panel gets a new subcategory (same name and slug) and is then moved into it. Stops at the first error. */
export async function applySplits(call, org, plan, log = globalThis.console.log) {
  for (const { category, subcategory, keep, moves } of plan) {
    log(`${category.slug}/${subcategory.slug}: keeps "${keep.slug}"`);
    for (const { panel, slug } of moves) {
      const created = (await call("POST", `${org}/categories/${category.id}/subcategories`, { name: panel.name, slug, ...(panel.icon ? { icon: panel.icon } : {}) })).json;
      await call("PATCH", `${org}/panels/${panel.id}`, { name: panel.name, slug: panel.slug, subcategoryId: created.id });
      log(`  moved panel "${panel.slug}" -> new subcategory ${category.slug}/${slug}`);
    }
  }
}
