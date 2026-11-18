# Proof Handoff

Two agents finishing a job can disagree about which revision was delivered. Proof Handoff records the sender's SHA-256 file digest and lets the designated recipient acknowledge that digest from their own wallet. A receipt can be shared by ID. The file travels separately through a channel the parties choose.

## Using a receipt

1. Both participants need a BSC Agent ID. The sender chooses a file and the intended recipient's wallet address. The browser hashes the file locally.
2. The sender reviews and confirms a zero-value contract call. The resulting receipt starts **Pending**. At this point only the sender has made an attestation.
3. The recipient opens the receipt and chooses their copy of the file. The interface compares the digest before offering acceptance. The recipient confirms the transaction in their wallet.
4. The sender can cancel while a receipt is pending. Accepted and cancelled receipts are final. Each on-chain write incurs the network gas fee.

The contract reads `balanceOf` on the official non-transferable Agent ID registry at `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F` on chain 56. Both parties must hold an ID at creation, and the recipient must still hold one at acceptance. The sender can cancel even if their ID is subsequently unavailable. [Hackathon announcement and registry](https://www.binance.com/en/support/announcement/detail/95f5dbe0ea674a48a739b59e046648bf)

## Permissions and privacy

The contract has no owner, upgrade mechanism, token approvals, or payable operations. The contract cannot change the registry. Every address can read a receipt. Party addresses, hashes and timestamps are public. People who can guess a file's contents can check their guess against the digest. Use this workflow for artifacts whose public fingerprint and participant association are acceptable. An accepted receipt represents the recipient's signed acknowledgment. The contract cannot independently observe off-chain delivery or establish legal identity.

## Build and test

Use Node.js 22 or 24. Run these commands from this directory.

```sh
npm install --ignore-scripts
npm run build
npm test
npm run preview
```

Open `http://127.0.0.1:8711/`. The frontend reads its BSC deployment address from `web/deployment.json`. An empty address enables local file hashing while chain actions stay unavailable. The frontend can be hosted as static files over HTTPS.

The EVM tests use a local fixture for the identity registry at its canonical address. They exercise eligibility, sender and recipient permissions, matching file revisions, cancellation, and finality.

## Deployment and verification

The build emits `build/standard-input.json` for BscScan's Solidity Standard JSON verification option. Compiler settings are Solidity `0.8.30+commit.73712a01`, optimizer enabled with 200 runs, EVM target Paris, no constructor arguments. Select `contracts/ProofHandoff.sol:ProofHandoff` and MIT.

`node scripts/deployment.cjs` performs a read-only deployment preview on BSC. It checks the canonical CREATE2 factory bytecode, simulates deployment, and reports the predicted address and gas. Its RPC receives the creation bytecode. The script never signs. After a confirmed deployment, compare the full runtime against `build/contract.json`, complete BscScan verification, and set the confirmed contract address in `web/deployment.json`. [Factory specification](https://github.com/Arachnid/deterministic-deployment-proxy)
