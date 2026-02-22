#!/bin/bash

# =================================================================
# NANO AUTOMATION CONSOLE - LINUX DEPLOYMENT SCRIPT
# =================================================================
# Tested on: Ubuntu 22.04 / 24.04 LTS
# Run: chmod +x setup_linux.sh && ./setup_linux.sh
# =================================================================

set -e
echo "🚀 Starting Linux Deployment Suite..."

# 1. Update & Basic Tools
echo "[1/7] Updating system packages..."
sudo apt-get update -y && sudo apt-get upgrade -y
sudo apt-get install -y curl wget git build-essential ca-certificates gnupg

# 2. Install Node.js LTS (v20)
echo "[2/7] Installing Node.js LTS (v20)..."
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
echo "  Node.js: $(node -v) | NPM: $(npm -v)"

# 3. Install Puppeteer/Chrome Dependencies
echo "[3/7] Installing browser dependencies (Chromium + Xvfb)..."
# Handle both traditional and newer Ubuntu package names
sudo apt-get install -y \
    libgbm-dev libnss3 libatk-bridge2.0-0 libgtk-3-0 \
    libxss1 libxdamage1 libxcomposite1 \
    libpango-1.0-0 libcairo2 libcups2 \
    libxkbcommon-x11-0 libdrm2 libxrandr2 \
    xvfb fonts-liberation libappindicator3-1 \
    2>/dev/null || true

# libasound2 was renamed to libasound2t64 in Ubuntu 24.04+
sudo apt-get install -y libasound2 2>/dev/null || sudo apt-get install -y libasound2t64 2>/dev/null || true

# Install Chromium (try snap first, then apt)
if ! command -v chromium-browser &> /dev/null && ! command -v chromium &> /dev/null; then
    echo "  Installing Chromium..."
    sudo apt-get install -y chromium-browser 2>/dev/null || \
    sudo snap install chromium 2>/dev/null || \
    echo "  ⚠️ Could not install Chromium. puppeteer-real-browser will download its own."
fi

# 4. Install Project Dependencies
echo "[4/7] Installing NPM packages..."
cd "$(dirname "$0")"
npm install

# 5. Build Dashboard
echo "[5/7] Building Dashboard UI..."
cd dashboard
npm install
npm run build
cd ..

# 6. Configure Firewall (Remote Access)
echo "[6/7] Opening Firewall for Dashboard (Port 4000) and Solver (Port 3000)..."
sudo ufw allow 4000/tcp 2>/dev/null || true
sudo ufw allow 3000/tcp 2>/dev/null || true
sudo ufw allow 22/tcp 2>/dev/null || true
sudo ufw --force enable 2>/dev/null || true
sudo ufw status 2>/dev/null || true

# 7. Install PM2 (Process Manager for 24/7 Uptime)
echo "[7/7] Setting up PM2 for background persistence..."
sudo npm install -g pm2

# Get public IP
PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "YOUR_SERVER_IP")

echo ""
echo "================================================================"
echo " ✅ DEPLOYMENT COMPLETE!"
echo "================================================================"
echo ""
echo " Quick Start:"
echo "   node server.js                    # Run in foreground"
echo "   pm2 start server.js --name nano   # Run in background"
echo "   pm2 logs nano                     # View logs"
echo "   pm2 save && pm2 startup           # Auto-start on reboot"
echo ""
echo " Dashboard: http://${PUBLIC_IP}:4000"
echo ""
echo " Xvfb (headless display, required for CAPTCHA solver):"
echo "   export DISPLAY=:99"
echo "   Xvfb :99 -screen 0 1280x720x24 &"
echo ""
echo "================================================================"
