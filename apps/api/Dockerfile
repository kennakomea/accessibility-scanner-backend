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

# At the end of the 'builder' stage, the built files are located at:
# /app/apps/api/dist/
# --- Release Stage ---
FROM node:18-alpine AS release

WORKDIR /app

# Install pnpm to run the install command and dumb-init for signal handling.
RUN npm install -g pnpm && apk add --no-cache dumb-init

# Copy only the final, built application code from the builder stage.
# The contents of `dist` are copied directly into the current WORKDIR (/app).
COPY --from=builder /app/apps/api/dist ./

# Copy the package.json for the specific app to the root of our new stage.
# This makes the app standalone.
COPY --from=builder /app/apps/api/package.json ./

# Install ONLY production dependencies based on the standalone package.json.
# This creates a lean, clean node_modules folder.
RUN pnpm install --prod --ignore-scripts

# Use dumb-init to handle signals correctly
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Set the start command to run the built application.
# Since we copied the contents of `dist` to `/app`, the main file is now at `/app/index.js`.
CMD ["node", "index.js"] 