FROM node:18-alpine AS base

# Set the working directory for the entire build process
WORKDIR /usr/src/app

# Install pnpm globally in the image
RUN npm install -g pnpm

# Copy the root package.json, pnpm-lock.yaml, and pnpm-workspace.yaml
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json ./

# Copy the 'apps' directory which contains the source code and package.json for all applications
# This ensures that pnpm can find all workspace packages
COPY apps ./apps

# Install dependencies for all workspace projects.
# Using --frozen-lockfile is good practice for CI/builds
# We install all dependencies because this Dockerfile might be used for dev, where devDeps are needed.
# For a production build, you might use `RUN pnpm install --filter @accessibility-scanner-backend/api --prod`
RUN pnpm install --frozen-lockfile

# Set the final working directory to the specific app
WORKDIR /usr/src/app/apps/api

# Expose the port the API will run on (defined in docker-compose.yml as well)
EXPOSE 3000

# The command to run the API application
# Using pnpm exec and -P flag to specify tsconfig for ts-node
CMD ["pnpm", "exec", "ts-node", "-P", "./tsconfig.json", "src/index.ts"] 