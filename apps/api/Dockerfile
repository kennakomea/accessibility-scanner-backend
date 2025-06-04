FROM node:18-alpine AS base

# Set the working directory
WORKDIR /usr/src/app

# Install pnpm globally
RUN npm install -g pnpm

# Install necessary build tools for native modules if any, and other utilities
# Add git for pnpm to fetch git dependencies if any, unzip for general utility.
# python3, make, g++ are common for node-gyp.
RUN apk add --no-cache python3 make g++ git unzip dumb-init

# Copy the root package.json, pnpm-lock.yaml, and pnpm-workspace.yaml
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json ./

# Copy the 'apps' directory
COPY apps ./apps

# Install dependencies for all workspace projects.
# Note: For a strict production build, you might filter for --prod dependencies.
RUN pnpm install --frozen-lockfile

# Set the final working directory to the specific app
WORKDIR /usr/src/app/apps/api

# Expose the port
EXPOSE 3000

# Use dumb-init as the entrypoint
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Command to run the API application
# No longer using start.sh for D-Bus
CMD ["pnpm", "exec", "ts-node", "-P", "./tsconfig.json", "src/index.ts"] 