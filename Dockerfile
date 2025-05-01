# Use an official Node.js image as the base
FROM node:18

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install the dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Set environment variables for default values
ENV BAMBUBOARD_HTTP_PORT=8080
ENV BAMBUBOARD_PRINTER_URL=""
ENV BAMBUBOARD_PRINTER_PORT=""
ENV BAMBUBOARD_PRINTER_SN=""
ENV BAMBUBOARD_PRINTER_ACCESS_CODE=""
ENV BAMBUBOARD_TEMP_SETTING=""
ENV BAMBUBOARD_FAN_PERCENTAGES=false
ENV BAMBUBOARD_FAN_ICONS=true
ENV BAMBUBOARD_LOGGING=false

# Expose the port the app runs on
EXPOSE 8080

# Command to run your app
CMD [ "node", "bambuConnection.js" ]
