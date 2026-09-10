// Shared CSV serialization used by every "Download"/"Export CSV" button in the app - one escaping
// rule (RFC4180-ish: quote a field only when it contains a comma, double-quote, or newline, and
// double up any embedded quotes) so every export behaves the same regardless of which route built
// it. routes/activity.js's /export predates this and inlines the same logic - left as-is rather
// than refactored, to avoid touching a working export while adding these new ones.
function escapeCsvField(val) {
  const s = val === null || val === undefined ? '' : String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCsvField(row[c])).join(','));
  }
  return lines.join('\n');
}

module.exports = { escapeCsvField, toCsv };
