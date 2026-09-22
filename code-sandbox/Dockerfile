# The coding sandbox: an ACP harness, and nothing else.
#
# Deliberately not the web image. That one carries noevia's server, its state directory and its
# credentials, and a coding agent has no business near any of them. This image holds a harness,
# a supervisor and a Node runtime.
#
# The harness is pinned. An agent that updates itself under you is a supply-chain change you did
# not review, in the one container allowed to run arbitrary commands.
FROM node:22-bookworm-slim

ARG HARNESS_PACKAGE=opencode-ai
ARG HARNESS_VERSION=1.18.31
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --no-fund --no-audit "${HARNESS_PACKAGE}@${HARNESS_VERSION}" \
 && npm cache clean --force

WORKDIR /srv
# pi-acp-bridge.cjs: noevia's own ACP bridge for pi (routes pi's approvals to noevia). Used only
# when the image installs pi (HARNESS_PACKAGE=@earendil-works/pi-coding-agent) and runs with
# CODE_HARNESS_COMMAND=node CODE_HARNESS_ARGS=/srv/pi-acp-bridge.cjs and CODE_HARNESS_NAME=pi on web.
COPY supervisor.cjs pi-acp-bridge.cjs ./

# `node` (uid 1000) already exists in this image. Nothing here runs as root.
USER node
ENV PORT=8030 \
    WORKSPACE_ROOT=/workspaces \
    CODE_HARNESS_COMMAND=opencode \
    CODE_HARNESS_ARGS=acp \
    HARNESS_VERSION=${HARNESS_VERSION}
EXPOSE 8030

# No health check on purpose: a connection to this port starts an agent, so probing it would
# start one every thirty seconds. Compose watches the process instead.
CMD ["node", "supervisor.cjs"]
