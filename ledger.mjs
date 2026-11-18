export const RPC_URL = "https://bsc-dataseed.bnbchain.org";
export const ABI = [
  "function create(address recipient, bytes32 digest) returns (uint256 id)",
  "function accept(uint256 id, bytes32 digest)",
  "function cancel(uint256 id)",
  "function get(uint256 id) view returns (address sender, address recipient, bytes32 digest, uint64 openedAt, uint64 closedAt, uint8 state)",
  "event Created(uint256 indexed id, address indexed sender, address indexed recipient, bytes32 digest)",
  "error UnknownReceipt()", "error NotPending()", "error WrongParty()",
  "error DigestMismatch()", "error InvalidParties()", "error AgentIdRequired(address account)"
];
export const stateNames = { 1: "Pending", 2: "Accepted", 3: "Cancelled" };

export function receiptId(input) {
  const value = input.trim();
  if (!/^\d{1,78}$/.test(value)) return null;
  const id = BigInt(value);
  return id > 0n && id < 2n ** 256n ? id : null;
}

export function normalizeDigest(input) {
  const hex = input.trim().replace(/^0x/i, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? "0x" + hex : null;
}

export async function hashFile(file) {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return "0x" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function recipientAddress(ethers, value) {
  const input = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(input) || !ethers.isAddress(input)) return null;
  const address = ethers.getAddress(input);
  return address === ethers.ZeroAddress ? null : address;
}

export function prepareIntent(iface, contract, action, recipient, fileDigest, record) {
  let args, signer = null, id = null;
  if (action === "create") {
    if (!recipient || !fileDigest) throw new Error("Choose a file and enter a valid recipient address.");
    args = [recipient, fileDigest];
  } else {
    if (!record || record.state !== 1) throw new Error("This receipt must be pending.");
    id = record.id;
    if (action === "accept") {
      if (!fileDigest || fileDigest !== record.digest) throw new Error("Choose the exact file named by this receipt’s digest.");
      signer = record.recipient;
      args = [id, fileDigest];
    } else if (action === "cancel") {
      signer = record.sender;
      args = [id];
    } else throw new Error("Unknown receipt action.");
  }
  return Object.freeze({
    action, contract, id, signer, recipient: action === "create" ? recipient : record.recipient,
    digest: action === "create" ? fileDigest : record.digest,
    data: iface.encodeFunctionData(action, args)
  });
}

export function signingError(intent, account) {
  if (intent.signer && intent.signer !== account) return "Select the required signing account shown above.";
  if (intent.action === "create" && intent.recipient === account) return "Choose a recipient different from the sender.";
  return "";
}

export function createdReceiptId(iface, logs, intent, sender) {
  for (const log of logs) {
    if (log.address.toLowerCase() !== intent.contract.toLowerCase()) continue;
    const event = iface.parseLog(log);
    if (event?.name === "Created" && event.args.sender === sender &&
        event.args.recipient === intent.recipient && event.args.digest === intent.digest) return event.args.id;
  }
  return null;
}
