# capture-service — local, batch-mode meeting capture.
#
# Built with `context: capture-service` (see docker-compose.yml), so every path
# here is relative to that directory.
#
# Two things this image deliberately does:
#
#  1. INSTALLS requirements-whisper.txt, unlike CI. A container that cannot
#     transcribe is not a deployment, so the real Whisper extra is baked in and
#     the model is fetched on first use (or pre-seeded into the mounted
#     huggingface cache for an air-gapped install). The test suite still runs
#     with no ML dependency at all — see capture-service/README.md §5.
#  2. RUNS AS NON-ROOT. The service writes uploaded recordings to a temp file
#     before decoding them. A container that accepts arbitrary audio from a
#     network should not be doing it as uid 0.

FROM python:3.12-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # The service binds 0.0.0.0 INSIDE the container so the compose network can
    # reach it. That is not the same as being published: docker-compose.yml gives
    # this service no `ports:` entry at all, and puts it on a network with
    # `internal: true`. See the "why capture-service publishes no port" comment
    # there before changing either.
    CAPTURE_HOST=0.0.0.0 \
    CAPTURE_PORT=8080

WORKDIR /srv/capture-service

# libgomp1 is ctranslate2's OpenMP runtime dependency; python:3.12-slim does not
# carry it, and the failure without it is an opaque ImportError on the first
# /capture request rather than at start-up.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Requirements first, source second: a code change then reuses the dependency
# layer instead of re-downloading ctranslate2, onnxruntime and av every build.
COPY requirements.txt requirements-whisper.txt ./
RUN pip install --no-cache-dir -r requirements.txt -r requirements-whisper.txt

COPY capture_service ./capture_service
COPY healthcheck.py ./

# The Whisper model cache is created here, owned by `capture`, because
# docker-compose.yml mounts the whisper-models volume on it. A named volume
# copies the ownership of the directory it is mounted over; if that directory
# does not exist in the image, Docker creates it as root, and the first
# /capture then fails with transcriber_unavailable (PermissionError on
# ~/.cache/huggingface/hub). Found on the first live Docker run.
RUN useradd --create-home --uid 10001 capture \
    && mkdir -p /home/capture/.cache/huggingface \
    && chown -R capture:capture /srv/capture-service /home/capture/.cache
USER capture

EXPOSE 8080

# healthcheck.py sends the shared secret when one is configured, so this keeps
# working with authentication on. It exits 0 only on a 200 whose body says
# `status: ok` — a container that answers 401 to everything is not healthy, and
# marking it healthy would let compose route traffic to it.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD ["python", "healthcheck.py"]

CMD ["python", "-m", "capture_service"]
