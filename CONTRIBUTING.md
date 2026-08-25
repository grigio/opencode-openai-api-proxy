# Contributing

Thank you for contributing to `opencode-openai-api-proxy`.

This project provides an OpenCode server wrapped with an OpenAI-compatible proxy, so changes often affect request routing, auth, model mapping, streaming behavior, or Docker startup flow. Keep changes focused and verify the behavior end to end when needed.

## Workflow

1. Create a branch from `main`.
2. Keep the change as small and scoped as possible.
3. Update the implementation and the relevant tests together.
4. Run the project checks locally.
5. Open a Pull Request with the template below.

## Behavior

New features or behavior changes are welcome but should never change default behavior. They should be opt-in behind a environment flag, or extend existing functionality. This allows users to adopt the new behavior at their own pace and provides a safer path for rolling out changes.

## Testing

Tests are required for behavior changes.

Add or update tests whenever a change modifies routing, request/response mapping, auth, streaming, Docker startup, or any other observable behavior. Put the tests close to the behavior being changed, in the most relevant unit or integration test file.

Prefer the smallest test that proves the behavior:

- Unit tests for parsing, routing, mapping, and isolated logic.
- Integration tests for changes that depend on the live OpenCode server or the built Docker image.

Before opening a PR, run the relevant checks:

```bash
./tests/test-unit.sh
./tests/test-integration.sh
docker build -t local/opencode-openai-api-proxy .
```

# Pull Request template

When opening a Pull Request, use the following template to describe the change:   

## Motivation

What problem does this change solve? Why is it needed?

## Before

Describe the previous behavior.

Include examples, logs, request/response snippets, or screenshots when useful.

## After

Describe the new behavior.

Explain the implementation at a level useful to reviewers.

| Scenario | Before | After |
|---|---|---|
| Example | ❌ | ✅ |

## Test plan

- Tests added or updated:
- Commands run:
  - `./tests/test-unit.sh`
  - `./tests/test-integration.sh`
  - `docker build -t local/opencode-openai-api-proxy .`
- Manual validation, if applicable:´

## local test-integration results

<details>
<summary>test-integration</summary>
--- Iniciando Teste de Integração (Docker) ---
1. Buildando imagem: opencode-integration-test-1780549127...
[+] Building 1.3s (14/14) FINISHED                                                                                docker:default
 => [internal] load build definition from Dockerfile                                                                        0.0s
 => => transferring dockerfile: 1.55kB                                                                                      0.0s
 => [internal] l...(COMPLETE WITH THE ENTIRE EXECUTION OUTPUT)
</details>