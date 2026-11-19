// Lint rules: ESLint recommended and typescript-eslint recommended with type information.
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
    { ignores: ['dist/', 'node_modules/'] },
    eslint.configs.recommended,
    tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
        },
        rules: {
            // Fastify tells an async hook or handler from a callback one by the promise it returns: a hook without an
            // await must still be async, or Fastify waits for a done() that never comes
            '@typescript-eslint/require-await': 'off',
            // listeners of puppeteer, node:http and process are async on purpose; each catches its own errors
            '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
            // the promise of test() from node:test belongs to the runner, which waits for it and reports its failure
            '@typescript-eslint/no-floating-promises': ['error', {
                allowForKnownSafeCalls: [{ from: 'package', name: ['test', 'describe', 'it'], package: 'node:test' }],
            }],
        },
    },
    { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
);
