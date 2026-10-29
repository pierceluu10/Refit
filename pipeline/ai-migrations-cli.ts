import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  proposeAiMigrations,
  proposeSdkMajor,
  runAiMigrations,
  runAiSurfaceMigrations,
  type AiMigrationProposal,
} from './ai-migrations.ts';
import { proveRequests, type ProofProvider } from './ai-request-proof.ts';
import { findReviewSites } from './ai-review-sites.ts';
import { AI_RULE_KINDS, checkAiRuleTables, loadAiRuleTables, type AiRuleKind } from './ai-rules.ts';
import { loadSdkProofTable, proveSdkTable } from './sdk-request-proofs.ts';
import type { SdkMajorProposal } from './ai-sdk-majors.ts';
import { aiBudgetConfiguration } from './ai-budget.ts';
import { cliErrorMessage } from './cli-errors.ts';
import { readBoundedResponse } from './network.ts';
import { isObject, parseJson } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { terminalText } from './workflow-presentation.ts';

const USAGE = `Usage: refit ai-migrations --check-rules [--live] [--json]
       refit ai-migrations [--repository <root>] [--package <openai|@anthropic-ai/sdk|@google/genai>] [--edits-only] [--output <patch>] [--json]
       refit ai-migrations --validate [--repository <root>] [--package <name>] [--check <command>] [--image <image>] [--json]
       refit ai-migrations --ai-surfaces [--repository <root>] [--check <command>] [--image <image>] [--json]   (GitHub Actions only)
       refit ai-migrations --review [--repository <root>] [--kind <api-surface|response-format|beta-feature|sdk-major>]... [--json]
       refit ai-migrations --prove-table --sdk-directory <dir> --releases <name@version,...> --run <url> --output <path>
       refit ai-migrations --prove --provider <openai|anthropic|gemini> --calls <call>[,<call>...] [--stream] [--tools] [--json-output] [--sdk-directory <dir>] [--json]`;

const HELP = `${USAGE}

--check-rules: verifies every rule in data/rules/{openai,anthropic,gemini}: each quote must be on
its saved page under docs/ai-docs/pages. --live also reads every page from the provider again.

Default: proposes the AI SDK major upgrade for a repository: the documented rewrites, the sites left
for review and the package upgrade. The upgrade re-resolves package-lock.json in networked Docker;
--edits-only skips it and lists the code edits and stops only.

--review: lists API surface migrations, response-format changes and beta features with no
documented one-to-one mapping (and report-only Python and Gemini sites), each with its rule, quote
and page. Nothing is edited.

--prove: sends the smallest request for each call with the SDK installed in --sdk-directory and the
key from OPENAI_API_KEY or ANTHROPIC_API_KEY (refit-bench Actions secrets). Without the key nothing
is sent and the proof is pending with the reason. Spends a few cents at most.`;

const { values } = parseArgs({
  options: {
    'check-rules': { type: 'boolean' },
    live: { type: 'boolean' },
    repository: { type: 'string', default: '.' },
    package: { type: 'string' },
    'edits-only': { type: 'boolean' },
    output: { type: 'string' },
    prove: { type: 'boolean' },
    'prove-table': { type: 'boolean' },
    review: { type: 'boolean' },
    validate: { type: 'boolean' },
    'ai-surfaces': { type: 'boolean' },
    'remove-sampling': { type: 'boolean' },
    check: { type: 'string' },
    kind: { type: 'string', multiple: true },
    run: { type: 'string' },
    releases: { type: 'string' },
    provider: { type: 'string' },
    calls: { type: 'string' },
    stream: { type: 'boolean' },
    tools: { type: 'boolean' },
    'json-output': { type: 'boolean' },
    'sdk-directory': { type: 'string' },
    image: { type: 'string', default: 'node:22-alpine' },
    json: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});

// GitHub's API returns a discussion as JSON; its `body` is the page text.
async function livePage(url: string) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: url.includes('api.github.com') ? 'application/vnd.github+json' : 'text/plain',
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new PipelineInputError(`HTTP ${response.status}`);
  }
  const text = await readBoundedResponse(response, 4 * 1024 * 1024, url);
  if (!url.includes('api.github.com')) return text;
  const parsed = parseJson(text);
  if (!isObject(parsed) || typeof parsed.body !== 'string')
    throw new PipelineInputError('no discussion body');
  return parsed.body;
}

try {
  if (values.help) console.log(HELP);
  else if (values['check-rules']) {
    const tables = await loadAiRuleTables();
    const problems = await checkAiRuleTables(tables, values.live ? { live: livePage } : {});
    const count = tables.reduce((sum, table) => sum + table.rules.length, 0);
    if (values.json)
      console.log(JSON.stringify({ tables: tables.length, rules: count, problems }, null, 2));
    else {
      console.log(
        `${count} rules in ${tables.length} tables${values.live ? ', pages read live' : ''}.`,
      );
      for (const problem of problems)
        console.log(`  ${problem.table} ${problem.rule}: ${terminalText(problem.problem)}`);
    }
    process.exitCode = problems.length ? 1 : 0;
  } else if (values['ai-surfaces']) {
    // refit-bench Actions only (the run refuses elsewhere): the AI lane for shut-down OpenAI
    // Completions and Assistants calls, with OPENAI_API_KEY, OPENAI_MODEL and the AI budget.
    const key = process.env.OPENAI_API_KEY?.trim();
    if (!key)
      throw new PipelineInputError(
        'The AI surface lane needs OPENAI_API_KEY (a refit-bench secret).',
      );
    const root = resolve(values.repository!);
    const result = await runAiSurfaceMigrations({
      repository: root,
      tables: await loadAiRuleTables(),
      ai: {
        apiKey: key,
        model: process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-luna',
        budget: aiBudgetConfiguration(process.env),
      },
      checks: {
        image: values.image!,
        command: values.check ? values.check.split(/\s+/).filter(Boolean) : ['npm', 'test'],
        prepareDependencies: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].some((name) =>
          existsSync(join(root, name)),
        ),
      },
      onProgress: (message) => console.error(`  ${message}`),
    });
    console.log(
      values.json
        ? JSON.stringify(result, null, 2)
        : `${result.status}: ${terminalText(result.reason)}`,
    );
  } else if (values.validate) {
    // Benchmarks: the proposal validated with the repository's own checks before and after, in
    // offline Docker, with nothing published. `--check` names the command; otherwise `npm test`
    // when the repository has a real test script, else `npm run build`.
    const root = resolve(values.repository!);
    const scripts = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).scripts ?? {};
    const command = values.check
      ? values.check.split(/\s+/).filter(Boolean)
      : typeof scripts.test === 'string' && !/no test specified/.test(scripts.test)
        ? ['npm', 'test']
        : typeof scripts.build === 'string'
          ? ['npm', 'run', 'build']
          : undefined;
    const result = command
      ? await runAiMigrations({
          repository: root,
          tables: await loadAiRuleTables(),
          packageName: values.package,
          removeSampling: values['remove-sampling'],
          checks: {
            image: values.image!,
            command,
            prepareDependencies: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].some((name) =>
              existsSync(join(root, name)),
            ),
          },
          onProgress: (message) => console.error(`  ${message}`),
        })
      : { status: 'no-checks', reason: 'No --check, test or build script.' };
    console.log(
      values.json
        ? JSON.stringify(result, null, 2)
        : `${result.status}: ${terminalText(result.reason)}`,
    );
  } else if (values.review) {
    const kinds = (values.kind ?? AI_RULE_KINDS) as AiRuleKind[];
    if (kinds.some((kind) => !AI_RULE_KINDS.includes(kind))) throw new PipelineInputError(USAGE);
    const findings = await findReviewSites(
      resolve(values.repository!),
      await loadAiRuleTables(),
      kinds,
    );
    if (values.json) console.log(JSON.stringify(findings, null, 2));
    else if (!findings.length)
      console.log('No API surface, response-format or beta-feature site to review.');
    else
      for (const item of findings)
        console.log(
          `${item.file}:${item.line}  ${item.rule}  ${item.breaking ? 'breaking' : 'cleanup'}${item.status === 'report' ? ', report only' : ''}${item.ambiguous ? ', client unclear' : ''}${item.test ? ', test path' : ''}  ${terminalText(item.text)}`,
        );
  } else if (values['prove-table']) {
    // refit-bench Actions only: --releases names what --sdk-directory holds, as name@version,...
    if (!values['sdk-directory'] || !values.run || !values.releases || !values.output)
      throw new PipelineInputError(
        'refit ai-migrations --prove-table --sdk-directory <dir> --releases <name@version,...> --run <refit-bench run URL> --output <path>',
      );
    const releases = Object.fromEntries(
      values.releases.split(',').map((entry) => {
        const at = entry.lastIndexOf('@');
        return [entry.slice(0, at), entry.slice(at + 1)];
      }),
    );
    const table = await proveSdkTable({
      table: await loadSdkProofTable(),
      sdkDirectory: resolve(values['sdk-directory']),
      releases,
      run: values.run,
      date: new Date().toISOString().slice(0, 10),
    });
    await writeFile(values.output, `${JSON.stringify(table, null, 2)}\n`);
    for (const proof of table.proofs)
      console.log(
        `accepted  ${proof.package}@${proof.release} ${proof.call}${proof.stream ? ' +stream' : ''}${proof.tools ? ' +tools' : ''}${proof.json ? ' +json' : ''}`,
      );
    for (const item of table.pending)
      console.log(
        `pending   ${item.package}@${item.major} ${item.call}: ${terminalText(item.reason)}`,
      );
  } else if (values.prove) {
    const provider = values.provider as ProofProvider;
    if (!['openai', 'anthropic', 'gemini'].includes(provider) || !values.calls)
      throw new PipelineInputError(USAGE);
    const proof = await proveRequests({
      provider,
      sdkDirectory: values['sdk-directory'] && resolve(values['sdk-directory']),
      calls: values.calls.split(',').map((call) => ({
        call: call.trim(),
        stream: values.stream,
        tools: values.tools,
        json: values['json-output'],
      })),
    });
    console.log(
      values.json
        ? JSON.stringify(proof, null, 2)
        : `${proof.status}: ${terminalText(proof.reason)}`,
    );
    process.exitCode = proof.status === 'rejected' ? 2 : 0;
  } else {
    const tables = await loadAiRuleTables();
    const root = resolve(values.repository!);
    const proposal: (SdkMajorProposal & Partial<AiMigrationProposal>) | null = values['edits-only']
      ? await proposeSdkMajor(root, tables, values.package)
      : await proposeAiMigrations(root, tables, {
          image: values.image!,
          before: new Date().toISOString(),
          packageName: values.package,
          removeSampling: values['remove-sampling'],
        });
    if (values.output && proposal?.patch) await writeFile(values.output, proposal.patch);
    if (values.json) console.log(JSON.stringify(proposal, null, 2));
    else if (!proposal) console.log('No AI SDK below its target major.');
    else {
      console.log(
        `${proposal.packageName} ${proposal.installed} → ${proposal.targetMajor}.x: ${proposal.edits.length} edits, ${proposal.stops.length} left for review.`,
      );
      for (const stop of proposal.stops)
        console.log(`  ${stop.file}:${stop.line}  ${stop.rule}  ${terminalText(stop.reason)}`);
      if (proposal.upgradeRefusal)
        console.log(`  Package upgrade refused: ${terminalText(proposal.upgradeRefusal)}`);
    }
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(cliErrorMessage(error, 'ai-migrations'));
  process.exitCode = 1;
}
