// ESLint flat config for behavior code (docs/concepts/charger-engine.md,
// "Behavior API"). A behavior must be a pure function of its `ctx`, because
// the same code runs on the real clock, on a VirtualClock in tests and on k6.
// Every wait goes through `ctx.sleep`, every draw through `ctx.random`, every
// instant through `ctx.now`, and user data through `ctx.state`.
//
// Use it from your own eslint.config.js:
//
//   import behaviorConfig from "@ocpp-cp-simulator/contracts/eslint-behavior";
//   export default [{ files: ["behaviors/**/*.ts"], ... }, ...behaviorConfig];
//
// It needs a TypeScript parser to be configured for the files (for example
// through typescript-eslint); the rules below are syntax rules only.

const NONDETERMINISTIC_GLOBALS = [
  "Date",
  "performance",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "queueMicrotask",
  "requestAnimationFrame",
].map((name) => ({
  name,
  message: `Not available to a behavior: use ctx.now() / ctx.sleep() / ctx.until() (and ctx.random() for draws).`,
}));

const MUTABLE_CONTAINERS = "Map|Set|WeakMap|WeakSet|Array|Object";

export const behaviorRules = {
  "no-restricted-globals": ["error", ...NONDETERMINISTIC_GLOBALS],
  "no-restricted-properties": [
    "error",
    {
      object: "Math",
      property: "random",
      message: "Use ctx.random(stream): it is seeded.",
    },
    {
      object: "Date",
      property: "now",
      message: "Use ctx.now().",
    },
    {
      object: "crypto",
      property: "randomUUID",
      message: "Use ctx.random(stream).uuid().",
    },
    {
      object: "globalThis",
      property: "Date",
      message: "Use ctx.now().",
    },
    {
      object: "globalThis",
      property: "setTimeout",
      message: "Use ctx.sleep().",
    },
  ],
  "no-restricted-syntax": [
    "error",
    {
      selector: "Program > VariableDeclaration[kind=/^(let|var)$/]",
      message:
        "Module-scope mutable state is shared by every station and survives a test: keep user data in ctx.state.",
    },
    {
      selector:
        "Program > ExportNamedDeclaration > VariableDeclaration[kind=/^(let|var)$/]",
      message: "Module-scope mutable state: keep user data in ctx.state.",
    },
    {
      selector: `Program > VariableDeclaration > VariableDeclarator[init.type='NewExpression'][init.callee.name=/^(${MUTABLE_CONTAINERS})$/]`,
      message:
        "A module-scope container is mutable state in disguise: keep user data in ctx.state.",
    },
    {
      selector:
        "Program > VariableDeclaration > VariableDeclarator[init.type='ArrayExpression'][init.elements.length=0]",
      message: "An empty module-scope array is an accumulator: use ctx.state.",
    },
    {
      selector:
        "Program > VariableDeclaration > VariableDeclarator[init.type='ObjectExpression'][init.properties.length=0]",
      message: "An empty module-scope object is an accumulator: use ctx.state.",
    },
    {
      selector: "ForOfStatement[await=true]",
      message: "`for await` hangs silently on k6.",
    },
    {
      selector: "FunctionDeclaration[async=true][generator=true]",
      message: "Async generators hang silently on k6.",
    },
    {
      selector: "FunctionExpression[async=true][generator=true]",
      message: "Async generators hang silently on k6.",
    },
    {
      selector: "VariableDeclaration[kind=/^(await )?using$/]",
      message: "`using` is not supported on k6.",
    },
  ],
};

/** Flat config array: spread it after your own parser setup. */
const behaviorConfig = [
  {
    name: "ocpp-cp-sim/behavior",
    rules: behaviorRules,
  },
];

export default behaviorConfig;
