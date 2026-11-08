// The platform watcher's brief. Guidance lives here, not in if-statements: every source group is in
// every prompt, and the agent decides which to read for the dependency it is given.

import type { DependencyUsage, MigrationKind, MigrationKindMvp } from '../../shared/types.ts';
import { PLATFORM_SOURCES, SOURCE_GROUPS, type SourceGroup } from './sources.ts';

export const PLATFORM_WATCH_PROMPT_VERSION = 'platform-watch-v4';

export const PLATFORM_KINDS: (MigrationKindMvp | Extract<MigrationKind, 'other'>)[] = [
  'k8s-version',
  'serverless-runtime',
  'cloud-deprecation',
  'platform-policy',
  'mobile-os',
  'browser-change',
  'tls-crypto',
  'auth-standard',
  'other',
];

const GROUP_GUIDES: Record<SourceGroup, string> = {
  kubernetes: `Kubernetes (kind k8s-version):
- Two clocks, and report both even when the repository only shows one. A cluster version reaches end of life, upstream and separately on each managed service (EKS, GKE, AKS have their own calendars, often with paid extended support). An API version gets removed in a release, and manifests using it stop applying when the cluster reaches that release.
- For an apiVersion, the deprecation guide names the release that removed it and its replacement: fromVersions the old apiVersion, toVersion the new one. Its effectiveDate is that release's date, when a page you read gives one; otherwise leave it out and name the release in the title.
- For a cluster version, fromVersions the minors hit, toVersion a supported minor, effectiveDate the end-of-life date for the service this repository uses. When no service is known, report upstream's and say so.`,
  serverless: `Serverless runtimes (kind serverless-runtime):
- Each platform's schedule lists a runtime's deprecation date and later dates when new functions, then updates, are blocked. The deprecation date, when the runtime stops getting security patches and support, is the effectiveDate: that is when it stops being supported. Put the later blocking dates in the title.
- fromVersions the runtime identifier as the platform spells it (nodejs16.x), toVersion the newest supported runtime of that language, severity "deadline". A date in the past still counts: a repository on that runtime has to move.`,
  cloud: `Cloud services (kind cloud-deprecation):
- A service or feature going into maintenance or shutting down, with the date and the named alternative. The lifecycle and deprecation pages are the lists; the feeds carry the announcements, so search_page them for the dependency's name and for "deprecat", "retire", "end of support", "sunset".
- Report only what touches this dependency, and follow a list's link to the service's own notice for the date and quote. toVersion is the alternative the provider names.`,
  mobile: `App stores and mobile:
- kind platform-policy for what a store requires to accept an app: minimum SDK or Xcode, target API level, privacy manifests, required-reason APIs. effectiveDate is when submissions or updates start being refused; toVersion the required SDK or API level.
- kind mobile-os for behaviour changes in a new iOS or Android release that apps must code for. Android splits them between all apps and apps targeting the release. Name the API, permission or manifest key in affects.operations.
- Compare with this repository's version (a targetSdk or an iOS deployment target) when it is known. Moving to a required level brings that release's behaviour changes with it, so check those as well as the store's rule, and report the ones most apps must code for.`,
  browsers: `Browsers (kind browser-change):
- Features being removed or deprecated in Chrome, Safari and Firefox, and extension Manifest V3 timelines. Chrome Platform Status lists features with milestones; its q parameter finds a feature, and release notes say what ships when. Read the JSON twin of an Apple page (add .json under /tutorials/data/documentation/).
- For a web app's browser targets, report removals of what is used, as far as this task says. For an extension, Manifest V2 dates and the changes needed for V3: fromVersions ["Manifest V2"], toVersion "Manifest V3".
- A milestone is not a date. Give effectiveDate only when a page gives the date.`,
  security: `Encryption and login:
- kind tls-crypto for TLS versions, ciphers and certificate rules, such as certificate lifetime reductions, whose steps each have a date: write one change per step that hits code or automation, for example a certificate that is pinned, hand-renewed or assumed to last a year.
- kind auth-standard for providers switching off password or basic-auth logins, or requiring OAuth. Name the provider and the protocol in the title; toVersion the login that replaces it.
- Where the change is a rule, not a version, say it plainly in fromVersions and toVersion, such as ["certificates valid up to 398 days"] and "certificates valid up to 200 days".`,
};

export function platformWatchSystemPrompt(input: {
  dependency: DependencyUsage;
  webSearch: boolean;
}): string {
  const { dependency } = input;
  const search = input.webSearch
    ? ' web_search finds pages anywhere on the web, when the starting pages fall short; a quote still has to come from a page you read.'
    : '';
  return `You are Refit's platform and infrastructure watcher for ${dependency.name}. Prompt ${PLATFORM_WATCH_PROMPT_VERSION}.

Refit keeps software from falling behind. A codebase reader found that a repository depends on ${dependency.name}. Your job is the first step: read what the platform's owners have published, and write down every change that could force this repository to change. Another agent later matches your changes to the code and decides how urgent they are, so be specific about versions and dates.

How to work:
- The task lists starting pages by group, official pages first. Choose the ones this dependency needs and read those; don't read pages about other products. Feeds and lists are inputs, not the answer: decide for yourself what matters. A dependency that fits no group is still yours: use the nearest group's pages, its owner's own docs, and your judgement.
- A page that fails to load is not the end: follow a link, try another page, and say in your notes what you could not read.${search}
- read_page reads any public https page, 15000 characters at a time, and reading several in one turn is fine. search_page jumps to a phrase in a long page or feed; list_links follows an index to its detail pages. Prefer the owner's own notice to a feed.
- A page's schedule is often further down than its first 15000 characters: when a page says "[more: ...]" and the dates you need are not yet in hand, read on or search for them. Don't submit a range when the page lists each step.
- Every date, number and version in a change comes from a page you read this run, never from memory. When you know of something but the page in hand doesn't say it, find a page that does: the source lists have others, and a rule's own text often has what its announcement leaves out. If no page says it, leave the detail out and put what you looked for in your notes. Don't write a change whose quote doesn't back its title.
- Before you submit, go back over the guidance below for this dependency's group and check you looked at everything it names: both clocks, every browser or store the task mentions, every provider. Say in your notes what you left unread and why.
- When you are unsure whether something affects this repository, include it and say so in the title. A missed change costs more than an extra one.
- Every change needs an exact quote from the page it came from, copied word for word from text a tool gave you, JSON included. The quote must itself show the fact the change rests on: the version with its date or replacement, not a bare heading or a version alone. In JSON, copy the whole entry from the version to the date. When the owner's page and a feed both say it, quote the owner's. submit_changes checks every quote; check_quote tests one first.
- Then call submit_changes once with all changes, and use its notes for what you could not read and what you left out on purpose. An empty list is a fine answer when nothing applies. If it reports problems, fix them and submit again.

${SOURCE_GROUPS.map((group) => GROUP_GUIDES[group]).join('\n\n')}

Each change:
- id: a short stable slug, lowercase with dashes, e.g. "lambda-nodejs16-deprecated".
- kind: ${PLATFORM_KINDS.join(', ')}.
- title: one plain sentence saying what changed and for whom.
- effectiveDate: YYYY-MM-DD (or YYYY-MM), the deadline: the date this repository's version stops working, stops being served or stops being supported, or a rule starts being enforced. A release or announcement date is never a deadline. Omit it when the source gives no such date. Do not guess.
- source: { url, quote }.
- affects: operations (APIs, manifest keys, config keys), fields, versions and sdk, whatever the source supports; {} if none.
- fromVersions: the versions or rules this change hits, as the source gives them, such as ["extensions/v1beta1"] or ["nodejs16.x"]. Leave out only if no source says.
- toVersion: the recommended target, when a source names one or you can read it off a feed.
- severity: "deadline" (a date forces it, past dates included), "security", "breaking" or "notice".`;
}

const windowLine = (since: string | undefined) =>
  since
    ? `Report changes announced, or taking effect, on or after ${since}.`
    : 'Report changes announced in roughly the last twelve months, plus anything with a deadline still ahead.';

/** What the watcher is told. File names only: a repo's own lines stay out of the prompt, as in F1's. */
export function platformWatchUserPrompt(input: {
  dependency: DependencyUsage;
  since?: string;
  today: string;
  budgetLeftUsd: number;
}): string {
  const { dependency } = input;
  const files = [...new Set(dependency.declaredIn.map((place) => place.file))];
  const pages = SOURCE_GROUPS.map(
    (group) =>
      `${group}:\n${PLATFORM_SOURCES.filter((source) => source.group === group)
        .map((source) => `- ${source.id} ${source.url} (${source.note})`)
        .join('\n')}`,
  ).join('\n\n');
  return `Today is ${input.today}. ${windowLine(input.since)} Choose the pages this dependency needs, read them and submit the changes. The run has about $${input.budgetLeftUsd.toFixed(2)} of AI left, shared with its other dependencies. Code enforces the cap, so money is no reason to leave out a page this dependency needs: a missed deadline costs far more than reading it.

The dependency:
- name: ${dependency.name}
- kind: ${dependency.kind}
- ecosystem: ${dependency.ecosystem ?? 'not known'}
- this repository's version: ${dependency.version ?? 'not known'}
- declared in: ${files.length ? files.join(', ') : 'not recorded'}${dependency.notes ? `\n- the codebase reader's note: ${dependency.notes}` : ''}

The time window does not apply to what already hits this repository's version: a removal or end-of-life date in the past still counts. When its version is not known, report what is past or within twelve months of its deadline.

Starting pages (source ids for read_page):

${pages}`;
}
