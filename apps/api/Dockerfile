FROM node:18-alpine AS builder

# Set working directory to represent the monorepo root within the image
WORKDIR /app

# Install pnpm globally
RUN npm install -g pnpm

# Install necessary build tools for native modules and other utilities
RUN apk add --no-cache python3 make g++ git unzip dumb-init

# Copy the root workspace files.
# Paths are relative to this Dockerfile's location (apps/api), going up to the monorepo root.
COPY ../../package.json ../../pnpm-lock.yaml ../../pnpm-workspace.yaml ./
COPY ../../tsconfig.base.json ./

# Copy all application code from the monorepo's "apps" directory.
# `../` refers to `accessibility-scanner-backend/apps/`.
# This copies the contents of `accessibility-scanner-backend/apps/` (i.e., api/, worker/)
# into `/app/apps/` inside the image.
COPY ../ ./apps/

# At this point, the image structure for building is:
# /app/package.json (root)
# /app/pnpm-lock.yaml
# /app/pnpm-workspace.yaml
# /app/tsconfig.base.json
# /app/apps/api/...
# /app/apps/worker/...

# Install dependencies for all workspace projects.
# pnpm will handle the workspace structure correctly.
RUN pnpm install --frozen-lockfile

# Build the specific application (API).
# pnpm --filter <appName> run <script> executes the script in the context of that app.
# The appName is defined in apps/api/package.json ("name": "@accessibility-scanner-backend/api")
RUN CI=false pnpm --filter @accessibility-scanner-backend/api run build
# This will create /app/apps/api/dist

# --- Release Stage ---
FROM node:18-alpine AS release

WORKDIR /app

# Install dumb-init for better signal handling and pnpm for the start command if it uses pnpm exec
RUN apk add --no-cache dumb-init && npm install -g pnpm

# Create a subdirectory for the app's package.json to ensure pnpm workspace setup is recognized
RUN mkdir -p ./apps/api

# Copy the built 'dist' folder directly into the root of the WORKDIR
COPY --from=builder /app/apps/api/dist ./dist

# Copy the API app's package.json into its new location.
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json

# Copy the root package.json and workspace files for pnpm to understand the context for runtime.
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/pnpm-workspace.yaml ./

# Reinstall production dependencies for only the API service in its final location.
# This ensures a lean production image with only necessary node_modules.
# The WORKDIR is the monorepo root for `pnpm install --filter` to work correctly referencing the workspace.
RUN pnpm install --prod --frozen-lockfile --filter @accessibility-scanner-backend/api...

# The WORKDIR is already /app, so the start command path is simple.
EXPOSE 3000
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# The "start" script in apps/api/package.json is "node dist/index.js".
# This CMD will be used by Railway if its "Start Command" is empty, but we will set it explicitly.
CMD ["node", "dist/index.js"] 