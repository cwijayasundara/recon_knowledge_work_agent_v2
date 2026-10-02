# Sandbox for the recipe engineer: onboarding_sdk and its readers, nothing else.
# Build from the repo root: docker build -t onb-sandbox -f sandbox/Dockerfile .
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ripgrep \
 && rm -rf /var/lib/apt/lists/*

COPY packages/onboarding_sdk /tmp/onboarding_sdk
RUN pip install --no-cache-dir /tmp/onboarding_sdk "fastapi>=0.115" "uvicorn>=0.34" \
 && rm -rf /tmp/onboarding_sdk

COPY sandbox/executor /opt/executor

RUN useradd --create-home --uid 1000 runner \
 && mkdir -p /in /work /ref /skills \
 && chown runner:runner /work

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    WORK_DIR=/work
USER runner
WORKDIR /work
EXPOSE 8080

# The ACA backend talks to the executor; the Docker backend replaces the
# command with a sleep and uses `docker exec`.
CMD ["python", "-m", "uvicorn", "--app-dir", "/opt/executor", "app:app", "--host", "0.0.0.0", "--port", "8080"]
