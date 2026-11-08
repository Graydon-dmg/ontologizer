// @ts-check

/**
 * Turn a stream of text chunks into parsed JSON objects, one per complete line.
 * - A line split across chunks is joined before parsing.
 * - Blank lines, fence lines (```), and lines that are not JSON objects are skipped, never thrown.
 * - The last line is parsed even without a trailing newline.
 * @param {AsyncIterable<string> | Iterable<string>} textChunks
 * @returns {AsyncGenerator<Record<string, any>>}
 */
export async function* jsonLines(textChunks) {
  let buffer = '';
  for await (const chunk of textChunks) {
    if (typeof chunk !== 'string' || chunk === '') continue;
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const obj = parseLine(line);
      if (obj) yield obj;
    }
  }
  const obj = parseLine(buffer);
  if (obj) yield obj;
}

/**
 * @param {string} line
 * @returns {Record<string, any> | null}
 */
function parseLine(line) {
  const s = line.trim();
  if (!s || s.startsWith('```')) return null;
  // Tolerate stray text around one object ("Here it is: {...}"); a line with no braces is skipped.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
