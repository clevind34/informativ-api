/**
 * /api/data/mcid-audit — serves data/mcid-audit.json
 *
 * Standard data-serve endpoint pattern. No role restrictions — all users
 * can view the MCID hygiene audit findings (per Michael's directive).
 */

import { serveDataFile } from './data-serve.mjs';

export const handler = async (event) => serveDataFile(event, 'mcid-audit.json');
