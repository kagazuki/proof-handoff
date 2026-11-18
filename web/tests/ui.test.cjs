const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

// Run against the local static preview. Browser fixtures intercept every chain request in memory.
const base = "http://127.0.0.1:8711/";
const executable = process.env.HANDOFF_BROWSER || "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";

function installFixtures() {
  const nativeFetch = window.fetch.bind(window);
  const mock = window.fixture = {
    sender: "0x" + "1".repeat(40), recipient: "0x" + "2".repeat(40), contract: "0x" + "3".repeat(40),
    hash: "0x" + "4".repeat(64), block: "0x" + "5".repeat(64),
    digest: "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    state: 1, chain: "0x38", confirmed: null, writes: [], methods: [], rpc: []
  };
  mock.account = mock.sender;
  window.ethereum = {
    request: async ({ method, params }) => {
      mock.methods.push(method);
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [mock.account];
      if (method === "eth_chainId") return mock.chain;
      if (method === "eth_sendTransaction") { mock.writes.push(params[0]); return mock.hash; }
      throw new Error("Unexpected wallet method " + method);
    }
  };
  window.fetch = async (input, init) => {
    const url = new URL(input.url || input, location.href);
    if (url.origin === location.origin && url.pathname === "/deployment.json")
      return Response.json({ chainId: 56, address: mock.contract });
    if (url.origin === location.origin) return nativeFetch(input, init);
    if (url.hostname !== "bsc-dataseed.bnbchain.org") throw new Error("Unexpected host");
    const { id, method, params } = await new Request(input, init).json();
    mock.rpc.push(method);
    const iface = new ethers.Interface([
      "function get(uint256) view returns (address,address,bytes32,uint64,uint64,uint8)",
      "event Created(uint256 indexed id,address indexed sender,address indexed recipient,bytes32 digest)",
      "error UnknownReceipt()"
    ]);
    let result;
    if (method === "eth_chainId") result = "0x38";
    else if (method === "eth_getCode") result = "0x01";
    else if (method === "eth_call") {
      const data = params[0].data;
      if (data.startsWith(iface.getFunction("get").selector)) {
        if (iface.decodeFunctionData("get", data)[0] !== 7n) return Response.json({ id, jsonrpc: "2.0",
          error: { code: 3, message: "execution reverted", data: iface.encodeErrorResult("UnknownReceipt") } });
        result = iface.encodeFunctionResult("get", [mock.sender, mock.recipient, mock.digest, 100, mock.state === 1 ? 0 : 200, mock.state]);
      } else result = "0x";
    } else if (method === "eth_getTransactionReceipt") {
      result = null;
      if (mock.confirmed !== null) {
        const event = iface.encodeEventLog("Created", [7n, mock.sender, mock.recipient, mock.digest]);
        result = { transactionHash: mock.hash, blockHash: mock.block, blockNumber: "0x10", transactionIndex: "0x0",
          from: mock.account, to: mock.contract, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1",
          logsBloom: "0x" + "0".repeat(512), status: mock.confirmed, type: "0x0", contractAddress: null,
          logs: [{ ...event, address: mock.contract, transactionHash: mock.hash, blockHash: mock.block,
            blockNumber: "0x10", transactionIndex: "0x0", logIndex: "0x0", removed: false }] };
      }
    } else throw new Error("Unexpected RPC method " + method);
    return Response.json({ id, jsonrpc: "2.0", result });
  };
}

async function waitFor(read, label) {
  for (let i = 0; i < 120; i++) {
    const result = await read();
    if (result) return result;
    await delay(100);
  }
  throw new Error("Timed out waiting for " + label);
}

test("Proof Handoff in a local browser", { timeout: 110000 }, async t => {
  const response = await fetch(base);
  assert.equal(response.status, 200, "Start the localhost static preview first");
  const profile = await fs.mkdtemp(path.join(__dirname, "browser-"));
  const child = spawn(executable, [
    "--headless", "--disable-gpu", "--disable-background-networking", "--disable-extensions",
    "--no-first-run", "--disable-sync", "--no-default-browser-check", "--no-proxy-server",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost", "--remote-debugging-port=0",
    "--user-data-dir=" + profile, "about:blank"
  ], { windowsHide: true, stdio: "ignore" });
  let launchError;
  child.on("error", error => { launchError = error; });
  let socket, command;
  t.after(async () => {
    if (command && socket.readyState === 1) command("Browser.close").catch(() => {});
    for (let i = 0; child.exitCode === null && !launchError && i < 30; i++) await delay(100);
    socket?.close();
    if (child.exitCode === null && !launchError) child.kill();
    if (path.dirname(path.resolve(profile)) === __dirname && path.basename(profile).startsWith("browser-"))
      await fs.rm(profile, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  });
  const port = await waitFor(async () => {
    if (launchError) throw launchError;
    if (child.exitCode) throw new Error("Browser exited with " + child.exitCode);
    try { return (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\s/)[0]; }
    catch { return false; }
  }, "headless browser");
  const targets = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let seq = 0;
  const pending = new Map(), exceptions = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.exception?.description);
    const ticket = pending.get(message.id);
    if (!ticket) return;
    pending.delete(message.id);
    if (message.error) ticket.reject(new Error(message.error.message));
    else ticket.resolve(message.result);
  };
  command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await command("Runtime.enable");
  await command("Page.enable");
  const run = async expression => {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async expression => {
    try { return await waitFor(() => run(expression), expression); }
    catch (error) {
      const status = await run("Array.from(document.querySelectorAll('title,#deployment-title,#deployment-state,#wallet-state,#lookup-state,#tx-state'), n => n.textContent)");
      throw new Error(error.message + " | " + [...status, ...exceptions].join(" | "));
    }
  };
  const file = content => run("setFile(" + JSON.stringify(content) + ")");
  const helpers = function () {
    window.ui = id => document.getElementById(id);
    window.fill = (id, value) => { ui(id).value = value; ui(id).dispatchEvent(new Event("input")); };
    window.setFile = text => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([text], "local.txt"));
      ui("file").files = transfer.files;
      ui("file").dispatchEvent(new Event("change"));
    };
  };
  await command("Page.addScriptToEvaluateOnNewDocument", { source: "(" + helpers + ")()" });
  const click = id => run("ui(" + JSON.stringify(id) + ").click()");

  await t.test("null deployment, SHA-256 comparison and responsive layout", async () => {
    await command("Page.navigate", { url: base });
    await until("window.ui && ui('deployment-title')?.textContent === 'Local checks only'");
    assert.equal(await run("performance.getEntriesByType('resource').every(r => new URL(r.name).origin === location.origin)"), true);
    await file("abc");
    await until("ui('digest').textContent.startsWith('0xba7816bf')");
    await run("fill('expected',ui('digest').textContent.slice(2).toUpperCase())");
    assert.match(await run("ui('compare-state').textContent"), /^Match\./);
    await file("different");
    await until("ui('compare-state').textContent.startsWith('Mismatch.')");
    assert.equal(await run("ui('create').disabled && ui('lookup').disabled && ui('record').hidden"), true);
    for (const width of [320, 768, 1280]) {
      await command("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
      assert.equal(await run("document.documentElement.scrollWidth <= innerWidth"), true, "overflow at " + width);
    }
  });
  await command("Page.addScriptToEvaluateOnNewDocument", { source: "(" + installFixtures + ")()" });
  await command("Page.navigate", { url: base });
  await until("window.ui && ui('deployment-title')?.textContent === 'BSC contract'");

  await t.test("create reviews exact BAW fields and confirms only from a mined event", async () => {
    await file("abc");
    await until("ui('digest').textContent === fixture.digest");
    await run("fill('recipient',fixture.recipient)");
    await click("create");
    assert.equal(await run("ui('review').open && fixture.methods.length === 0"), true);
    const fields = await run("Array.from(ui('baw-fields').querySelectorAll('code'), x => x.textContent)");
    const { Interface } = require("../vendor/ethers.umd.min.js");
    const i = new Interface(["function create(address,bytes32)"]);
    assert.equal(fields[1], "0");
    assert.deepEqual([...i.decodeFunctionData("create", fields[2])], [await run("fixture.recipient"), await run("fixture.digest")]);
    await run("fixture.chain='0x1'");
    await click("wallet-action");
    await until("ui('wallet-state').textContent.includes('Switch your wallet')");
    await run("fixture.chain='0x38'");
    await click("wallet-action");
    await until("ui('wallet-action').textContent === 'Confirm in browser wallet'");
    assert.equal(await run("fixture.writes.length"), 0);
    await click("wallet-action");
    await until("ui('tx-state').textContent.includes('not returned a mined receipt')");
    assert.deepEqual(await run("fixture.writes[0]"), {
      from: await run("fixture.sender"), to: fields[0], value: "0x0", data: fields[2], chainId: "0x38"
    });
    await run("fixture.confirmed='0x1'");
    await click("check-tx");
    await until("ui('tx-state').textContent.includes('Share receipt ID 7')");
  });
  await t.test("lookup, changed file, stale record, signer change, and reverted acceptance", async () => {
    await run("fixture.methods.length=0; fixture.confirmed=null");
    await click("find-mode");
    await run("fill('receipt-id','99')");
    await click("lookup");
    await until("ui('lookup-state').textContent.includes('No receipt exists')");
    await run("fill('receipt-id','7')");
    await click("lookup");
    await until("ui('record-state').textContent === 'Pending' && !ui('record').hidden");
    assert.equal(await run("fixture.methods.length"), 0);
    await file("wrong");
    await until("ui('match').textContent.startsWith('Mismatch.')");
    assert.equal(await run("ui('accept').disabled"), true);
    await file("abc");
    await until("!ui('accept').disabled");
    await click("accept");
    await click("wallet-action");
    await until("ui('wallet-state').textContent.includes('required signing account')");
    await run("fixture.account=fixture.recipient");
    await click("wallet-action");
    await until("ui('wallet-action').textContent === 'Confirm in browser wallet'");
    await run("fixture.state=2");
    await click("wallet-action");
    await until("ui('wallet-state').textContent.includes('must be pending')");
    await run("fixture.state=1; fixture.account=fixture.sender");
    await click("wallet-action");
    await until("ui('wallet-action').textContent === 'Reconnect browser wallet'");
    assert.equal(await run("fixture.writes.length"), 1);
    await run("fixture.account=fixture.recipient");
    await click("wallet-action");
    await until("ui('wallet-action').textContent === 'Confirm in browser wallet'");
    await click("wallet-action");
    await until("fixture.writes.length===2 && !ui('review').open && !ui('check-tx').disabled");
    await run("fixture.confirmed='0x0'");
    await click("check-tx");
    await until("ui('tx-state').textContent.startsWith('Transaction reverted')");
  });
  await t.test("sender cancellation, accepted and cancelled records", async () => {
    await until("!ui('cancel').disabled");
    await click("cancel");
    await click("wallet-action");
    await until("ui('wallet-state').textContent.includes('required signing account')");
    await run("fixture.account=fixture.sender; fixture.confirmed='0x1'");
    await click("wallet-action");
    await until("ui('wallet-action').textContent === 'Confirm in browser wallet'");
    await click("wallet-action");
    await until("ui('tx-state').textContent.includes('Receipt #7 cancelled')");
    for (const [number, expected] of [[2, "Accepted"], [3, "Cancelled"]]) {
      await until("!ui('lookup').disabled");
      await run("fixture.state=" + number);
      await click("lookup");
      await until("ui('record-state').textContent === '" + expected + "' && !ui('record').hidden");
      assert.equal(await run("ui('record-actions').hidden"), true);
    }
    assert.deepEqual(exceptions, []);
  });
});
