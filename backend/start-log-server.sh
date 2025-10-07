#!/bin/bash

# PM2 Log Server Startup Script

# Set default port if not specified
LOG_SERVER_PORT=${LOG_SERVER_PORT:-3001}

echo "Starting PM2 Log Server on port $LOG_SERVER_PORT..."

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed or not in PATH"
    exit 1
fi

# Check if PM2 is available
if ! command -v pm2 &> /dev/null; then
    echo "Error: PM2 is not installed or not in PATH"
    echo "Install PM2 with: npm install -g pm2"
    exit 1
fi

# Check if express is available (try to require it)
if ! node -e "require('express')" 2>/dev/null; then
    echo "Warning: Express.js not found. Installing..."
    npm install express
    if [ $? -ne 0 ]; then
        echo "Error: Failed to install Express.js"
        exit 1
    fi
fi

# Make the script executable
chmod +x pm2-log-server.js

# Start the server
echo "PM2 Log Server starting..."
echo "Web interface will be available at: http://localhost:$LOG_SERVER_PORT"
echo "Press Ctrl+C to stop the server"

# Run the server
LOG_SERVER_PORT=$LOG_SERVER_PORT node pm2-log-server.js