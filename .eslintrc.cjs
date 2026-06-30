module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react-hooks/recommended",
    "prettier",
  ],
  ignorePatterns: ["dist", ".eslintrc.cjs"],
  parser: "@typescript-eslint/parser",
  plugins: ["react-refresh"],
  rules: {
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
  },
  overrides: [
    {
      files: ["src/components/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-syntax": [
          "error",
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
        ],
      },
    },
    {
      files: ["src/components/scenario/scenarioPersistence.ts"],
      rules: {
        "no-restricted-syntax": "off",
      },
    },
    {
      files: [
        "src/components/ui/**/*.tsx",
        "src/contexts/**/*.tsx",
        "src/data/providers/**/*.tsx",
        "src/components/ChargePointConfigModal.tsx",
        "src/components/MeterValueCurveModal.tsx",
      ],
      rules: { "react-refresh/only-export-components": "off" },
    },
  ],
};
