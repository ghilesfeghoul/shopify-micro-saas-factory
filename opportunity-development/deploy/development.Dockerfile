# ─── Stage 1: Build ──────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Stage 2: Runtime ────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI for subprocess spawning
RUN npm install -g @anthropic-ai/claude-code

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package*.json ./

RUN mkdir -p /data /apps /app/logs && chown -R node:node /data /apps /app

USER node

# Configure git for autocommits in generated workspaces
RUN git config --global user.name "MSF Dev Agent" \
    && git config --global user.email "dev@micro-saas-factory.local" \
    && git config --global init.defaultBranch main

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3002/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

EXPOSE 3002

CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/api/server.js"]
