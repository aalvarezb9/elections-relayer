// elections-relayer/index.js
// Modo ESM (package.json con "type":"module"). Node 18+.
// Dependencias: express, cors, ethers@5

import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// ---------- ESM __dirname ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------- Config --------------------
const RNP_URL = process.env.RNP_URL || 'http://127.0.0.1:4000';
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PROVIDER_URL = process.env.RPC_URL || 'http://127.0.0.1:8545';
const RELAYER_PRIVATE_KEY =
  process.env.RELAYER_PK ||
  // ⚠️ Solo desarrollo: clave de una cuenta de Hardhat local (cámbiala en prod).
  '0x8166f546bab6da521a8369cab06c5d2b9e46670292d85c875ee9ec20e84ffb61';

// Cargar ABI+address sin import assertions (compat Node 18/20/22)
const require = createRequire(import.meta.url);
const contractCfg = require('./config/contract.json');

// Provider y signer del relayer
const provider = new ethers.providers.JsonRpcProvider(PROVIDER_URL);
const wallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);

// Instancia de contrato
const voting = new ethers.Contract(contractCfg.address, contractCfg.abi, wallet);

// -------------------- Utils --------------------
function ensureDirOf(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendParticipation(dni, txHash) {
  try {
    const file = path.join(__dirname, 'data', 'participation.json');
    ensureDirOf(file);
    let arr = [];
    if (fs.existsSync(file)) arr = JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
    arr.push({ dni, txHash, at: new Date().toISOString() });
    fs.writeFileSync(file, JSON.stringify(arr, null, 2));
  } catch (e) {
    console.error('No se pudo guardar participation:', e);
  }
}

function hasFn(sig) {
  return !!voting.interface.functions[sig];
}

// Getter seguro para electionId (soporta currentElectionId() y getCurrentElectionId())
async function getCurrentElectionIdSafe() {
  if (hasFn('currentElectionId()')) return voting.currentElectionId();
  if (hasFn('getCurrentElectionId()')) return voting.getCurrentElectionId();
  return ethers.BigNumber.from(0);
}

// -------------------- Capacidades (por ABI) --------------------
const HAS = {
  voteSimple: !!voting.interface.functions['vote(uint256)'],
  getAllCandidates: !!voting.interface.functions['getAllCandidates()'],
  getCandidatesCount: !!voting.interface.functions['getCandidatesCount()'],
  getCandidate: !!voting.interface.functions['getCandidate(uint256)'],
  candidatesIdx: !!voting.interface.functions['candidates(uint256)'],
  getVotes: !!voting.interface.functions['getVotes(uint256)'],
};
console.log('Contract capabilities (ABI):', HAS);

// -------------------- App --------------------
const app = express();
app.use(cors());
app.use(express.json());

// Salud
app.get('/health', (_req, res) => res.json({ ok: true }));

// Info + capacidades
app.get('/info', async (_req, res) => {
  try {
    const eId = await getCurrentElectionIdSafe();
    res.json({ address: voting.address, currentElectionId: Number(eId), HAS });
  } catch (e) {
    res.status(500).send('Error leyendo contrato');
  }
});

// Lista de candidatos (robusto para varios contratos sencillos)
app.get('/candidates', async (_req, res) => {
  try {
    if (HAS.getAllCandidates) {
      const list = await voting.getAllCandidates();
      const out = list.map((t) => ({
        id: (t.id ?? t[0]).toNumber(),
        name: (t.name ?? t[1]),
        voteCount: (t.voteCount ?? t[2]).toNumber(),
      }));
      return res.json(out);
    }

    if (HAS.getCandidatesCount && (HAS.getCandidate || HAS.candidatesIdx)) {
      const cnt = (await voting.getCandidatesCount()).toNumber();
      const out = [];
      for (let i = 0; i < cnt; i++) {
        if (HAS.getCandidate) {
          const t = await voting.getCandidate(i);
          out.push({
            id: (t.id ?? t[0]).toNumber(),
            name: (t.name ?? t[1]),
            voteCount: (t.voteCount ?? t[2]).toNumber(),
          });
        } else {
          const name = await voting.candidates(i);
          const vc = HAS.getVotes ? await voting.getVotes(i) : 0;
          out.push({ id: i, name, voteCount: Number(vc) });
        }
      }
      return res.json(out);
    }

    // Fallback: intenta 0..9
    const out = [];
    for (let i = 0; i < 10; i++) {
      try {
        const t = await voting.getCandidate(i);
        out.push({
          id: (t.id ?? t[0]).toNumber(),
          name: (t.name ?? t[1]),
          voteCount: (t.voteCount ?? t[2]).toNumber(),
        });
      } catch { break; }
    }
    res.json(out);
  } catch (e) {
    console.error('/candidates', e);
    res.status(500).send('Error');
  }
});

// Registro off-chain de participación
app.get('/participation', (_req, res) => {
  try {
    const file = path.join(__dirname, 'data', 'participation.json');
    if (!fs.existsSync(file)) return res.json([]);
    const arr = JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
    res.json(arr);
  } catch (_e) {
    res.status(500).send('Error');
  }
});

// Metadatos off-chain: imagen por candidato (se mantiene igual)
const META_FILE = path.join(__dirname, 'data', 'candidateMeta.json');
const loadMeta = () => {
  try {
    if (!fs.existsSync(META_FILE)) return {};
    return JSON.parse(fs.readFileSync(META_FILE, 'utf8') || '{}');
  } catch {
    return {};
  }
};
const saveMeta = (obj) => {
  ensureDirOf(META_FILE);
  fs.writeFileSync(META_FILE, JSON.stringify(obj, null, 2));
};

app.get('/candidate-meta', async (req, res) => {
  try {
    const electionId = parseInt(String(req.query.electionId));
    if (Number.isNaN(electionId)) return res.status(400).send('electionId requerido');
    const meta = loadMeta();
    const items = meta[electionId] || {};
    const arr = Object.keys(items).map((k) => ({
      candidateId: Number(k),
      imageUrl: items[k].imageUrl || '',
    }));
    res.json({ electionId, items: arr });
  } catch (e) {
    console.error('/candidate-meta GET', e);
    res.status(500).send('Error leyendo metadatos');
  }
});

app.put('/candidate-meta', async (req, res) => {
  try {
    const { electionId, items } = req.body || {};
    if (Number.isNaN(Number(electionId)) || !Array.isArray(items)) {
      return res.status(400).send('electionId y items requeridos');
    }
    const meta = loadMeta();
    meta[electionId] = meta[electionId] || {};
    for (const it of items) {
      const cid = Number(it.candidateId);
      if (Number.isNaN(cid)) continue;
      meta[electionId][cid] = { imageUrl: String(it.imageUrl || '') };
    }
    saveMeta(meta);
    res.json({ ok: true });
  } catch (e) {
    console.error('/candidate-meta PUT', e);
    res.status(500).send('Error guardando metadatos');
  }
});

// -------------------- Votar (simple) --------------------
// body: { dni, fingerprint, candidateId }
app.post('/vote', async (req, res) => {
  try {
    const { dni, fingerprint, candidateId } = req.body || {};
    console.log('Vote:', { dni, fingerprint, candidateId });

    if (!dni || !fingerprint || candidateId === undefined) {
      return res.status(400).send('dni, fingerprint y candidateId requeridos');
    }

    // 0) Sanity: contrato vivo
    const code = await provider.getCode(voting.address);
    if (!code || code === '0x') {
      return res.status(500).send(`No hay contrato en ${voting.address} sobre ${PROVIDER_URL}`);
    }

    // 1) Verificación biométrica (RNP-mock) y obtención del salt
    const vr = await fetch(`${RNP_URL}/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dni, fingerprint })
    });
    if (!vr.ok) return res.status(502).send('RNP-mock no disponible');
    const verify = await vr.json();
    if (!verify.match) return res.status(401).send('Biometría inválida o DNI no habilitado');
    if (!verify.salt) return res.status(502).send('RNP-mock no envió salt');

    // 2) Derivar nulificador por-elección (ciego en on-chain)
    const eId = await getCurrentElectionIdSafe();
    const dniHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(dni));
    // baseNull = keccak256(salt, dniHash)
    const baseNull = ethers.utils.solidityKeccak256(
      ['bytes32','bytes32'],
      [verify.salt, dniHash]
    );
    // nullifier = keccak256(electionId, baseNull) ⇒ válido sólo para ESTA elección
    const nullifier = ethers.utils.solidityKeccak256(
      ['uint256','bytes32'],
      [eId, baseNull]
    );

    // (opcional) chequeo on-chain previo
    if (hasFn('hasVoted(uint256,bytes32)')) {
      const used = await voting.hasVoted(eId, nullifier);
      if (used) return res.status(409).send('Ya votaste en esta elección');
    }

    // 3) Enviar la TX con nulificador
    if (!hasFn('voteWithNullifier(bytes32,uint256)')) {
      return res.status(500).send('El contrato no tiene voteWithNullifier(bytes32,uint256). Redeploy y actualiza contract.json');
    }

    const tx = await voting['voteWithNullifier(bytes32,uint256)'](nullifier, Number(candidateId));
    await tx.wait();

    // 4) Registrar participación off-chain (quién votó)
    appendParticipation(dni, tx.hash);

    return res.json({ txHash: tx.hash });
  } catch (e) {
    console.error('/vote error:', e);
    const msg = e?.error?.message || e?.reason || (typeof e?.message === 'string' ? e.message : 'Error del relayer');
    return res.status(400).send(msg);
  }
});

// -------------------- Arranque --------------------
app.listen(PORT, async () => {
  console.log(`Relayer http://localhost:${PORT}`);
  try {
    const eId = await getCurrentElectionIdSafe();
    console.log('Contrato OK. currentElectionId:', Number(eId));
  } catch (e) {
    console.error('No se pudo leer el contrato. Revisa contract.json / RPC / deploy.');
    console.error(e);
  }
});
