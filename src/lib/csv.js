const FORMULA_PREFIX = /^[\s\u0000-\u001f\u007f-\u009f\ufeff]*[=+\-@]/u;

export function csvCell(value) {
  const text = String(value ?? '');
  const safeText = typeof value === 'number' && Number.isFinite(value)
    ? text
    : FORMULA_PREFIX.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

export function encodeCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}
