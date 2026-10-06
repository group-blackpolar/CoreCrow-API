// Builds src/fixtures/master-house-june-2026.json: FULLY SYNTHETIC maritime import data.
// Usage: node scripts/build-demo-fixture.mjs
// No real company, consignee, bill of lading or container is used. Names come from word lists,
// identifiers use the reserved DEMO prefixes, and the generator is seeded so the output is reproducible.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEED = 20260601;
const TARGET_ROWS = 6632;

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = prng(SEED);
const int = (min, max) => min + Math.floor(random() * (max - min + 1));
const pick = (list) => list[Math.floor(random() * list.length)];
/** Power-law pick: low indexes are chosen far more often, which gives realistic top-N rankings. */
const skewed = (list, exponent = 1.6) => list[Math.min(list.length - 1, Math.floor(list.length * random() ** exponent))];

const CARRIERS = [
  "NORDMAR LINE", "PACIFIC ARROW SHIPPING", "SEABRIDGE CONTAINER LINES", "AZURE TIDE LINES", "ORIENT HORIZON LINE",
  "CARIBE EXPRESS SHIPPING", "BLUE MERIDIAN LINES", "TRANSOCEAN ATLAS", "COBALT WAVE LINES", "SOLSTICE MARINE",
  "HARBORLIGHT CARRIERS", "ISTHMUS CONTAINER LINE",
];
const ARRIVAL_PORTS = [
  "ATLANTIC GATEWAY TERMINAL", "PACIFIC GATEWAY TERMINAL", "CARIBBEAN CONTAINER TERMINAL", "ISTHMUS PORTS COMPANY", "COSTA NORTE TERMINAL",
];
// Geography is public information, not company data.
const DEPARTURE_PORTS = [
  ["SHANGHAI", "CHINA"], ["NINGBO", "CHINA"], ["YANTIAN", "CHINA"], ["QINGDAO", "CHINA"], ["XIAMEN", "CHINA"], ["TIANJIN", "CHINA"], ["GUANGZHOU", "CHINA"],
  ["HONG KONG", "HONG KONG"], ["BUSAN", "KOREA (REPUBLIC OF)"], ["KAOHSIUNG", "TAIWAN"], ["SINGAPORE", "SINGAPORE"], ["PORT KLANG", "MALAYSIA"],
  ["HAIPHONG", "VIET NAM"], ["LAEM CHABANG", "THAILAND"], ["NHAVA SHEVA", "INDIA"], ["COLOMBO", "SRI LANKA"],
  ["HOUSTON, TX", "UNITED STATES OF AMERICA"], ["SAVANNAH, GA", "UNITED STATES OF AMERICA"], ["MIAMI, FL", "UNITED STATES OF AMERICA"], ["NEW YORK, NY", "UNITED STATES OF AMERICA"], ["LOS ANGELES, CA", "UNITED STATES OF AMERICA"],
  ["CARTAGENA", "COLOMBIA"], ["BUENAVENTURA", "COLOMBIA"], ["SANTOS, SP", "BRAZIL"], ["CALLAO", "PERU"], ["GUAYAQUIL", "ECUADOR"], ["VERACRUZ", "MEXICO"], ["MANZANILLO, MX", "MEXICO"],
  ["PUERTO QUETZAL", "GUATEMALA"], ["SAN ANTONIO", "CHILE"], ["BUENOS AIRES", "ARGENTINA"],
  ["VALENCIA", "SPAIN"], ["BARCELONA", "SPAIN"], ["ROTTERDAM", "NETHERLANDS"], ["ANTWERP", "BELGIUM"], ["HAMBURG", "GERMANY"], ["GENOA", "ITALY"], ["ALGECIRAS", "SPAIN"],
];
const TOP_PORTS = DEPARTURE_PORTS.slice(0, 16); // Asia dominates volume.

const FIRST = ["AURORA", "MERIDIAN", "ZENIT", "CORDILLERA", "ISTMO", "PACIFICA", "BOREAL", "DELTA", "ESMERALDA", "FENIX", "GAVIOTA", "HORIZONTE", "IRIS", "JADE", "KALEIDO", "LUMINA", "MONTEVERDE", "NEBULA", "OASIS", "PLEYADES", "QUASAR", "RIVIERA", "SIERRA", "TRAMONTANA", "UMBRAL", "VERTICE", "WAYRA", "XALAPA", "YUNQUE", "ZAFIRO", "ALBATROS", "BAHIA", "CORAL", "DUNA", "ECLIPSE", "FARO", "GLACIAR", "HELICE", "ISLOTE", "JAGUAR"];
const NOUNS = ["LOGISTICS", "CARGO", "FREIGHT", "TRADING", "FORWARDING", "SUPPLY CHAIN", "GLOBAL SERVICES", "SHIPPING AGENCY", "TRANSPORT", "CONSOLIDATION"];
const FORMS = ["S.A.", "INC", "CORP", "LLC", "S.A.", "LTD"];
const HOUSE_STYLE = ["IMPORTADORA", "DISTRIBUIDORA", "COMERCIAL", "INVERSIONES", "TECNO", "AGRO", "FARMA", "MUEBLES", "TEXTIL", "FERRETERIA", "ELECTRO", "AUTO", "CONSTRUCTORA", "ALIMENTOS", "QUIMICOS"];
const HOUSE_NOUN = ["DEL ISTMO", "CENTRAL", "DEL CARIBE", "PACIFICO", "NORTE", "ANDINA", "AMERICAS", "DEL VALLE", "MODERNA", "UNIVERSAL", "PANAMERICANA", "ATLAS", "CONTINENTAL", "DEL SUR", "GLOBAL"];

function unique(count, make) {
  const seen = new Set();
  while (seen.size < count) seen.add(make());
  return [...seen];
}
const MASTER_CONSIGNEES = unique(300, () => `${pick(FIRST)} ${pick(NOUNS)} ${pick(FORMS)}`);
const HOUSE_CONSIGNEES = unique(1650, () => `${pick(HOUSE_STYLE)} ${pick(HOUSE_NOUN)} ${pick(FIRST)} ${pick(FORMS)}`);

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const code = (length) => Array.from({ length }, () => alphabet[int(0, alphabet.length - 1)]).join("");
const digits = (length) => Array.from({ length }, () => int(0, 9)).join("");
const decimal = (value) => Number(value.toFixed(2)).toString();

const rows = [];
let masterIndex = 0;
while (rows.length < TARGET_ROWS) {
  masterIndex += 1;
  const masterConsignee = skewed(MASTER_CONSIGNEES);
  const carrier = skewed(CARRIERS, 1.3);
  const arrivalPort = skewed(ARRIVAL_PORTS, 1.4);
  const [masterPort, masterCountry] = random() < 0.78 ? skewed(TOP_PORTS, 1.3) : pick(DEPARTURE_PORTS);
  const day = int(1, 30);
  const arrival = `2026-06-${String(day).padStart(2, "0")}`;
  const masterBill = `DMST${digits(8)}`;
  const houseCount = int(1, 4);
  const houses = Array.from({ length: houseCount }, () => {
    const transship = random() < 0.15;
    const [port, country] = transship ? pick(DEPARTURE_PORTS) : [masterPort, masterCountry];
    return { consignee: skewed(HOUSE_CONSIGNEES, 1.5), bill: `DMH${masterIndex % 10}${code(8)}`, port, country };
  });
  const containers = int(1, 6);
  for (let index = 0; index < containers && rows.length < TARGET_ROWS; index += 1) {
    const house = pick(houses);
    const teus = random() < 0.7 ? 1 : 2;
    const weight = (teus === 1 ? 6 + random() * 12 : 14 + random() * 24);
    const hasMaster = random() < 0.63;
    const hasHouse = random() < 0.65;
    rows.push({
      arrival_date: arrival,
      master_carrier: carrier,
      master_consignee: masterConsignee,
      master_metric_tons: hasMaster ? decimal(weight) : null,
      master_port_arrival: arrivalPort,
      master_port_departure: masterPort,
      master_country_origin: masterCountry,
      master_teus: hasMaster ? String(teus) : null,
      master_bill_number: masterBill,
      container_number: `DEMU${digits(7)}`,
      house_carrier: carrier,
      house_consignee: house.consignee,
      house_metric_tons: hasHouse ? decimal(weight * (0.9 + random() * 0.2)) : null,
      house_port_arrival: arrivalPort,
      house_port_departure: house.port,
      house_country_origin: house.country,
      house_teus: hasHouse ? String(teus) : null,
      house_bill_number: house.bill,
    });
  }
}

const payload = {
  schemaVersion: 2,
  fixtureId: "master-house-june-2026",
  source: {
    period: "2026-06",
    sourceWorkbook: "synthetic-generator",
    sanitization: "Fully synthetic demonstration data (seed 20260601, scripts/build-demo-fixture.mjs). No real company, consignee, bill of lading or container.",
  },
  rows,
};
const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
writeFileSync(fileURLToPath(new URL("../src/fixtures/master-house-june-2026.json", import.meta.url)), bytes);
console.log(JSON.stringify({
  rows: rows.length, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
  masterBills: new Set(rows.map((row) => row.master_bill_number)).size,
  containers: new Set(rows.map((row) => row.container_number)).size,
  masterConsignees: new Set(rows.map((row) => row.master_consignee)).size,
  houseConsignees: new Set(rows.map((row) => row.house_consignee)).size,
}));
