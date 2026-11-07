import { z } from 'zod';

export const ColumnSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['int', 'bigint', 'uuid', 'text', 'decimal', 'bool', 'timestamp']),
  primary: z.boolean().optional(),
  unique: z.boolean().optional(),
  nullable: z.boolean().optional(),
  references: z
    .object({
      table: z.string(),
      column: z.string(),
      onDelete: z.enum(['cascade', 'restrict', 'set_null']).optional(),
    })
    .optional(),
});
export type Column = z.infer<typeof ColumnSchema>;

export const TableSchema = z.object({
  name: z.string().min(1),
  rows: z.number().int().min(0).max(1e10),
  columns: z.array(ColumnSchema).min(1).max(30),
  indexes: z.array(z.array(z.string())).default([]),
});
export type Table = z.infer<typeof TableSchema>;

export const QuerySchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['read', 'write']),
  table: z.string(),
  where: z.array(z.string()).default([]),
  joins: z.array(z.object({ table: z.string(), local: z.string(), foreign: z.string() })).default([]),
  perSecond: z.number().positive().max(100000),
});
export type Query = z.infer<typeof QuerySchema>;

export const DatabaseSpecSchema = z.object({
  tables: z.array(TableSchema).min(1).max(16),
  workload: z.array(QuerySchema).max(20).default([]),
});
export type DatabaseSpec = z.infer<typeof DatabaseSpecSchema>;

export const DatabasePatchSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_index'), table: z.string(), columns: z.array(z.string()).min(1) }),
  z.object({ op: z.literal('add_replica') }),
  z.object({ op: z.literal('archive_rows'), table: z.string(), fraction: z.number().min(0.05).max(0.95) }),
  z.object({ op: z.literal('restore_column'), table: z.string(), column: z.string() }),
  z.object({ op: z.literal('unlock_table'), table: z.string() }),
]);
export type DatabasePatch = z.infer<typeof DatabasePatchSchema>;
