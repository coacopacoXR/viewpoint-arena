import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".partykit/**",
      ".vercel/**",
      "coverage/**",
      "*.config.{js,cjs,mjs}",
      // Git-ignored scratch space of the delegated agents: task specs, run logs,
      // throwaway browser scripts. Not part of the project; a local lint run
      // must not fail on them (CI never has them).
      ".qwen-tasks/**",
      ".qwen/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // 172 violations at the time this config landed. Kept at "warn", not
      // "off": this repo is being prepared for external audit, and silencing
      // the rule would erase the type debt instead of tracking it. It stays a
      // warning (not an error) so CI can gate on errors while the count is
      // ratcheted down — see the T1.1 follow-up in docs/plan/EXECUTION-LOG.md.
      // 80 of the 172 are in types.ts, which is exempted below.
      "@typescript-eslint/no-explicit-any": "warn",
      // types.ts uses `declare global { namespace JSX { ... } }` for R3F
      // intrinsic-element augmentation â€” the standard TypeScript pattern for
      // declaration merging, not the code-organisation misuse this rule targets.
      "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }],
      // Standard options: allows `const { excluded, ...rest } = obj` patterns
      // without flagging `excluded` as unused, and `_`-prefixed names as an
      // explicit "intentionally unused" convention.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          ignoreRestSiblings: true,
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // R3F augments JSX intrinsic elements with Three.js constructor signatures
    // that are genuinely untypeable without `any`. Exempted so the 92 real
    // `any`s elsewhere stay visible instead of being lost in the noise.
    files: ["types.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  eslintConfigPrettier,
);
