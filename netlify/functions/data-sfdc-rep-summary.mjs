import { serveDataFile } from './data-serve.mjs';
export const handler = async (event) => serveDataFile(event, 'sfdc-rep-summary.json');
