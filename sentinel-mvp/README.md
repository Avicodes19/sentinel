# SENTINEL — SIH Disaster Management MVP

A command-centre web/PWA prototype for verified population accounting, rescue status, operational priority, relief needs, dispatch tracking and live disaster alerts.

## What is included

- Command Center dashboard matching the supplied Figma visual language.
- Persons Registry with one-click status updates.
- Operations Map with satellite basemap, severity halos, zone popups and resource dispatch.
- Resources view with stock/reserved/available quantities.
- Alerts / live incident feed.
- Multi-operation browser with India and Nepal demo operations: Odisha cyclone, Assam flood, Sikkim landslide and Nepal Terai flood.
- Official-style administrative zone names using real district names; production should key them to LGD/Census administrative codes.
- Disaster identity in every operation: disaster type, hazard, geography, authority and source.
- Optional Supabase/PostgreSQL persistence + Realtime schema.
- IMD district-warning/rainfall server adapter.
- NDMA SACHET CAP/RSS integration notes/adapter endpoint.
- Census of India aggregate population-baseline integration boundary.
- Local Government Directory (LGD) administrative-name/code integration boundary.
- ISRO Bhuvan WMS integration boundary for authorized thematic/flood layers.

## Run

1. Install Node.js 20+.
2. `npm install`
3. Copy `.env.example` to `.env`.
4. Leave Supabase fields blank for demo mode, or configure them after running `sql/schema.sql` in Supabase.
5. `npm start`
6. Open `http://localhost:3000`.

## Data architecture

Census data is used only as an aggregate population baseline. LGD + Census administrative geography is used for official state/district/sub-district naming and codes; the MVP does not invent fictional district names. The Census API explicitly does not expose individual or household-level records. Person-level rescue lists therefore come from an authorized operational roster maintained/imported by the responsible authority.

IMD supplies hazard/weather observations and district warnings. NDMA SACHET supplies geo-targeted disaster alerts through CAP/RSS. Bhuvan can supply OGC WMS/WMTS thematic geospatial layers. Sentinel combines these external observations with field-verified population/resource state to calculate an operational priority score.

## Important production note

Do not use public Census data as an individual identity registry, and do not build an Aadhaar dependency. Use an authorized local administrative/emergency roster and minimal personal data. Add role-based authentication, audit logs, encryption, retention rules and least-privilege policies before any real deployment.

## Files

- `public/` — Sentinel UI, styling and demo dataset.
- `server/index.js` — zero-dependency Node server, API proxy and persistence adapter.
- `sql/schema.sql` — Supabase/PostgreSQL schema and Realtime setup.
- `docs-data-sources.md` — external-data integration plan and privacy boundary.
- `run-demo.bat` — Windows quick start.

No `npm install` is required for the demo server; it uses Node's built-in HTTP/fetch APIs. Supabase is accessed through its REST API when configured.

## Resource-request endpoint

Sentinel creates a resource request with:

`POST /api/relief/dispatch`

Example JSON:

```json
{
  "operationId": "<operation>",
  "zoneId": "<official-zone-id>",
  "resource": "Drinking Water",
  "quantity": 80,
  "unit": "L",
  "supplier": "Partner / agency",
  "transport": "Pending assignment"
}
```

The response creates a dispatch in `REQUESTED` state. If `SUPPLIER_WEBHOOK_URL` is configured, Sentinel also POSTs an `resource.requested` event to that external logistics endpoint. Without a configured partner API, the built-in Logistics workflow is the authoritative MVP handoff and is not presented as a real government/foreign-agency integration.

Status progression is controlled by:

`POST /api/relief/dispatch/:id/status`

with `{ "status": "APPROVED" }`, then `ASSIGNED`, `DISPATCHED`, `IN_TRANSIT`, `ARRIVED`, `DELIVERED`, and finally `VERIFIED`.

Current operation dispatches can be read from:

`GET /api/relief/dispatches?operation=<operationId>`
