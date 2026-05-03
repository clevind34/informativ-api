// data-sfdc-contacts.mjs
// Endpoint: GET /api/data/sfdc-contacts
//
// Serves SFDC contact records keyed by PIE prospect_id. Sourced from
// sync_sfdc_contacts_to_pie.py via publish_to_gateway.py weekly.
//
// Deployed: May 3, 2026 (Phase 2C-2 — SFDC Contact Sync)

import { serveDataFile } from "./data-serve.mjs";

export const handler = async (event) => serveDataFile(event, "sfdc-contacts.json");
