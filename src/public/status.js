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
  button.setAttribute("aria-label", `Appearance: ${dark ? "Dark" : "Light"}`);
  button.setAttribute("title", `Switch to ${dark ? "light" : "dark"} theme`);
};

applyTheme(preferredTheme());
button?.addEventListener("click", () => {
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("bp-theme", next);
  applyTheme(next);
});

const chart = document.querySelector(".traffic-chart");
const tooltip = chart?.querySelector(".chart-tooltip");

const positionTooltip = (bar, pointer) => {
  if (!chart || !tooltip) return;
  const chartBox = chart.getBoundingClientRect();
  const barBox = bar.getBoundingClientRect();
  const x = pointer?.clientX ?? barBox.left + barBox.width / 2;
  const y = pointer?.clientY ?? barBox.top;
  tooltip.style.left = `${Math.max(12, Math.min(chartBox.width - 12, x - chartBox.left))}px`;
  tooltip.style.top = `${Math.max(12, y - chartBox.top - 12)}px`;
};

const showTooltip = (bar, pointer) => {
  if (!tooltip) return;
  tooltip.querySelector("strong").textContent = bar.dataset.time;
  tooltip.querySelector(".tooltip-requests").textContent =
    `${bar.dataset.requests} requests`;
  tooltip.querySelector(".tooltip-latency").textContent =
    `Average latency: ${bar.dataset.latency === "—" ? "No samples" : `${bar.dataset.latency} ms`}`;
  tooltip.querySelector(".tooltip-errors").textContent =
    `4xx ${bar.dataset.errors4xx} · 5xx ${bar.dataset.errors5xx}`;
  tooltip.hidden = false;
  positionTooltip(bar, pointer);
};

const hideTooltip = () => {
  if (tooltip) tooltip.hidden = true;
};

chart?.querySelectorAll(".traffic-bar").forEach((bar) => {
  bar.addEventListener("mouseenter", (event) => showTooltip(bar, event));
  bar.addEventListener("mousemove", (event) => positionTooltip(bar, event));
  bar.addEventListener("mouseleave", hideTooltip);
  bar.addEventListener("focus", () => showTooltip(bar));
  bar.addEventListener("blur", hideTooltip);
});
