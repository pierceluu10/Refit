FROM node:22-alpine
WORKDIR /opt/billing
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && chmod -R a+rX /opt/billing
