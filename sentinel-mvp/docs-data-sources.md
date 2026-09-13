# SENTINEL — MVP data-source architecture

## 1. Population baseline
**Census of India / Office of the Registrar General & Census Commissioner, India**

Use for aggregate population baselines and administrative geography. Census API data is aggregate and does not expose an individual/household identity roster. Therefore Sentinel must NOT fabricate a person list from Census. Person-level rescue operations use an authorized operational roster supplied by the responsible authority, local-body/shelter records, or emergency registration.

## 2. Administrative geography / official zone names
**Local Government Directory (LGD) + Census administrative mapping**

For India, Sentinel should use official administrative-unit names and codes rather than invented labels such as “Riverside Valley.” LGD provides downloadable/searchable district, sub-district, village, ward and local-body directories; Census administrative atlases provide the census geographic frame. The MVP demo uses real district names as the operational zones and keeps an `adminSource` marker for this boundary layer.

## 3. India hazard / warning layer
**India Meteorological Department (IMD)**

Server-side adapter targets district warning and districtwise rainfall endpoints. IMD warning categories can inform the hazard layer. Sentinel's red/amber/blue/green **operational severity** is a separate derived layer based on hazard + population exposure + people unaccounted/missing + resource shortages + access + vulnerability + time since relief.

## 4. India public disaster alerts
**NDMA SACHET**

Server-side CAP/RSS adapter for geo-targeted disaster alerts. External alerts are stored as observations/events and can be shown in the live incident feed.

## 5. India geospatial layers
**ISRO / NRSC Bhuvan**

Use OGC WMS/WMTS services for authorized thematic layers such as flood/hazard information and administrative/geospatial context. The exact production layer should be configured after confirming the service's current access terms and endpoint.

## 6. Nepal operation
**Department of Hydrology and Meteorology (DHM) + National Emergency Operation Centre (NEOC)**

The MVP includes a Nepal operation and integration boundary. Do not reuse India's Census/IMD sources for Nepal. A production Nepal adapter should consume authoritative DHM hazard/weather information and NEOC/local-authority operational data, subject to the relevant API/feed availability and permissions.

## 7. Maps
The MVP uses Leaflet with switchable satellite/street basemaps. For production, replace demo imagery with a licensed/authorized imagery provider or an approved Bhuvan/other OGC layer. The coloured halo around each point is Sentinel's **operational priority visualization**, not a claim about the exact physical footprint of a hazard.

## 8. Person verification
The fastest field workflow is intentionally minimal:

1. Authorized responder opens the operation roster.
2. Search/scan the person record if needed.
3. Tap `FOUND / RESCUED`, `SHELTERED`, `CRITICAL`, or `MISSING`.
4. Sentinel timestamps and records a verification event.

The MVP does not require Aadhaar or biometric equipment. Any government identity integration should only be added under an authorized legal/technical integration with the relevant authority.
