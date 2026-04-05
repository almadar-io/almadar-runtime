/**
 * LocalPersistenceAdapter - Filesystem CRUD for `persistence: "local"` entities.
 *
 * One directory per entity type, one JSON file per instance.
 * Language-level feature: benefits all .orb programs, not just the agent.
 * Offline-first apps, CLI tools, config managers, local databases all use it.
 *
 * @packageDocumentation
 */

import fs from 'fs';
import path from 'path';
import type { PersistenceAdapter } from './OrbitalServerRuntime.js';
import type { EntityRow } from './types.js';

/**
 * Filesystem-backed persistence adapter.
 *
 * Storage layout:
 * ```
 * {root}/
 *   {entityType}/
 *     {id}.json
 * ```
 */
export class LocalPersistenceAdapter implements PersistenceAdapter {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }

  private entityDir(entityType: string): string {
    const dir = path.join(this.root, entityType.toLowerCase());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private filePath(entityType: string, id: string): string {
    return path.join(this.entityDir(entityType), `${id}.json`);
  }

  async create(entityType: string, data: EntityRow): Promise<{ id: string }> {
    const id = (data.id as string) || `${entityType.toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record: EntityRow = { ...data, id };
    const filePath = this.filePath(entityType, id);
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
    return { id };
  }

  async update(entityType: string, id: string, data: EntityRow): Promise<void> {
    const filePath = this.filePath(entityType, id);
    let existing: EntityRow = { id };
    if (fs.existsSync(filePath)) {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as EntityRow;
    }
    const merged: EntityRow = { ...existing, ...data, id };
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf-8');
  }

  async delete(entityType: string, id: string): Promise<void> {
    const filePath = this.filePath(entityType, id);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  async getById(entityType: string, id: string): Promise<EntityRow | null> {
    const filePath = this.filePath(entityType, id);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as EntityRow;
  }

  async list(entityType: string): Promise<EntityRow[]> {
    const dir = this.entityDir(entityType);
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const results: EntityRow[] = [];
    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      results.push(JSON.parse(content) as EntityRow);
    }
    return results;
  }

  /**
   * Remove all data for an entity type.
   */
  async clear(entityType: string): Promise<void> {
    const dir = path.join(this.root, entityType.toLowerCase());
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Remove all local data.
   */
  async clearAll(): Promise<void> {
    if (fs.existsSync(this.root)) {
      fs.rmSync(this.root, { recursive: true, force: true });
      fs.mkdirSync(this.root, { recursive: true });
    }
  }
}
