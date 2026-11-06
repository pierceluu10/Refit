import { describe, expect, it } from 'vitest';
import {
  androidSdkCheck,
  findSdkSettings,
  iosPrivacyManifestCheck,
  parsePrivacyManifest,
  playRequirement,
} from './mobile.ts';
import { fixture } from './test-helpers.ts';

const now = new Date('2026-11-06T00:00:00Z');

describe('android sdk proof', () => {
  it('reads Groovy, Kotlin and manifest settings', () => {
    expect(
      findSdkSettings('build.gradle', 'targetSdkVersion 33\nminSdkVersion 21').map((s) => [
        s.key,
        s.value,
      ]),
    ).toEqual([
      ['targetSdk', 33],
      ['minSdk', 21],
    ]);
    expect(findSdkSettings('build.gradle.kts', 'targetSdk = 35').map((s) => s.value)).toEqual([35]);
    expect(
      findSdkSettings(
        'AndroidManifest.xml',
        '<uses-sdk android:minSdkVersion="23" android:targetSdkVersion="34" />',
      ).map((s) => s.value),
    ).toEqual([23, 34]);
  });

  it('knows the requirement by date', () => {
    expect(playRequirement('2025-01-01')?.api).toBe(34);
    expect(playRequirement('2026-11-06')?.api).toBe(35);
  });

  it('fails a target below the requirement and says the table may be stale', async () => {
    const result = await androidSdkCheck.run({}, { repoDir: fixture('android-old'), now });
    expect(result.passed).toBe(false);
    expect(result.failedItems).toContain(
      "app/build.gradle:5 targetSdk 33 is below Play's required API 35",
    );
    expect(result.notes.join('\n')).toContain('the table ends there');
  });

  it('passes a current target, uses an agent-confirmed requirement, and reads around non-literals', async () => {
    const passing = await androidSdkCheck.run(
      { requiredMinSdk: 23 },
      { repoDir: fixture('android-new'), now },
    );
    expect(passing.passed).toBe(true);
    expect(passing.passedItems).toContain(
      'app/build.gradle.kts:4 minSdk 24 meets the required minSdk 23',
    );
    const newer = await androidSdkCheck.run(
      { requiredTargetSdk: 36 },
      { repoDir: fixture('android-new'), now },
    );
    expect(newer.failedItems).toContain(
      "app/build.gradle.kts:5 targetSdk 35 is below Play's required API 36",
    );
  });
});

describe('ios privacy manifest proof', () => {
  it('fails required-reason APIs with no manifest', async () => {
    const result = await iosPrivacyManifestCheck.run({}, { repoDir: fixture('ios-missing') });
    expect(result.passed).toBe(false);
    const failed = result.failedItems.join('\n');
    expect(failed).toContain(
      'NSPrivacyAccessedAPICategoryUserDefaults is used (App/Store.swift:4 UserDefaults)',
    );
    expect(failed).toContain('NSPrivacyAccessedAPICategorySystemBootTime');
  });

  it('passes when the manifest declares a reason for each', async () => {
    const result = await iosPrivacyManifestCheck.run({}, { repoDir: fixture('ios-ok') });
    expect(result.passed).toBe(true);
    expect(result.passedItems.join('\n')).toContain(
      'declared in App/PrivacyInfo.xcprivacy with CA92.1',
    );
  });

  it('flags a malformed manifest and bad reason codes', () => {
    const bad = parsePrivacyManifest(
      'P.xcprivacy',
      '<plist><dict><key>NSPrivacyAccessedAPITypes</key><array><dict><key>NSPrivacyAccessedAPIType</key><string>NSPrivacyAccessedAPICategoryDiskSpace</string><key>NSPrivacyAccessedAPITypeReasons</key><array><string>because</string></array></dict></array></dict>',
    );
    expect(bad.problems.join('\n')).toContain('not a well-formed plist');
    expect(bad.problems.join('\n')).toContain('reason "because" is not a reason code');
  });

  it('is unknown with no iOS app', async () => {
    const result = await iosPrivacyManifestCheck.run({}, { repoDir: fixture('k8s-new') });
    expect(result.passed).toBe('unknown');
  });
});
