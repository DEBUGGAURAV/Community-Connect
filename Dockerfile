# Use Node.js as the base
FROM node:20-slim

# Install Python3 for your match.py script
RUN apt-get update && apt-get install -y python3

# Set up a new user named "user" with user ID 1000 (Mandatory for Hugging Face)
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user
WORKDIR $HOME/app

# Copy package files and install Node dependencies
COPY --chown=user package*.json ./
RUN npm install

# Copy all other project files
COPY --chown=user . .

# Expose the mandatory Hugging Face port
EXPOSE 7860

# Start the server
CMD ["node", "server.js"]
