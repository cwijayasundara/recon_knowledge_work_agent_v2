# Azure dev deployment

`main.bicep` compiles (`az bicep build --file infra/main.bicep`) but has not
been deployed. Before the first deployment:

1. **Spike the ACA sessions request format.** `src/onboarding_agent/sandbox/aca_backend.py`
   calls `{poolManagementEndpoint}/{exec|files|seal}?identifier=<run_id>` with a
   token for `https://dynamicsessions.io`. Confirm this against a real custom
   container pool (plan, Phase 9) and adjust the paths if needed.
2. Build and push the three images: `scripts/vendor_matcher.sh`, then
   `docker build -f Dockerfile.api .`, `docker build -f sandbox/Dockerfile .`,
   `docker build web --build-arg NEXT_PUBLIC_API_URL=/api --build-arg API_INTERNAL_URL=http://<prefix>-api`.
3. Register an Entra ID app for Container Apps built-in auth and pass its client id.
4. Check model names and versions available in the region (`models` parameter).

Deploy: `ONB_PG_PASSWORD=... az deployment group create -g <rg> -f infra/main.bicep -p infra/dev.bicepparam`.

Known gaps:

- The matcher's LLM adapter takes an API key string, so matcher LLM/embedding
  routes stay off on Azure (`ONB_MATCHER_ENABLE_LLM=false`) until either a Key
  Vault key is added or the adapter accepts a token provider.
- Locked runs are not yet copied to the immutable `locked-runs` container; the
  working object store is the `objects` Azure Files share.
