import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import unusedImports from 'eslint-plugin-unused-imports';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.test.json'],
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      'unused-imports': unusedImports,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      // Tests type-check too. Loosen a type only to test what an untyped caller can do, and say why.
      '@typescript-eslint/ban-ts-comment': ['error', {
        'ts-nocheck': true,
        'ts-ignore': true,
        'ts-expect-error': 'allow-with-description',
        minimumDescriptionLength: 10,
      }],
      '@typescript-eslint/no-explicit-any': 'error',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'scripts/**/*.mjs',
      '**/*.test-d.ts',
      'eslint.config.mjs',
      'jest.config.cjs',
    ],
  }
);
