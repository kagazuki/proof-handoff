import {
  ABI, RPC_URL, stateNames, receiptId, normalizeDigest, hashFile, recipientAddress,
  prepareIntent, signingError, createdReceiptId
} from "./ledger.mjs";

const el = id => document.getElementById(id);
const say = (id, value) => { el(id).textContent = value; };
const show = (id, visible) => { el(id).hidden = !visible; };
const descriptions = {
  create: "Open a pending receipt. This records the sender’s claim only.",
  accept: "Attest as the recipient that you checked the file against this receipt.",
  cancel: "Close this pending receipt as its sender. It can no longer be accepted."
};
let ethers, iface, reader, contract, address;
let digest = null, fileVersion = 0, lookupVersion = 0, loadingReceipt = false;
let record = null, mode = "new", session = null, submitting = false, transaction = null;

function details(node, fields) {
  node.replaceChildren(...fields.map(([label, value]) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const definition = document.createElement("dd");
    term.textContent = label;
    definition.textContent = value;
    row.append(term, definition);
    return row;
  }));
}

function deployment(title, message, retry = false) {
  say("deployment-title", title);
  say("deployment-state", message);
  show("retry", retry);
  update();
}

async function start() {
  deployment("Checking deployment…", "Reading the BSC contract configuration.");
  let provider;
  try {
    const response = await fetch("./deployment.json", { cache: "no-store", credentials: "omit" });
    if (!response.ok) throw new Error("Could not load deployment.json.");
    const config = await response.json();
    if (config?.chainId !== 56) throw new Error("The configuration must specify BSC chain 56.");
    if (config.address === null) {
      deployment("Local checks only", "No contract address is configured. You can hash a file and compare digests here.");
      return;
    }
    if (!window.ethers) await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "./vendor/ethers.umd.min.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Could not load the bundled ethers library."));
      document.head.append(script);
    });
    ethers = window.ethers;
    if (!ethers?.version.startsWith("6.")) throw new Error("The bundled ethers v6 library is required.");
    const target = typeof config.address === "string" && recipientAddress(ethers, config.address);
    if (!target) throw new Error("The configured contract address is invalid.");
    const endpoint = new ethers.FetchRequest(RPC_URL);
    endpoint.timeout = 12000;
    provider = new ethers.JsonRpcProvider(endpoint, 56, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
    if (BigInt(await provider.send("eth_chainId", [])) !== 56n) throw new Error("The read endpoint is on the wrong chain.");
    if (await provider.getCode(target) === "0x") throw new Error("No contract code was found at the configured address.");
    iface = new ethers.Interface(ABI);
    contract = new ethers.Contract(target, iface, provider);
    reader = provider;
    address = target;
    deployment("BSC contract", target);
  } catch (error) {
    provider?.destroy();
    const message = error instanceof SyntaxError ? "The deployment configuration is unreadable." :
      error.code || error instanceof TypeError ? "Could not reach the configuration or BSC endpoint." : error.message;
    deployment("Receipt desk unavailable", message + " Local file checks are available.", true);
  }
}

function update() {
  const raw = el("recipient").value.trim();
  const recipient = ethers && recipientAddress(ethers, raw);
  const locked = submitting || Boolean(transaction && !transaction.done);
  el("create").disabled = !address || !recipient || !digest || locked;
  el("lookup").disabled = !address || loadingReceipt || receiptId(el("receipt-id").value) === null;
  el("accept").disabled = !address || record?.state !== 1 || digest !== record.digest || locked;
  el("cancel").disabled = !address || record?.state !== 1 || locked;
  say("create-hint", raw && ethers && !recipient ? "Enter a nonzero EVM address with a valid checksum or all lowercase letters." :
    "Both parties need an Agent ID to open a handoff.");
  show("copy-digest", Boolean(digest));
  say("digest", digest || "Choose a file to calculate its digest.");
  const expected = el("expected").value;
  say("compare-state", !expected.trim() ? "Paste a digest to compare it locally." :
    !normalizeDigest(expected) ? "Enter 64 hexadecimal characters, optionally prefixed with 0x." :
    !digest ? "Choose a file to compare." : normalizeDigest(expected) === digest ?
      "Match. The file has the expected digest." : "Mismatch. The file has a different digest.");
  if (record) {
    say("match", !digest ? "Choose the file in File check to verify its contents." :
      digest === record.digest ? "Exact match. The selected file has the recorded digest." :
        "Mismatch. The selected file differs from the recorded digest.");
  }
}

async function selectFile(file) {
  const version = ++fileVersion;
  digest = null;
  update();
  if (!file) { say("file-state", "No file selected."); return; }
  say("file-state", "Calculating the digest of " + file.name + "…");
  try {
    if (!globalThis.crypto?.subtle) throw new Error("Open this page over HTTPS or localhost to hash a file.");
    const result = await hashFile(file);
    if (version !== fileVersion) return;
    digest = result;
    say("file-state", file.name + " · " + file.size.toLocaleString() + " bytes");
  } catch (error) {
    if (version !== fileVersion) return;
    say("file-state", globalThis.crypto?.subtle ? "Could not read this file. Choose it again or try a smaller file." : error.message);
  }
  update();
}

function clearRecord() {
  ++lookupVersion;
  loadingReceipt = false;
  record = null;
  show("record", false);
  const raw = el("receipt-id").value;
  say("lookup-state", raw.trim() && receiptId(raw) === null ? "Enter a positive whole receipt number." : "Enter the ID shared by the sender.");
  update();
}

async function readReceipt(id) {
  const result = await contract.get(id);
  const state = Number(result.state);
  if (!stateNames[state]) throw new Error("Unrecognized receipt state.");
  return { id, state, sender: result.sender, recipient: result.recipient, digest: result.digest,
    openedAt: result.openedAt, closedAt: result.closedAt };
}

async function lookup() {
  clearRecord();
  const id = receiptId(el("receipt-id").value);
  if (!address || id === null) return;
  const version = lookupVersion;
  loadingReceipt = true;
  update();
  say("lookup-state", "Reading receipt " + id + " from BSC…");
  try {
    const found = await readReceipt(id);
    if (version !== lookupVersion) return;
    record = found;
    const date = timestamp => new Date(Number(timestamp) * 1000).toLocaleString();
    const fields = [["Sender", found.sender], ["Recipient", found.recipient], ["SHA-256", found.digest],
      ["Opened", date(found.openedAt)]];
    if (found.closedAt) fields.push(["Closed", date(found.closedAt)]);
    say("record-title", "Receipt #" + id);
    say("record-state", stateNames[found.state]);
    say("lookup-state", { 1: "Pending. Only the sender has made a claim.", 2: "Accepted. The recipient attested to this digest.",
      3: "Cancelled. The sender closed this receipt." }[found.state]);
    details(el("record-details"), fields);
    show("record", true);
    show("record-actions", found.state === 1);
  } catch (error) {
    if (version !== lookupVersion) return;
    say("lookup-state", error.revert?.name === "UnknownReceipt" || error.data === iface.getError("UnknownReceipt").selector ?
      "No receipt exists with this ID." : error.code === "CALL_EXCEPTION" ?
        "The contract could not return this receipt. Check its ID and try again." : "Could not read the receipt from BSC. Try again.");
  } finally {
    if (version === lookupVersion) { loadingReceipt = false; update(); }
  }
}

function setMode(next) {
  if (mode === next) return;
  mode = next;
  clearRecord();
  for (const key of ["new", "find"]) {
    el(key + "-mode").setAttribute("aria-pressed", String(key === next));
    show(key + "-pane", key === next);
  }
}

async function copyText(text, statusId) {
  try {
    await navigator.clipboard.writeText(text);
    say(statusId, "Copied to clipboard.");
  } catch { say(statusId, "Select the displayed value and copy it manually."); }
}

function copyFields(intent) {
  el("baw-fields").replaceChildren(...[["contract address", intent.contract], ["value", "0"], ["calldata", intent.data]].map(([label, value]) => {
    const row = document.createElement("div");
    row.className = "copy-field";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "link";
    button.textContent = "Copy " + label;
    button.onclick = () => copyText(value, "baw-status");
    const code = document.createElement("code");
    code.textContent = value;
    row.append(button, code);
    return row;
  }));
}

function walletChanged() {
  if (!session) return;
  session.account = null;
  ++session.walletVersion;
  say("wallet-state", "Wallet account or network changed. Check BSC (56) and reconnect.");
  say("wallet-action", "Reconnect browser wallet");
}

function review(action) {
  if (session || submitting || !address || (transaction && !transaction.done)) return;
  const intent = prepareIntent(iface, address, action, recipientAddress(ethers, el("recipient").value), digest, record);
  const wallet = window.ethereum?.request ? window.ethereum : null;
  session = { intent, wallet, account: null, walletVersion: 0 };
  const fields = [["Network", "BNB Smart Chain (56)"], ["Contract (to)", address], ["Method", action]];
  if (intent.id !== null) fields.push(["Receipt ID", intent.id.toString()]);
  fields.push(["Signing account", intent.signer || "Sender’s wallet"], ["Recipient", intent.recipient], ["File digest", intent.digest],
    ["Value", "0 BNB (network gas applies)"], ["Calldata", intent.data]);
  details(el("review-details"), fields);
  say("review-title", { create: "Open handoff", accept: "Accept receipt", cancel: "Cancel receipt" }[action]);
  say("review-description", descriptions[action]);
  copyFields(intent);
  el("baw").open = !wallet;
  say("baw-status", "");
  say("wallet-state", wallet ? "Connect your signing account to continue." : "No browser wallet detected. You can confirm independently in BAW.");
  say("wallet-action", "Connect browser wallet");
  show("wallet-action", Boolean(wallet));
  el("wallet-action").disabled = false;
  wallet?.on?.("accountsChanged", walletChanged);
  wallet?.on?.("chainChanged", walletChanged);
  wallet?.on?.("disconnect", walletChanged);
  el("review").showModal();
}

function closeReview() {
  const wallet = session?.wallet;
  for (const event of ["accountsChanged", "chainChanged", "disconnect"]) wallet?.removeListener?.(event, walletChanged);
  session = null;
  if (el("review").open) el("review").close();
}

function walletMessage(error) {
  if (error.code === 4001 || error.code === "ACTION_REJECTED") return "Wallet request declined.";
  if (error.code === "CALL_EXCEPTION") {
    let reason;
    try { reason = iface.parseError(error.data)?.name; } catch {}
    if (reason === "AgentIdRequired") return "The contract requires an Agent ID for the signing parties.";
    return "The contract rejected this action. Check the parties and reload the receipt.";
  }
  return typeof error.code === "undefined" && error instanceof Error ? error.message : "Wallet or network request failed. Check your wallet before retrying.";
}

async function walletAction() {
  const current = session;
  if (!current?.wallet || submitting) return;
  const { intent, wallet, account } = current;
  const version = current.walletVersion;
  const request = (method, params = []) => wallet.request({ method, params });
  const stillCurrent = () => session === current && current.walletVersion === version;
  el("wallet-action").disabled = true;
  try {
    if (!account) {
      await request("eth_requestAccounts");
      if (session !== current) return;
      // Connecting may itself emit accountsChanged. Read the current account after consent.
      const connectedVersion = current.walletVersion;
      const chain = await request("eth_chainId");
      const accounts = await request("eth_accounts");
      if (session !== current || current.walletVersion !== connectedVersion) return;
      if (BigInt(chain) !== 56n) throw new Error("Switch your wallet to BNB Smart Chain (56), then reconnect.");
      const selected = recipientAddress(ethers, accounts[0] || "");
      if (!selected) throw new Error("Select a signing account in your wallet.");
      const error = signingError(intent, selected);
      if (error) throw new Error(error);
      current.account = selected;
      say("wallet-state", "Signing account: " + selected + ". Review the details and confirm in your wallet.");
      say("wallet-action", "Confirm in browser wallet");
      return;
    }
    submitting = true;
    update();
    say("wallet-state", "Checking the current record and simulating the transaction…");
    if (intent.id !== null) {
      const fresh = await readReceipt(intent.id);
      const checked = prepareIntent(iface, address, intent.action, null, digest, fresh);
      if (checked.data !== intent.data || checked.signer !== intent.signer || checked.digest !== intent.digest ||
          checked.recipient !== intent.recipient) throw new Error("Receipt changed. Close this review and reload it.");
    } else if (intent.digest !== digest) throw new Error("The selected file changed. Review the handoff again.");
    const tx = { from: account, to: intent.contract, value: "0x0", data: intent.data, chainId: "0x38" };
    if (await reader.getCode(intent.contract) === "0x") throw new Error("Contract code is unavailable. Reload before continuing.");
    await reader.call(tx);
    const accounts = await request("eth_accounts");
    const chain = await request("eth_chainId");
    if (!stillCurrent()) return;
    if (BigInt(chain) !== 56n || recipientAddress(ethers, accounts[0] || "") !== account) {
      walletChanged();
      return;
    }
    say("wallet-state", "Review and confirm the zero-value transaction in your wallet.");
    const hash = await request("eth_sendTransaction", [tx]);
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Wallet returned no valid transaction hash. Check wallet history before retrying.");
    closeReview();
    transaction = { hash, intent, account, done: false };
    show("transaction", true);
    show("check-tx", true);
    el("tx-link").href = "https://bscscan.com/tx/" + hash;
    say("tx-link", "View " + hash + " on BscScan");
    say("tx-state", "Submitted. Waiting for the BSC transaction receipt.");
    el("transaction").scrollIntoView({ block: "nearest" });
    await checkConfirmation();
  } catch (error) {
    if (session === current) say("wallet-state", walletMessage(error));
  } finally {
    submitting = false;
    if (session === current) el("wallet-action").disabled = false;
    update();
  }
}

async function checkConfirmation() {
  const tx = transaction;
  if (!tx || tx.done || tx.checking) return;
  tx.checking = true;
  el("check-tx").disabled = true;
  try {
    const mined = await reader.getTransactionReceipt(tx.hash);
    if (!mined) {
      say("tx-state", "Submitted. BSC has not returned a mined receipt yet.");
      return;
    }
    if (mined.status !== 0 && mined.status !== 1) throw new Error("Unknown status");
    let message = "Transaction reverted in block " + mined.blockNumber + ".";
    if (mined.status === 1) {
      message = "Confirmed in block " + mined.blockNumber + ". ";
      if (tx.intent.action === "create") {
        const id = createdReceiptId(iface, mined.logs, tx.intent, tx.account);
        message += id === null ? "Receipt ID unavailable. Check the transaction logs." : "Share receipt ID " + id + " with the recipient.";
      } else message += "Receipt #" + tx.intent.id + (tx.intent.action === "accept" ? " accepted." : " cancelled.");
    }
    tx.done = true;
    say("tx-state", message);
    show("check-tx", false);
    if (mode === "find" && receiptId(el("receipt-id").value) === tx.intent.id) await lookup();
  } catch {
    say("tx-state", "Confirmation unavailable. Check again or open the transaction on BscScan.");
  } finally {
    tx.checking = false;
    el("check-tx").disabled = false;
    update();
  }
}

el("new-mode").onclick = () => setMode("new");
el("find-mode").onclick = () => setMode("find");
el("receipt-id").oninput = clearRecord;
el("recipient").oninput = el("expected").oninput = update;
el("find-pane").onsubmit = event => { event.preventDefault(); lookup(); };
el("file").onchange = event => selectFile(event.target.files[0]);
const drop = el("drop-zone");
drop.ondragover = event => { event.preventDefault(); drop.classList.add("drag"); };
drop.ondragleave = () => drop.classList.remove("drag");
drop.ondrop = event => {
  event.preventDefault();
  drop.classList.remove("drag");
  el("file").value = "";
  selectFile(event.dataTransfer.files[0]);
};
for (const action of ["create", "accept", "cancel"]) el(action).onclick = () => review(action);
el("copy-digest").onclick = () => copyText(digest, "digest-copy-state");
el("wallet-action").onclick = walletAction;
el("review").addEventListener("cancel", event => { event.preventDefault(); closeReview(); });
el("close-review").onclick = closeReview;
el("retry").onclick = start;
el("check-tx").onclick = checkConfirmation;
start();
