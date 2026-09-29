/**
 * Local .env loader.
 *
 * dotenv/config resolves `.env` against process.cwd(), so `npm start` from the
 * repo root (`node backend/src/server.js`) would silently miss backend/.env and
 * quietly fall back to the file store instead of Hindsight. Resolving the path
 * from this file makes config loading independent of where the process started.
 *
 * Real environment variables always win — dotenv never overwrites what the host
 * (Render, Docker, CI) already set.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(here, '../.env') });
// Keep a cwd-relative .env working too, for anyone running from inside backend/.
dotenv.config();
