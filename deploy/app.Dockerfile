# The `app` container: build the Vite bundle, serve it with nginx.
#
# Build context is the REPO ROOT (see docker-compose.yml), so paths here are
# repo-relative. Two stages, because the runtime image must not contain Node,
# npm, the lockfile or node_modules: it serves static files, and a container
# that only serves files should not carry a JavaScript runtime to be attacked.

# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:24-alpine AS build

WORKDIR /app

# Lockfile first so a source-only change reuses the install layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# VITE_-prefixed values are INLINED INTO THE BUNDLE by Vite at build time, so
# they have to be present in this stage and they cannot be supplied at runtime.
# That is the documented VITE_ rule (scripts/check-public-env.mjs, .env.example):
# only client-safe values may travel this way. The Supabase pair is the approved
# exception — the anon key is public by design, with access control enforced by
# Postgres Row Level Security — and VITE_PARTYKIT_HOST is a hostname, not a
# credential. A secret passed as a build ARG would be readable by anyone who can
# `docker history` the image, which is why nothing else is passed here.
ARG VITE_SUPABASE_URL=""
ARG VITE_SUPABASE_ANON_KEY=""
ARG VITE_PARTYKIT_HOST=""
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_PARTYKIT_HOST=$VITE_PARTYKIT_HOST

RUN npm run build

# ── Stage 2: serve ──────────────────────────────────────────────────────────
FROM nginx:alpine AS runtime

# The config is an envsubst TEMPLATE, not a plain conf.d file. app.conf currently
# has no ${...} placeholder in it, and the template mechanism stays anyway: it is
# what NGINX_ENVSUBST_FILTER below depends on, and it means a future
# deployment-specific value is substituted at CONTAINER START from the environment
# rather than baked into a layer. A value baked in at build time is readable by
# anyone who can `docker history` the image — the same reason the VITE_ build args
# above carry only client-safe values.
#
# The placeholder this used to carry was ${CAPTURE_SHARED_SECRET}, substituted
# into an X-Capture-Token header on the two capture routes nginx proxied straight
# to capture-service. Those routes now go to the `api` container, which adds the
# header itself from its own env_file (lib/ai/router.ts), so the secret is no
# longer this container's business — and the variable is deliberately NOT declared
# here, because defining a credential in an image that nothing reads is how one
# ends up in a debug session's `docker exec app env`.
#
# NGINX_ENVSUBST_FILTER restricts substitution to CAPTURE_* names. Without it
# envsubst would also eat nginx's own $uri, $host and $proxy_add_x_forwarded_for,
# which are not environment variables and must survive into the served config.
ENV NGINX_ENVSUBST_FILTER=^CAPTURE_

# Replaces the stock welcome-page site. See deploy/nginx/app.conf for why /api/*
# is handled explicitly instead of falling through to the SPA. The entrypoint
# writes /etc/nginx/conf.d/default.conf from this template.
COPY deploy/nginx/app.conf /etc/nginx/templates/default.conf.template

# The base image ships its own /etc/nginx/conf.d/default.conf. The entrypoint
# overwrites it with the substituted template, but removing it means a container
# started with an entrypoint that skips template processing serves nothing
# rather than the stock welcome page on :80.
RUN rm -f /etc/nginx/conf.d/default.conf

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["wget", "-qO-", "http://127.0.0.1/nginx-health"]

# nginx:alpine's own entrypoint and master-process-as-root/worker-as-nginx
# split. Overriding the user would break the entrypoint's pid-file handling, and
# the worker that actually serves requests is already unprivileged.
