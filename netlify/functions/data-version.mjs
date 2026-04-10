import { serveDataFile } from './data-serve.mjs';
export const handler = async (event) => {
  const file = (event.queryStringParameters || {}).file;
  if (file === 'forecast-summary') return serveDataFile(event, 'forecast-summary.json');
  return serveDataFile(event, 'version.json');
};
