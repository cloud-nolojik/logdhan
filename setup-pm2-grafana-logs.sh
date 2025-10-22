#!/bin/bash

# PM2 Logs to Grafana Setup Script
# This script connects to a remote server and sets up PM2 log forwarding to Grafana via Loki

set -e

# Configuration variables
REMOTE_HOST="64.227.179.191"
REMOTE_USER="root"
REMOTE_PASSWORD="nolojiK@2023Nov"
LOKI_URL="https://logs-prod-028.grafana.net"
PROMTAIL_VERSION="2.9.4"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if required variables are set
check_config() {
    if [[ -z "$REMOTE_HOST" ]]; then
        print_error "REMOTE_HOST is not set. Please configure the remote server hostname/IP."
        exit 1
    fi
    
    if [[ -z "$REMOTE_USER" ]]; then
        print_error "REMOTE_USER is not set. Please configure the remote server username."
        exit 1
    fi
    
    if [[ -z "$LOKI_URL" ]]; then
        print_error "LOKI_URL is not set. Please configure the Loki server URL (e.g., http://localhost:3100)."
        exit 1
    fi
}

# Function to prompt for configuration
prompt_config() {
    if [[ -z "$REMOTE_HOST" ]]; then
        read -p "Enter remote server hostname/IP: " REMOTE_HOST
    fi
    
    if [[ -z "$REMOTE_USER" ]]; then
        read -p "Enter remote server username: " REMOTE_USER
    fi
    
    if [[ -z "$REMOTE_PASSWORD" ]]; then
        read -s -p "Enter remote server password: " REMOTE_PASSWORD
        echo
    fi
    
    if [[ -z "$LOKI_URL" ]]; then
        read -p "Enter Loki server URL (e.g., http://localhost:3100): " LOKI_URL
    fi
}

# Function to build SSH command using sshpass for password authentication
build_ssh_cmd() {
    echo "sshpass -p '$REMOTE_PASSWORD' ssh -o StrictHostKeyChecking=no $REMOTE_USER@$REMOTE_HOST"
}

# Function to build SCP command using sshpass for password authentication
build_scp_cmd() {
    echo "sshpass -p '$REMOTE_PASSWORD' scp -o StrictHostKeyChecking=no"
}

# Function to check if sshpass is installed
check_sshpass() {
    if ! command -v sshpass &> /dev/null; then
        print_error "sshpass is required for password authentication but not installed."
        print_status "Installing sshpass..."
        
        # Try to install sshpass based on OS
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            if command -v brew &> /dev/null; then
                brew install hudochenkov/sshpass/sshpass
            else
                print_error "Please install Homebrew first, then run: brew install hudochenkov/sshpass/sshpass"
                exit 1
            fi
        elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
            # Linux
            if command -v apt-get &> /dev/null; then
                sudo apt-get update && sudo apt-get install -y sshpass
            elif command -v yum &> /dev/null; then
                sudo yum install -y sshpass
            elif command -v dnf &> /dev/null; then
                sudo dnf install -y sshpass
            else
                print_error "Please install sshpass manually for your Linux distribution"
                exit 1
            fi
        else
            print_error "Unsupported OS. Please install sshpass manually."
            exit 1
        fi
        
        print_status "sshpass installed successfully"
    fi
}

# Function to create Promtail configuration
create_promtail_config() {
    local pm2_home=$(eval "$(build_ssh_cmd)" 'echo $HOME/.pm2')
    
    cat > promtail-config.yml << EOF
server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /tmp/positions.yaml

clients:
  - url: ${LOKI_URL}/loki/api/v1/push

scrape_configs:
  - job_name: pm2-logs
    static_configs:
      - targets:
          - localhost
        labels:
          job: pm2
          host: ${REMOTE_HOST}
          __path__: ${pm2_home}/logs/*.log
    
    pipeline_stages:
      - regex:
          expression: '^(?P<timestamp>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z): (?P<level>\w+): (?P<message>.*)$'
      - labels:
          level:
      - timestamp:
          source: timestamp
          format: RFC3339Nano
          
  - job_name: pm2-out-logs
    static_configs:
      - targets:
          - localhost
        labels:
          job: pm2-out
          host: ${REMOTE_HOST}
          __path__: ${pm2_home}/logs/*-out-*.log
          
  - job_name: pm2-error-logs
    static_configs:
      - targets:
          - localhost
        labels:
          job: pm2-error
          host: ${REMOTE_HOST}
          __path__: ${pm2_home}/logs/*-error-*.log
EOF
}

# Function to install Promtail on remote server
install_promtail() {
    print_status "Installing Promtail on remote server..."
    
    local ssh_cmd=$(build_ssh_cmd)
    
    # Create installation script
    cat > install_promtail.sh << 'EOF'
#!/bin/bash
set -e

PROMTAIL_VERSION=${1:-2.9.4}
INSTALL_DIR="$HOME/promtail"

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
EOF

    # Copy and run installation script
    local scp_cmd=$(build_scp_cmd)
    eval "$scp_cmd install_promtail.sh $REMOTE_USER@$REMOTE_HOST:~/"
    eval "$ssh_cmd" "'chmod +x ~/install_promtail.sh && ~/install_promtail.sh $PROMTAIL_VERSION'"
    
    # Clean up local script
    rm install_promtail.sh
    
    print_status "Promtail installation completed"
}

# Function to deploy Promtail configuration
deploy_config() {
    print_status "Deploying Promtail configuration..."
    
    local ssh_cmd=$(build_ssh_cmd)
    local scp_cmd=$(build_scp_cmd)
    
    # Copy configuration to remote server
    eval "$scp_cmd promtail-config.yml $REMOTE_USER@$REMOTE_HOST:~/promtail/"
    
    print_status "Configuration deployed"
}

# Function to create systemd service for Promtail
create_systemd_service() {
    print_status "Creating systemd service for Promtail..."
    
    local ssh_cmd=$(build_ssh_cmd)
    
    # Create service file content
    cat > promtail.service << EOF
[Unit]
Description=Promtail service
After=network.target

[Service]
Type=simple
User=$REMOTE_USER
ExecStart=$HOME/promtail/promtail -config.file=$HOME/promtail/promtail-config.yml
Restart=on-failure
RestartSec=20
StandardOutput=journal
StandardError=journal
SyslogIdentifier=promtail

[Install]
WantedBy=multi-user.target
EOF

    # Copy service file and enable it
    local scp_cmd=$(build_scp_cmd)
    eval "$scp_cmd promtail.service $REMOTE_USER@$REMOTE_HOST:~/"
    eval "$ssh_cmd" "'
        sudo mv ~/promtail.service /etc/systemd/system/
        sudo systemctl daemon-reload
        sudo systemctl enable promtail
        sudo systemctl start promtail
        sudo systemctl status promtail --no-pager
    '"
    
    # Clean up local service file
    rm promtail.service
    
    print_status "Systemd service created and started"
}

# Function to test connection
test_connection() {
    print_status "Testing connection to remote server..."
    
    local ssh_cmd=$(build_ssh_cmd)
    
    if eval "$ssh_cmd" "'echo Connection successful'"; then
        print_status "SSH connection established successfully"
    else
        print_error "Failed to connect to remote server"
        exit 1
    fi
}

# Function to verify PM2 logs
verify_pm2_logs() {
    print_status "Verifying PM2 logs directory..."
    
    local ssh_cmd=$(build_ssh_cmd)
    
    eval "$ssh_cmd" "'
        if [ -d ~/.pm2/logs ]; then
            echo PM2 logs directory found
            ls -la ~/.pm2/logs/ | head -10
        else
            echo PM2 logs directory not found. Make sure PM2 is installed and running applications.
        fi
    '"
}

# Function to check Promtail status
check_promtail_status() {
    print_status "Checking Promtail status..."
    
    local ssh_cmd=$(build_ssh_cmd)
    
    eval "$ssh_cmd" "'
        sudo systemctl status promtail --no-pager
        echo --- Recent Promtail logs ---
        sudo journalctl -u promtail -n 20 --no-pager
    '"
}

# Main installation function
main() {
    print_status "Starting PM2 to Grafana logs setup..."
    
    # Check if sshpass is installed
    check_sshpass
    
    # Prompt for configuration if not set
    prompt_config
    
    # Validate configuration
    check_config
    
    # Test SSH connection
    test_connection
    
    # Verify PM2 logs exist
    verify_pm2_logs
    
    # Create Promtail configuration
    create_promtail_config
    
    # Install Promtail
    install_promtail
    
    # Deploy configuration
    deploy_config
    
    # Create and start systemd service
    create_systemd_service
    
    # Check status
    check_promtail_status
    
    print_status "Setup completed successfully!"
    print_status "Next steps:"
    echo "1. Add Loki as a data source in Grafana: $LOKI_URL"
    echo "2. Create dashboards using these log labels:"
    echo "   - {job=\"pm2\"} for all PM2 logs"
    echo "   - {job=\"pm2-out\"} for application output logs"
    echo "   - {job=\"pm2-error\"} for application error logs"
    echo "   - {host=\"$REMOTE_HOST\"} to filter by this server"
    
    # Clean up local config file
    rm promtail-config.yml
}

# Command line options
case "${1:-}" in
    "test")
        check_sshpass
        prompt_config
        check_config
        test_connection
        verify_pm2_logs
        ;;
    "status")
        check_sshpass
        prompt_config
        check_config
        check_promtail_status
        ;;
    "uninstall")
        check_sshpass
        prompt_config
        check_config
        print_status "Uninstalling Promtail..."
        ssh_cmd=$(build_ssh_cmd)
        eval "$ssh_cmd" "'
            sudo systemctl stop promtail || true
            sudo systemctl disable promtail || true
            sudo rm -f /etc/systemd/system/promtail.service
            sudo systemctl daemon-reload
            rm -rf ~/promtail
        '"
        print_status "Promtail uninstalled"
        ;;
    *)
        main
        ;;
esac