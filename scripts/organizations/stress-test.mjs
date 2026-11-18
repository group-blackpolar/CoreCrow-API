// Stress Test (es: Pruebas de Estrés): the organization where Black Polar develops and validates ecosystem features.
// This file is configuration only: provisioning is scripts/provision-organization.mjs, the same for any organization.
// Categories are ordinary, administrable navigation (rename, reorder or delete them in Administration afterwards).
const entry = (slug, es, en, icon) => ({ slug, name: { es, en }, ...(icon ? { icon } : {}) });

export default {
  organization: { slug: "stress-test", name: "Stress Test", description: "Pruebas de Estrés" },
  // No standard home and no landing page: members open the first navigation entry. A landing can be configured later.
  hideSystemHome: true,
  landing: { mode: "NONE" },
  // Each entry opens a published starter page (the navigation lists only entries that have one); modules replace them later.
  panelPerSubcategory: { slug: "overview", note: { es: "Espacio de pruebas. Aquí se conectarán los módulos de esta área.", en: "Test space. This area's modules will be connected here." } },
  categories: [
    { ...entry("evaluations", "Evaluaciones", "Evaluations", "checklist"), subcategories: [
      entry("exams", "Exámenes", "Exams"), entry("forms", "Formularios", "Forms"), entry("question-bank", "Banco de preguntas", "Question bank"),
      entry("attempts-results", "Intentos y resultados", "Attempts and results"), entry("analytics", "Analíticas", "Analytics"),
    ] },
    { ...entry("ui-lab", "Laboratorio de UI", "UI Lab", "palette"), subcategories: [
      entry("components", "Componentes visuales", "Visual components"), entry("layouts", "Layouts", "Layouts"), entry("responsiveness", "Responsividad", "Responsiveness"),
      entry("animations", "Animaciones", "Animations"), entry("ui-states", "Estados de interfaz", "Interface states"),
    ] },
    { ...entry("data-lab", "Laboratorio de datos", "Data Lab", "database"), subcategories: [
      entry("test-datasets", "Datasets de prueba", "Test datasets"), entry("queries", "Consultas", "Queries"), entry("imports", "Importaciones", "Imports"),
      entry("performance-validation", "Validación de rendimiento", "Performance validation"),
    ] },
    { ...entry("security", "Seguridad", "Security", "shield-check"), subcategories: [
      entry("permissions", "Permisos", "Permissions"), entry("roles", "Roles", "Roles"), entry("sessions", "Sesiones", "Sessions"),
      entry("devices", "Dispositivos", "Devices"), entry("access-policies", "Políticas de acceso", "Access policies"),
    ] },
    { ...entry("ai-lab", "Laboratorio de IA", "AI Lab", "cpu"), subcategories: [
      entry("corecrow-chat", "CoreCrow Chat", "CoreCrow Chat"), entry("ai-models", "Modelos de IA", "AI models"), entry("integrations", "Integraciones", "Integrations"),
      entry("tool-tests", "Pruebas de herramientas", "Tool tests"),
    ] },
    { ...entry("performance", "Rendimiento", "Performance", "gauge"), subcategories: [
      entry("latency", "Latencia", "Latency"), entry("load", "Carga", "Load"), entry("db-queries", "Consultas", "Queries"),
      entry("rendering", "Renderizado", "Rendering"), entry("concurrency", "Pruebas de concurrencia controladas", "Controlled concurrency tests"),
    ] },
    { ...entry("automations", "Automatizaciones", "Automations", "refresh"), subcategories: [
      entry("workflows", "Workflows", "Workflows"), entry("events", "Eventos", "Events"), entry("automated-tasks", "Tareas automatizadas", "Automated tasks"),
    ] },
    { ...entry("monitoring", "Monitoreo", "Monitoring", "pulse"), subcategories: [
      entry("monitoring-events", "Eventos", "Events"), entry("metrics", "Métricas", "Metrics"), entry("errors", "Errores", "Errors"),
      entry("test-results", "Resultados de pruebas", "Test results"),
    ] },
  ],
};
