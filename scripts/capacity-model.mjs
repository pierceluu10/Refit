// Derives the hosted worker capacity model in docs/CAPACITY.md from committed measurements and
// the assumptions below, so every derived number can be recomputed: node scripts/capacity-model.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const MEASUREMENTS = {
  inventory: 'docs/benchmarks/2026-10-22-capacity-inventory.json',
  preparation: 'docs/benchmarks/2026-10-22-capacity-preparation.json',
  // End-to-end per-repository seconds of validated Stripe migrations (laptop, 2026-10-16).
  migrations: ['fresh', 'original', 'heldout'].map(
    (set) => `docs/benchmarks/2026-10-16-stripe-fixrate-${set}-results.json`,
  ),
};
// Read from Fly's pages on the day below; prices are for iad. Fly's monthly price is 720 hours.
const FLY = {
  sources: [
    'https://docs.fly.io/about/pricing',
    'https://docs.fly.io/machines/cpu-performance',
    'https://docs.fly.io/machines/guides-examples/machine-sizing',
  ],
  checkedAt: '2026-10-22',
  hoursPerMonth: 720,
  extraMemoryUsdPerGbMonth: 6,
  volumeUsdPerGbMonth: 0.15,
  // Baseline share of one core per shared vCPU (5 ms per 80 ms period); bursts spend at most 500 s.
  sharedQuota: 0.0625,
  burstSeconds: 500,
};
const SIZES = [
  // The size fly.toml runs today; shared presets allow at most 2 GB per vCPU.
  { name: 'shared-cpu-2x', kind: 'shared', cpus: 2, memoryGb: 4, presetGb: 0.5, presetUsd: 4.39 },
  { name: 'shared-cpu-4x', kind: 'shared', cpus: 4, memoryGb: 8, presetGb: 1, presetUsd: 8.78 },
  { name: 'performance-1x', kind: 'performance', cpus: 1, memoryGb: 8, presetGb: 2, presetUsd: 33 },
  { name: 'performance-2x', kind: 'performance', cpus: 2, memoryGb: 8, presetGb: 4, presetUsd: 66 },
];
const VOLUME_GB = 20;
// Refit's default validation profile (pipeline/docker-sandbox.ts): a 3 GiB container whose 2 GiB
// tmpfs workspace is charged to the same memory limit.
const CONTAINER_GIB = 3;
const GIB = 1024 ** 3;
const ASSUMPTIONS = {
  repositoriesPerCustomer: 3,
  // DEFAULT_INTERVAL_SECONDS in pipeline/hosted-service.ts, and an hourly alternative.
  pollIntervalsSeconds: [300, 3600],
  validatedMigrationsPerRepositoryPerMonth: 2,
  // Busy fraction a machine is planned for, leaving room for queues and retries.
  targetUtilisation: 0.5,
  customers: [10, 50, 200],
  notes: [
    'A poll runs a full scan and a contract download (pipeline/watch.ts); its CPU is taken as one static inventory at p90.',
    'A validation container is limited to one CPU and the worker runs one job at a time, so a migration uses at most its wall seconds of CPU; its CPU is taken as its wall time.',
    'A Fly performance vCPU is taken to run as fast as one Apple M5 core under the recorded load. Not measured.',
  ],
};

const { values } = parseArgs({ options: { output: { type: 'string' } } });
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const inventory = await read(MEASUREMENTS.inventory);
const preparation = await read(MEASUREMENTS.preparation);
const migrationSeconds = (await Promise.all(MEASUREMENTS.migrations.map(read)))
  .flatMap((run) => run.rows.filter((row) => row.outcome === 'validated'))
  .map((row) => row.seconds)
  .sort((a, b) => a - b);
const percentile = (sorted, p) => sorted[Math.ceil((p / 100) * sorted.length) - 1];
const migration = {
  count: migrationSeconds.length,
  p50: percentile(migrationSeconds, 50),
  p90: percentile(migrationSeconds, 90),
  max: migrationSeconds.at(-1),
};
const round = (value, digits = 2) => Number(value.toFixed(digits));

const pollCpu = inventory.summary.inventory.cpuSeconds.p90;
const workerPeakGib = inventory.summary.inventory.maxRssBytes.max / GIB;
const sizes = SIZES.map((size) => {
  const usdPerMonth =
    size.presetUsd + (size.memoryGb - size.presetGb) * FLY.extraMemoryUsdPerGbMonth;
  const usdPerSecond = usdPerMonth / (FLY.hoursPerMonth * 3600);
  // Sustained CPU seconds per second one sequential job can use once any burst is spent.
  const sustained = size.kind === 'shared' ? Math.min(1, size.cpus * FLY.sharedQuota) : 1;
  // Machine seconds a job holds the worker: its wall time, or longer when throttled.
  const occupied = (wall, cpu) => Math.max(wall, cpu / sustained);
  const job = {
    inventoryP50: occupied(
      inventory.summary.inventory.wallSeconds.p50,
      inventory.summary.inventory.cpuSeconds.p50,
    ),
    inventoryP90: occupied(
      inventory.summary.inventory.wallSeconds.p90,
      inventory.summary.inventory.cpuSeconds.p90,
    ),
    migrationP50: occupied(migration.p50, migration.p50),
    migrationP90: occupied(migration.p90, migration.p90),
  };
  const machinesFor = (interval) =>
    Object.fromEntries(
      ASSUMPTIONS.customers.map((customers) => {
        const repositories = customers * ASSUMPTIONS.repositoriesPerCustomer;
        const perRepositoryPerHour =
          (3600 / interval) * occupied(inventory.summary.inventory.wallSeconds.p90, pollCpu) +
          (ASSUMPTIONS.validatedMigrationsPerRepositoryPerMonth / FLY.hoursPerMonth) *
            job.migrationP90;
        const machines = Math.max(
          1,
          Math.ceil((repositories * perRepositoryPerHour) / (3600 * ASSUMPTIONS.targetUtilisation)),
        );
        return [
          customers,
          {
            repositories,
            machines,
            usdPerMonth: round(machines * (usdPerMonth + VOLUME_GB * FLY.volumeUsdPerGbMonth)),
          },
        ];
      }),
    );
  return {
    ...size,
    usdPerMonth: round(usdPerMonth),
    sustainedCpuPerSecond: sustained,
    memoryHeadroomGib: round(size.memoryGb - CONTAINER_GIB - workerPeakGib),
    jobSeconds: Object.fromEntries(
      Object.entries(job).map(([key, value]) => [key, round(value, 1)]),
    ),
    jobsPerHour: Object.fromEntries(
      Object.entries(job).map(([key, value]) => [key, Math.floor(3600 / value)]),
    ),
    usdPerJob: Object.fromEntries(
      Object.entries(job).map(([key, value]) => [key, round(value * usdPerSecond, 5)]),
    ),
    machines: Object.fromEntries(
      ASSUMPTIONS.pollIntervalsSeconds.map((interval) => [interval, machinesFor(interval)]),
    ),
  };
});

const model = {
  formatVersion: 1,
  measurements: MEASUREMENTS,
  fly: FLY,
  assumptions: ASSUMPTIONS,
  inputs: {
    inventory: inventory.summary.inventory,
    validatedMigrationSeconds: migration,
    preparation: preparation.summary.all,
    workerPeakGib: round(workerPeakGib),
    containerGib: CONTAINER_GIB,
    pollCpuSeconds: pollCpu,
  },
  sizes,
};
const text = `${JSON.stringify(model, null, 2)}\n`;
if (values.output) await writeFile(values.output, text);
else process.stdout.write(text);
