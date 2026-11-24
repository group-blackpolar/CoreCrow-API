// Stress Test (es: Pruebas de Estrés): the organization where Black Polar develops and validates ecosystem features.
// This file is configuration only: provisioning is scripts/provision-organization.mjs, the same for any organization.
// Stress Test is only for exams: Evaluations is its single content category (the other laboratories were removed on request, 2026-11-24).
// Categories are ordinary, administrable navigation (rename, reorder or delete them in Administration afterwards).
const entry = (slug, es, en, icon) => ({ slug, name: { es, en }, ...(icon ? { icon } : {}) });
// An entry whose starter page hosts the evaluations workspace (builder / player / results, each shown only to members allowed to use it).
const workspace = (slug, es, en, props) => ({ ...entry(slug, es, en), component: { id: "evaluations", type: "evaluation_workspace", props } });

export default {
  organization: { slug: "stress-test", name: "Stress Test", description: "Pruebas de Estrés" },
  // No standard home and no landing page: members open the first navigation entry. A landing can be configured later.
  hideSystemHome: true,
  landing: { mode: "NONE" },
  // Each entry opens a published starter page (the navigation lists only entries that have one); modules replace them later.
  panelPerSubcategory: { slug: "overview", note: { es: "Espacio de pruebas. Aquí se conectarán los módulos de esta área.", en: "Test space. This area's modules will be connected here." } },
  categories: [
    { ...entry("evaluations", "Evaluaciones", "Evaluations", "checklist"), subcategories: [
      workspace("exams", "Exámenes", "Exams", { views: ["builder", "player", "results"], kind: "EXAM" }), workspace("forms", "Formularios", "Forms", { views: ["builder", "player", "results"], kind: "FORM" }),
      entry("question-bank", "Banco de preguntas", "Question bank"),
      workspace("attempts-results", "Intentos y resultados", "Attempts and results", { views: ["results"] }), entry("analytics", "Analíticas", "Analytics"),
    ] },
  ],
};
