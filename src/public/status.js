/* global document, localStorage, matchMedia */
const root = document.documentElement;
const button = document.querySelector(".theme-toggle");

const preferredTheme = () => {
  const stored = localStorage.getItem("bp-theme");
  if (stored === "light" || stored === "dark") return stored;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

const applyTheme = (theme) => {
  root.dataset.theme = theme;
  if (!button) return;
  const dark = theme === "dark";
  button.setAttribute("aria-label", `Apariencia: ${dark ? "Oscuro" : "Claro"}`);
  button.setAttribute("title", `Cambiar a tema ${dark ? "claro" : "oscuro"}`);
};

applyTheme(preferredTheme());
button?.addEventListener("click", () => {
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("bp-theme", next);
  applyTheme(next);
});
