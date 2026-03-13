# Ollama + Claude Code Compatibility Findings

**Date**: 2026-03-12
**Ollama version**: 0.17.7
**Claude Code version**: 2.1.74

## Root Cause

Agents failed instantly (84ms, zero tokens) because the configured cloud models (`minimax-m2.5:cloud`, `glm-5:cloud`) were **not registered** in the local Ollama instance. The `/api/show` endpoint returned `"model not found"` for both.

Cloud models in Ollama are not available by default — they require `ollama pull <model>:cloud` to register their manifests (which are tiny, ~300B metadata pointing to the cloud endpoint). This is true even though no actual model weights are downloaded.

## Verification

### 1. Cloud models require explicit pull

```bash
# Before pull — model not found
curl http://localhost:11434/api/show -d '{"model":"minimax-m2.5:cloud"}'
# → {"error":"model 'minimax-m2.5:cloud' not found"}

# After pull — model registered (337B manifest)
ollama pull minimax-m2.5:cloud
curl http://localhost:11434/api/show -d '{"model":"minimax-m2.5:cloud"}'
# → {"modelfile":"...","remote_model":"minimax-m2.5","remote_host":"https://ollama.com:443",...}
```

### 2. Claude Code + Ollama env var approach works

Once models are pulled, the exact env var approach liteboard uses works correctly:

```bash
ANTHROPIC_BASE_URL=http://localhost:11434 ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_API_KEY="" \
  claude -p "say hello" --model minimax-m2.5:cloud --output-format stream-json --verbose
# → Successfully responded with "Hello there!" (3932ms, 43883 input tokens)
```

### 3. `ANTHROPIC_API_KEY=""` works correctly

Setting `ANTHROPIC_API_KEY` to empty string (as liteboard does in `getProviderEnv()`) works fine. No need to delete the key or use `ollama launch`.

## Fix Applied

**`src/provider.ts`**: Added `checkOllamaModel(baseUrl, model)` — verifies a specific model is registered via `/api/show`.

**`src/cli.ts`**: After confirming the Ollama server is healthy, the pre-flight check now iterates all models configured with the `"ollama"` provider and verifies each is registered. If any model is missing, liteboard exits with:

```
Error: Ollama model 'minimax-m2.5:cloud' is not registered. Run: ollama pull minimax-m2.5:cloud
```

## Available Cloud Models (this machine)

After pulling the missing models:

| Model | Status | Remote Host |
|-------|--------|-------------|
| `deepseek-v3.1:671b-cloud` | Available (pre-existing) | ollama.com |
| `gpt-oss:20b-cloud` | Available (pre-existing) | ollama.com |
| `minimax-m2.5:cloud` | Available (pulled) | ollama.com |
| `glm-5:cloud` | Available (pulled) | ollama.com |

## Recommendations

1. **Document model setup**: Any Ollama cloud model must be pulled before use. Add this to liteboard docs or `liteboard setup`.
2. **No need for `ollama launch`**: The manual env var approach works identically. No reason to change spawning to use `ollama launch claude`.
3. **No env var conflict**: `ANTHROPIC_API_KEY=""` correctly overrides the parent process's real API key. No fix needed in `getProviderEnv()`.
