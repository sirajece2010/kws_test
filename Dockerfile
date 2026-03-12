# Use the official Node.js image as the base image
FROM node:18

# Set the working directory in the container
WORKDIR /app

# Copy the application files into the working directory
COPY api/package.json /app/package.json
COPY api/package-lock.json /app/package-lock.json

# Install the application dependencies
RUN npm install

COPY api/src /app/src
COPY public /app/public

EXPOSE 3050

# Define the entry point for the container
CMD ["npm", "run", "dev"]