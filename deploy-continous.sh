#!/bin/bash

# === CONFIG ===
REMOTE_USER="root"
REMOTE_HOST="64.227.179.191"
REMOTE_PASSWORD="nolojiK@2023Nov"
REMOTE_DIR="/var/www/logdhan"
FRONTEND_DIR="./frontend"
BACKEND_DIR="./backend"
COMMIT_MSG="Auto-deploy on $(date '+%Y-%m-%d %H:%M:%S')"
BRANCH="master"  # Change if using a different branch

# Check if sshpass is installed
if ! command -v sshpass &> /dev/null; then
    echo "⚠️ sshpass not found. Install it with: brew install hudochenkov/sshpass/sshpass"
    exit 1
fi

# SSH/SCP commands with password
SSH_CMD="sshpass -p '$REMOTE_PASSWORD' ssh -o StrictHostKeyChecking=no"
RSYNC_CMD="sshpass -p '$REMOTE_PASSWORD' rsync -avz -e 'ssh -o StrictHostKeyChecking=no'"

# === STEP 0: Git Commit and Push ===
echo "📦 Committing and pushing to GitHub..."
git add .
git commit -m "$COMMIT_MSG" || echo "⚠️ Nothing to commit"
git push origin HEAD:$BRANCH

if [ $? -ne 0 ]; then
  echo "❌ Git push failed. Aborting deployment."
  exit 1
fi

# === STEP 1: Build Frontend (Vite uses 'dist') ===
echo "🔧 Building frontend..."
cd $FRONTEND_DIR
npm install
npm run build

if [ ! -d "dist" ]; then
  echo "❌ Vite build failed: 'dist/' folder not found!"
  exit 1
fi
cd -

# === STEP 2: Upload Backend (excluding node_modules) ===
echo "🚚 Uploading backend..."
sshpass -p "$REMOTE_PASSWORD" rsync -avz --exclude 'node_modules' -e "ssh -o StrictHostKeyChecking=no" $BACKEND_DIR/ $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/backend

# === STEP 3: Upload Frontend Build (from Vite 'dist/') ===
echo "🚚 Uploading frontend build..."
sshpass -p "$REMOTE_PASSWORD" rsync -avz -e "ssh -o StrictHostKeyChecking=no" $FRONTEND_DIR/dist/ $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/frontend

# === STEP 3.5: Upload scanner.py (lives at project root, called from backend) ===
echo "🚚 Uploading scanner.py..."
sshpass -p "$REMOTE_PASSWORD" rsync -avz -e "ssh -o StrictHostKeyChecking=no" scanner.py $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/scanner.py

# === STEP 4: Restart Backend (with PM2) + ensure Python deps for scanner.py ===
echo "🚀 Restarting backend server..."
sshpass -p "$REMOTE_PASSWORD" ssh -o StrictHostKeyChecking=no $REMOTE_USER@$REMOTE_HOST << 'ENDSSH'
cd /var/www/logdhan/backend
npm install
# Ensure scanner.py Python deps are available (idempotent — quick if already installed)
python3 -m pip install --quiet --upgrade pandas numpy yfinance || echo "⚠️ pip install failed — scanner.py may not run"
pm2 flush logdhan-backend
pm2 restart logdhan-backend || pm2 start src/index.js --name logdhan-backend
ENDSSH

echo "✅ Deployment complete and code pushed to GitHub!"