# ── Single stage: run TypeScript directly with tsx ───────────────────────────
# Avoids tsc compilation errors during Docker build.
# tsx is a zero-config TypeScript runner (like ts-node but faster).
FROM node:20-alpine

# Install Chromium for Playwright execution worker
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    openssl \
    && rm -rf /var/cache/apk/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

# Copy manifests first for better layer caching
COPY package.json package-lock.json ./
COPY prisma ./prisma/

# Install ALL dependencies (tsx is in devDependencies)
RUN npm ci

# Generate Prisma client
RUN npx prisma generate

# Copy source
COPY tsconfig.json ./
COPY src ./src/
# Create required runtime directories
RUN mkdir -p static/test-runs screenshots

EXPOSE 4000

# Run server with tsx (no compile step needed)
CMD ["npx", "tsx", "src/index.ts"]
