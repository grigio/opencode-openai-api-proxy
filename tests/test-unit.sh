#!/bin/bash
set -e

echo "--- Running Unit Tests (JS Mocks) ---"
cd proxy
npm install
npm test
cd ..
echo "--- Unit Tests Completed Successfully! ---"
