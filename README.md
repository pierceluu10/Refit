<p align="center">
  <img src="public/refit-agent-avatar.png" alt="Refit logo" width="96" height="96" />
</p>
<h1 align="center">Refit</h1>
<p align="center"><strong>Turn upstream API changes into reviewed code updates.</strong></p>

This repository holds the Refit website. The migration engine was removed on 2026-10-31 and is being rebuilt; its history stays in git.

## Run the website

Requires Node.js 22.12+ or a supported newer release.

```sh
npm ci
npm run dev
```

`npm run typecheck`, `npm run format:check`, `npm test` and `npm run build` are the checks CI runs.
