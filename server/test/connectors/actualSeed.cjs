// Run by tests/services.yml when the actual-api service starts (inside actual-http-api's image, which has Actual's
// Node API): sets Actual's server up with its password and puts an empty budget on it, as the app's "create budget"
// does. Everything else the Actual connector's tests need (accounts, categories, payees, transactions, schedules)
// they write through actual-http-api itself (actualSeed.ts). Tries again while Actual's server starts.
// (From the image's working directory, which has the packages: this file is mounted elsewhere.)
const api = require(`${process.cwd()}/node_modules/@actual-app/api`);

const URL = process.env.ACTUAL_SERVER_URL;
const PASSWORD = process.env.ACTUAL_SERVER_PASSWORD;

async function bootstrap() {
  const response = await fetch(`${URL}/account/bootstrap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
  // 400 "already bootstrapped" is fine: this runs again when the container restarts.
  if (!response.ok && response.status !== 400) throw new Error(`bootstrap: ${response.status} ${await response.text()}`);
}

async function main() {
  await bootstrap();
  require("node:fs").mkdirSync("/tmp/seed", { recursive: true });
  await api.init({ dataDir: "/tmp/seed", serverURL: URL, password: PASSWORD });
  const budgets = await api.getBudgets();
  if (budgets.some((b) => b.name === "Kubus test")) return api.shutdown();
  await api.runImport("Kubus test", async () => {});
  await api.sync();
  await api.shutdown();
  console.log("budget made");
}

(async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await main();
      return;
    } catch (e) {
      // Only while Actual's server is starting (a refused connection), not for anything it answers.
      if (attempt >= 20 || !/fetch failed|ECONN/.test(`${e && e.message} ${e && e.cause}`)) throw e;
      console.error(`seed attempt ${attempt}: ${e && e.message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
