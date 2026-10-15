# convert-service — tessellate STEP/IGES/BREP once, on the server.
#
# Built with `context: ./convert-service` (see docker-compose.yml), so every path
# here is relative to that directory.
#
# Three things this image deliberately does:
#
#  1. INSTALLS the OpenCascade engine and gltfpack, unlike CI on a contributor's
#     laptop. A container that cannot tessellate is not a deployment. Both are
#     proven AT BUILD TIME rather than on the first request: `import OCP` fails
#     the build if the headless GL libraries are missing, and `gltfpack` fails it
#     if the pinned release binary will not run on this base image.
#  2. CARRIES THE TESTS AND pytest. `docker compose run --rm convert-service
#     pytest` is the acceptance check for this service (README §5), and the
#     fixtures it converts are committed inputs, not generated ones — so both are
#     in the image. pytest is ~2 MB and imports nothing at service start-up.
#  3. RUNS AS NON-ROOT, and the conversion runs as a SUBPROCESS of that user.
#     The service accepts arbitrary CAD files from a network and hands them to a
#     native kernel; a segfault or an OOM kill in OpenCascade must take one job
#     down, not the container. See convert_service/jobs.py.

# ── gltfpack ────────────────────────────────────────────────────────────────
#
# The official meshoptimizer release binary: one static executable, no runtime,
# no package manager. The `gltfpack` npm package was rejected because its cli.js
# downloads a binary on first use, which would break an air-gapped install at
# conversion time rather than at build time.
#
# The checksum is pinned so a replaced asset on GitHub cannot enter the image
# silently. To upgrade: change GLTFPACK_VERSION, download the new zip, and paste
# its `sha256sum` here.
FROM python:3.12-slim AS tools

ARG GLTFPACK_VERSION=v1.3
ARG GLTFPACK_SHA256=0666d9dc40d60fe5b9a45f3fc24f8e6ca87112974bd5de9ca57152aa13d06017

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/gltfpack.zip \
      "https://github.com/zeux/meshoptimizer/releases/download/${GLTFPACK_VERSION}/gltfpack-ubuntu.zip" \
    && echo "${GLTFPACK_SHA256}  /tmp/gltfpack.zip" | sha256sum -c - \
    && unzip -j /tmp/gltfpack.zip gltfpack -d /opt \
    && chmod 0755 /opt/gltfpack

# ── The service ─────────────────────────────────────────────────────────────
FROM python:3.12-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # The service binds 0.0.0.0 INSIDE the container so the compose network can
    # reach it. That is not the same as being published: docker-compose.yml gives
    # this service no `ports:` entry at all, and puts it on a network with
    # `internal: true`. See the "why convert-service publishes no port" comment
    # there before changing either.
    CONVERT_HOST=0.0.0.0 \
    CONVERT_PORT=8080

WORKDIR /srv/convert-service

# OCP links the whole of OpenCascade, including the visualisation toolkit, so
# `import OCP` needs libGL and the X client libraries even though this service
# never opens a window and never renders. python:3.12-slim carries none of them,
# and the failure without them is an opaque ImportError on the first /convert.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 \
        libglu1-mesa \
        libxext6 \
        libxi6 \
        libxmu6 \
        libxrender1 \
        libfreetype6 \
    && rm -rf /var/lib/apt/lists/*

# Requirements first, source second: a code change then reuses the dependency
# layer instead of re-downloading the 67 MB OCP wheel every build.
COPY requirements.txt requirements-ocp.txt requirements-dev.txt ./
RUN pip install --no-cache-dir -r requirements-ocp.txt -r requirements-dev.txt

COPY --from=tools /opt/gltfpack /usr/local/bin/gltfpack

COPY convert_service ./convert_service
COPY healthcheck.py ./
COPY pytest.ini ./
# tests and scripts are in the image on purpose: `docker compose run --rm
# convert-service pytest` is the acceptance check for this service (README §5),
# and the fixtures it converts are committed inputs the benchmark also uses.
COPY tests ./tests
COPY scripts ./scripts

# Fail the build, not the first request, when the engine cannot load. gltfpack
# with no arguments prints its usage and exits non-zero, so the version line is
# what is checked; `|| true` keeps that exit code from failing the layer.
RUN python -c "import OCP; from OCP.BRepMesh import BRepMesh_IncrementalMesh; print('OCP import ok')" \
    && python -c "import pygltflib; print('pygltflib', pygltflib.__version__)" \
    && (gltfpack -h 2>&1 | head -1 || true) \
    && which gltfpack

# Non-root, and the source is owned by that user. Each job's files go in a
# mkdtemp() directory under /tmp, which the parent removes once the response
# has been sent — so there is nothing here for a job to own.
RUN useradd --create-home --uid 10001 convert \
    && chown -R convert:convert /srv/convert-service
USER convert

EXPOSE 8080

# healthcheck.py sends the shared secret when one is configured, so this keeps
# working with authentication on. It exits 0 only on a 200 whose body says
# `status: ok` — a container that answers 401 to everything is not healthy, and
# marking it healthy would let compose route traffic to it.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD ["python", "healthcheck.py"]

CMD ["python", "-m", "convert_service"]
