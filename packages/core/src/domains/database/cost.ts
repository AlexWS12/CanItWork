import { usd } from '../../cost';
import type { MonthlyCost } from '../../domain';
import { partitionsOf, type DatabaseSpec } from './schema';

// A month of one mid-size managed database node, a gigabyte of its storage, and a small connection pooler in front.
const NODE_USD = 140;
const STORAGE_USD_PER_GB = 0.115;
const POOLER_USD = 15;
// Bytes a row takes: a header, a few bytes per column, and each index adding about a third again.
const ROW_HEADER = 24;
const BYTES_PER_COLUMN = 16;
const INDEX_SHARE = 0.3;

/**
 * The month's cost of a schema: its nodes (the primary, or one per partition of a partitioned table, each with its read
 * replicas) and the storage its rows and indexes take on every copy.
 */
export function databaseCost(spec: DatabaseSpec, extras: { pooler?: boolean } = {}): MonthlyCost {
  const copies = 1 + (spec.replicas ?? 0);
  const partitioned = spec.tables.filter((t) => partitionsOf(t) > 1);
  const primaries = (partitioned.length < spec.tables.length ? 1 : 0) + partitioned.reduce((sum, t) => sum + partitionsOf(t), 0);
  const lines: MonthlyCost['lines'] = [];
  lines.push({ label: primaries > 1 ? `${primaries} database nodes` : 'Primary database', usd: usd(primaries * NODE_USD) });
  if (copies > 1) lines.push({ label: `${copies - 1} read replica${copies === 2 ? '' : 's'}`, usd: usd(primaries * (copies - 1) * NODE_USD) });
  const bytes = spec.tables.reduce((sum, t) => sum + t.rows * (ROW_HEADER + BYTES_PER_COLUMN * t.columns.length) * (1 + INDEX_SHARE * t.indexes.length), 0);
  const storage = (bytes / 1e9) * STORAGE_USD_PER_GB * copies;
  if (storage >= 0.01) lines.push({ label: `Storage (${Math.max(1, Math.round(bytes / 1e9))} GB${copies > 1 ? ` on ${copies} copies` : ''})`, usd: usd(storage) });
  if (extras.pooler) lines.push({ label: 'Connection pooler', usd: POOLER_USD });
  return { usd: usd(lines.reduce((sum, l) => sum + l.usd, 0)), lines };
}
