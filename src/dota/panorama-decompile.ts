// Recover Panorama source (CSS/JS/XML) from the COMPILED Source 2 resources that
// shipping custom games bundle in their VPKs: .vcss_c / .vjs_c / .vxml_c. The compiler
// stores the original source verbatim in a data block; we pull the longest printable
// run (dropping the short metadata/dependency runs) and trim it to the source start.
// Good enough to study UI — not a byte-perfect resource parser.

/** Is this a compiled Panorama resource whose source we can recover? */
export function isCompiledPanorama(path: string): boolean {
  return /\.(vxml_c|vcss_c|vjs_c)$/i.test(path);
}

/** Map a compiled panorama path to its source extension (.vcss_c -> .css, etc.). */
export function panoramaSourcePath(path: string): string {
  return path.replace(/\.vcss_c$/i, ".css").replace(/\.vxml_c$/i, ".xml").replace(/\.vjs_c$/i, ".js");
}

/** Extract the embedded source text from a compiled panorama buffer. */
const META_RE = /m_(Input|Compiler|Additional|Argument|Spec|nVersion|Resource)|RED2|DATA\b|VructResource|m_pStringData|REDIRESRCES/;

export function decompilePanorama(buf: Buffer, ext: string): string {
  const txt = buf.toString("latin1");
  // Drop short metadata/dependency runs UNCONDITIONALLY (a long compiler block must not
  // win just by being longest). Keep the rest as source candidates.
  const runs = (txt.match(/[\x09\x0A\x0D\x20-\x7E]{16,}/g) || []).filter((r) => !META_RE.test(r));
  if (!runs.length) return "";

  // Score candidates by how source-like they are for this extension, not raw length.
  const isXml = /vxml_c$/i.test(ext);
  const isCss = /vcss_c$/i.test(ext);
  const kindRe = isXml ? /<[A-Za-z!?/]/ : isCss ? /[{};]\s*[#.@A-Za-z-]|:\s*[^;]+;/ : /\bfunction\b|=>|\bvar\b|\blet\b|\bconst\b|\(function/;
  const matching = runs.filter((r) => kindRe.test(r));
  // Prefer the longest run that LOOKS like the right source; else the longest run overall.
  const pool = matching.length ? matching : runs;
  let best = pool.reduce((a, b) => (b.length > a.length ? b : a), "");

  best = best.replace(/^[^\S\r\n]+/, "");
  if (isXml) {
    const lt = best.indexOf("<");
    if (lt > 0) best = best.slice(lt);
  } else if (isCss) {
    const close = best.lastIndexOf("}");
    if (close >= 0) best = best.slice(0, close + 1); // trim trailing compiler metadata after the CSS
  }
  return best.trim();
}
