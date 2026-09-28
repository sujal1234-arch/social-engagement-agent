import fs from 'node:fs';
import { parse } from 'csv-parse/sync';

/** Read a CSV file (with header row) into an array of row objects. */
export function readCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return parse(text, { columns: true, skip_empty_lines: true, trim: true });
}

export function toInt(value, fallback = 0) {
  const n = Number.parseInt(String(value ?? '').replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}
