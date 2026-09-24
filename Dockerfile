FROM node:20-bookworm

# Install Python
RUN rm -rf /var/lib/apt/lists/* \
    && apt-get clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY requirements.txt ./
RUN pip3 install --break-system-packages -r requirements.txt

COPY . .

ENV NODE_ENV=production

CMD ["npm", "start"]