# The test environment's variables (source it): what tests/setup-env.sh started.
export KUBUS_TEST_POSTGRES=${KUBUS_TEST_POSTGRES:-postgres://postgres:postgres@localhost:5432/postgres}
export KUBUS_TEST_MYSQL=${KUBUS_TEST_MYSQL:-mysql://root:mysql@127.0.0.1:3306}
export KUBUS_TEST_MARIADB=${KUBUS_TEST_MARIADB:-mysql://root:mariadb@127.0.0.1:3307}
# The connectors' real services (tests/setup-env.sh --connectors; services.yml profile `connectors`) are optional:
# each variable is set only while its service answers, so a test file without it is skipped.
if curl -fs -m 1 http://localhost:8086/health >/dev/null 2>&1; then
  export KUBUS_TEST_INFLUX=${KUBUS_TEST_INFLUX:-http://localhost:8086}
fi
export IBM_TELEMETRY_DISABLED=true
# Without Chrome (a cloud session has Playwright's Chromium only): playwright-cli uses that.
if ! command -v google-chrome >/dev/null && [ -x /opt/pw-browsers/chromium ]; then
  export PLAYWRIGHT_MCP_CONFIG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/playwright-chromium.json"
fi
