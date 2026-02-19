# ---------------------------------------------------------------------------
# OpsPilot — Multi-stage Dockerfile
# ---------------------------------------------------------------------------
# Stage 1: Build (compile TypeScript → JavaScript)
# Stage 2: Production (minimal Node.js runtime)
# ---------------------------------------------------------------------------

# ── Stage 1: Build ──────────────────────────────────────────────────────────

FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
COPY config/ ./config/

RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# ── Stage 2: Production ────────────────────────────────────────────────────

FROM node:20-alpine AS production

# Security: run as non-root user
RUN addgroup -S opspilot && adduser -S opspilot -G opspilot

WORKDIR /app

# Copy production artifacts from builder
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/config/ ./config/

# Create data directory for SQLite
RUN mkdir -p /app/data && chown -R opspilot:opspilot /app

# Switch to non-root user
USER opspilot

# Expose ports
#   3000 — REST API
#   3001 — WebSocket
#   3002 — Dashboard
EXPOSE 3000 3001 3002

# Health check against the REST API /api/health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

# Set production environment
ENV NODE_ENV=production

# Start OpsPilot
CMD ["node", "dist/index.js"]
