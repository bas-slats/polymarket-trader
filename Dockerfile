FROM node:20-alpine

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Copy static web UI to dist
RUN mkdir -p /app/dist/ui/web && cp -r /app/src/ui/web/* /app/dist/ui/web/

# Create data directory for SQLite
RUN mkdir -p /app/data

# Set environment variables
ENV NODE_ENV=production

# Run the Docker entry point with web UI
CMD ["node", "dist/index-docker-full.js"]
