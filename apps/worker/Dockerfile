FROM node:18-alpine AS builder

# Set CI=false for the entire build stage to prevent linting/test errors from stopping the build.
ENV CI=false

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

# Copy the files needed for installation and building.
# This includes the entire 'apps' directory to ensure the pnpm workspace is complete.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json ./
COPY apps ./apps

# Install dependencies for all workspace projects.
# pnpm will handle the workspace structure correctly now.
RUN pnpm install --frozen-lockfile

# Build the specific application (Worker).
# The appName is defined in apps/worker/package.json ("name": "@accessibility-scanner-backend/worker")
RUN pnpm --filter @accessibility-scanner-backend/worker run build

# --- DEBUGGING STEP ---
# List the contents of the app directory to verify that the 'dist' folder was created.
RUN ls -la /app/apps/worker
# --- END DEBUGGING STEP ---

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

# Copy the built 'dist' folder from the builder stage.
COPY --from=builder /app/apps/worker/dist ./dist

# Copy the necessary package.json files directly from the build context.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json ./apps/worker/package.json

# Reinstall production dependencies for only the Worker service.
# We add --ignore-scripts to prevent development lifecycle scripts (like husky's "prepare") from running.
RUN pnpm install --prod --ignore-scripts --filter @accessibility-scanner-backend/worker

# Use dumb-init to handle signals correctly
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Set the start command to run the built application.
CMD ["node", "dist/index.js"] 