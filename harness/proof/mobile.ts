// Mobile: Android targetSdk and minSdk against Google Play's target API requirement, and an iOS
// privacy manifest that declares a reason for every required-reason API the native code uses.
// Both read files only; nothing from the repo runs.
import type { ProofCheck } from './types.ts';
import {
  lineOf,
  optNumber,
  optString,
  proofDetail,
  readRoot,
  readText,
  walkFiles,
} from './util.ts';

// Source: https://developer.android.com/google/play/requirements/target-sdk and
// https://support.google.com/googleplay/android-developer/answer/11926878. New apps and updates must
// target at least `api` from `from`. The table stops at the last requirement recorded here; pass
// `requiredTargetSdk` when the agent has confirmed a newer one at the source.
export const PLAY_TARGET_SDK: { from: string; api: number }[] = [
  { from: '2023-08-31', api: 33 },
  { from: '2024-08-31', api: 34 },
  { from: '2025-08-31', api: 35 },
];

export type SdkSetting = {
  file: string;
  line: number;
  key: 'targetSdk' | 'minSdk' | 'compileSdk';
  value?: number;
  raw: string;
};

export function findSdkSettings(file: string, text: string): SdkSetting[] {
  const out: SdkSetting[] = [];
  const gradle = /\b(targetSdk|minSdk|compileSdk)(?:Version)?\s*(?:=|\(|\s)\s*([^\s)]+)/g;
  const manifest = /android:(targetSdk|minSdk)Version\s*=\s*"([^"]+)"/g;
  const re = /\.xml$/.test(file) ? manifest : gradle;
  for (const match of text.matchAll(re)) {
    const raw = match[2].replace(/["']/g, '');
    const value = /^\d+$/.test(raw) ? Number(raw) : undefined;
    out.push({
      file,
      line: lineOf(text, match.index ?? 0),
      key: match[1] as SdkSetting['key'],
      value,
      raw,
    });
  }
  return out;
}

export function playRequirement(asOf: string): { api: number; from: string } | undefined {
  return [...PLAY_TARGET_SDK].reverse().find((r) => r.from <= asOf);
}

export const androidSdkCheck: ProofCheck = {
  name: 'android-sdk',
  description:
    "Check an Android app's targetSdk and minSdk (build.gradle, build.gradle.kts, AndroidManifest.xml) against Google Play's target API requirement. Returns evidence, never blocks.",
  inputSchema: {
    type: 'object',
    properties: {
      requiredTargetSdk: {
        type: 'number',
        description:
          "Play's current target API level, if the agent confirmed a newer one than the built-in table",
      },
      requiredMinSdk: {
        type: 'number',
        description: 'A minimum minSdk to check against, e.g. what a dependency now requires',
      },
      asOf: {
        type: 'string',
        description: 'Judge the requirement as of this date (YYYY-MM-DD). Default: today',
      },
    },
  },
  run: async (input, ctx) => {
    const root = readRoot(ctx);
    const asOf = optString(input, 'asOf') ?? (ctx.now ?? new Date()).toISOString().slice(0, 10);
    const fromTable = playRequirement(asOf);
    const required = optNumber(input, 'requiredTargetSdk') ?? fromTable?.api;
    const requiredMin = optNumber(input, 'requiredMinSdk');
    const files = (await walkFiles(root)).filter((f) =>
      /(^|\/)(build\.gradle(\.kts)?|AndroidManifest\.xml)$/.test(f),
    );
    const settings: SdkSetting[] = [];
    for (const file of files) {
      const text = await readText(root, file);
      if (text) settings.push(...findSdkSettings(file, text));
    }
    const passedItems: string[] = [];
    const failedItems: string[] = [];
    const notes: string[] = [];
    if (optNumber(input, 'requiredTargetSdk') === undefined && fromTable) {
      const last = PLAY_TARGET_SDK.at(-1)!;
      notes.push(
        `requirement from the built-in table: API ${fromTable.api} since ${fromTable.from}${fromTable === last ? `; the table ends there, so confirm whether a newer level applies on ${asOf}` : ''}`,
      );
    }
    for (const s of settings) {
      const where = `${s.file}:${s.line} ${s.key} ${s.raw}`;
      if (s.value === undefined) {
        notes.push(`${where} is not a literal; read where it is defined`);
        continue;
      }
      if (s.key === 'targetSdk' && required !== undefined) {
        if (s.value >= required) passedItems.push(`${where} meets Play's API ${required}`);
        else failedItems.push(`${where} is below Play's required API ${required}`);
      }
      if (s.key === 'minSdk') {
        const target = settings.find(
          (t) => t.key === 'targetSdk' && t.file === s.file && t.value !== undefined,
        )?.value;
        if (target !== undefined && s.value > target)
          failedItems.push(`${where} is above targetSdk ${target}`);
        if (requiredMin !== undefined) {
          if (s.value >= requiredMin)
            passedItems.push(`${where} meets the required minSdk ${requiredMin}`);
          else failedItems.push(`${where} is below the required minSdk ${requiredMin}`);
        } else notes.push(`${where} (Play sets no minimum minSdk; libraries may)`);
      }
    }
    if (files.length === 0) notes.push('no Android build files found');
    return proofDetail('android-sdk', {
      passedItems,
      failedItems,
      notes,
      ...(settings.length === 0 ? { passed: 'unknown' as const } : {}),
    });
  },
};

// Source: https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api
// Symbols per category. Matching is textual, so the agent should read each hit before trusting it.
export const REQUIRED_REASON_APIS: Record<string, RegExp> = {
  NSPrivacyAccessedAPICategoryFileTimestamp:
    /\b(creationDate|modificationDate|fileModificationDate|contentModificationDateKey|creationDateKey|getattrlist|getattrlistbulk|fgetattrlist|getattrlistat)\b|\b(stat|fstat|fstatat|lstat)\s*\(/,
  NSPrivacyAccessedAPICategorySystemBootTime: /\b(systemUptime|mach_absolute_time)\b/,
  NSPrivacyAccessedAPICategoryDiskSpace:
    /\b(volumeAvailableCapacityKey|volumeAvailableCapacityForImportantUsageKey|volumeAvailableCapacityForOpportunisticUsageKey|volumeTotalCapacityKey|systemFreeSize|systemSize)\b|\b(statfs|statvfs|fstatfs|fstatvfs)\s*\(/,
  NSPrivacyAccessedAPICategoryActiveKeyboards: /\bactiveInputModes\b/,
  NSPrivacyAccessedAPICategoryUserDefaults: /\b(NSUserDefaults|UserDefaults)\b/,
};

export type PrivacyManifest = {
  file: string;
  wellFormed: boolean;
  declared: Record<string, string[]>;
  problems: string[];
};

export function parsePrivacyManifest(file: string, text: string): PrivacyManifest {
  const problems: string[] = [];
  const wellFormed =
    /<plist[\s>]/.test(text) && /<\/plist>/.test(text) && /<dict>/.test(text) && balancedTags(text);
  if (!wellFormed) problems.push(`${file} is not a well-formed plist`);
  const declared: Record<string, string[]> = {};
  const entry = /<key>NSPrivacyAccessedAPIType<\/key>\s*<string>([^<]+)<\/string>/g;
  for (const match of text.matchAll(entry)) {
    const category = match[1].trim();
    // The reasons array belongs to the same dict: search until the dict closes.
    const rest = text.slice((match.index ?? 0) + match[0].length);
    const before = text.slice(0, match.index ?? 0);
    const dictStart = before.lastIndexOf('<dict>');
    const dictBody = text.slice(
      dictStart,
      (match.index ?? 0) + match[0].length + rest.indexOf('</dict>'),
    );
    const reasons = /<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
      dictBody,
    );
    const codes = reasons
      ? [...reasons[1].matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1].trim())
      : [];
    if (!Object.hasOwn(REQUIRED_REASON_APIS, category))
      problems.push(`${file} declares unknown category ${category}`);
    if (codes.length === 0) problems.push(`${file} declares ${category} with no reasons`);
    for (const code of codes)
      if (!/^[0-9A-F]{4}\.\d$/.test(code))
        problems.push(`${file} ${category} reason "${code}" is not a reason code like "CA92.1"`);
    declared[category] = codes;
  }
  return { file, wellFormed, declared, problems };
}

function balancedTags(text: string): boolean {
  const stack: string[] = [];
  for (const match of text
    .replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g, '')
    .matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = match;
    if (selfClosing) continue;
    if (!closing) stack.push(name);
    else if (stack.pop() !== name) return false;
  }
  return stack.length === 0;
}

export const iosPrivacyManifestCheck: ProofCheck = {
  name: 'ios-privacy-manifest',
  description:
    "Check that an iOS app's PrivacyInfo.xcprivacy is a valid plist and declares an approved reason for every required-reason API category its Swift and Objective-C code uses. Returns evidence, never blocks.",
  inputSchema: { type: 'object', properties: {} },
  run: async (_input, ctx) => {
    const root = readRoot(ctx);
    const files = await walkFiles(root);
    const sources = files.filter((f) => /\.(swift|m|mm|c|h)$/.test(f));
    const isIosApp =
      files.some((f) =>
        /\.xcodeproj\/|\.xcworkspace\/|(^|\/)Info\.plist$|(^|\/)Podfile$/.test(f),
      ) || sources.some((f) => f.endsWith('.swift'));
    const used = new Map<string, string[]>();
    for (const file of sources) {
      const text = await readText(root, file);
      if (!text) continue;
      for (const [category, re] of Object.entries(REQUIRED_REASON_APIS)) {
        const global = new RegExp(re.source, 'g');
        for (const match of text.matchAll(global)) {
          const hits = used.get(category) ?? [];
          if (hits.length < 5)
            hits.push(`${file}:${lineOf(text, match.index ?? 0)} ${match[0].trim()}`);
          used.set(category, hits);
        }
      }
    }
    const manifests: PrivacyManifest[] = [];
    for (const file of files.filter((f) => f.endsWith('PrivacyInfo.xcprivacy'))) {
      const text = await readText(root, file);
      if (text !== undefined) manifests.push(parsePrivacyManifest(file, text));
    }
    const passedItems: string[] = [];
    const failedItems: string[] = [];
    const notes: string[] = [];
    for (const m of manifests) {
      failedItems.push(...m.problems);
      if (m.problems.length === 0)
        passedItems.push(
          `${m.file} is a well-formed privacy manifest declaring ${Object.keys(m.declared).length} API categories`,
        );
    }
    for (const [category, hits] of used) {
      const declaredIn = manifests.find((m) => (m.declared[category] ?? []).length > 0);
      if (declaredIn)
        passedItems.push(
          `${category} is used (${hits[0]}) and declared in ${declaredIn.file} with ${declaredIn.declared[category].join(', ')}`,
        );
      else
        failedItems.push(
          `${category} is used (${hits.join('; ')}) but no privacy manifest declares a reason for it`,
        );
    }
    if (used.size === 0 && isIosApp)
      passedItems.push('no required-reason APIs found in Swift or Objective-C sources');
    if (!isIosApp) notes.push('no iOS app project found');
    notes.push(
      'third-party SDKs ship their own manifests; Pods and other vendored folders were not scanned',
    );
    return proofDetail('ios-privacy-manifest', {
      passedItems,
      failedItems,
      notes,
      ...(!isIosApp && manifests.length === 0 ? { passed: 'unknown' as const } : {}),
    });
  },
};
