FROM node:18-alpine AS builder

# Set CI=false for the entire build stage to prevent linting/test errors from stopping the build.
ENV CI=false

# Set working directory to represent the monorepo root within the image
WORKDIR /app

# Install pnpm globally
RUN npm install -g pnpm

# Install necessary build tools for native modules and other utilities
RUN apk add --no-cache python3 make g++ git unzip dumb-init

# Copy the files needed for installation and building.
# This includes the entire 'apps' directory to ensure the pnpm workspace is complete.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json ./
COPY apps ./apps

# We install dependencies. pnpm correctly finds everything now.
RUN pnpm install --frozen-lockfile

# Build the specific application (API).
# pnpm --filter <appName> run <script> executes the script in the context of that app.
# The appName is defined in apps/api/package.json ("name": "@accessibility-scanner-backend/api")
RUN pnpm --filter @accessibility-scanner-backend/api run build

# --- DEBUGGING STEP ---
# List the contents of the app directory to verify that the 'dist' folder was created.
RUN ls -la /app/apps/api
# --- END DEBUGGING STEP ---

# This will create /app/apps/api/dist

# --- Release Stage ---
FROM node:18-alpine AS release

WORKDIR /app

# Install dumb-init for better signal handling and pnpm for the start command if it uses pnpm exec
RUN apk add --no-cache dumb-init && npm install -g pnpm

# Create a subdirectory for the app's package.json to ensure pnpm workspace setup is recognized
RUN mkdir -p ./apps/api

# Copy the built 'dist' folder from the builder stage.
COPY --from=builder /app/apps/api/dist ./dist

# Copy the necessary package.json files directly from the build context, not from the builder stage.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json

# Reinstall production dependencies for only the API service in its final location.
# This ensures a lean production image with only necessary dependencies.
RUN pnpm install --prod --ignore-scripts --filter @accessibility-scanner-backend/api

# Use dumb-init to handle signals correctly
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Set the start command to run the built application.
CMD ["node", "dist/index.js"] 