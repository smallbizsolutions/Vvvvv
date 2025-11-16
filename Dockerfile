FROM ghcr.io/puppeteer/puppeteer:21.6.1

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies as root
USER root
RUN npm install --production

# Copy application files
COPY . .

# Set environment variables
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Expose port
EXPOSE 3000

# Run as non-root user
USER pptruser

# Start the application
CMD ["node", "index.js"]
