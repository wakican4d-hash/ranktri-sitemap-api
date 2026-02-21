#!/bin/bash
# deploy-security-hardening.sh
# Commits and pushes security hardening changes to GitHub

set -e  # Exit on error

cd /Users/waseemakram/Downloads/ranktri-backend

echo "📋 Checking git status..."
git status

echo ""
echo "📦 Staging security files..."
git add security.js SECURITY.md SECURITY_IMPLEMENTATION.md server.js package.json package-lock.json GITHUB_AND_STORAGE_EXPLANATION.md

echo ""
echo "📝 Committing changes..."
git commit -m "Security hardening: Rate limiting (20/15min per IP), input validation (Zod), SSRF prevention, Helmet.js headers (OWASP-compliant)"

echo ""
echo "🚀 Pushing to GitHub..."
git push origin main

echo ""
echo "✅ All changes pushed to GitHub!"
echo ""
echo "📍 View on GitHub:"
echo "   https://github.com/wakican4d-hash/ranktri-backend"
echo ""
echo "🔗 Production auto-deploys from GitHub to:"
echo "   https://ranktri-backend.vercel.app"
echo ""
git log --oneline -1
