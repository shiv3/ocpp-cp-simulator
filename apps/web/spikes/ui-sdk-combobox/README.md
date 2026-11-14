# UI SDK combobox spike (#936)

Isolated prototype: the console's free-text filter `Combobox` rebuilt on
`@ui-sdk/react` `Autocomplete`. **Nothing in `apps/web/src` imports it**, it is
not a Bun workspace member (`workspaces` are `packages/*` and `apps/*`, one
level only), the root `vitest` excludes `apps/web/spikes/**`, and `tsc` /
`vite build` never see it. The root `bun.lock` and `package.json` are untouched.

Report and decision: [`docs/analyses/ui-sdk-evaluation.md`](../../../../docs/analyses/ui-sdk-evaluation.md).

## Run

From the repository root (after the usual `bun install`):

```sh
# --legacy-peer-deps: @ui-sdk/react peers on react >= 19; without the flag npm
# installs a second React here and every hook throws "Invalid hook call".
npm install --prefix apps/web/spikes/ui-sdk-combobox --legacy-peer-deps --no-package-lock
npx vitest run --config apps/web/spikes/ui-sdk-combobox/vitest.config.ts
node apps/web/spikes/ui-sdk-combobox/measure-size.mjs   # minified / gzip, react externalised
```

`comparison.spike.test.tsx` runs one behavior suite against the production
component and the prototype. A behavior the production component lacks is
written `GAP: …` and asserted to **fail** (`it.fails`), so fixing it in
production turns that test red and tells you to move it out of the gap list.
