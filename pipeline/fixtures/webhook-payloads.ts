// GitHub App webhook payloads shaped like GitHub's published schemas (octokit/webhooks,
// payload-schemas/api.github.com at aa80c24), and malformed variants of each for fuzzing.
export const WEBHOOK_APP_ID = 123;
export const WEBHOOK_INSTALLATION = 456;
export const WEBHOOK_REPOSITORY_ID = 789;

type Path = (string | number)[];
type Payload = Record<string, unknown>;

export function repositoryRecord(fullName: string, id: number) {
  return {
    id,
    node_id: `R_${id}`,
    name: fullName.split('/')[1],
    full_name: fullName,
    private: true,
  };
}

function installationRecord(options: { login?: string; id?: number; updatedAt?: string | number }) {
  return {
    id: options.id ?? WEBHOOK_INSTALLATION,
    app_id: WEBHOOK_APP_ID,
    account: { login: options.login ?? 'example', id: 1001, type: 'Organization' },
    repository_selection: 'selected',
    updated_at: options.updatedAt ?? '2026-10-22T08:00:00Z',
    suspended_at: null,
  };
}

export function installation(
  action: string,
  repositories: [string, number][],
  options: { login?: string; id?: number; updatedAt?: string | number } = {},
) {
  return {
    action,
    installation: {
      ...installationRecord(options),
      suspended_at: action === 'suspend' ? '2026-10-22T08:00:00Z' : null,
    },
    repositories: repositories.map(([name, id]) => repositoryRecord(name, id)),
    sender: { login: 'octocat', id: 1 },
  };
}

export function installationRepositories(
  action: 'added' | 'removed',
  repositories: [string, number][],
  options: { login?: string; id?: number } = {},
) {
  const listed = repositories.map(([name, id]) => repositoryRecord(name, id));
  return {
    action,
    installation: installationRecord(options),
    repository_selection: 'selected',
    repositories_added: action === 'added' ? listed : [],
    repositories_removed: action === 'removed' ? listed : [],
    requester: null,
    sender: { login: 'octocat', id: 1 },
  };
}

export function repositoryEvent(
  action: string,
  fullName: string,
  changes: unknown,
  options: { id?: number; installation?: number } = {},
) {
  return {
    action,
    ...(changes === undefined ? {} : { changes }),
    repository: repositoryRecord(fullName, options.id ?? WEBHOOK_REPOSITORY_ID),
    installation: { id: options.installation ?? WEBHOOK_INSTALLATION, node_id: 'MDIz' },
    sender: { login: 'octocat', id: 1 },
  };
}

export function accountRename(from: string, to: string) {
  return {
    action: 'renamed',
    target_type: 'Organization',
    account: { login: to, id: 1001, node_id: 'O_1001', avatar_url: '', html_url: '' },
    changes: { login: { from } },
    installation: { id: WEBHOOK_INSTALLATION, node_id: 'MDIz' },
    sender: { login: 'octocat', id: 1 },
  };
}

// undefined removes the field. Each list holds only values the parser must refuse at that path.
const OBJECTS = [undefined, null, 'object', 7, true, []];
const IDENTIFIERS = [undefined, null, '', '7', -1, 0, 1.5, 2 ** 53, true, [], {}];
const LOGINS = [
  undefined,
  null,
  '',
  7,
  true,
  [],
  {},
  'has space',
  '-leading',
  'a/b',
  'é',
  'x'.repeat(40),
];
const NAMES = [undefined, null, '', 7, true, [], {}, 'has space', 'a/b', 'é', 'x'.repeat(101)];
const FULL_NAMES = [
  undefined,
  null,
  '',
  7,
  'example',
  'example/',
  '/application',
  'example/a b',
  'example/a/b',
  `example/${'x'.repeat(101)}`,
  `${'x'.repeat(40)}/application`,
];
const TIMESTAMPS = ['', 'yesterday', -1, 0, 1.5, true, [], {}];
const ACTIONS = [undefined, null, 7, true, [], {}];
// One more than the parser accepts in a single delivery.
const TOO_MANY = 10_001;

function mutate(payload: Payload, path: Path, value: unknown): Payload {
  const copy = structuredClone(payload);
  let parent = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
  const last = path[path.length - 1];
  if (value === undefined) delete parent[last];
  else parent[last] = value;
  return copy;
}

const installationPaths: [Path, unknown[]][] = [
  [['action'], ACTIONS],
  [['installation'], OBJECTS],
  [['installation', 'id'], IDENTIFIERS],
  [
    ['installation', 'app_id'],
    [undefined, null, WEBHOOK_APP_ID + 1, String(WEBHOOK_APP_ID)],
  ],
  [['installation', 'account'], OBJECTS],
  [['installation', 'account', 'login'], LOGINS],
  [['installation', 'updated_at'], TIMESTAMPS],
];

function listPaths(field: string, required: boolean): [Path, unknown[]][] {
  return [
    [[field], required ? [undefined, null, 'list', 7, {}] : [null, 'list', 7, {}]],
    [[field, 0], OBJECTS.filter((value) => value !== undefined)],
    [[field, 0, 'id'], IDENTIFIERS],
    [
      [field, 0, 'full_name'],
      [...FULL_NAMES, 'other/application', 'example/Other-Name/x'],
    ],
  ];
}

const repositoryPaths: [Path, unknown[]][] = [
  [['action'], ACTIONS],
  [['repository'], OBJECTS],
  [['repository', 'id'], IDENTIFIERS],
  [['repository', 'full_name'], FULL_NAMES],
  [['installation'], OBJECTS],
  [['installation', 'id'], IDENTIFIERS],
];

const application: [string, number][] = [['example/application', WEBHOOK_REPOSITORY_ID]];

// One valid payload for every lifecycle event and action the hosted worker acts on, with the
// fields the parser validates and the values each must refuse.
export function lifecycleWebhooks(): {
  name: string;
  event: string;
  payload: Payload;
  paths: [Path, unknown[]][];
}[] {
  return [
    ...['created', 'deleted', 'suspend', 'unsuspend', 'new_permissions_accepted'].map((action) => ({
      name: `installation.${action}`,
      event: 'installation',
      payload: installation(action, application),
      paths: [...installationPaths, ...listPaths('repositories', false)],
    })),
    ...(['added', 'removed'] as const).map((action) => ({
      name: `installation_repositories.${action}`,
      event: 'installation_repositories',
      payload: installationRepositories(action, application),
      paths: [
        ...installationPaths,
        ...listPaths(`repositories_${action}`, true),
        [
          [`repositories_${action === 'added' ? 'removed' : 'added'}`],
          [undefined, null, 'list', 7, {}],
        ],
      ] as [Path, unknown[]][],
    })),
    {
      name: 'repository.renamed',
      event: 'repository',
      payload: repositoryEvent('renamed', 'example/billing', {
        repository: { name: { from: 'application' } },
      }),
      paths: [
        ...repositoryPaths,
        [['changes'], OBJECTS],
        [['changes', 'repository', 'name', 'from'], NAMES],
      ],
    },
    {
      name: 'repository.transferred',
      event: 'repository',
      payload: repositoryEvent('transferred', 'example/application', {
        owner: { from: { user: { login: 'someone', id: 2 } } },
      }),
      paths: [
        ...repositoryPaths,
        [['changes'], OBJECTS],
        [['changes', 'owner', 'from'], OBJECTS],
        [['changes', 'owner', 'from', 'user', 'login'], LOGINS],
      ],
    },
    ...['archived', 'unarchived'].map((action) => ({
      name: `repository.${action}`,
      event: 'repository',
      payload: repositoryEvent(action, 'example/application', undefined),
      paths: repositoryPaths,
    })),
    {
      name: 'installation_target.renamed',
      event: 'installation_target',
      payload: accountRename('example', 'example-labs'),
      paths: [
        [['action'], ACTIONS],
        [['account'], OBJECTS],
        [['account', 'login'], LOGINS],
        // A missing login change is a slug-only rename, which is ignored rather than refused.
        [['changes', 'login', 'from'], LOGINS.filter((value) => value !== undefined)],
        [['installation'], OBJECTS],
        [['installation', 'id'], IDENTIFIERS],
      ],
    },
  ];
}

// Every validated field of every lifecycle payload set to each value it must refuse, plus
// list-level faults. Each case must be refused with a 4xx.
export function malformedWebhooks() {
  const cases: { name: string; event: string; payload: unknown }[] = [];
  for (const base of lifecycleWebhooks()) {
    for (const [path, values] of base.paths)
      for (const value of values)
        cases.push({
          name: `${base.name} ${path.join('.')}=${JSON.stringify(value) ?? 'missing'}`.slice(
            0,
            160,
          ),
          event: base.event,
          payload: mutate(base.payload, path, value),
        });
  }
  const many = Array.from({ length: TOO_MANY }, (_, index) =>
    repositoryRecord(`example/repository-${index}`, index + 1),
  );
  const duplicate = repositoryRecord('example/Application', WEBHOOK_REPOSITORY_ID + 1);
  cases.push(
    {
      name: 'installation.created with too many repositories',
      event: 'installation',
      payload: { ...installation('created', []), repositories: many },
    },
    {
      name: 'installation_repositories.added with too many repositories',
      event: 'installation_repositories',
      payload: { ...installationRepositories('added', []), repositories_added: many },
    },
    {
      name: 'installation.created listing one repository twice',
      event: 'installation',
      payload: {
        ...installation('created', application),
        repositories: [repositoryRecord('example/application', WEBHOOK_REPOSITORY_ID), duplicate],
      },
    },
    {
      name: 'installation_repositories adding and removing one repository',
      event: 'installation_repositories',
      payload: {
        ...installationRepositories('added', application),
        repositories_removed: [duplicate],
      },
    },
  );
  return cases;
}
