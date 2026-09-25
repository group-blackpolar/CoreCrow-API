import { fail } from "../../shared/errors.js";
function configured(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > 10_000)
        fail(500, "NORTH_LIMIT_CONFIGURATION_INVALID", `${name} is invalid`);
    return value;
}
export function northResourceLimits() {
    return Object.freeze({
        categoriesPerOrganization: configured("NORTH_CATEGORY_LIMIT", 100),
        subcategoriesPerCategory: configured("NORTH_SUBCATEGORY_LIMIT", 100),
        panelsPerSubcategory: configured("NORTH_PANEL_LIMIT", 100),
        sectionsPerPanel: configured("NORTH_SECTION_LIMIT", 50),
        componentsPerPanel: configured("NORTH_COMPONENT_LIMIT", 100),
    });
}
