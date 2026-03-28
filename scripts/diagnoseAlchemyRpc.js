/**
 * Diagnose Sepolia RPC (Alchemy or any JSON-RPC URL).
 *
 * Usage (from repo root):
 *   node scripts/diagnoseAlchemyRpc.js "https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY"
 *
 * Or set ALCHEMY_TEST_URL in .env and:
 *   node scripts/diagnoseAlchemyRpc.js
 *
 * Interpreting results:
 *   HTTP 200 + result        → URL/key OK from Node (no browser Origin). If browser still fails → Alchemy allowlist / localhost.
 *   HTTP 401 / 403           → Invalid key, wrong network app, or auth policy.
 *   HTTP 400                 → Bad URL, body rejected, or Alchemy-specific policy (often allowlist when Origin sent).
 *   JSON-RPC error -32000    → Usually NOT nonce/gas; those show on eth_sendRawTransaction, not eth_blockNumber.
 *
 * Nonce / gas errors almost never appear as HTTP 400 on simple read calls; they appear when sending txs (MetaMask / wallet).
 */

require("dotenv").config({ path: require("path").join(__dirname, "../frontend/.env.local") });
require("dotenv").config({ path: require("path").join(__dirname, "../frontend/.env") });
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const https = require("https");
const { URL } = require("url");

const urlArg = process.argv[2];
const rpcUrl =
  urlArg ||
  process.env.ALCHEMY_TEST_URL ||
  process.env.NEXT_PUBLIC_SEPOLIA_RPC ||
  (process.env.NEXT_PUBLIC_ALCHEMY_KEY
    ? `https://eth-sepolia.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY}`
    : null);

if (!rpcUrl) {
  console.error(
    "Pass RPC URL as first argument or set NEXT_PUBLIC_SEPOLIA_RPC / NEXT_PUBLIC_ALCHEMY_KEY / ALCHEMY_TEST_URL",
  );
  process.exit(1);
}

function postJson(urlString, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const data = JSON.stringify(body);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...extraHeaders,
      },
    };
    const req = https.request(opts, (res) => {
      let chunks = "";
      res.on("data", (c) => (chunks += c));
      res.on("end", () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: chunks });
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const u = new URL(rpcUrl);
  console.log("RPC host:", u.host);
  console.log("");

  const payload = { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] };

  console.log("--- A) Node request (no Origin header) — like server / curl ---");
  let a;
  try {
    a = await postJson(rpcUrl, payload);
  } catch (e) {
    console.error("Request failed:", e.message);
    process.exit(1);
  }
  console.log("HTTP status:", a.statusCode);
  try {
    const j = JSON.parse(a.body);
    if (j.error) {
      console.log("JSON-RPC error:", j.error);
    } else {
      console.log("JSON-RPC OK, eth_blockNumber:", j.result);
    }
  } catch {
    console.log("Body (first 500 chars):", a.body.slice(0, 500));
  }

  console.log("");
  console.log("--- B) Simulated browser request (Origin: http://localhost:3000) ---");
  let b;
  try {
    b = await postJson(rpcUrl, payload, { Origin: "http://localhost:3000" });
  } catch (e) {
    console.error("Request failed:", e.message);
    process.exit(1);
  }
  console.log("HTTP status:", b.statusCode);
  try {
    const j = JSON.parse(b.body);
    if (j.error) {
      console.log("JSON-RPC error:", j.error);
    } else {
      console.log("JSON-RPC OK, eth_blockNumber:", j.result);
    }
  } catch {
    console.log("Body (first 500 chars):", b.body.slice(0, 500));
  }

  console.log("");
  console.log("--- Summary ---");
  let aOk = false;
  let bOk = false;
  try {
    const ja = JSON.parse(a.body);
    aOk = a.statusCode === 200 && !!ja.result && !ja.error;
  } catch {
    aOk = false;
  }
  try {
    const jb = JSON.parse(b.body);
    bOk = b.statusCode === 200 && !!jb.result && !jb.error;
  } catch {
    bOk = false;
  }

  if (aOk && !bOk) {
    console.log(
      "Node works but browser-like request fails → Alchemy Allow list: add http://localhost:3000 (NOT nonce/gas).",
    );
  } else if (aOk && bOk) {
    console.log("Both OK here → if browser still fails, hard-refresh, clear cache, confirm same URL in .env.");
  } else if (a.statusCode === 400 || a.statusCode === 403) {
    console.log("Fails from Node too → wrong/revoked key, wrong endpoint, or Alchemy app misconfigured (NOT nonce/gas).");
  } else {
    console.log("See HTTP status and bodies above. Nonce/gas errors appear when *sending* txs, not on eth_blockNumber reads.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
