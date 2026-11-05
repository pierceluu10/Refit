import { afterEach, describe, expect, it } from 'vitest';
import { scanDeadApis, type DeadScanReport } from './dead-scan.ts';
import { makeRepo, removeRepo } from './test-fixtures.ts';

const TODAY = '2026-11-05';

const repos: string[] = [];
async function scan(files: Record<string, string>, today = TODAY): Promise<DeadScanReport> {
  const repoDir = await makeRepo(files);
  repos.push(repoDir);
  return scanDeadApis(repoDir, 'test/repo', { today });
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map(removeRepo));
});

/** What the provider's entries send on to a fix or the AI check, as `id:line`. */
const flagged = (report: DeadScanReport, prefix: string) =>
  report.details
    .filter(
      (one) =>
        one.entryId.startsWith(prefix) &&
        (one.matchClass === 'live' || one.matchClass === 'unclear'),
    )
    .map((one) => `${one.entryId}:${one.line}`)
    .sort();

function explain(report: DeadScanReport): string {
  return report.details
    .map((one) => `${one.matchClass} ${one.entryId} ${one.file}:${one.line} ${one.reason}`)
    .concat(report.quiet.map((one) => `quiet ${one.entryId} ${one.file}:${one.line} ${one.reason}`))
    .join('\n');
}

describe('telegram', () => {
  const FILE = [
    "import { Telegraf } from 'telegraf';",
    'await bot.sendMessage(chatId, text, { receiver_user_id: 5 });',
    'await bot.sendMessage(chatId, text, { ephemeral_message_parameters: { receiver_user_id: 5 } });',
    'await bot.answerCallbackQuery({ callback_query_id: query.id });',
    'await fetch(`https://api.telegram.org/bot${token}/sendPhoto?chat_id=1&callback_query_id=2`);',
    'await bot.editEphemeralMessageText({ chat_id: 1, receiver_user_id: 5 });',
    'const answers = poll.correct_option_id;',
    'const correct = poll.correct_option_ids;',
    'const price = gift.last_resale_star_count;',
    'const amount = gift.last_resale_amount;',
    'await bot.getBusinessAccountGifts({ exclude_limited: true });',
    'await bot.getBusinessAccountGifts({ exclude_limited_upgradable: true });',
  ].join('\n');

  it('flags the dead names and leaves their live neighbours alone', async () => {
    const report = await scan({ 'src/bot.ts': FILE });
    expect(flagged(report, 'TG-'), explain(report)).toEqual([
      'TG-1.send-ephemeral-params:2',
      'TG-1.send-ephemeral-params:5',
      'TG-2.correct_option_id:7',
      'TG-3.last_resale_star_count:9',
      'TG-4.exclude_limited:11',
    ]);
  });

  it("leaves a quiz app's own correct_option_id alone in a file that never names Telegram", async () => {
    const report = await scan({
      'src/bot.ts': "import { Telegraf } from 'telegraf';\n",
      'src/quiz.ts': 'export const isRight = (row, id) => row.correct_option_id === id;\n',
    });
    expect(flagged(report, 'TG-'), explain(report)).toEqual([]);
  });
});

describe('deepgram', () => {
  it('flags the dead parameters and leaves the current ones alone', async () => {
    const report = await scan({
      'src/listen.ts': [
        "const url = 'https://api.deepgram.com/v1/listen?analyze_sentiment=true';",
        "const live = 'https://api.deepgram.com/v1/listen?sentiment=true';",
        "const topics = 'https://api.deepgram.com/v1/listen?detect_topics=true';",
        "const liveTopics = 'https://api.deepgram.com/v1/listen?topics=true';",
        "const brief = { summarize: 'v1' };",
        "const liveBrief = { summarize: 'v2' };",
        "const liveDefault = 'https://api.deepgram.com/v1/listen?summarize=true';",
      ].join('\n'),
    });
    expect(flagged(report, 'DG-'), explain(report)).toEqual([
      'DG-1.analyze_sentiment:1',
      'DG-2.detect_topics:3',
      'DG-3.summarize-v1:5',
    ]);
  });

  it('flags the retired agent model and the callback header, not what replaced them', async () => {
    const report = await scan({
      'src/agent.ts': [
        "import { createClient } from '@deepgram/sdk';",
        "const old = { type: 'google', model: 'gemini-3.1-flash-lite-preview' };",
        "const current = { type: 'google', model: 'gemini-3.1-flash-lite' };",
        "const token = req.headers['dg-token'];",
        "const auth = req.headers['authorization'];",
      ].join('\n'),
    });
    expect(flagged(report, 'DG-'), explain(report)).toEqual([
      'DG-4.gemini-3.1-flash-lite-preview:2',
      'DG-5.dg-token:4',
    ]);
  });

  it("leaves an app's own analyze_sentiment function and summarize option alone", async () => {
    const report = await scan({
      'src/deepgram.ts': "import { createClient } from '@deepgram/sdk';\n",
      'src/own.py':
        'result = analyze_sentiment(text)\nreport(summarize=v1, analyze_sentiment=True)\n',
    });
    expect(flagged(report, 'DG-'), explain(report)).toEqual([]);
  });

  it('leaves the Gemini model id alone in a repo with no Deepgram', async () => {
    const report = await scan({
      'src/gemini.ts': "const old = { model: 'gemini-3.1-flash-lite-preview' };\n",
    });
    expect(flagged(report, 'DG-'), explain(report)).toEqual([]);
  });
});

describe('elevenlabs', () => {
  const FILE = [
    "import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';",
    "const tool = { type: 'api_integration_mcp' };",
    "const liveTool = { type: 'mcp' };",
    "const url = 'https://api.elevenlabs.io/v1/convai/conversations?data_collection_params=age:missing';",
    "const liveUrl = 'https://api.elevenlabs.io/v1/convai/conversations?data_collection_params=age:eq:';",
    'const discover = doc.auto_sync_info.auto_discover;',
    'const sync = doc.auto_sync_info.frequency;',
    'const depth = crawl_job.max_depth;',
    'const tree = { max_depth: 3 };',
    'const forest = model.max_depth;',
  ].join('\n');

  it('flags the dead names and leaves their live neighbours alone', async () => {
    const report = await scan({ 'src/agent.ts': FILE });
    expect(flagged(report, 'EL-'), explain(report)).toEqual([
      'EL-1.api_integration_mcp:2',
      'EL-2.data-collection-missing:4',
      'EL-3.auto_discover:6',
      'EL-4.crawl-job-max_depth:8',
    ]);
  });

  it('holds the sound effects model until its day, and spares the new one', async () => {
    const files = {
      'src/sfx.ts': [
        "import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';",
        "const old = { model_id: 'eleven_text_to_sound_v2' };",
        "const current = { model_id: 'eleven_text_to_sound_v3' };",
      ].join('\n'),
    };
    const before = await scan(files);
    expect(flagged(before, 'EL-5'), explain(before)).toEqual([]);
    const after = await scan(files, '2027-03-02');
    expect(flagged(after, 'EL-5'), explain(after)).toEqual(['EL-5.eleven_text_to_sound_v2:2']);
  });
});
