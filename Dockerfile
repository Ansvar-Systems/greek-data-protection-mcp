# ─────────────────────────────────────────────────────────────────────────────
# Greek Data Protection MCP — multi-stage Dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# Build:  docker build -t greek-data-protection-mcp .
# Run:    docker run --rm -p 3000:3000 greek-data-protection-mcp
#
# The image expects a pre-built database at /app/data/hdpa.db.
# Override with HDPA_DB_PATH for a custom location.
#
# NOTE: production node_modules are COPIED from the builder stage to preserve
# the better-sqlite3 native binding. Re-running `npm ci --omit=dev
# --ignore-scripts` in the production stage strips the postinstall step that
# fetches/builds the .node binding and breaks every SQLite tool call.
# ─────────────────────────────────────────────────────────────────────────────

# --- Stage 1: Build TypeScript + native deps ---
FROM node:20-slim AS builder

WORKDIR /app

# Build deps for better-sqlite3 native binding
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# Run install WITH scripts so better-sqlite3 postinstall builds the native binding
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Prune dev deps but keep the built better-sqlite3 binding
RUN npm prune --omit=dev

# --- Stage 2: Production ---
FROM node:20-slim AS production

WORKDIR /app
ENV NODE_ENV=production
ENV HDPA_DB_PATH=/app/data/hdpa.db

# Bring node_modules from builder so the better-sqlite3 native .node binding is preserved
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/dist/ dist/
COPY package.json package-lock.json* ./

# Database (provisioned by ghcr-build.yml from GitHub Release: data/database.db.gz -> data/database.db)
COPY data/database.db data/hdpa.db

# Non-root user for security
RUN addgroup --system --gid 1001 mcp && \
    adduser --system --uid 1001 --ingroup mcp mcp && \
    chown -R mcp:mcp /app
USER mcp

# Health check: verify HTTP server responds
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/src/http-server.js"]
