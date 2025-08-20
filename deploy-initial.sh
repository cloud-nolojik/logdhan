#!/usr/bin/env bash
set -euo pipefail

read -p "SSH target (e.g. root@64.227.179.191): " REMOTE
read -p "Domain (e.g. logdhan.com): " DOMAIN
read -p "Git repo URL (HTTPS or SSH): " GIT_REPO
read -p "Git branch [main]: " GIT_BRANCH
GIT_BRANCH=${GIT_BRANCH:-main}
read -p "Email for Let's Encrypt: " CERT_EMAIL

ssh "$REMOTE" bash -s <<EOF
  set -euo pipefail

  # 1) System prep
  apt update
  apt install -y nodejs npm nginx git ufw certbot python3-certbot-nginx

  # 2) Firewall
  ufw allow 'Nginx Full'
  ufw allow OpenSSH
  ufw --force enable

  # 3) Project dirs
  mkdir -p /var/www/$DOMAIN
  chown -R \$USER:\$USER /var/www/$DOMAIN

  cd /var/www/$DOMAIN

  # 4) Clone your repo (assumes it contains backend/ and frontend/)
  if [ -d .git ]; then
    echo "Repo already cloned—fetching latest"
    git fetch
    git reset --hard origin/$GIT_BRANCH
  else
    git clone -b $GIT_BRANCH $GIT_REPO .
  fi

  # 5) Backend: install & run under PM2
  cd backend
  npm install
  npm install -g pm2
  pm2 start index.js --name "$DOMAIN-backend"
  pm2 save

  # 6) Frontend: build
  cd ../frontend
  npm install
  npm run build

  # 7) Move build output to a clean 'frontend' folder
  rm -rf /var/www/$DOMAIN/frontend
  mkdir -p /var/www/$DOMAIN/frontend
  mv build/* /var/www/$DOMAIN/frontend/

  # 8) Nginx site config
  cat > /etc/nginx/sites-available/$DOMAIN <<NGCONF
server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN www.$DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    root /var/www/$DOMAIN/frontend;
    index index.html;
    try_files \$uri /index.html;

    location /api/v1/ {
        proxy_pass         http://localhost:5650;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGCONF

  # enable & test
  ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN
  nginx -t
  systemctl reload nginx

  # 9) Obtain SSL cert
  certbot --nginx \
    --non-interactive \
    --agree-tos \
    --email $CERT_EMAIL \
    -d $DOMAIN -d www.$DOMAIN

  echo "✅ Deployment complete on $REMOTE!"
EOF