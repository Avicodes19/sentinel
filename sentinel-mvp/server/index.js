import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 3000);
function loadEnv() {
  try {
    const p = path.join(root, ".env");
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]])
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {}
}
loadEnv();

function loadSeed() {
  const possiblePaths = [
    path.join(publicDir, "demo-data.json"),
    path.join(process.cwd(), "public", "demo-data.json"),
    path.join(root, "demo-data.json"),
    path.join(process.cwd(), "demo-data.json"),
  ];
  for (const p of possiblePaths) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, "utf8"));
      }
    } catch {}
  }
  return { operations: [], currentOperationId: "" };
}
const seed = loadSeed();

const memory = {
  operations: structuredClone(seed.operations),
  currentOperationId: seed.currentOperationId,
  dispatches: [],
};
for (const o of memory.operations) o._initialAlerts = structuredClone(o.alerts);
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const hasSupabase = !!(supabaseUrl && supabaseKey);

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}
function text(res, status, data, type = "text/plain") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(data);
}
async function body(req) {
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
  let s = "";
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}
async function supa(table, method = "GET", query = "", payload) {
  if (!hasSupabase) return null;
  const r = await fetch(`${supabaseUrl}/rest/v1/${table}${query}`, {
    method,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      ...(method !== "GET"
        ? {
            "Content-Type": "application/json",
            Prefer: "return=representation",
          }
        : {}),
    },
    body: method === "GET" ? undefined : JSON.stringify(payload),
  });
  const t = await r.text();
  let d;
  try {
    d = JSON.parse(t);
  } catch {
    d = t;
  }
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${t.slice(0, 200)}`);
  return d;
}
function time(tz = "Asia/Kolkata") {
  return new Date().toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  });
}
function currentOperation(id) {
  return (
    memory.operations.find((o) => o.id === id) ||
    memory.operations.find((o) => o.id === memory.currentOperationId) ||
    memory.operations[0]
  );
}
function publicOperation(o) {
  const { _initialAlerts, ...safe } = o;
  return safe;
}
async function buildState(id) {
  const o = currentOperation(id);
  memory.currentOperationId = o.id;
  let zones = o.zones,
    people = o.people,
    alerts = o.alerts,
    teams = o.teams,
    resources = o.resources;
  if (hasSupabase) {
    try {
      const [z, p, a, t, r] = await Promise.all([
        supa("zones", "GET", `?operation_id=eq.${encodeURIComponent(o.id)}`),
        supa("people", "GET", `?operation_id=eq.${encodeURIComponent(o.id)}`),
        supa(
          "alerts",
          "GET",
          `?operation_id=eq.${encodeURIComponent(o.id)}&order=created_at.desc`,
        ),
        supa(
          "response_teams",
          "GET",
          `?operation_id=eq.${encodeURIComponent(o.id)}`,
        ),
        supa(
          "resources",
          "GET",
          `?operation_id=eq.${encodeURIComponent(o.id)}`,
        ),
      ]);
      if (z?.length) zones = z;
      if (p?.length) people = p;
      if (a?.length) alerts = a;
      if (t?.length) teams = t;
      if (r?.length) resources = r;
    } catch (e) {
      console.warn("Supabase read fallback:", e.message);
    }
  }
  const dispatches = memory.dispatches.filter((d) => d.operationId === o.id);
  return {
    operations: memory.operations.map(publicOperation),
    currentOperationId: o.id,
    operation: publicOperation(o),
    zones,
    people,
    alerts,
    teams,
    resources,
    dispatches,
    integrations: {
      supabase: hasSupabase,
      imd: process.env.IMD_ENABLED !== "false",
      ndma: process.env.NDMA_ENABLED !== "false",
      census: process.env.CENSUS_ENABLED !== "false",
      bhuvan: !!process.env.BHUVAN_WMS_LAYER,
      nepalDhm: process.env.NEPAL_DHM_ENABLED !== "false",
    },
  };
}
async function notifyHub(dispatch, event = "resource.updated") {
  const hubUrl = process.env.LOGISTICS_HUB_URL;

  if (!hubUrl) {
    console.warn("LOGISTICS_HUB_URL is not configured.");
    return false;
  }

  try {
    const response = await fetch(`${hubUrl}/api/dispatch-update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentinel-Event": event,
      },
      body: JSON.stringify({
        event,
        dispatch,
      }),
    });

    if (!response.ok) {
      const text = await response.text();

      console.error(`Hub update failed (${response.status}): ${text}`);

      return false;
    }

    return true;
  } catch (error) {
    console.error("Could not reach Logistics Hub:", error.message);

    return false;
  }
}
async function handle(req, res) {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  if (req.method === "GET" && p === "/api/state")
    return json(res, 200, await buildState(u.searchParams.get("operation")));
  if (req.method === "GET" && p === "/api/operations")
    return json(res, 200, {
      operations: memory.operations.map(publicOperation),
    });
  if (req.method === "POST" && /^\/api\/people\/[^/]+\/status$/.test(p)) {
    const id = p.split("/")[3],
      b = await body(req),
      op = currentOperation(b.operationId),
      person = op.people.find((x) => x.id === id);
    if (!person) return json(res, 404, { error: "Person not found" });
    const allowed = [
      "missing",
      "critical",
      "rescued",
      "unaccounted",
      "sheltered",
    ];
    if (!allowed.includes(b.status))
      return json(res, 400, { error: "Invalid status" });
    const previous = person.status;
    person.status = b.status;
    person.logged_at = time(
      op.country === "Nepal" ? "Asia/Kathmandu" : "Asia/Kolkata",
    );
    const alert = {
      time: person.logged_at,
      type:
        b.status === "rescued"
          ? "success"
          : b.status === "critical"
            ? "critical"
            : "warning",
      source: "FIELD",
      text: `${person.name} (${person.id}) marked ${b.status.toUpperCase()} by ${b.verifiedBy || "Authorized Rescue Operator"} in ${op.name}.`,
    };
    op.alerts.unshift(alert);
    if (hasSupabase) {
      try {
        await supa(
          "people",
          "PATCH",
          `?id=eq.${encodeURIComponent(id)}&operation_id=eq.${encodeURIComponent(op.id)}`,
          { status: b.status, logged_at: new Date().toISOString() },
        );
        await supa("verification_events", "POST", "", {
          person_id: id,
          operation_id: op.id,
          previous_status: previous,
          new_status: b.status,
          verified_by: b.verifiedBy || "Authorized Rescue Operator",
          source: "rescue_portal",
        });
        await supa("alerts", "POST", "", {
          type: alert.type,
          text: alert.text,
          operation_id: op.id,
          source: "FIELD",
        });
      } catch (e) {
        console.warn(e.message);
      }
    }
    return json(res, 200, { person, alerts: op.alerts.slice(0, 12) });
  }
  if (req.method === "POST" && p === "/api/relief/dispatch") {
    const b = await body(req),
      op = currentOperation(b.operationId),
      zone = op.zones.find((z) => z.id === b.zoneId),
      n = Number(b.quantity);
    if (!zone) return json(res, 404, { error: "Zone not found" });
    if (!n || n < 1)
      return json(res, 400, { error: "Quantity must be positive" });
    const id = `DSP-${Date.now()}`;
    const now = new Date().toISOString();
    const dispatch = {
      id,
      operationId: op.id,
      zoneId: zone.id,
      zoneName: zone.name,
      resource: b.resource,
      quantity: n,
      unit: b.unit || "units",
      supplier: b.supplier || "Pending assignment",
      transport: b.transport || "Pending assignment",
      eta: b.eta || null,
      status: "REQUESTED",
      requestedAt: now,
      events: [{ status: "REQUESTED", at: now, actor: b.actor || "Authority" }],
    };
    memory.dispatches.unshift(dispatch);
    const alert = {
      time: time(op.country === "Nepal" ? "Asia/Kathmandu" : "Asia/Kolkata"),
      type: "info",
      source: "RELIEF",
      text: `Resource request created: ${n.toLocaleString("en-IN")} ${b.unit || "units"} ${b.resource} → ${zone.name}. Supplier acknowledgement required.`,
    };
    op.alerts.unshift(alert);
    if (hasSupabase) {
      try {
        await supa("relief_dispatches", "POST", "", {
          id,
          operation_id: op.id,
          zone_id: b.zoneId,
          resource: b.resource,
          quantity: n,
          unit: b.unit || "units",
          status: "requested",
          supplier_name: b.supplier || null,
          transport_id: b.transport || null,
          eta: b.eta || null,
        });
        await supa("dispatch_events", "POST", "", {
          dispatch_id: id,
          previous_status: null,
          new_status: "requested",
          actor_role: "AUTHORITY",
          notes: "Resource request created",
        });
        await supa("alerts", "POST", "", {
          type: "info",
          text: alert.text,
          zone_id: b.zoneId,
          operation_id: op.id,
          source: "RELIEF",
        });
      } catch (e) {
        console.warn(e.message);
      }
    }
    // Optional partner webhook: set SUPPLIER_WEBHOOK_URL in .env to notify an external logistics system.
    let supplierNotified = false;
    if (process.env.SUPPLIER_WEBHOOK_URL) {
      try {
        const r = await fetch(process.env.SUPPLIER_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Sentinel-Event": "resource.requested",
          },
          body: JSON.stringify({ event: "resource.requested", dispatch }),
        });
        supplierNotified = r.ok;
      } catch (e) {
        console.warn("Supplier webhook failed:", e.message);
      }
    }
    return json(res, 201, {
      ok: true,
      dispatch,
      supplierNotified,
      message: `Request ${id} created for ${zone.name}.`,
    });
  }
  if (req.method === "GET" && p === "/api/relief/dispatches") {
    const op = currentOperation(u.searchParams.get("operation"));
    return json(res, 200, {
      dispatches: memory.dispatches.filter((d) => d.operationId === op.id),
    });
  }
  if (
    req.method === "POST" &&
    /^\/api\/relief\/dispatch\/[^/]+\/status$/.test(p)
  ) {
    const id = p.split("/")[4],
      b = await body(req),
      d = memory.dispatches.find((x) => x.id === id);
    if (!d) return json(res, 404, { error: "Dispatch not found" });
    const order = [
      "REQUESTED",
      "APPROVED",
      "ASSIGNED",
      "DISPATCHED",
      "IN_TRANSIT",
      "ARRIVED",
      "DELIVERED",
      "VERIFIED",
    ];
    const next = String(b.status || "").toUpperCase();
    if (!order.includes(next))
      return json(res, 400, { error: "Invalid dispatch status" });
    const currentIndex = order.indexOf(d.status),
      nextIndex = order.indexOf(next);
    if (nextIndex !== currentIndex + 1 && next !== d.status)
      return json(res, 400, {
        error: `Invalid transition ${d.status} → ${next}`,
      });
    const now = new Date().toISOString();
    d.status = next;
    d.events.push({
      status: next,
      at: now,
      actor: b.actor || "Authorized Logistics Operator",
      location: b.location || null,
      notes: b.notes || null,
    });
    if (b.transport) d.transport = b.transport;
    if (b.supplier) d.supplier = b.supplier;
    if (b.eta) d.eta = b.eta;

    const op = currentOperation(d.operationId);
    const alert = {
      time: time(op.country === "Nepal" ? "Asia/Kathmandu" : "Asia/Kolkata"),
      type:
        next === "VERIFIED"
          ? "success"
          : next === "IN_TRANSIT"
            ? "info"
            : "warning",
      source: "RELIEF",
      text: `${d.resource} ${d.quantity} ${d.unit} to ${d.zoneName}: ${next.replaceAll("_", " ")}.`,
    };
    op.alerts.unshift(alert);
    if (hasSupabase) {
      try {
        await supa(
          "relief_dispatches",
          "PATCH",
          `?id=eq.${encodeURIComponent(id)}`,
          {
            status: next,
            assigned_team: b.transport || undefined,
            eta: b.eta || undefined,
          },
        );
        await supa("dispatch_events", "POST", "", {
          dispatch_id: id,
          previous_status: order[currentIndex].toLowerCase(),
          new_status: next.toLowerCase(),
          actor_role: b.actorRole || "LOGISTICS",
          notes: b.notes || null,
        });
        await supa("alerts", "POST", "", {
          type: alert.type,
          text: alert.text,
          operation_id: op.id,
          zone_id: d.zoneId,
          source: "RELIEF",
        });
      } catch (e) {
        console.warn(e.message);
      }
    }

    const hubUpdated =
      b.source !== "logistics-hub"
        ? await notifyHub(d, "resource.updated")
        : false;

    return json(res, 200, {
      ok: true,
      dispatch: d,
      alerts: op.alerts.slice(0, 12),
      hubUpdated,
    });
  }
  if (req.method === "GET" && p === "/api/integrations/imd") {
    if (process.env.IMD_ENABLED === "false")
      return json(res, 200, { source: "IMD", live: false, data: [] });
    try {
      const [w, r] = await Promise.all([
        fetch("https://mausam.imd.gov.in/api/warnings_district_api.php"),
        fetch("https://mausam.imd.gov.in/api/districtwise_rainfall_api.php"),
      ]);
      if (!w.ok || !r.ok) throw new Error(`IMD HTTP ${w.status}/${r.status}`);
      return json(res, 200, {
        source: "IMD",
        live: true,
        warnings: await w.json(),
        rainfall: await r.json(),
        fetchedAt: new Date().toISOString(),
      });
    } catch (e) {
      return json(res, 200, {
        source: "IMD",
        live: false,
        error: e.message,
        data: [],
        note: "Public endpoint unavailable from this environment. Keep this server-side proxy in deployment.",
      });
    }
  }
  if (req.method === "GET" && p === "/api/integrations/census")
    return json(res, 200, {
      source: "Census of India",
      live: false,
      available: true,
      note: "Aggregate 2001/2011 API only. It does not expose individual or household identities. Use it for population baselines; use an authorized operational roster for person-level rescue tracking.",
      url: "https://censusindia.gov.in/census.website/en/data/api/about",
    });
  if (req.method === "GET" && p === "/api/integrations/lgd")
    return json(res, 200, {
      source: "Local Government Directory (LGD)",
      live: false,
      available: true,
      note: "Use LGD as the authoritative administrative-unit/code reference for state, district, sub-district, village, ward and local-body names. Sentinel should key operational zones to official LGD codes rather than invented labels.",
      url: "https://lgdirectory.gov.in/",
    });
  if (req.method === "GET" && p === "/api/integrations/ndma")
    return json(res, 200, {
      source: "NDMA SACHET",
      live: false,
      available: true,
      feed: "CAP/RSS",
      note: "SACHET publishes geo-targeted CAP alerts and an RSS feed. Production should consume the authorized CAP/RSS feed server-side with ETag caching.",
      url: "https://sachet.ndma.gov.in/CapFeed",
    });
  if (req.method === "GET" && p === "/api/integrations/bhuvan")
    return json(res, 200, {
      source: "ISRO Bhuvan",
      live: false,
      available: true,
      wmsUrl:
        process.env.BHUVAN_WMS_URL ||
        "https://bhuvan-vec2.nrsc.gov.in/bhuvan/wms",
      layer: process.env.BHUVAN_WMS_LAYER || null,
      note: "Bhuvan exposes OGC WMS/WMTS thematic services including flood-hazard layers. Configure the exact authorized layer before production.",
    });

  if (req.method === "GET") {
    let file = p === "/" ? "/index.html" : p;
    const full = path.normalize(path.join(publicDir, file));
    if (!full.startsWith(publicDir)) return text(res, 403, "Forbidden");
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const ext = path.extname(full);
      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
      };
      return text(
        res,
        200,
        fs.readFileSync(full),
        types[ext] || "application/octet-stream",
      );
    }
  }
  return text(res, 404, "Not found");
}
export async function handler(req, res) {
  try {
    return await handle(req, res);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message });
  }
}

export default handler;
export { handle, json, text };

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  http
    .createServer((req, res) =>
      handle(req, res).catch((e) => {
        console.error(e);
        json(res, 500, { error: e.message });
      }),
    )
    .listen(port, () =>
      console.log(
        `Sentinel MVP: http://localhost:${port} | Supabase: ${hasSupabase ? "configured" : "demo mode"}`,
      ),
    );
}
