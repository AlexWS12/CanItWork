import { SYSTEM, checkPatches, type Inspection } from '../../domain';
import { SchemaRun, isIndexed } from './engine';
import { DEFAULT_POOL, DatabasePatchSchema, type DatabasePatch, type Table } from './schema';

// Hand edits to a database as it runs: the same fixes the agents make (an index, a replica, a bigger pool, a pooler, batching an
// N+1 loop, more partitions, archiving old rows), offered as settings and buttons in the Inspector. They live beside the engine
// rather than in it, so they go through its own apply and log, and a replay ends where the live run did.

export class EditableSchemaRun extends SchemaRun {
  check(patches: unknown[]) {
    return checkPatches(DatabasePatchSchema, patches, (patch: DatabasePatch) => {
      const table = 'table' in patch ? this.table(patch.table) : undefined;
      if ('table' in patch && !table) return `There is no table called ${patch.table}.`;
      if (patch.op === 'add_index') {
        const missing = patch.columns.find((c) => !table!.columns.some((col) => col.name === c));
        if (missing) return `${patch.table} has no column called ${missing}.`;
        if (table!.indexes.some((ix) => ix.join() === patch.columns.join())) return `${patch.table} already has that index.`;
      }
      if (patch.op === 'repartition') {
        if (patch.by && !table!.columns.some((c) => c.name === patch.by)) return `${patch.table} has no column called ${patch.by}.`;
        if (!patch.by && !table!.partitionBy) return `${patch.table} isn't partitioned yet, so it needs a column to split on.`;
      }
      if (patch.op === 'batch_query') {
        const query = this.spec.workload.find((q) => q.name === patch.query);
        if (!query) return `There is no query called ${patch.query}.`;
        if ((query.repeats ?? 1) <= 1) return `${patch.query} already runs once per request.`;
      }
      if (patch.op === 'add_pooler' && this.pooler) return 'There is already a pooler in front of the database.';
      return null;
    });
  }

  inspect(target: string): Inspection | null {
    if (target === SYSTEM) return this.systemSettings();
    const view = super.inspect(target);
    const table = this.table(target);
    if (!view || !table) return view;
    return { ...view, ...this.tableEdits(table) };
  }

  private systemSettings(): Inspection {
    const pool = this.spec.pool ?? DEFAULT_POOL;
    return {
      title: 'Database settings',
      rows: [
        ['Tables', this.spec.tables.length],
        ['Connections in use', `${Math.round(this.inUse)} of ${pool}`],
        ['Pooler', this.pooler ? 'Yes' : 'No'],
      ],
      actions: [],
      settings: [
        {
          kind: 'number',
          label: 'Connection pool',
          hint: 'Connections each node allows. Too few and requests wait; too many and the database thrashes.',
          value: pool,
          min: 5,
          max: Math.min(10000, Math.max(500, pool * 4)),
          step: 5,
          unit: '',
          patch: { op: 'set_pool' },
          key: 'size',
        },
      ],
      edits: [{ label: 'Add a read replica', patches: [{ op: 'add_replica' }] }, ...(this.pooler ? [] : [{ label: 'Put a pooler in front', patches: [{ op: 'add_pooler' }] }])],
    };
  }

  private tableEdits(table: Table): Pick<Inspection, 'settings' | 'edits'> {
    const queries = this.spec.workload.filter((q) => q.table === table.name);
    // The first filter column of each query on this table that no index leads with, once each
    const unindexed = [...new Set(queries.map((q) => q.where[0]).filter((c): c is string => Boolean(c) && !isIndexed(table, c)))];
    const loops = queries.filter((q) => (q.repeats ?? 1) > 1);
    return {
      settings: table.partitionBy
        ? [
            {
              kind: 'number',
              label: 'Partitions',
              hint: `Nodes the rows are spread over, split by ${table.partitionBy}.`,
              value: table.partitions ?? 1,
              min: 1,
              max: 32,
              step: 1,
              unit: '',
              patch: { op: 'repartition', table: table.name },
              key: 'partitions',
            },
          ]
        : [],
      edits: [
        ...unindexed.map((column) => ({ label: `Index ${column}`, patches: [{ op: 'add_index', table: table.name, columns: [column] }] })),
        ...loops.map((q) => ({ label: `Batch ${q.name} into one query`, patches: [{ op: 'batch_query', query: q.name }] })),
        { label: 'Archive half the rows', patches: [{ op: 'archive_rows', table: table.name, fraction: 0.5 }], destructive: true },
      ],
    };
  }
}
