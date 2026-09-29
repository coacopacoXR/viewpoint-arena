# The `partykit` container: PartyKit's server in node mode.
#
# docs/local-capture-plan.md §"docker-compose.yml services" asks for "PartyKit
# dev server in node mode (or, alternative: deploy PartyKit to their own
# Cloudflare account — keep both options documented)". This is the first option.
#
# THE SECOND OPTION needs no image at all: deploy party/room.server.ts to the
# org's own Cloudflare account with `npx partykit deploy`, set
# VITE_PARTYKIT_HOST to that deployment's hostname, and scale this service to
# zero (`docker compose up -d --scale partykit=0`). Nothing else in the stack
# refers to it — the browser connects to PartyKit directly, which is why the
# hostname is a build-time VITE_ value and not a compose service discovery name.
#
# Node mode is PartyKit's local runtime. It is single-node and persists room
# state to disk rather than to Durable Objects, so it is the right answer for a
# self-hosted single-box install and the wrong one for a multi-region
# deployment. That trade is the reason the Cloudflare option stays documented.

# Debian slim, NOT alpine. `partykit dev` runs rooms inside Cloudflare's workerd,
# which ships glibc-only binaries. On alpine (musl) workerd never starts, nothing
# listens on 1999, and every WebSocket gets a 502 from nginx-proxy -- while the
# CLI still prints "Build succeeded, starting server...". Verified 2026-09-22.
FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# PARTYKIT_PORT is what `partykit dev` listens on; the compose network reaches it
# as partykit:1999. Bound to 0.0.0.0 because a container's loopback is not the
# host's, and nginx-proxy has to be able to reach it.
ENV PARTYKIT_PORT=1999 \
    HOST=0.0.0.0

EXPOSE 1999

# `partykit dev` has NO --host and NO --no-open option (checked against
# `partykit dev --help` for the pinned 0.0.115). Passing either makes the CLI
# exit with "unknown option" before listening, so the container could never
# start. It already binds 0.0.0.0 by default (verified: LISTENING 0.0.0.0:1999).
# --no-hotkeys: there is no TTY in a container for its keyboard shortcuts.
#
# Through an entrypoint rather than a bare CMD because room code runs inside
# workerd, which does not inherit this container's environment: anything the
# room server needs has to be passed as `--var`. See the script's own comment.
RUN chmod +x /app/deploy/partykit-entrypoint.sh
CMD ["/app/deploy/partykit-entrypoint.sh"]
