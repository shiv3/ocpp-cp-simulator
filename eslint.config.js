// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";
import globals from "globals";
import { readFileSync } from "node:fs";

// Line ratchet (#877): new files stay under MAX_LINES; the files listed in
// scripts/file-size-allowlist.json may not grow past their recorded size.
// scripts/check-file-size.ts fails on growth, a missing file or an unlisted over-limit file.
const MAX_LINES = 800;
const fileSizeAllowlist = JSON.parse(
  readFileSync(
    new URL("./scripts/file-size-allowlist.json", import.meta.url),
    "utf8",
  ),
);
const maxLines = (max) => [
  "error",
  { max, skipBlankLines: false, skipComments: false },
];
const sizeIgnores = [
  "packages/ocpp/src/**",
  "**/__tests__/**",
  "**/*.test.{ts,tsx}",
];

// Flat config (ESLint 9). Port of the old .eslintrc.cjs: same recommended sets,
// same custom rules, same per-path overrides.

// #101 class: scenario persistence must go through the scenarioPersistence
// helpers, never straight at the repository / service. Enforced in components.
const restrictedScenarioPersistence = [
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.object.name='scenarioRepository'][callee.property.name='save']",
    message:
      "route scenario persistence through scenarioPersistence helpers (#101 class).",
  },
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.object.name='scenarioRepository'][callee.property.name='load']",
    message:
      "route scenario persistence through scenarioPersistence helpers (#101 class).",
  },
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.object.name='scenarioRepository'][callee.property.name='delete']",
    message:
      "route scenario persistence through scenarioPersistence helpers (#101 class).",
  },
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.object.name='chargePointService'][callee.property.name='loadScenario']",
    message:
      "route scenario persistence through scenarioPersistence helpers (#101 class).",
  },
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.object.name='chargePointService'][callee.property.name='removeScenario']",
    message:
      "route scenario persistence through scenarioPersistence helpers (#101 class).",
  },
];

export default tseslint.config(
  // Only TypeScript sources are linted (matches the old `--ext ts,tsx`); build
  // output and JS config files (vite/tailwind/postcss/this file) are skipped.
  {
    ignores: [
      "dist",
      "dist-cli",
      "**/*.{js,cjs,mjs}",
      "apps/cli/src/exportK6/engine.generated.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // #570: an import used only as a type must say so, or check:boundaries
      // counts it as a runtime edge. `import("x").T` is type-only by nature.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "separate-type-imports",
          disallowTypeAnnotations: false,
        },
      ],
      // Empty interfaces are intentional here (generated OCPP empty-payload
      // response types, placeholder prop types); keep the rule for misuse of
      // the `{}` type but allow the interface form. Matches pre-ESLint-9 intent.
      "@typescript-eslint/no-empty-object-type": [
        "error",
        { allowInterfaces: "always" },
      ],
    },
  },

  {
    files: ["apps/web/src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...restrictedScenarioPersistence],
    },
  },
  {
    files: ["apps/web/src/components/scenario/scenarioPersistence.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    files: [
      "apps/web/src/components/ui/**/*.tsx",
      "apps/web/src/contexts/**/*.tsx",
      "apps/web/src/data/providers/**/*.tsx",
      "apps/web/src/components/ChargePointConfigModal.tsx",
      "apps/web/src/components/MeterValueCurveModal.tsx",
    ],
    rules: { "react-refresh/only-export-components": "off" },
  },
  {
    files: ["packages/**/*.{ts,tsx}", "apps/**/*.{ts,tsx}"],
    ignores: sizeIgnores,
    rules: { "max-lines": maxLines(MAX_LINES) },
  },
  ...Object.entries(fileSizeAllowlist).map(([file, max]) => ({
    files: [file],
    rules: { "max-lines": maxLines(max) },
  })),
);
