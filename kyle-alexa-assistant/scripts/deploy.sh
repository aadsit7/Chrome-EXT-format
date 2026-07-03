#!/usr/bin/env bash
#
# Deploy Kyle: build the Lambda zip, update the Lambda function code, then
# deploy the skill package with the ASK CLI.
#
# Prereqs: AWS CLI configured, ASK CLI configured (ask configure), zip, npm.
# Usage:   ./scripts/deploy.sh [lambda-function-name]
#
set -euo pipefail

FUNCTION_NAME="${1:-kyle-alexa-assistant}"

# Location-independent: resolve this script's directory, then the project root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

echo "==> Project root: $PROJECT_ROOT"

echo "==> Installing production dependencies"
cd lambda
npm install --omit=dev --no-audit --no-fund

echo "==> Building lambda.zip"
rm -f ../lambda.zip
zip -qr ../lambda.zip . -x '.env' -x '*.zip'
cd "$PROJECT_ROOT"
echo "    $(du -h lambda.zip | cut -f1) written to lambda.zip"

echo "==> Updating Lambda function code: $FUNCTION_NAME"
aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://lambda.zip" \
  --no-cli-pager \
  --query 'LastUpdateStatus' \
  --output text

echo "==> Deploying skill package with ASK CLI"
ask deploy

echo "==> Restoring dev dependencies for local testing"
cd lambda
npm install --no-audit --no-fund >/dev/null

echo "==> Done. Test in the Alexa Developer Console or say: \"Alexa, open kyle\""
