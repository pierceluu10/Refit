// Small text helpers: HTML to text, passage splitting and BM25 ranking. No dependencies.

const STOP = new Set(
  'a an and are as at be by for from has have how i in is it of on or that the this to was what when where which will with you your'.split(
    ' ',
  ),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_.]+/)
    .flatMap((token) => (token.includes('.') ? [token, ...token.split('.')] : [token]))
    .map((token) => token.replace(/^\.+|\.+$/g, ''))
    .filter((token) => token.length > 1 && !STOP.has(token));
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|pre|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-z0-9#]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** Split text into passages of roughly `size` characters on paragraph boundaries. */
export function splitPassages(text: string, size = 700): string[] {
  const paragraphs = text
    .split(/\n{1,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const passages: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length > size) {
      passages.push(current);
      current = '';
    }
    current = current ? `${current}\n${paragraph}` : paragraph;
    while (current.length > size * 2) {
      passages.push(current.slice(0, size * 2));
      current = current.slice(size * 2);
    }
  }
  if (current) passages.push(current);
  return passages;
}

export type Ranked<T> = { item: T; score: number };

/** Rank documents against a query with BM25. Returns only documents with a positive score. */
export function rank<T>(query: string, items: T[], toText: (item: T) => string): Ranked<T>[] {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0 || items.length === 0) return [];
  const docs = items.map((item) => tokenize(toText(item)));
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
  const docFreq = new Map<string, number>();
  for (const doc of docs) {
    for (const token of new Set(doc)) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
  }
  const k1 = 1.2;
  const b = 0.75;
  const ranked = docs.map((doc, index) => {
    const tf = new Map<string, number>();
    for (const token of doc) tf.set(token, (tf.get(token) ?? 0) + 1);
    let score = 0;
    for (const token of queryTokens) {
      const f = tf.get(token) ?? 0;
      if (!f) continue;
      const n = docFreq.get(token) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / avgLength)));
    }
    return { item: items[index], score };
  });
  return ranked.filter((entry) => entry.score > 0).sort((x, y) => y.score - x.score);
}

/** Levenshtein distance, for "did you mean" suggestions. */
export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = temp;
    }
  }
  return prev[b.length];
}

export function closest(name: string, candidates: Iterable<string>, max = 3): string[] {
  const lower = name.toLowerCase();
  return [...candidates]
    .map((candidate) => ({ candidate, d: editDistance(lower, candidate.toLowerCase()) }))
    .filter(({ candidate, d }) => d <= Math.max(2, Math.floor(candidate.length / 3)))
    .sort((x, y) => x.d - y.d)
    .slice(0, max)
    .map(({ candidate }) => candidate);
}
