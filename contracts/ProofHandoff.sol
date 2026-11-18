// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IAgentId {
    function balanceOf(address holder) external view returns (uint256);
}

/// A receipt records both parties' attestations to one file digest.
contract ProofHandoff {
    IAgentId public constant agentId = IAgentId(0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F);

    enum State { Missing, Pending, Accepted, Cancelled }
    struct Receipt {
        address sender;
        uint64 openedAt;
        State state;
        address recipient;
        uint64 closedAt;
        bytes32 digest;
    }

    uint256 public count;
    mapping(uint256 => Receipt) private receipts;

    error InvalidParties();
    error EmptyDigest();
    error AgentIdRequired(address account);
    error UnknownReceipt();
    error NotPending();
    error WrongParty();
    error DigestMismatch();

    event Created(uint256 indexed id, address indexed sender, address indexed recipient, bytes32 digest);
    event Accepted(uint256 indexed id);
    event Cancelled(uint256 indexed id);

    function create(address recipient, bytes32 digest) external returns (uint256 id) {
        if (recipient == address(0) || recipient == msg.sender) revert InvalidParties();
        if (digest == bytes32(0)) revert EmptyDigest();
        requireId(msg.sender);
        requireId(recipient);
        id = ++count;
        receipts[id] = Receipt(msg.sender, uint64(block.timestamp), State.Pending, recipient, 0, digest);
        emit Created(id, msg.sender, recipient, digest);
    }

    function accept(uint256 id, bytes32 digest) external {
        Receipt storage r = pending(id);
        if (msg.sender != r.recipient) revert WrongParty();
        if (digest != r.digest) revert DigestMismatch();
        requireId(msg.sender);
        r.state = State.Accepted;
        r.closedAt = uint64(block.timestamp);
        emit Accepted(id);
    }

    function cancel(uint256 id) external {
        Receipt storage r = pending(id);
        if (msg.sender != r.sender) revert WrongParty();
        r.state = State.Cancelled;
        r.closedAt = uint64(block.timestamp);
        emit Cancelled(id);
    }

    function get(uint256 id) external view returns (
        address sender, address recipient, bytes32 digest, uint64 openedAt, uint64 closedAt, State state
    ) {
        Receipt storage r = receipts[id];
        if (r.state == State.Missing) revert UnknownReceipt();
        return (r.sender, r.recipient, r.digest, r.openedAt, r.closedAt, r.state);
    }

    function pending(uint256 id) private view returns (Receipt storage r) {
        r = receipts[id];
        if (r.state == State.Missing) revert UnknownReceipt();
        if (r.state != State.Pending) revert NotPending();
    }

    function requireId(address account) private view {
        if (agentId.balanceOf(account) == 0) revert AgentIdRequired(account);
    }
}
