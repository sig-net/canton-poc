import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/generated/**", "**/node_modules/**", "**/.daml/**", "**/*.mjs"],
  },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "eslint.config.ts",
            "packages/canton-sig/tsdown.config.ts",
            "packages/canton-sig/vitest.config.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-useless-empty-export": "error",
      "no-useless-return": "error",
    },
  },
  {
    files: [
      "eslint.config.ts",
      "packages/canton-sig/tsdown.config.ts",
      "packages/canton-sig/vitest.config.ts",
    ],
    ...tseslint.configs.disableTypeChecked,
  },
);
