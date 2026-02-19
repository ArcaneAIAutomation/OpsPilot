// ---------------------------------------------------------------------------
// OpsPilot — Audit Logger
// ---------------------------------------------------------------------------
// Append-only audit trail. Every approval, action, and security-relevant
// event generates an immutable audit entry. Entries are stored via the
// storage engine so they persist according to the configured backend.
// ---------------------------------------------------------------------------

import { IAuditLogger, AuditEntry, AuditFilter } from '../types/security';
import { IStorageEngine } from '../types/storage';
import { ILogger } from '../types/module';
import { generateId } from '../../shared/utils';

const AUDIT_COLLECTION = 'system::audit';

export class AuditLogger implements IAuditLogger {
  private readonly storage: IStorageEngine;
  private readonly logger: ILogger;

  constructor(storage: IStorageEngine, logger: ILogger) {
    this.storage = storage;
    this.logger = logger.child('AuditLogger');
  }

  async log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<void> {
    const full: AuditEntry = {
      ...entry,
      id: generateId(),
      timestamp: new Date(),
    };

    await this.storage.set(AUDIT_COLLECTION, full.id, full);

    this.logger.debug('Audit entry recorded', {
      id: full.id,
      action: full.action,
      actor: full.actor,
      target: full.target,
    });
  }

  async query(filter: AuditFilter): Promise<AuditEntry[]> {
    let entries = await this.storage.list<AuditEntry>(AUDIT_COLLECTION);

    if (filter.action) {
      entries = entries.filter((e) => e.action === filter.action);
    }
    if (filter.actor) {
      entries = entries.filter((e) => e.actor === filter.actor);
    }
    if (filter.from) {
      const from = filter.from.getTime();
      entries = entries.filter((e) => new Date(e.timestamp).getTime() >= from);
    }
    if (filter.to) {
      const to = filter.to.getTime();
      entries = entries.filter((e) => new Date(e.timestamp).getTime() <= to);
    }

    // Sort newest first
    entries.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    if (filter.limit) {
      entries = entries.slice(0, filter.limit);
    }

    return entries;
  }
}
