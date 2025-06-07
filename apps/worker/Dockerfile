FROM node:18-alpine AS builder

# Set working directory to represent the monorepo root within the image
WORKDIR /app

# Install pnpm globally
RUN npm install -g pnpm

# Install necessary build tools, Chromium for Puppeteer, and other utilities
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git \
    unzip \
    dumb-init \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ttf-freefont \
    udev \
    fontconfig \
    dbus

# Set environment variables for Puppeteer to use the system-installed Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Copy the root workspace files.
# Paths are relative to this Dockerfile's location (apps/worker), going up to the monorepo root.
COPY ../../package.json ../../pnpm-lock.yaml ../../pnpm-workspace.yaml ./
COPY ../../tsconfig.base.json ./

# Copy all application code from the monorepo's "apps" directory.
# `../` refers to `accessibility-scanner-backend/apps/`.
# This copies the contents of `accessibility-scanner-backend/apps/` (i.e., api/, worker/)
# into `/app/apps/` inside the image.
COPY ../ ./apps/

# Install dependencies for all workspace projects.
# pnpm will handle the workspace structure correctly.
RUN pnpm install --frozen-lockfile

# Build the specific application (Worker).
# The appName is defined in apps/worker/package.json ("name": "@accessibility-scanner-backend/worker")
RUN pnpm --filter @accessibility-scanner-backend/worker run build
# This will create /app/apps/worker/dist

# --- Release Stage ---
FROM node:18-alpine AS release

WORKDIR /app

# Install dumb-init, Chromium and its dependencies for Puppeteer runtime.
# Also install pnpm if you intend to use `pnpm exec` in the CMD.
RUN apk add --no-cache \
    dumb-init \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ttf-freefont \
    udev \
    fontconfig \
    dbus \
    && npm install -g pnpm

# Set environment variables for Puppeteer again for the release stage
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Create a subdirectory for the app's package.json to ensure pnpm workspace setup is recognized
RUN mkdir -p ./apps/worker

# Copy the built 'dist' folder directly into the root of the WORKDIR
COPY --from=builder /app/apps/worker/dist ./dist

# Copy the Worker app's package.json.
COPY --from=builder /app/apps/worker/package.json ./apps/worker/package.json

# Copy the root package.json and workspace files for pnpm to understand the context for installing filtered prod dependencies.
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/pnpm-workspace.yaml ./

# Reinstall production dependencies for only the Worker service in its final location.
# This ensures a lean production image with only necessary node_modules for the worker.
RUN pnpm install --prod --frozen-lockfile --filter @accessibility-scanner-backend/worker...

# The WORKDIR is already /app, so the start command path is simple.
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# The "start" script in apps/worker/package.json is "node dist/index.js".
# This will be used if the Railway start command is set correctly.
CMD ["node", "dist/index.js"] 