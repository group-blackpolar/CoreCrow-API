// Declarative, idempotent initial categories of the evaluations module (DATA for scripts/import-evaluation.mjs). A category that already exists
// (same key) is never modified: from then on it belongs to its administrators. `evaluations` lists evaluation keys to assign when they have no category.
export default {
  categories: [
    { key: "lectura-critica", name: "Lectura Crítica", description: "Simulacros de comprensión, interpretación y análisis crítico de textos y lecturas.", color: "#4f46e5", evaluations: ["lectura-critica-principito-01", "lectura-critica-naranja-lima-02"] },
    { key: "ingles", name: "Inglés", description: "Evaluaciones de comprensión y uso del idioma inglés.", color: "#0f766e", evaluations: [] },
  ],
};
