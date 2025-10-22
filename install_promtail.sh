#!/bin/bash
set -e

PROMTAIL_VERSION=${1:-2.9.4}
INSTALL_DIR="$HOME/promtail"

# Install required packages
echo "Installing required packages..."
if command -v apt-get &> /dev/null; then
    # Fix repository issues and install packages
    apt-get update --fix-missing || true
    apt-get install -y wget unzip || {
        echo "Trying alternative package installation..."
        # Try installing from available repositories only
        apt-get install -y --fix-missing wget unzip || {
            echo "Using snap as fallback..."
            snap install wget || true
        }
    }
elif command -v yum &> /dev/null; then
    yum install -y wget unzip
elif command -v dnf &> /dev/null; then
    dnf install -y wget unzip
else
    echo "Package manager not found. Please install wget and unzip manually."
    exit 1
fi

# Verify unzip is available
if ! command -v unzip &> /dev/null; then
    echo "Installing unzip via alternative method..."
    # Try direct download of unzip binary if package manager fails
    if command -v wget &> /dev/null; then
        wget -O /tmp/unzip https://github.com/madler/unzip/raw/master/unzip || true
        chmod +x /tmp/unzip
        mv /tmp/unzip /usr/local/bin/ || true
    fi
fi

# Create installation directory
mkdir -p $INSTALL_DIR
cd $INSTALL_DIR

# Download Promtail
echo "Downloading Promtail v${PROMTAIL_VERSION}..."
wget -q "https://github.com/grafana/loki/releases/download/v${PROMTAIL_VERSION}/promtail-linux-amd64.zip"

# Extract
unzip -q promtail-linux-amd64.zip
chmod +x promtail-linux-amd64

# Create symlink
ln -sf promtail-linux-amd64 promtail

# Clean up
rm promtail-linux-amd64.zip

echo "Promtail installed successfully in $INSTALL_DIR"
