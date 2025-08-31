// elections-relayer/index.js (ESM)
// deps: express, cors, ethers@5
import express from "express";
import cors from "cors";
import { ethers } from "ethers";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "0x8166f546bab6da521a8369cab06c5d2b9e46670292d85c875ee9ec20e84ffb61"; // demo
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const RNP_URL = process.env.RNP_URL || "http://127.0.0.1:4000";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

if (!CONTRACT_ADDRESS) {
  console.error("Falta CONTRACT_ADDRESS");
  process.exit(1);
}

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const ABI = [
  "function currentElectionId() view returns (uint256)",
  "function elections(uint256) view returns (uint256 id, string title, bool active)",
  "function merkleRootOf(uint256) view returns (bytes32)",
  "function setCurrentElectionMerkleRoot(bytes32 root) external",
  "function voteWithNullifier(bytes32,uint256,bytes32[],bytes32) external",

  "function getVotesCount() view returns (uint256)",
  "function getVotesCount(uint256) view returns (uint256)",
  "function getVote(uint256) view returns (tuple(uint256 id, uint256 candidateId, uint64 timestamp))",
  "function getVote(uint256,uint256) view returns (tuple(uint256 id, uint256 candidateId, uint64 timestamp))",

  "event VoteRecorded(uint256 indexed electionId, uint256 indexed candidateId, uint256 indexed voteId, uint64 timestamp)"
];
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

async function fetchJSON(url, options={}) {
  const res = await fetch(url, options);
  const t = await res.text();
  try { return JSON.parse(t); } catch { return { raw: t, status: res.status }; }
}

async function getAllVotesCurrentElection() {
  const eid = (await contract.currentElectionId()).toNumber();

  // 1) por eventos (rápido)
  try {
    const filter = contract.filters.VoteRecorded(eid, null, null);
    const logs = await contract.queryFilter(filter, 0, "latest");
    const items = logs
      .map(l => ({
        id: l.args.voteId.toNumber(),
        candidateId: l.args.candidateId.toNumber(),
        timestamp: Number(l.args.timestamp)
      }))
      .sort((a, b) => a.id - b.id);
    return { electionId: eid, total: items.length, items };
  } catch (_) {
    // 2) fallback on-chain con sobrecargas
    const n = (await contract["getVotesCount()"]()).toNumber(); // ← firma exacta
    const items = [];
    for (let i = 0; i < n; i++) {
      const v = await contract["getVote(uint256)"](i); // ← firma exacta
      items.push({
        id: Number(v.id),
        candidateId: Number(v.candidateId),
        timestamp: Number(v.timestamp)
      });
    }
    return { electionId: eid, total: items.length, items };
  }
}

const app = express();
app.use(cors());
app.use(express.json());

// estado básico para el cliente
app.get("/status", async (_req, res) => {
  try {
    const eid = (await contract.currentElectionId()).toNumber();
    const root = await contract.merkleRootOf(eid);
    res.json({ electionId: eid, root });
  } catch (e) {
    res.status(500).json({ error: "status-failed", detail: String(e) });
  }
});

// sincroniza root on-chain con el root del RNP (sin ver PII)
app.post("/admin/sync-root", async (_req, res) => {
  try {
    const eid = (await contract.currentElectionId()).toNumber();
    if (!eid) return res.status(400).json({ error: "no-election" });

    const { root } = await fetchJSON(`${RNP_URL}/root?electionId=${eid}`);
    if (!root) return res.status(500).json({ error: "no-root-from-rnp" });

    const onchain = await contract.merkleRootOf(eid);
    if (onchain.toLowerCase() !== root.toLowerCase()) {
      const tx = await contract.setCurrentElectionMerkleRoot(root);
      const receipt = await tx.wait();
      return res.json({ synced: true, electionId: eid, root, txHash: receipt.transactionHash });
    }
    res.json({ synced: false, electionId: eid, root });
  } catch (e) {
    res.status(500).json({ error: "sync-root-failed", detail: String(e) });
  }
});

// voto: el cliente entrega leaf/proof (obtenidos del RNP). El relayer no ve PII.
app.post("/vote", async (req, res) => {
  try {
    const { candidateId, electionId, leaf, proof, root } = req.body || {};
    if (candidateId === undefined || candidateId === null) return res.status(400).json({ error: "candidateId requerido" });
    if (!leaf || !Array.isArray(proof)) return res.status(400).json({ error: "leaf y proof requeridos" });

    const eid = (await contract.currentElectionId()).toNumber();
    if (electionId && Number(electionId) !== eid) return res.status(400).json({ error: "electionId mismatch" });

    const onchainRoot = await contract.merkleRootOf(eid);
    if (root && root.toLowerCase() !== onchainRoot.toLowerCase()) {
      return res.status(400).json({ error: "root desincronizado" });
    }

    const fn = contract["voteWithNullifier(bytes32,uint256,bytes32[],bytes32)"];
    const tx = await fn(ethers.constants.HashZero, ethers.BigNumber.from(candidateId), proof, leaf, { gasLimit: 500000 });
    const receipt = await tx.wait();
    res.json({ ok: true, txHash: receipt.transactionHash, electionId: eid, root: onchainRoot });
  } catch (e) {
    console.error("/vote error:", e);
    res.status(500).json({ error: "vote-failed", detail: String(e) });
  }
});

app.get("/votes", async (_req, res) => {
  try {
    const data = await getAllVotesCurrentElection();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "votes-failed", detail: String(e) });
  }
});

app.listen(PORT, () => console.log(`Relayer http://127.0.0.1:${PORT}`));
