#!/bin/bash

MODE=${1:-dev}

start_dev() {
    echo "🚀 启动 Mira 桌面应用..."
    npm install

    echo ""
    echo "🖥️  启动 Electron 窗口..."
    echo "   按 Ctrl+Shift+A 全局唤出"
    echo ""

    npm run dev
}

start_package() {
    echo "📦 打包 Mira..."
    npm install
    npm run package
    echo ""
    echo "✅ 打包完成! 安装包在 release/ 目录"
}

case $MODE in
    dev)      start_dev ;;
    package)  start_package ;;
    *)        echo "用法: ./start.sh [dev|package]" ;;
esac
