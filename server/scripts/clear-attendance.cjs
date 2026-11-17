// Clear attendance when AliasMail uses DATA_FILE instead of a SQL database.
// Stop the server before running: node scripts/clear-attendance.cjs

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const serverDir = path.join(__dirname, '..');
const configuredFile = process.env.DATA_FILE || 'data/db.json';
const dataFile = path.isAbsolute(configuredFile)
  ? configuredFile
  : path.resolve(serverDir, configuredFile);

if (!fs.existsSync(dataFile)) {
  console.error(`AliasMail data file was not found: ${dataFile}`);
  process.exitCode = 1;
  return;
}

const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const removed = Array.isArray(data.attendance?.sessions)
  ? data.attendance.sessions.length
  : 0;

data.attendance = { sessions: [] };

const temporaryFile = `${dataFile}.attendance-cleanup.tmp`;
fs.writeFileSync(temporaryFile, JSON.stringify(data));
fs.renameSync(temporaryFile, dataFile);

console.log(`Attendance cleared. Removed ${removed} session(s) from ${dataFile}`);
