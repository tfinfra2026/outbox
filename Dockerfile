FROM node:20-alpine

WORKDIR /app

# Install production dependencies first
COPY backend/package*.json ./

RUN npm ci --omit=dev \
    && npm cache clean --force

# Copy the complete backend application
COPY backend/ .

# Runtime directories
RUN mkdir -p /app/uploads /app/data

# Application port
EXPOSE 4000

# Start application
CMD ["node", "server.js"]
