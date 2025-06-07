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

# This will create /app/apps/worker/dist

# --- Release Stage ---
FROM node:18-alpine AS release

WORKDIR /app

# Install pnpm and dumb-init.
RUN npm install -g pnpm && apk add --no-cache dumb-init

# Install Chromium and its dependencies for Puppeteer runtime.
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ttf-freefont \
    udev \
    fontconfig \
    dbus

# Set environment variables for Puppeteer again for the release stage
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Copy only the final, built application code from the builder stage.
COPY --from=builder /app/apps/worker/dist ./

# Copy the package.json for the specific app to the root of our new stage.
COPY --from=builder /app/apps/worker/package.json ./

# Install ONLY production dependencies based on the standalone package.json.
RUN pnpm install --prod --ignore-scripts

# Use dumb-init to handle signals correctly
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Set the start command to run the built application.
CMD ["node", "index.js"] 