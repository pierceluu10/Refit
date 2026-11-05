#!/usr/bin/env node
// What memory has to show: the tracked numbers, and every detection lesson as JSON for the scanner's
// rules and fixtures (P5). Lessons name repos, so this stays with the people who run this store.
//   node memory/scripts/report.ts [lessons.json]
import { writeFileSync } from 'node:fs';
import { customerStores, learningMetrics, memoryDir } from '../index.ts';

export async function report(dir = memoryDir()) {
  const stores = customerStores(dir);
  const runs = (await Promise.all(stores.map((store) => store.listRuns()))).flat();
  const lessons = (await Promise.all(stores.map((store) => store.listLessons()))).flat();
  return { metrics: learningMetrics(runs, lessons), lessons };
}

if (process.argv[1] === import.meta.filename) {
  const { metrics, lessons } = await report();
  console.log(JSON.stringify(metrics, null, 2));
  const out = process.argv[2];
  if (out) writeFileSync(out, `${JSON.stringify(lessons, null, 2)}\n`);
}
