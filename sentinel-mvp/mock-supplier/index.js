import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");

  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);

    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  }
}

loadEnv();

const PORT = Number(process.env.SUPPLIER_PORT || 4000);
const SENTINEL_URL = process.env.SENTINEL_URL || "http://localhost:3000";

/*
|--------------------------------------------------------------------------
| Operation registry
|--------------------------------------------------------------------------
|
| These are seeded from Sentinel's current demo-data.json.
|
| IMPORTANT:
| This is NOT a fixed list of four logistics systems.
|
| When Sentinel sends a request for an operation that isn't here,
| the hub automatically creates a new regional hub for it.
|
*/

const operations = new Map([
  [
    "op-odisha-cyclone",
    {
      id: "op-odisha-cyclone",
      name: "Cyclone Response",
      disasterType: "Cyclone",
      country: "India",
      region: "Odisha",
      authority: "State EOC / Odisha SDMA",
      zones: [
        ["OD-KEN", "Kendrapara"],
        ["OD-BAL", "Balasore"],
        ["OD-BHA", "Bhadrak"],
        ["OD-PUR", "Puri"],
        ["OD-JAG", "Jagatsinghpur"],
        ["OD-KHU", "Khordha"],
      ],
    },
  ],

  [
    "op-assam-flood",
    {
      id: "op-assam-flood",
      name: "Monsoon Flood Response",
      disasterType: "Flood",
      country: "India",
      region: "Assam",
      authority: "State EOC / ASDMA",
      zones: [
        ["AS-DHE", "Dhemaji"],
        ["AS-LAK", "Lakhimpur"],
        ["AS-DIB", "Dibrugarh"],
        ["AS-JOR", "Jorhat"],
      ],
    },
  ],

  [
    "op-sikkim-landslide",
    {
      id: "op-sikkim-landslide",
      name: "Monsoon Landslide Response",
      disasterType: "Landslide",
      country: "India",
      region: "Sikkim",
      authority: "State EOC / Sikkim SDMA",
      zones: [
        ["SK-GAN", "Gangtok"],
        ["SK-NAM", "Namchi"],
        ["SK-PAK", "Pakyong"],
      ],
    },
  ],

  [
    "op-nepal-flood",
    {
      id: "op-nepal-flood",
      name: "Terai Flood Response",
      disasterType: "Flood",
      country: "Nepal",
      region: "Terai",
      authority: "NEOC / Local EOC",
      zones: [
        ["NP-MOR", "Morang"],
        ["NP-SUN", "Sunsari"],
        ["NP-JHA", "Jhapa"],
        ["NP-SAP", "Saptari"],
      ],
    },
  ],
]);

/*
|--------------------------------------------------------------------------
| Runtime state
|--------------------------------------------------------------------------
*/

const requests = new Map();
const subscribers = new Map();

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function now() {
  return new Date().toISOString();
}

function operationFromRequest(request) {
  return operations.get(request.operationId);
}

function getOperation(operationId) {
  return operations.get(operationId);
}

function getZone(operation, zoneId) {
  if (!operation) return null;

  const zone = operation.zones.find(([id]) => id === zoneId);

  if (!zone) return null;

  return {
    id: zone[0],
    name: zone[1],
  };
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });

  res.end(JSON.stringify(data));
}

function html(res, status, content) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });

  res.end(content);
}

async function readBody(req) {
  if (req.body) {
    if (typeof req.body === "object") return req.body;
    if (typeof req.body === "string") {
      try {
        return JSON.parse(req.body);
      } catch {
        return {};
      }
    }
  }

  let body = "";

  for await (const chunk of req) {
    body += chunk;
  }

  if (!body) return {};

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

/*
|--------------------------------------------------------------------------
| Dynamic operation registration
|--------------------------------------------------------------------------
|
| If Sentinel later introduces:
|
|   op-kerala-flood
|   op-gujarat-cyclone
|   op-west-bengal-flood
|
| the hub can still accept the request.
|
*/

function ensureOperation(request) {
  if (operations.has(request.operationId)) {
    return operations.get(request.operationId);
  }

  const operation = {
    id: request.operationId,
    name: request.operationName || request.operationId,
    disasterType: request.disasterType || "Disaster Response",
    country: request.country || "Unknown",
    region: request.state || request.region || request.country || "Regional",
    authority: request.authority || "Regional Emergency Operations Centre",
    zones: [],
  };

  operations.set(operation.id, operation);

  return operation;
}

/*
|--------------------------------------------------------------------------
| Real-time browser updates
|--------------------------------------------------------------------------
*/

function broadcast(operationId, event, data) {
  const clients = subscribers.get(operationId);

  if (!clients) return;

  const payload = `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;

  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // Client disconnected.
    }
  }
}

function subscribe(operationId, res) {
  if (!subscribers.has(operationId)) {
    subscribers.set(operationId, new Set());
  }

  subscribers.get(operationId).add(res);

  res.on("close", () => {
    subscribers.get(operationId)?.delete(res);

    if (subscribers.get(operationId)?.size === 0) {
      subscribers.delete(operationId);
    }
  });
}

/*
|--------------------------------------------------------------------------
| Notify Sentinel
|--------------------------------------------------------------------------
*/

async function updateSentinel(dispatch, status, extra = {}, sentinelBase = null) {
  const base =
    sentinelBase || process.env.SENTINEL_URL || "http://localhost:3000";

  try {
    const response = await fetch(
      `${base}/api/relief/dispatch/${dispatch.id}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status,
          source: "logistics-hub",
          actor: extra.actor || "Regional Logistics Authority",
          transport: extra.transport,
          supplier: extra.supplier,
          eta: extra.eta,
          location: extra.location,
          notes: extra.notes,
        }),
      },
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `Sentinel returned ${response.status}`);
    }

    return data;
  } catch (error) {
    console.error(`Sentinel update failed for ${dispatch.id}:`, error.message);

    return null;
  }
}

/*
|--------------------------------------------------------------------------
| Create request
|--------------------------------------------------------------------------
*/

function createRequest(payload) {
  const operation = ensureOperation(payload);

  let zone = getZone(operation, payload.zoneId);

  /*
   * If a future zone is introduced dynamically, don't crash.
   */
  if (!zone && payload.zoneId) {
    zone = {
      id: payload.zoneId,
      name: payload.zoneName || payload.zoneId,
    };

    operation.zones.push([zone.id, zone.name]);
  }

  const request = {
    id: payload.dispatch?.id || `DSP-${Date.now()}`,

    operationId: operation.id,

    operationName: operation.name,

    disasterType: payload.disasterType || operation.disasterType,

    country: operation.country,

    region: operation.region,

    authority: operation.authority,

    zoneId: zone?.id || payload.zoneId,

    zoneName: zone?.name || payload.zoneName || payload.zoneId,

    resource: payload.resource || "Unknown resource",

    quantity: Number(payload.quantity || 0),

    unit: payload.unit || "units",

    priority: payload.priority || "NORMAL",

    supplier: payload.supplier || "Pending assignment",

    transport: payload.transport || "Pending assignment",

    eta: payload.eta || null,

    status: payload.dispatch?.status || "REQUESTED",

    requestedAt: payload.dispatch?.requestedAt || now(),

    events: payload.dispatch?.events?.length
      ? payload.dispatch.events
      : [
          {
            status: "REQUESTED",
            at: now(),
            actor: "Sentinel Authority",
          },
        ],
  };

  requests.set(request.id, request);

  return request;
}

/*
|--------------------------------------------------------------------------
| Status transition
|--------------------------------------------------------------------------
*/

const STATUS_FLOW = [
  "REQUESTED",
  "APPROVED",
  "ASSIGNED",
  "DISPATCHED",
  "IN_TRANSIT",
  "ARRIVED",
  "DELIVERED",
  "VERIFIED",
];

function updateRequestStatus(id, payload) {
  const request = requests.get(id);

  if (!request) {
    throw new Error("Request not found");
  }

  const next = String(payload.status || "").toUpperCase();

  if (!STATUS_FLOW.includes(next)) {
    throw new Error(`Invalid status: ${next}`);
  }

  const currentIndex = STATUS_FLOW.indexOf(request.status);
  const nextIndex = STATUS_FLOW.indexOf(next);

  if (next !== request.status && nextIndex !== currentIndex + 1) {
    throw new Error(`Invalid transition ${request.status} → ${next}`);
  }

  if (next === request.status) {
    return request;
  }

  request.status = next;

  request.events.push({
    status: next,
    at: now(),
    actor: payload.actor || "Regional Logistics Authority",
    notes: payload.notes || null,
  });

  if (payload.supplier) {
    request.supplier = payload.supplier;
  }

  if (payload.transport) {
    request.transport = payload.transport;
  }

  if (payload.eta) {
    request.eta = payload.eta;
  }

  return request;
}

/*
|--------------------------------------------------------------------------
| Regional dashboard
|--------------------------------------------------------------------------
*/

function renderHub(operation, basePath = "") {
  const operationRequests = [...requests.values()]
    .filter((r) => r.operationId === operation.id)
    .sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));

  const active = operationRequests.filter(
    (r) => !["VERIFIED", "DELIVERED"].includes(r.status),
  ).length;

  const rows = operationRequests.length
    ? operationRequests
        .map(
          (r) => `
          <tr>
            <td>
              <strong>${escapeHtml(r.id)}</strong>
            </td>

            <td>
              ${escapeHtml(r.resource)}
            </td>

            <td>
              ${escapeHtml(r.quantity)}
              ${escapeHtml(r.unit)}
            </td>

            <td>
              <strong>${escapeHtml(r.zoneName)}</strong>
              <small>${escapeHtml(r.zoneId)}</small>
            </td>

            <td>
              <span class="status ${slug(r.status)}">
                ${escapeHtml(r.status.replaceAll("_", " "))}
              </span>
            </td>

            <td>
              ${escapeHtml(r.requestedAt.replace("T", " ").replace("Z", ""))}
            </td>

            <td>
              <div class="actions">
                ${nextAction(r)}
              </div>
            </td>
          </tr>
        `,
        )
        .join("")
    : `
      <tr>
        <td colspan="7" class="empty">
          No resource requests for this operation.
        </td>
      </tr>
    `;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
/>

<title>
  ${escapeHtml(operation.region)}
  Logistics Hub
</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  background: #080a0d;
  color: #e9edf2;
}

header {
  border-bottom: 1px solid #20252c;
  padding: 24px 32px;
  background: #0c0f13;
}

.top {
  max-width: 1400px;
  margin: auto;

  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: center;
}

.brand {
  display: flex;
  gap: 14px;
  align-items: center;
}

.logo {
  width: 42px;
  height: 42px;
  border: 1px solid #39414b;
  display: grid;
  place-items: center;
  border-radius: 10px;
  font-weight: 800;
}

.eyebrow {
  color: #7f8a96;
  font-size: 11px;
  letter-spacing: 1.5px;
  font-weight: 700;
}

h1 {
  margin: 4px 0 0;
  font-size: 25px;
}

.live {
  color: #72e0a4;
  font-size: 12px;
  font-weight: 700;
}

main {
  max-width: 1400px;
  margin: auto;
  padding: 30px 32px;
}

.hero {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 20px;
  align-items: end;
  margin-bottom: 25px;
}

.hero h2 {
  font-size: 34px;
  margin: 5px 0;
}

.hero p {
  color: #89939f;
  margin: 0;
}

.stats {
  display: grid;
  grid-template-columns:
    repeat(3, minmax(0, 1fr));

  gap: 14px;
  margin-bottom: 25px;
}

.card {
  background: #0d1116;
  border: 1px solid #20262d;
  border-radius: 12px;
  padding: 20px;
}

.number {
  font-size: 34px;
  font-weight: 800;
  margin-top: 7px;
}

.table-wrap {
  background: #0d1116;
  border: 1px solid #20262d;
  border-radius: 12px;
  overflow: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th,
td {
  text-align: left;
  padding: 16px;
  border-bottom: 1px solid #1b2026;
  vertical-align: middle;
}

th {
  color: #69737f;
  font-size: 10px;
  letter-spacing: 1.2px;
}

td {
  font-size: 13px;
}

td small {
  display: block;
  color: #65707b;
  margin-top: 3px;
}

.status {
  display: inline-block;
  padding: 6px 9px;
  border-radius: 6px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .5px;
  background: #20252c;
}

.status.requested {
  color: #f3c76a;
}

.status.approved,
.status.assigned {
  color: #82b7ff;
}

.status.dispatched,
.status.in-transit {
  color: #b99cff;
}

.status.arrived,
.status.delivered,
.status.verified {
  color: #71dfa1;
}

.actions {
  display: flex;
  gap: 7px;
}

button {
  border: 1px solid #303740;
  background: #151a20;
  color: #dce2e8;
  padding: 8px 11px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 10px;
  font-weight: 800;
}

button:hover {
  background: #20262d;
}

button:disabled {
  opacity: .45;
  cursor: default;
}

.empty {
  text-align: center;
  padding: 50px;
  color: #68727d;
}

.toast {
  position: fixed;
  right: 24px;
  bottom: 24px;
  background: #141a20;
  border: 1px solid #303740;
  padding: 14px 18px;
  border-radius: 8px;
  display: none;
  max-width: 420px;
  box-shadow: 0 10px 40px #0008;
}

@media(max-width: 800px) {
  main {
    padding: 20px 15px;
  }

  header {
    padding: 20px 15px;
  }

  .top,
  .hero {
    grid-template-columns: 1fr;
    display: grid;
  }

  .stats {
    grid-template-columns: 1fr;
  }
}

</style>
</head>

<body>

<header>
  <div class="top">

    <div class="brand">
      <a href="${basePath || '/'}" style="text-decoration:none;color:inherit;display:flex;align-items:center;gap:14px;">
        <div class="logo">S</div>
        <div>
          <div class="eyebrow">
            SENTINEL REGIONAL LOGISTICS
          </div>
          <h1>
            ${escapeHtml(operation.region)}
            Logistics Hub
          </h1>
        </div>
      </a>
    </div>

    <div style="display:flex;gap:16px;align-items:center;">
      <a href="${basePath || '/'}" style="color:#7f8a96;text-decoration:none;font-size:12px;font-weight:700;">← All Hubs</a>
      <a href="/" style="color:#82b7ff;text-decoration:none;font-size:12px;font-weight:700;">Command Center ↗</a>
      <div class="live">
        ● LIVE CONNECTION
      </div>
    </div>

  </div>
</header>

<main>

  <section class="hero">

    <div>
      <div class="eyebrow">
        ${escapeHtml(operation.disasterType)}
        RESPONSE
      </div>

      <h2>
        ${escapeHtml(operation.name)}
      </h2>

      <p>
        ${escapeHtml(operation.authority)}
        ·
        ${escapeHtml(operation.region)}
      </p>
    </div>

  </section>

  <section class="stats">

    <div class="card">
      <div class="eyebrow">
        ACTIVE REQUESTS
      </div>

      <div
        class="number"
        id="activeCount"
      >
        ${active}
      </div>
    </div>

    <div class="card">
      <div class="eyebrow">
        TOTAL REQUESTS
      </div>

      <div
        class="number"
        id="totalCount"
      >
        ${operationRequests.length}
      </div>
    </div>

    <div class="card">
      <div class="eyebrow">
        ZONES
      </div>

      <div class="number">
        ${operation.zones.length}
      </div>
    </div>

  </section>

  <section class="table-wrap">

    <table>

      <thead>
        <tr>
          <th>REQUEST</th>
          <th>RESOURCE</th>
          <th>QUANTITY</th>
          <th>DESTINATION</th>
          <th>STATUS</th>
          <th>REQUESTED</th>
          <th>ACTION</th>
        </tr>
      </thead>

      <tbody id="requestRows">
        ${rows}
      </tbody>

    </table>

  </section>

</main>

<div
  id="toast"
  class="toast"
></div>

<script>

const basePath = ${JSON.stringify(basePath)};
const operationId =
  ${JSON.stringify(operation.id)};

const eventSource =
  new EventSource(
    basePath + "/api/events?operation=" +
    encodeURIComponent(operationId)
  );

eventSource.addEventListener(
  "request.created",
  (event) => {
    const request = JSON.parse(event.data);

    if (request.operationId !== operationId) {
      return;
    }

    showToast(
      "New resource request received: " +
      request.quantity +
      " " +
      request.unit +
      " " +
      request.resource +
      " → " +
      request.zoneName
    );

    refresh();
  }
);

eventSource.addEventListener(
  "request.updated",
  (event) => {
    const request = JSON.parse(event.data);

    if (request.operationId !== operationId) {
      return;
    }

    showToast(
      request.id +
      " → " +
      request.status.replaceAll("_", " ")
    );

    refresh();
  }
);

eventSource.onerror = () => {
  console.warn(
    "Regional hub live connection interrupted."
  );
};

async function refresh() {

  const response =
    await fetch(
      basePath + "/api/requests?operation=" +
      encodeURIComponent(operationId)
    );

  const data = await response.json();

  document.getElementById(
    "activeCount"
  ).textContent = data.active;

  document.getElementById(
    "totalCount"
  ).textContent = data.requests.length;

  document.getElementById(
    "requestRows"
  ).innerHTML =
    data.requests.length
      ? data.requests.map(renderRow).join("")
      : \`
        <tr>
          <td colspan="7" class="empty">
            No resource requests for this operation.
          </td>
        </tr>
      \`;
}

function renderRow(r) {

  const index =
    [
      "REQUESTED",
      "APPROVED",
      "ASSIGNED",
      "DISPATCHED",
      "IN_TRANSIT",
      "ARRIVED",
      "DELIVERED",
      "VERIFIED"
    ].indexOf(r.status);

  const flow =
    [
      "REQUESTED",
      "APPROVED",
      "ASSIGNED",
      "DISPATCHED",
      "IN_TRANSIT",
      "ARRIVED",
      "DELIVERED",
      "VERIFIED"
    ];

  const next =
    flow[index + 1];

  return \`
    <tr>

      <td>
        <strong>\${escapeHtml(r.id)}</strong>
      </td>

      <td>
        \${escapeHtml(r.resource)}
      </td>

      <td>
        \${escapeHtml(r.quantity)}
        \${escapeHtml(r.unit)}
      </td>

      <td>
        <strong>
          \${escapeHtml(r.zoneName)}
        </strong>

        <small>
          \${escapeHtml(r.zoneId)}
        </small>
      </td>

      <td>
        <span
          class="status \${r.status.toLowerCase()}"
        >
          \${escapeHtml(
            r.status.replaceAll("_", " ")
          )}
        </span>
      </td>

      <td>
        \${escapeHtml(
          r.requestedAt
            .replace("T", " ")
            .replace("Z", "")
        )}
      </td>

      <td>
        \${
          next
            ? \`
              <button
                onclick="advance(
                  '\${escapeHtml(r.id)}',
                  '\${next}'
                )"
              >
                → \${next.replaceAll("_", " ")}
              </button>
            \`
            : "COMPLETE"
        }
      </td>

    </tr>
  \`;
}

async function advance(id, status) {

  const response =
    await fetch(
      basePath + "/api/request/" +
      encodeURIComponent(id) +
      "/status",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          status
        })
      }
    );

  const data =
    await response.json();

  if (!response.ok) {
    showToast(
      data.error ||
      "Could not update request."
    );

    return;
  }

  refresh();
}

refresh();
setInterval(refresh, 4000);

function escapeHtml(value) {

  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {

  const toast =
    document.getElementById("toast");

  toast.textContent = message;
  toast.style.display = "block";

  clearTimeout(window.toastTimer);

  window.toastTimer =
    setTimeout(() => {
      toast.style.display = "none";
    }, 4500);
}

</script>

</body>
</html>
`;
}

/*
|--------------------------------------------------------------------------
| Next status button
|--------------------------------------------------------------------------
*/

function nextAction(request) {
  const index = STATUS_FLOW.indexOf(request.status);
  const next = STATUS_FLOW[index + 1];

  if (!next) {
    return `<span style="color:#71dfa1;font-size:10px;font-weight:800">COMPLETE</span>`;
  }

  return `
    <button
      onclick="advance('${escapeHtml(request.id)}','${next}')"
    >
      → ${escapeHtml(next.replaceAll("_", " "))}
    </button>
  `;
}

/*
|--------------------------------------------------------------------------
| Main HTTP server
|--------------------------------------------------------------------------
*/

async function handle(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    let pathname = url.pathname;
    let basePath = "";

    if (pathname === "/mock" || pathname.startsWith("/mock/")) {
      basePath = "/mock";
      pathname = pathname.slice(5) || "/";
    }

    const host = req.headers.host || "localhost:3000";
    const sentinelBase =
      process.env.SENTINEL_URL ||
      (host.includes("localhost") ? `http://${host}` : `https://${host}`);

    /*
     * CORS
     */

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });

      return res.end();
    }

    /*
     * Sentinel webhook
     */

    if (req.method === "POST" && pathname === "/api/resource-request") {
      const body = await readBody(req);

      const dispatch = body.dispatch || body;

      if (!dispatch.operationId) {
        return json(res, 400, {
          error: "operationId is required.",
        });
      }

      const request = createRequest({
        ...dispatch,
        event: body.event || "resource.requested",
      });

      const operation = operationFromRequest(request);

      console.log("");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("NEW RESOURCE REQUEST");
      console.log("Operation:", operation?.name);
      console.log("Region:", operation?.region);
      console.log("Zone:", request.zoneName);
      console.log("Resource:", request.resource);
      console.log("Quantity:", request.quantity, request.unit);
      console.log("Status:", request.status);
      console.log("Dispatch:", request.id);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

      broadcast(request.operationId, "request.created", request);

      return json(res, 201, {
        ok: true,
        request,
        hub: {
          operationId: operation.id,
          region: operation.region,
          url: `${basePath}/hub/${encodeURIComponent(operation.id)}`,
        },
      });
    }
    if (req.method === "POST" && pathname === "/api/dispatch-update") {
      const body = await readBody(req);
      const dispatch = body.dispatch || body;

      if (!dispatch.id) {
        return json(res, 400, {
          error: "dispatch.id is required.",
        });
      }

      const existing = requests.get(dispatch.id);

      if (!existing) {
        return json(res, 404, {
          error: `Dispatch ${dispatch.id} not found in Hub.`,
        });
      }

      existing.status = dispatch.status;

      if (dispatch.supplier !== undefined) {
        existing.supplier = dispatch.supplier;
      }

      if (dispatch.transport !== undefined) {
        existing.transport = dispatch.transport;
      }

      if (dispatch.eta !== undefined) {
        existing.eta = dispatch.eta;
      }

      if (Array.isArray(dispatch.events)) {
        existing.events = dispatch.events;
      }

      broadcast(existing.operationId, "request.updated", existing);

      return json(res, 200, {
        ok: true,
        request: existing,
        source: "sentinel",
      });
    }
    /*
     * SSE connection
     */

    if (req.method === "GET" && pathname === "/api/events") {
      const operationId = url.searchParams.get("operation");

      if (!operationId) {
        return json(res, 400, {
          error: "operation query parameter is required.",
        });
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      res.write(": connected\n\n");

      subscribe(operationId, res);

      return;
    }

    /*
     * Requests for one operation
     */

    if (req.method === "GET" && pathname === "/api/requests") {
      const operationId = url.searchParams.get("operation");

      let result = [...requests.values()];

      if (operationId) {
        result = result.filter((r) => r.operationId === operationId);
      }

      const active = result.filter(
        (r) => !["DELIVERED", "VERIFIED"].includes(r.status),
      ).length;

      return json(res, 200, {
        requests: result,
        active,
      });
    }

    /*
     * List operations
     */

    if (req.method === "GET" && pathname === "/api/operations") {
      return json(res, 200, {
        operations: [...operations.values()].map((operation) => ({
          ...operation,
          url: `${basePath}/hub/${encodeURIComponent(operation.id)}`,
        })),
      });
    }

    /*
     * Individual request
     */

    if (req.method === "GET" && /^\/api\/request\/[^/]+$/.test(pathname)) {
      const id = decodeURIComponent(pathname.split("/")[3]);

      const request = requests.get(id);

      if (!request) {
        return json(res, 404, {
          error: "Request not found.",
        });
      }

      return json(res, 200, request);
    }

    /*
     * Update request status
     */

    if (
      req.method === "POST" &&
      /^\/api\/request\/[^/]+\/status$/.test(pathname)
    ) {
      const id = decodeURIComponent(pathname.split("/")[3]);

      const body = await readBody(req);

      const request = requests.get(id);

      if (!request) {
        return json(res, 404, {
          error: "Request not found.",
        });
      }

      const updated = updateRequestStatus(id, body);

      /*
       * Tell Sentinel about the change.
       */

      const sentinelResult = await updateSentinel(
        updated,
        updated.status,
        body,
        sentinelBase,
      );

      /*
       * Tell the regional browser clients.
       */

      broadcast(updated.operationId, "request.updated", updated);

      return json(res, 200, {
        ok: true,
        request: updated,
        sentinelUpdated: !!sentinelResult,
      });
    }

    /*
     * Regional hub page
     *
     * /hub/op-odisha-cyclone
     * /hub/op-assam-flood
     * /hub/op-sikkim-landslide
     * /hub/op-nepal-flood
     */

    if (req.method === "GET" && pathname.startsWith("/hub/")) {
      const operationId = decodeURIComponent(pathname.slice("/hub/".length));

      const operation = getOperation(operationId);

      if (!operation) {
        return html(
          res,
          404,
          `
            <h1>Regional hub not found</h1>
            <p>
              No operation exists for
              ${escapeHtml(operationId)}.
            </p>
          `,
        );
      }

      return html(res, 200, renderHub(operation, basePath));
    }

    /*
     * Root = regional hub directory.
     */

    if (req.method === "GET" && pathname === "/") {
      const cards = [...operations.values()]
        .map(
          (operation) => `
              <a
                href="${basePath}/hub/${encodeURIComponent(operation.id)}"
                style="
                  display:block;
                  padding:22px;
                  margin:12px 0;
                  background:#0d1116;
                  border:1px solid #20262d;
                  border-radius:12px;
                  color:#e9edf2;
                  text-decoration:none;
                "
              >
                <div
                  style="
                    color:#7f8a96;
                    font-size:10px;
                    letter-spacing:1.3px;
                    font-weight:700;
                  "
                >
                  ${escapeHtml(operation.disasterType)}
                </div>

                <h2 style="margin:6px 0">
                  ${escapeHtml(operation.region)}
                </h2>

                <div
                  style="
                    color:#75808c;
                    font-size:13px;
                  "
                >
                  ${escapeHtml(operation.name)}
                  ·
                  ${escapeHtml(operation.authority)}
                </div>
              </a>
            `,
        )
        .join("");

      return html(
        res,
        200,
        `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sentinel Regional Logistics</title>
<style>
body {
  margin:0;
  background:#080a0d;
  color:#e9edf2;
  font-family:Inter,system-ui,sans-serif;
}
main {
  max-width:900px;
  margin:auto;
  padding:50px 25px;
}
h1 {
  font-size:36px;
}
p {
  color:#7f8a96;
}
a:hover {
  border-color:#4a5562 !important;
}
</style>
</head>

<body>
<main>

<div
  style="
    display:flex;
    justify-content:space-between;
    align-items:center;
    margin-bottom:24px;
  "
>
  <div
    style="
      color:#7f8a96;
      font-size:11px;
      letter-spacing:2px;
      font-weight:800;
    "
  >
    SENTINEL REGIONAL LOGISTICS
  </div>
  <a
    href="/"
    style="
      color:#82b7ff;
      text-decoration:none;
      font-size:13px;
      font-weight:700;
    "
  >
    ← Open Sentinel Command Center
  </a>
</div>

<h1>
Regional Logistics Hubs
</h1>

<p>
Each disaster operation has its own
logistics command interface.
</p>

${cards}

</main>
</body>
</html>
`,
      );
    }

    return json(res, 404, {
      error: "Not found.",
    });
  } catch (error) {
    console.error(error);

    return json(res, 500, {
      error: error.message,
    });
  }
}

export async function handler(req, res) {
  return handle(req, res);
}

export default handler;
export { handle, json, html, operations, requests };

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const server = http.createServer(handle);
  server.listen(PORT, "0.0.0.0", () => {
    console.log("");
    console.log("╔══════════════════════════════════════════════╗");
    console.log("║      SENTINEL REGIONAL LOGISTICS HUB        ║");
    console.log("╚══════════════════════════════════════════════╝");
    console.log("");
    console.log(`Hub directory: http://localhost:${PORT}`);
    console.log(`Webhook:       http://localhost:${PORT}/api/resource-request`);
    console.log(`Sentinel:      ${SENTINEL_URL}`);
    console.log("");
    console.log("Regional hubs:");

    for (const operation of operations.values()) {
      console.log(
        `  ${operation.region}: http://localhost:${PORT}/hub/${operation.id}`,
      );
    }

    console.log("");
  });
}