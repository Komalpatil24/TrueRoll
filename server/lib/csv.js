// CSV helpers. Cells starting with = + - @ are prefixed with ' so spreadsheet apps
// never treat student-supplied names as formulas (CSV injection).
function cell(v) {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  return [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

module.exports = { toCsv, cell };
