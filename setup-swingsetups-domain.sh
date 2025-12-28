#!/bin/bash
# Setup swingsetups.com domain on the server
# Run this script locally: bash setup-swingsetups-domain.sh

SERVER="64.227.179.191"
PASSWORD="nolojiK@2023Nov"

echo "=== Setting up swingsetups.com ==="
echo ""

# Step 1: Create nginx config for swingsetups.com
echo "Step 1: Creating nginx config..."
sshpass -p "$PASSWORD" ssh root@$SERVER -o StrictHostKeyChecking=no << 'ENDSSH'

# Create nginx config for swingsetups.com (copy from logdhan.com and modify)
cat > /etc/nginx/sites-available/swingsetups << 'EOF'
# HTTP - redirect to HTTPS
server {
    listen 80;
    server_name swingsetups.com www.swingsetups.com;

    # For certbot verification
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # Redirect all other requests to HTTPS (after SSL is set up)
    location / {
        return 301 https://swingsetups.com$request_uri;
    }
}
EOF

# Enable the site
ln -sf /etc/nginx/sites-available/swingsetups /etc/nginx/sites-enabled/swingsetups

# Test nginx config
nginx -t

# Reload nginx
systemctl reload nginx

echo "Nginx config created and reloaded"

ENDSSH

echo ""
echo "Step 2: Waiting for DNS propagation check..."
sleep 2

# Step 2: Verify DNS is pointing to server
echo "Checking if swingsetups.com resolves to $SERVER..."
RESOLVED_IP=$(dig +short swingsetups.com 2>/dev/null | head -1)
echo "DNS resolves to: $RESOLVED_IP"

if [ "$RESOLVED_IP" != "$SERVER" ]; then
    echo ""
    echo "WARNING: DNS may not have propagated yet."
    echo "Expected: $SERVER"
    echo "Got: $RESOLVED_IP"
    echo ""
    echo "You can:"
    echo "  1. Wait for DNS to propagate (can take up to 48 hours)"
    echo "  2. Run this script again later"
    echo ""
    read -p "Continue anyway? (y/n): " CONTINUE
    if [ "$CONTINUE" != "y" ]; then
        echo "Exiting. Run this script again once DNS propagates."
        exit 1
    fi
fi

# Step 3: Get SSL certificate
echo ""
echo "Step 3: Getting SSL certificate..."
sshpass -p "$PASSWORD" ssh root@$SERVER -o StrictHostKeyChecking=no << 'ENDSSH'

# Get SSL certificate using certbot
certbot --nginx -d swingsetups.com -d www.swingsetups.com --non-interactive --agree-tos --email admin@swingsetups.com --redirect

# Check if certificate was obtained
if [ -f /etc/letsencrypt/live/swingsetups.com/fullchain.pem ]; then
    echo "SSL certificate obtained successfully!"

    # Update nginx config with full SSL setup
    cat > /etc/nginx/sites-available/swingsetups << 'EOF'
server {
    listen 443 ssl;
    server_name swingsetups.com www.swingsetups.com;

    # App redirect routes for WhatsApp deep links
    location /app/ {
        proxy_pass http://localhost:5650;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # Android App Links verification
    location /.well-known/ {
        proxy_pass http://localhost:5650;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # API routes
    location /api/ {
        proxy_pass http://localhost:5650;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # Health check
    location /health {
        proxy_pass http://localhost:5650;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }

    # Frontend
    location / {
        root /var/www/logdhan/frontend;
        index index.html;
        try_files $uri /index.html;
    }

    ssl_certificate /etc/letsencrypt/live/swingsetups.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/swingsetups.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

# HTTP redirect
server {
    listen 80;
    server_name swingsetups.com www.swingsetups.com;
    return 301 https://swingsetups.com$request_uri;
}
EOF

    # Test and reload nginx
    nginx -t && systemctl reload nginx
    echo "Nginx updated with SSL config"
else
    echo "SSL certificate NOT obtained. Check certbot output above."
fi

ENDSSH

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Testing the domain..."
sleep 2

# Test the domain
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' https://swingsetups.com/api/v1/public/plans 2>/dev/null)
echo "API Response Code: $HTTP_CODE"

if [ "$HTTP_CODE" == "200" ]; then
    echo ""
    echo "SUCCESS! swingsetups.com is now working!"
    echo "  - https://swingsetups.com"
    echo "  - https://swingsetups.com/api/v1/public/plans"
else
    echo ""
    echo "Domain may not be fully configured yet."
    echo "Check: https://swingsetups.com"
fi
