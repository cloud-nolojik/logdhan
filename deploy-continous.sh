#!/bin/bash

# === CONFIG ===
REMOTE_USER="root"
REMOTE_HOST="64.227.179.191"
REMOTE_DIR="/var/www/logdhan"
FRONTEND_DIR="./frontend"
BACKEND_DIR="./backend"
COMMIT_MSG="Auto-deploy on $(date '+%Y-%m-%d %H:%M:%S')"
BRANCH="master"  # Change if using a different branch

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
rsync -avz --exclude 'node_modules' $BACKEND_DIR/ $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/backend

# === STEP 3: Upload Frontend Build (from Vite 'dist/') ===
echo "🚚 Uploading frontend build..."
rsync -avz $FRONTEND_DIR/dist/ $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/frontend

# === STEP 4: Restart Backend (with PM2) ===
echo "🚀 Restarting backend server..."
ssh $REMOTE_USER@$REMOTE_HOST << 'ENDSSH'
cd /var/www/logdhan/backend
npm install
pm2 restart logdhan-backend || pm2 start src/index.js --name logdhan-backend
ENDSSH

echo "✅ Deployment complete and code pushed to GitHub!"