// elections-relayer/index.js
// ESM (package.json con "type":"module"). Node 18+.
// Dep: express, cors, ethers@5, merkletreejs, keccak256

import express from "express";
import cors from "cors";
import { ethers } from "ethers";
import { MerkleTree } from "merkletreejs";
import keccak256 from "keccak256";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

// ---------- ESM helpers ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// ---------- Config ----------
const RNP_URL = process.env.RNP_URL || "http://127.0.0.1:4000";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PROVIDER_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PK ||
  // ⚠️ Sólo dev: una cuenta del nodo Hardhat
  "0xde9be858da4a475276426320d5e9262ecfc3ba460bfac56360bfa6c4c28b4ee0";

// Cargar ABI+address (generado por tu deploy script)
const contractCfg = require("./config/contract.json");

// Provider + signer
const provider = new ethers.providers.JsonRpcProvider(PROVIDER_URL);
const wallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);

// Instancia de contrato
const voting = new ethers.Contract(
  contractCfg.address,
  contractCfg.abi,
  wallet
);

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const mapVote = (v) => ({
  id: Number(v.id ?? v[0]),
  candidateId: Number(v.candidateId ?? v[1]),
  timestamp: Number(v.timestamp ?? v[2]), // uint64 -> number
});

// ---------- Utils ----------
const toBuf = (hex) => Buffer.from(String(hex || "").replace(/^0x/, ""), "hex");

function hasFn(sig) {
  return !!voting.interface.functions[sig];
}

async function getCurrentElectionIdSafe() {
  try {
    if (hasFn("currentElectionId()")) return await voting.currentElectionId();
    if (hasFn("getCurrentElectionId()")) return await voting.getCurrentElectionId();
  } catch (e) {
    if (e?.code === "CALL_EXCEPTION" && e?.data === "0x") return ethers.BigNumber.from(0);
    throw e;
  }
  return ethers.BigNumber.from(0);
}

function ensureDirOf(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

const PARTICIPATION_FILE = path.join(__dirname, "data", "participation.json");

function appendParticipation(dni, txHash) {
  try {
    ensureDirOf(PARTICIPATION_FILE);
    let arr = [];
    if (fs.existsSync(PARTICIPATION_FILE)) {
      arr = JSON.parse(fs.readFileSync(PARTICIPATION_FILE, "utf8") || "[]");
    }
    arr.push({ dni, txHash, at: new Date().toISOString() });
    fs.writeFileSync(PARTICIPATION_FILE, JSON.stringify(arr, null, 2));
  } catch (e) {
    console.error("No se pudo guardar participation:", e);
  }
}

// Reemplaza tu fetchJSON actual por ESTE:
async function fetchJSON(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text(); // ← leemos UNA vez
  if (!r.ok) {
    // Deja el contenido en el error para debug; corta por si es HTML largo
    throw new Error(`HTTP ${r.status} ${url}: ${text.slice(0,200)}${text.length>200?'...':''}`);
  }
  try {
    return JSON.parse(text); // ← parseamos desde el texto
  } catch {
    throw new Error(`Respuesta no JSON desde ${url}: ${text.slice(0,200)}${text.length>200?'...':''}`);
  }
}

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json());

// Salud
app.get("/health", (_req, res) => res.json({ ok: true }));

// Info básica
app.get("/info", async (_req, res) => {
  try {
    const code = await provider.getCode(voting.address);
    const exists = !!code && code !== "0x";
    const eid = exists ? await getCurrentElectionIdSafe() : 0;
    let root = "0x";
    try {
      root = exists && hasFn("merkleRootOf(uint256)")
        ? await voting.merkleRootOf(eid)
        : "0x";
    } catch {
      /* ignore */
    }

    res.json({
      address: voting.address,
      network: PROVIDER_URL,
      exists,
      currentElectionId: Number(eid || 0),
      merkleRoot: root,
    });
  } catch (e) {
    res.status(500).send("Error leyendo contrato");
  }
});

// Candidatos (compatible con tu front)
app.get("/candidates", async (_req, res) => {
  try {
    if (hasFn("getAllCandidates()")) {
      const list = await voting.getAllCandidates();
      const out = list.map((t) => ({
        id: (t.id ?? t[0]).toNumber(),
        name: t.name ?? t[1],
        voteCount: (t.voteCount ?? t[2]).toNumber(),
      }));
      return res.json(out);
    }

    // Fallback básico si no existe getAllCandidates()
    const cnt = hasFn("getCandidatesCount()")
      ? (await voting.getCandidatesCount()).toNumber()
      : 0;
    const out = [];
    for (let i = 0; i < cnt; i++) {
      const t = await voting.getCandidate(i);
      out.push({
        id: (t.id ?? t[0]).toNumber(),
        name: t.name ?? t[1],
        voteCount: (t.voteCount ?? t[2]).toNumber(),
      });
    }
    res.json(out);
  } catch (e) {
    console.error("/candidates", e);
    res.status(500).send("Error");
  }
});

// Metadatos de imágenes por candidato (opc)
const META_FILE = path.join(__dirname, "data", "candidateMeta.json");

const loadMeta = () => {
  try {
    return fs.existsSync(META_FILE)
      ? JSON.parse(fs.readFileSync(META_FILE, "utf8") || "{}")
      : {};
  } catch {
    return {};
  }
};

const saveMeta = (obj) => {
  ensureDirOf(META_FILE);
  fs.writeFileSync(META_FILE, JSON.stringify(obj, null, 2));
};

app.get("/candidate-meta", async (req, res) => {
  try {
    const electionId = parseInt(String(req.query.electionId));
    if (Number.isNaN(electionId)) {
      return res.status(400).send("electionId requerido");
    }

    const meta = loadMeta();
    const items = meta[electionId] || {};
    const arr = Object.keys(items).map((k) => ({
      candidateId: Number(k),
      imageUrl: items[k].imageUrl || "",
    }));

    res.json({ electionId, items: arr });
  } catch (e) {
    console.error("/candidate-meta GET", e);
    res.status(500).send("Error leyendo metadatos");
  }
});

app.put("/candidate-meta", async (req, res) => {
  try {
    const { electionId, items } = req.body || {};
    if (Number.isNaN(Number(electionId)) || !Array.isArray(items)) {
      return res.status(400).send("electionId y items requeridos");
    }

    const meta = loadMeta();
    meta[electionId] = meta[electionId] || {};

    for (const it of items) {
      const cid = Number(it.candidateId);
      if (Number.isNaN(cid)) continue;
      meta[electionId][cid] = { imageUrl: String(it.imageUrl || "") };
    }

    saveMeta(meta);
    res.json({ ok: true });
  } catch (e) {
    console.error("/candidate-meta PUT", e);
    res.status(500).send("Error guardando metadatos");
  }
});

// Participación (off-chain: quién votó)
app.get("/participation", (_req, res) => {
  try {
    if (!fs.existsSync(PARTICIPATION_FILE)) return res.json([]);
    const arr = JSON.parse(fs.readFileSync(PARTICIPATION_FILE, "utf8") || "[]");
    res.json(arr);
  } catch (_e) {
    res.status(500).send("Error");
  }
});

// --------- Merkle helpers (GLOBAL, sin centro/mesa) ---------
async function computeGlobalTree() {
  // RNP devuelve TODAS las hojas (toda la lista habilitada)
  const { leaves } = await fetchJSON(`${RNP_URL}/leaves`);
  const tree = new MerkleTree(leaves.map(toBuf), keccak256, {
    sortPairs: true,
  });
  const root = "0x" + tree.getRoot().toString("hex");
  return { tree, root, leaves };
}

app.get("/merkle-root", async (_req, res) => {
  try {
    const { root, leaves } = await computeGlobalTree();
    res.json({ merkleRoot: root, count: leaves.length });
  } catch (e) {
    console.error("/merkle-root", e);
    res.status(500).send("No se pudo calcular la Merkle root");
  }
});

// Admin: sincroniza root on-chain con la calculada desde RNP
app.post("/admin/sync-root", async (_req, res) => {
  try {
    const code = await provider.getCode(voting.address);
    if (!code || code === "0x") {
      return res.status(500).send("No hay contrato en la address configurada");
    }

    const eid = await getCurrentElectionIdSafe();
    if (!eid || eid.eq(0)) {
      return res.status(400).send("No hay elección activa");
    }

    const { root } = await computeGlobalTree();

    if (!hasFn("setCurrentElectionMerkleRoot(bytes32)")) {
      return res
        .status(500)
        .send("El contrato no expone setCurrentElectionMerkleRoot(bytes32)");
    }

    const tx = await voting["setCurrentElectionMerkleRoot(bytes32)"](root);
    await tx.wait();

    res.json({ root, txHash: tx.hash });
  } catch (e) {
    console.error("/admin/sync-root", e);
    const msg = e?.error?.message || e?.reason || e?.message || "Error";
    res.status(400).send(msg);
  }
});

// --------- Votar (dni, fingerprint; candidateId en URL) ---------
// POST /vote/:candidateId body: { dni, fingerprint }
app.post("/vote/:candidateId", async (req, res) => {
  try {
    const candidateId = Number(req.params.candidateId);
    const { dni, fingerprint } = req.body || {};

    if (!dni || !fingerprint || Number.isNaN(candidateId)) {
      return res.status(400).send("dni, fingerprint y candidateId requeridos");
    }

    // Sanity contrato
    const code = await provider.getCode(voting.address);
    if (!code || code === "0x") {
      return res.status(500).send("No hay contrato desplegado");
    }

    // 1) verificar biometría y obtener salt
    const verify = await fetchJSON(`${RNP_URL}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dni, fingerprint }),
    });

    if (!verify?.match) {
      return res.status(401).send("Biometría inválida o DNI no habilitado");
    }
    if (!verify?.salt) {
      return res.status(502).send("RNP no envió salt");
    }

    // 2) árbol global + leaf + proof
    const { tree, root, leaves } = await computeGlobalTree();
    const dniHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(dni));
    const leaf = ethers.utils.solidityKeccak256(
      ["bytes32", "bytes32"],
      [verify.salt, dniHash]
    );

    const inPadron = leaves.some(
      (x) => String(x).toLowerCase() === leaf.toLowerCase()
    );
    if (!inPadron) {
      return res.status(401).send("No está en el padrón");
    }

    const proof = tree.getHexProof(toBuf(leaf));
    const eId = await getCurrentElectionIdSafe();
    if (!eId || eId.eq(0)) {
      return res.status(400).send("No hay elección activa");
    }

    const baseNull = ethers.utils.solidityKeccak256(
      ["bytes32", "bytes32"],
      [verify.salt, dniHash]
    );
    const nullifier = ethers.utils.solidityKeccak256(
      ["uint256", "bytes32"],
      [eId, baseNull]
    );

    // 4) validar root on-chain
    if (
      !hasFn("merkleRootOf(uint256)") &&
      !hasFn("setCurrentElectionMerkleRoot(bytes32)")
    ) {
      return res.status(500).send("El contrato no soporta Merkle root");
    }

    const onchainRoot = hasFn("merkleRootOf(uint256)")
      ? await voting.merkleRootOf(eId)
      : ethers.constants.HashZero;

    if (onchainRoot === ethers.constants.HashZero) {
      return res
        .status(400)
        .send("Merkle root no seteada en la elección actual");
    }

    if (String(onchainRoot).toLowerCase() !== root.toLowerCase()) {
      return res
        .status(400)
        .send(
          "La Merkle root calculada no coincide con la on-chain. Ejecuta /admin/sync-root"
        );
    }

    // 5) (opcional) pre-chequeo duplicado
    if (hasFn("hasVoted(uint256,bytes32)")) {
      const used = await voting.hasVoted(eId, nullifier);
      if (used) {
        return res.status(409).send("Ya votaste en esta elección");
      }
    }

    // 6) TX on-chain: voteWithNullifier
    if (!hasFn("voteWithNullifier(bytes32,uint256,bytes32[],bytes32)")) {
      return res
        .status(500)
        .send(
          "El contrato no expone voteWithNullifier(bytes32,uint256,bytes32[],bytes32)"
        );
    }

    const tx = await voting[
      "voteWithNullifier(bytes32,uint256,bytes32[],bytes32)"
    ](nullifier, candidateId, proof, leaf);
    await tx.wait();

    appendParticipation(dni, tx.hash);
    res.json({ txHash: tx.hash });
  } catch (e) {
    console.error("/vote/:candidateId error:", e);
    const msg = e?.error?.message || e?.reason || e?.message || "Error del relayer";
    res.status(400).send(msg);
  }
});

// --------- (compat) endpoint sin :candidateId en URL ---------
// POST /vote body: { dni, fingerprint, candidateId }
app.post("/vote", async (req, res) => {
  const { candidateId } = req.body || {};
  if (candidateId === undefined) {
    return res.status(400).send("candidateId requerido");
  }

  // Reusar el handler anterior
  req.params = { candidateId: String(candidateId) };
  app._router.handle(
    { ...req, url: `/vote/${candidateId}`, method: "POST" },
    res,
    () => {}
  );
});

app.get("/votes", async (req, res) => {
  try {
    const code = await provider.getCode(voting.address);
    if (!code || code === "0x") return res.status(500).send("No hay contrato desplegado");

    const start = clamp(Number(req.query.start ?? 0), 0, 1e9);
    const limit = clamp(Number(req.query.limit ?? 50), 0, 1000);
    const eidQ = req.query.electionId;

    let eidNum;
    if (eidQ === undefined) {
      const eId = await getCurrentElectionIdSafe();
      eidNum = Number(eId || 0);
      const total = (await voting["getVotesCount()"]()).toNumber();
      const arr = await voting["getVotesRange(uint256,uint256)"](start, limit);
      return res.json({
        electionId: eidNum,
        start, limit, total,
        items: arr.map(mapVote),
      });
    } else {
      eidNum = Number(eidQ);
      if (Number.isNaN(eidNum)) return res.status(400).send("electionId inválido");
      const total = (await voting["getVotesCount(uint256)"](eidNum)).toNumber();
      const arr = await voting["getVotesRange(uint256,uint256,uint256)"](eidNum, start, limit);
      return res.json({
        electionId: eidNum,
        start, limit, total,
        items: arr.map(mapVote),
      });
    }
  } catch (e) {
    console.error("/votes", e);
    res.status(500).send(e?.reason || e?.message || "Error");
  }
});

app.get("/votes/by-candidate", async (req, res) => {
  try {
    const code = await provider.getCode(voting.address);
    if (!code || code === "0x") return res.status(500).send("No hay contrato desplegado");

    const eid = Number(req.query.electionId);
    const cid = Number(req.query.candidateId);
    if (Number.isNaN(eid) || Number.isNaN(cid)) {
      return res.status(400).send("electionId y candidateId requeridos");
    }
    const start = clamp(Number(req.query.start ?? 0), 0, 1e9);
    const limit = clamp(Number(req.query.limit ?? 50), 0, 1000);

    const total = (await voting["getVotesByCandidateCount(uint256,uint256)"](eid, cid)).toNumber();
    const arr = await voting["getVotesByCandidateRange(uint256,uint256,uint256,uint256)"](eid, cid, start, limit);
    res.json({ electionId: eid, candidateId: cid, start, limit, total, items: arr.map(mapVote) });
  } catch (e) {
    console.error("/votes/by-candidate", e);
    res.status(500).send(e?.reason || e?.message || "Error");
  }
});

// ---------- Start ----------
app.listen(PORT, async () => {
  console.log(`Relayer http://localhost:${PORT}`);
  try {
    const code = await provider.getCode(voting.address);
    if (!code || code === "0x") {
      console.warn(
        `⚠️ No hay contrato en ${voting.address}. Despliega y actualiza config/contract.json`
      );
      return;
    }
    const eId = await getCurrentElectionIdSafe();
    console.log("Contrato OK. currentElectionId:", Number(eId));
  } catch (e) {
    console.error(
      "No se pudo leer el contrato. Revisa contract.json / RPC / deploy."
    );
    console.error(e);
  }
});