import { afterEach, describe, expect, it } from 'vitest';
import { scanDeadApis, type DeadScanReport } from './dead-scan.ts';
import { makeRepo, removeRepo } from './test-fixtures.ts';

const TODAY = '2026-11-05';
const manifest = (dependencies: Record<string, string>) =>
  JSON.stringify({ dependencies }, null, 2);

const repos: string[] = [];
async function scan(files: Record<string, string>, today = TODAY): Promise<DeadScanReport> {
  const repoDir = await makeRepo(files);
  repos.push(repoDir);
  return scanDeadApis(repoDir, 'test/repo', { today });
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map(removeRepo));
});

/** Shows the whole report when a check fails, since a wrong class is usually about its reason. */
function explain(report: DeadScanReport): string {
  return report.details
    .map((one) => `${one.matchClass} ${one.entryId} ${one.file}:${one.line} ${one.reason}`)
    .concat(report.quiet.map((one) => `quiet ${one.entryId} ${one.file}:${one.line} ${one.reason}`))
    .join('\n');
}

const flagged = (report: DeadScanReport) =>
  report.details
    .filter((one) => one.matchClass === 'live' || one.matchClass === 'unclear')
    .map((one) => `${one.entryId} ${one.file}:${one.line}`)
    .sort();

describe('queue platforms on the dead list', () => {
  it('firebase: flags what shut down, and not the live call beside it', async () => {
    const report = await scan({
      'package.json': manifest({ firebase: '^12.0.0', 'firebase-admin': '^13.0.0' }),
      'server.ts': [
        "await fetch('https://fcm.googleapis.com/fcm/send', init);",
        "await fetch('https://fcm.googleapis.com/v1/projects/app/messages:send', init);",
        "await fetch('https://fcm.googleapis.com/fcm/send/browser-subscription-token', init);",
      ].join('\n'),
      'Upstream.kt': [
        'messaging.send(remoteMessage("$SENDER_ID@fcm.googleapis.com") { addData("a", "b") })',
        'adminMessaging.send(message)',
      ].join('\n'),
      'links.ts': [
        "await fetch('https://firebasedynamiclinks.googleapis.com/v1/shortLinks', init);",
        "const open = 'https://app.web.app/welcome';",
      ].join('\n'),
      'image.ts': [
        "import { getAI, getGenerativeModel, getImagenModel, GoogleAIBackend } from 'firebase/ai';",
        'const ai = getAI(app, { backend: new GoogleAIBackend() });',
        'const dead = getImagenModel(ai, { model: IMAGE_MODEL });',
        "const live = getGenerativeModel(ai, { model: 'gemini-nano-banana-2.1' });",
      ].join('\n'),
      'agent.ts': [
        "import { getAI, getGenerativeModel, AgentPlatformBackend } from 'firebase/ai';",
        'const ai = getAI(app, { backend: new AgentPlatformBackend() });',
        "const dead = getGenerativeModel(ai, { model: 'gemini-2.5-flash' });",
        "const live = getGenerativeModel(ai, { model: 'gemini-3.8-flash' });",
      ].join('\n'),
      'Agent.kt': [
        'val ai = Firebase.ai(backend = GenerativeBackend.agentPlatform())',
        'val dead = ai.generativeModel("gemini-2.5-pro")',
        'val live = ai.generativeModel("gemini-3.8-flash")',
      ].join('\n'),
      'developer.ts': [
        "import { getAI, getGenerativeModel, GoogleAIBackend } from 'firebase/ai';",
        'const ai = getAI(app, { backend: new GoogleAIBackend() });',
        "const live = getGenerativeModel(ai, { model: 'gemini-2.5-flash' });",
      ].join('\n'),
    });
    expect(flagged(report), explain(report)).toEqual([
      'FB-1.fcm-legacy-http server.ts:1',
      'FB-2.fcm-upstream Upstream.kt:1',
      'FB-3.dynamic-links links.ts:1',
      'FB-4.imagen image.ts:3',
      'FB-5.gemini-2.5-agent-platform Agent.kt:2',
      'FB-5.gemini-2.5-agent-platform agent.ts:3',
    ]);
  });

  it('firebase: a shutdown still ahead stays quiet until its day', async () => {
    const files = {
      'package.json': manifest({ 'firebase-admin': '^13.0.0' }),
      'groups.ts': "await fetch('https://fcm.googleapis.com/fcm/notification', init);\n",
    };
    const before = await scan(files);
    expect(flagged(before), explain(before)).toEqual([]);
    const after = await scan(files, '2027-09-29');
    expect(flagged(after), explain(after)).toEqual([
      'FB-6.fcm-instance-id-device-groups groups.ts:1',
    ]);
  });

  it('google-oauth-oob: flags the OOB redirect with Google, and not on another OAuth server', async () => {
    const report = await scan({
      'package.json': manifest({ 'google-auth-library': '^10.0.0' }),
      'google.ts': [
        "const authorize = 'https://accounts.google.com/o/oauth2/v2/auth';",
        "const dead = 'urn:ietf:wg:oauth:2.0:oob';",
        "const live = 'http://127.0.0.1:8080/callback';",
      ].join('\n'),
      'other.ts': [
        "const authorize = 'https://login.example.com/authorize';",
        "const theirs = 'urn:ietf:wg:oauth:2.0:oob';",
      ].join('\n'),
    });
    expect(flagged(report), explain(report)).toEqual(['GI-1.oauth-oob google.ts:2']);
  });

  it('tiktok: flags the v1 endpoints, and not their v2 replacements', async () => {
    const report = await scan({
      'login.ts': [
        "await fetch('https://open-api.tiktok.com/oauth/access_token/', init);",
        "await fetch('https://open.tiktokapis.com/v2/oauth/token/', init);",
        "const live = 'https://www.tiktok.com/v2/auth/authorize/';",
      ].join('\n'),
      'qr.ts': [
        "await fetch('https://open-api.tiktok.com/v0/oauth/get_qrcode', init);",
        "await fetch('https://open.tiktokapis.com/v2/oauth/get_qrcode/', init);",
      ].join('\n'),
      'upload.ts': [
        "await fetch('https://open-api.tiktok.com/share/video/upload/?open_id=1', init);",
        "await fetch('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', init);",
      ].join('\n'),
    });
    expect(flagged(report), explain(report)).toEqual([
      'TT-1.oauth-v1-web login.ts:1',
      'TT-2.qrcode-v1 qr.ts:1',
      'TT-3.share-video upload.ts:1',
    ]);
  });
});
