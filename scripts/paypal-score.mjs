// Scores the live PayPal requests `refit paypal` reported against hand labels. A request is a file
// and a line; a report matches a label in the same file within TOLERANCE lines, and each label and
// each report matches at most once (nearest first). Only repositories that were scanned count; a
// labelled repository that was not scanned counts all its labels as missed.
export const TOLERANCE = 4;

export function scorePayPal(results, labels, tolerance = TOLERANCE) {
  const byRepo = new Map(results.map((result) => [result.repo, result]));
  let matched = 0;
  let reportedTotal = 0;
  let labelledTotal = 0;
  const wrong = [];
  const missed = [];
  for (const { repo, requests } of labels.repos) {
    const result = byRepo.get(repo);
    const reported = (result?.status === 'scanned' ? result.calls : [])
      .filter((call) => call.use === 'live')
      .map((call) => ({ file: call.file, line: call.line }));
    const expected = requests.map((request) => {
      const cut = request.lastIndexOf(':');
      return { file: request.slice(0, cut), line: Number(request.slice(cut + 1)) };
    });
    labelledTotal += expected.length;
    reportedTotal += reported.length;
    const pairs = [];
    for (const [r, report] of reported.entries())
      for (const [e, label] of expected.entries())
        if (report.file === label.file && Math.abs(report.line - label.line) <= tolerance)
          pairs.push({ r, e, distance: Math.abs(report.line - label.line) });
    pairs.sort((a, b) => a.distance - b.distance);
    const usedReports = new Set();
    const usedLabels = new Set();
    for (const { r, e } of pairs)
      if (!usedReports.has(r) && !usedLabels.has(e)) {
        usedReports.add(r);
        usedLabels.add(e);
        matched++;
      }
    for (const [r, report] of reported.entries())
      if (!usedReports.has(r)) wrong.push({ repo, at: `${report.file}:${report.line}` });
    for (const [e, label] of expected.entries())
      if (!usedLabels.has(e)) missed.push({ repo, at: `${label.file}:${label.line}` });
  }
  const ratio = (part, whole) => (whole ? Number((part / whole).toFixed(4)) : null);
  return {
    repositories: labels.repos.length,
    labelled: labelledTotal,
    reported: reportedTotal,
    matched,
    precision: ratio(matched, reportedTotal),
    recall: ratio(matched, labelledTotal),
    wrong,
    missed,
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { readFile } = await import('node:fs/promises');
  const [resultsPath, labelsPath = 'docs/benchmarks/2026-10-22-paypal-labels.json'] =
    process.argv.slice(2);
  if (!resultsPath) {
    console.log('Usage: node scripts/paypal-score.mjs <results.json> [labels.json]');
    process.exit(1);
  }
  const results = JSON.parse(await readFile(resultsPath, 'utf8')).results;
  const score = scorePayPal(results, JSON.parse(await readFile(labelsPath, 'utf8')));
  console.log(
    `${score.repositories} labelled repositories: ${score.labelled} labelled requests, ${score.reported} reported, ${score.matched} matched. Precision ${score.precision}, recall ${score.recall}.`,
  );
  for (const item of score.wrong) console.log(`WRONG? ${item.repo} ${item.at}`);
  for (const item of score.missed) console.log(`MISSED  ${item.repo} ${item.at}`);
}
