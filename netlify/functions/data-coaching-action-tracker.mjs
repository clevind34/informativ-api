import { serveDataFile } from './data-serve.mjs';
export const handler = async (event) => serveDataFile(event, 'coaching-action-tracker.json');
