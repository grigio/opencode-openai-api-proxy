# Pinned Node 24 slim - matches .nvmrc and ensures type-stripping support (Node >= 23.6)
FROM node:24-slim

# Pinned versions for reproducible builds
ARG OPENCODE_VERSION=1.18.16

# Install minimal dependencies required for OpenCode, Git and PUID/PGID support.
# gosu is downloaded per architecture and verified by checksum (SHA256) before installation.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && dpkgArch="$(dpkg --print-architecture | awk -F- '{ print $NF }')" \
    && case "$dpkgArch" in \
         amd64) GOSU_SHA256="bbc4136d03ab138b1ad66fa4fc051bafc6cc7ffae632b069a53657279a450de3" ;; \
         arm64) GOSU_SHA256="c3805a85d17f4454c23d7059bcb97e1ec1af272b90126e79ed002342de08389b" ;; \
         *) echo "unsupported architecture: $dpkgArch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL -o /usr/local/bin/gosu "https://github.com/tianon/gosu/releases/download/1.17/gosu-$dpkgArch" \
    && echo "$GOSU_SHA256  /usr/local/bin/gosu" | sha256sum -c - \
    && chmod +x /usr/local/bin/gosu \
    && gosu --version \
    && rm -rf /var/lib/apt/lists/*

# Install OpenCode globally via NPM (pinned version)
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force

# Create directories for data and config persistence
RUN mkdir -p /home/node/.local/share/opencode \
    && mkdir -p /home/node/.config/opencode \
    && mkdir -p /home/node/project \
    && chown -R node:node /home/node

# Copy and configure the entrypoint script
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Set the working directory
WORKDIR /home/node/project

# Setup Proxy (separate layers to leverage build cache):
# 1. Manifests only -> install production dependencies from the lockfile.
# 2. Then the source code (single layer, respects .dockerignore).
COPY proxy/package.json proxy/package-lock.json /usr/src/proxy/
RUN cd /usr/src/proxy && npm ci --omit=dev && npm cache clean --force
COPY proxy/*.ts /usr/src/proxy/
COPY proxy/routes /usr/src/proxy/routes
COPY proxy/streaming /usr/src/proxy/streaming

# Expose ports (4096 OpenAI Proxy, 4097 native OpenCode API)
EXPOSE 4096 4097

# Environment variables
# The OpenCode server will run on 4097 internally
ENV OPENCODE_SERVER_HOSTNAME=0.0.0.0
ENV OPENCODE_SERVER_PORT=4097
# HOME must point at the node user's home: the container default (/root) is
# not owned by node, has no volume, and opencode resolves its auth store
# ($XDG_DATA_HOME/opencode or ~/.local/share/opencode) from HOME. Both the
# server and the proxy read auth.json from there (persisted by the
# opencode_data volume).
ENV HOME=/home/node

# Healthcheck: the /health endpoint does not require authentication.
# Uses PROXY_PORT env if overridden; falls back to 4096.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PROXY_PORT:-4096}/health > /dev/null || exit 1

# Set the entrypoint script
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Default command
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4097"]
