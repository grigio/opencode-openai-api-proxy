import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module'
            }
        },
        plugins: {
            '@typescript-eslint': tsPlugin
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': [
                'warn',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
            ],
            'prefer-const': 'warn',
            'no-var': 'error'
        }
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            sourceType: 'module',
            ecmaVersion: 'latest'
        },
        rules: {
            'no-unused-vars': 'off'
        }
    },
    {
        files: ['tests/**/*.js'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module'
            },
            globals: {
                jest: 'readonly',
                describe: 'readonly',
                test: 'readonly',
                expect: 'readonly',
                beforeEach: 'readonly',
                afterAll: 'readonly',
                beforeAll: 'readonly',
                afterEach: 'readonly'
            }
        },
        plugins: {
            '@typescript-eslint': tsPlugin
        },
        rules: {
            'no-undef': 'off',
            '@typescript-eslint/no-unused-vars': 'off'
        }
    },
    {
        ignores: ['node_modules/', 'dist/']
    }
];
