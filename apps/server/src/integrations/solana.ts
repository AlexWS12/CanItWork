import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction, clusterApiUrl, sendAndConfirmTransaction } from '@solana/web3.js';

// A run's provenance hash, written into a Solana memo, proves when the result existed and that it has not changed since,
// without trusting this server: anyone can read the memo on the explorer and compare it with the hash the link recomputes.
// Devnet by default (free); SOLANA_CLUSTER=mainnet-beta with a funded SOLANA_SECRET_KEY writes to mainnet.

const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.resolve(here, '../../.cache');
const KEY_FILE = path.join(CACHE, 'solana-key.json');
const ANCHORS_FILE = path.join(CACHE, 'solana-anchors.json');

export interface Anchor {
  signature: string;
  cluster: string;
  explorer: string;
  at: string;
}

const cluster = () => (process.env.SOLANA_CLUSTER?.trim() || 'devnet') as 'devnet' | 'testnet' | 'mainnet-beta';
const explorer = (signature: string) => `https://explorer.solana.com/tx/${signature}${cluster() === 'mainnet-beta' ? '' : `?cluster=${cluster()}`}`;

let connection: Connection | null = null;
const rpc = () => (connection ??= new Connection(process.env.SOLANA_RPC_URL?.trim() || clusterApiUrl(cluster()), 'confirmed'));

// The wallet that pays for memos: SOLANA_SECRET_KEY (a JSON byte array) if set, otherwise one made for devnet and kept in .cache
let wallet: Keypair | null = null;
function payer(): Keypair {
  if (wallet) return wallet;
  const fromEnv = process.env.SOLANA_SECRET_KEY?.trim();
  if (fromEnv) return (wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fromEnv) as number[])));
  mkdirSync(CACHE, { recursive: true });
  if (existsSync(KEY_FILE)) return (wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY_FILE, 'utf8')) as number[])));
  wallet = Keypair.generate();
  writeFileSync(KEY_FILE, JSON.stringify(Array.from(wallet.secretKey)));
  return wallet;
}

// The same hash is only ever anchored once
let anchors: Record<string, Anchor> | null = null;
function known() {
  if (anchors) return anchors;
  try {
    anchors = JSON.parse(readFileSync(ANCHORS_FILE, 'utf8')) as Record<string, Anchor>;
  } catch {
    anchors = {};
  }
  return anchors;
}
const pending = new Map<string, Promise<Anchor>>();

export const solanaEnabled = () => process.env.SOLANA_ANCHOR?.trim() !== 'off';
export const anchorOf = (hash: string) => known()[hash] ?? null;

// A devnet wallet tries the faucet when it runs low; mainnet, and devnet since the open faucet closed, are funded by hand
async function ensureFunds(key: PublicKey) {
  if (cluster() === 'mainnet-beta') return;
  const balance = await rpc().getBalance(key);
  if (balance >= 0.01 * LAMPORTS_PER_SOL) return;
  try {
    const sig = await rpc().requestAirdrop(key, LAMPORTS_PER_SOL);
    const latest = await rpc().getLatestBlockhash();
    await rpc().confirmTransaction({ signature: sig, ...latest }, 'confirmed');
  } catch {
    // Public faucets now ask for a sign-in: fund this address once at https://faucet.solana.com
    console.warn(`[solana] wallet ${key.toBase58()} is low on ${cluster()} SOL; fund it at https://faucet.solana.com`);
  }
}

/** The address that pays for memos, safe to show: fund it once on the faucet. */
export const walletAddress = () => payer().publicKey.toBase58();

export async function anchor(hash: string): Promise<Anchor> {
  const done = anchorOf(hash);
  if (done) return done;
  const running = pending.get(hash);
  if (running) return running;
  const job = (async () => {
    const key = payer();
    await ensureFunds(key.publicKey);
    const tx = new Transaction().add(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(`canitwork:${hash}`, 'utf8') }));
    const signature = await sendAndConfirmTransaction(rpc(), tx, [key], { commitment: 'confirmed' });
    const result: Anchor = { signature, cluster: cluster(), explorer: explorer(signature), at: new Date().toISOString() };
    known()[hash] = result;
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(ANCHORS_FILE, JSON.stringify(known(), null, 2));
    return result;
  })().finally(() => pending.delete(hash));
  pending.set(hash, job);
  return job;
}
