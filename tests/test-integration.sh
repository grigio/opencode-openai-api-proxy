#!/bin/bash
set -e

IMAGE_NAME="opencode-integration-test-$(date +%s)"
CONTAINER_NAME="opencode-test-container"
PASSWORD="test-password-123"

echo "--- Starting Integration Test (Docker) ---"
EXIT_CODE=0

# The script relies on jq for response parsing.
if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq is required but not installed. Install it (e.g. apt-get install jq) and re-run."
    exit 1
fi

# 1. Build
echo "1. Building image: $IMAGE_NAME..."
docker build -t "$IMAGE_NAME" .

# 2. Run
echo "2. Starting container..."
docker run -d --name "$CONTAINER_NAME" \
  -e OPENCODE_SERVER_PASSWORD="$PASSWORD" \
  -p 4096:4096 \
  -p 4097:4097 \
  "$IMAGE_NAME"

# 3. Wait for Ready
echo "3. Waiting for initialization (may take up to 60s)..."
MAX_RETRIES=60
COUNT=0
until curl -s http://localhost:4096/health | grep -q "ok"; do
    if [ $COUNT -ge $MAX_RETRIES ]; then
        echo "Error: Timeout initializing Proxy."
        docker logs "$CONTAINER_NAME"
        docker stop "$CONTAINER_NAME"
        docker rm "$CONTAINER_NAME"
        docker rmi "$IMAGE_NAME"
        exit 1
    fi
    sleep 1
    COUNT=$((COUNT+1))
done
echo "Proxy is online!"

# 4. Test Models
echo "4. Testing GET /v1/models..."
MODELS_RES=$(curl -s http://localhost:4096/v1/models -H "Authorization: Bearer $PASSWORD")
echo "Available Models: $MODELS_RES"

if echo "$MODELS_RES" | grep -q "object\":\"list"; then
    echo "Success: Model listing OK"
else
    echo "Error: Invalid models response: $MODELS_RES"
    # Fails but continues for cleanup
    EXIT_CODE=1
fi

# Extract the first available model dynamically (the legacy default
# opencode/big-pickle is not guaranteed to exist in every catalog), falling
# back to opencode/big-pickle when the models endpoint is empty.
TEST_MODEL=$(echo "$MODELS_RES" | jq -r 'if (.data | length) > 0 then .data[0].id else "opencode/big-pickle" end')
echo "Using model for tests: $TEST_MODEL"

# 5. Test Completion
echo "5. Testing POST /v1/chat/completions (No Stream)..."
COMPLETION_RES=$(curl -s -X POST http://localhost:4096/v1/chat/completions \
  -H "Authorization: Bearer $PASSWORD" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$TEST_MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Analyze the time complexity of QuickSort. Think step by step.\"}]
  }")

echo "Response: $COMPLETION_RES"

if echo "$COMPLETION_RES" | grep -q "chat.completion"; then
    echo "Success: Chat Completion OK"
    
    # Check support for reasoning tokens
    REASONING_TOKENS=$(echo "$COMPLETION_RES" | jq -r '.usage.completion_tokens_details.reasoning_tokens // "missing"')
    if [ "$REASONING_TOKENS" != "missing" ]; then
        echo "Success: 'reasoning_tokens' field present (Value: $REASONING_TOKENS)"
    else
        echo "Error: 'reasoning_tokens' field missing in response."
        EXIT_CODE=1
    fi

    # Check support for reasoning content
    REASONING_CONTENT_CHECK=$(echo "$COMPLETION_RES" | jq -r 'if .choices[0].message | has("reasoning_content") then "yes" else "no" end')
    
    if [ "$REASONING_CONTENT_CHECK" == "yes" ]; then
         echo "Success: 'reasoning_content' structure verified."
    else
         echo "Warning: 'reasoning_content' field not found in message structure."
    fi

else
    echo "Error: Chat Completion failed"
    EXIT_CODE=1
fi

# 6. Test Streaming Completion
echo "6. Testing POST /v1/chat/completions (With Stream)..."
echo "--- Stream Start ---"
STREAM_RES=$(curl -s -N -X POST http://localhost:4096/v1/chat/completions \
  -H "Authorization: Bearer $PASSWORD" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$TEST_MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Count from 1 to 5. Think first.\"}],
    \"stream\": true
  }")

echo "$STREAM_RES"
echo "--- Stream End ---"

if echo "$STREAM_RES" | grep -q "data: \[DONE\]"; then
    echo "Success: Chat Completion Stream OK"
else
    echo "Error: Chat Completion Stream failed or incomplete"
    EXIT_CODE=1
fi

echo "--- Container Logs (DEBUG) ---"
docker logs "$CONTAINER_NAME"
echo "--- End of Logs ---"

# 7. Test Responses API (No Stream)
echo "7. Testing POST /v1/responses (No Stream)..."
RESPONSES_RES=$(curl -s -X POST http://localhost:4096/v1/responses \
  -H "Authorization: Bearer $PASSWORD" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$TEST_MODEL\",
    \"input\": \"Hello from responses api\"
  }")

echo "Response: $RESPONSES_RES"

if echo "$RESPONSES_RES" | grep -q "\"id\""; then
    echo "Success: Responses API OK"
else
    echo "Error: Responses API failed"
    EXIT_CODE=1
fi

# 8. Test Responses API (With Stream)
echo "8. Testing POST /v1/responses (With Stream)..."
echo "--- Stream Start (Responses) ---"
STREAM_RESP_RES=$(curl -s -N -X POST http://localhost:4096/v1/responses \
  -H "Authorization: Bearer $PASSWORD" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$TEST_MODEL\",
    \"input\": \"Stream a short answer from responses api\",
    \"stream\": true
  }")

echo "$STREAM_RESP_RES"
echo "--- Stream End (Responses) ---"

if echo "$STREAM_RESP_RES" | grep -q "data: \[DONE\]"; then
    echo "Success: Responses API Stream OK"
else
    echo "Error: Responses API Stream failed or incomplete"
    EXIT_CODE=1
fi

# 9. Test Tools Routing (chat/completions)
echo "9. Testing tool calling in /v1/chat/completions..."
TOOLS_CHAT_RES=$(curl -s -w "\n%{http_code}" -X POST http://localhost:4096/v1/chat/completions \
  -H "Authorization: Bearer $PASSWORD" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$TEST_MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"What is the weather?\"}],
    \"tools\": [{\"type\": \"function\", \"function\": {\"name\": \"get_weather\"}}]
  }")
TOOLS_CHAT_CODE=$(echo "$TOOLS_CHAT_RES" | tail -n1)
TOOLS_CHAT_BODY=$(echo "$TOOLS_CHAT_RES" | head -n -1)

# Tool requests now route to the direct model gateway: a 2xx with a valid
# OpenAI payload (tool_calls or a normal completion), or a 502 gateway error
# when no upstream OpenAI-compatible endpoint is reachable.
if [ "$TOOLS_CHAT_CODE" = "200" ] || [ "$TOOLS_CHAT_CODE" = "502" ]; then
    echo "Success: chat/completions routed tools to the model gateway (HTTP $TOOLS_CHAT_CODE)"
else
    echo "Error: Tools routing in chat/completions failed. Response: $TOOLS_CHAT_BODY"
    EXIT_CODE=1
fi

# 10. Test Tools Routing (responses)
echo "10. Testing tool calling in /v1/responses..."
TOOLS_RESP_RES=$(curl -s -w "\n%{http_code}" -X POST http://localhost:4096/v1/responses \
  -H "Authorization: Bearer $PASSWORD" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$TEST_MODEL\",
    \"input\": \"What is the weather?\",
    \"tools\": [{\"type\": \"function\", \"function\": {\"name\": \"get_weather\"}}]
  }")
TOOLS_RESP_CODE=$(echo "$TOOLS_RESP_RES" | tail -n1)
TOOLS_RESP_BODY=$(echo "$TOOLS_RESP_RES" | head -n -1)

if [ "$TOOLS_RESP_CODE" = "200" ] || [ "$TOOLS_RESP_CODE" = "502" ]; then
    echo "Success: Tools routing in responses OK (HTTP $TOOLS_RESP_CODE)"
else
    echo "Error: Tools routing in responses failed. Response: $TOOLS_RESP_BODY"
    EXIT_CODE=1
fi

# 11. Cleanup
echo "11. Cleaning up resources..."
docker stop "$CONTAINER_NAME"
docker rm "$CONTAINER_NAME"
docker rmi "$IMAGE_NAME"

echo "--- Integration Test Completed! ---"
exit $EXIT_CODE
