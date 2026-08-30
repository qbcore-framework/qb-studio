export interface CredentialConnectionIdentity {
  id: string;
  scope: string;
  storageName: string;
  requiresKey: boolean;
}

export interface EncryptedCredentialUpdate {
  connectionId: string;
  /** Null is the explicit clear operation; otherwise bytes are already OS-encrypted. */
  data: Uint8Array | null;
}

export interface CredentialMigrationMutation {
  write: { path: string; data: Uint8Array } | null;
  removals: readonly string[];
}

export interface CredentialMutationPlan {
  writes: Array<{ path: string; data: Uint8Array }>;
  removals: string[];
}

export interface CredentialMutationPlanInput {
  /** Null means the caller did not provide an explicit versioned connection
   * list, so normalization fallback must not be mistaken for user deletion. */
  requestedConnectionIds: ReadonlySet<string> | null;
  previousConnections: readonly CredentialConnectionIdentity[];
  nextConnections: readonly CredentialConnectionIdentity[];
  updates: readonly EncryptedCredentialUpdate[];
  migration: CredentialMigrationMutation;
  currentPath(storageName: string): string;
  candidates(storageName: string): readonly string[];
  pathIdentity(path: string): string;
}

/**
 * Compose every credential write and retirement for one settings commit before
 * touching disk. Writes win over removals for the same path, which is important
 * when a credential-policy edit and an explicit replacement target the same
 * scoped file in one save.
 */
export function buildCredentialMutationPlan(input: CredentialMutationPlanInput): CredentialMutationPlan {
  const writes = new Map<string, { path: string; data: Uint8Array }>();
  const removals = new Map<string, string>();
  const stageWrite = (target: string, data: Uint8Array) => {
    const identity = input.pathIdentity(target);
    removals.delete(identity);
    writes.set(identity, { path: target, data: Uint8Array.from(data) });
  };
  const stageRemoval = (target: string) => {
    const identity = input.pathIdentity(target);
    if (!writes.has(identity)) removals.set(identity, target);
  };
  const retireStorage = (storageName: string) => {
    for (const candidate of input.candidates(storageName)) stageRemoval(candidate);
  };

  if (input.migration.write) stageWrite(input.migration.write.path, input.migration.write.data);
  for (const source of input.migration.removals) stageRemoval(source);

  const nextById = new Map(input.nextConnections.map((connection) => [connection.id, connection]));
  for (const previous of input.previousConnections) {
    if (input.requestedConnectionIds !== null && !input.requestedConnectionIds.has(previous.id)) {
      retireStorage(previous.storageName);
      continue;
    }
    const next = nextById.get(previous.id);
    if (next && (next.scope !== previous.scope || next.requiresKey !== previous.requiresKey)) {
      retireStorage(previous.storageName);
    }
  }

  for (const connection of input.nextConnections) {
    if (!connection.requiresKey) retireStorage(connection.storageName);
  }

  for (const update of input.updates) {
    const connection = nextById.get(update.connectionId);
    if (!connection) throw new Error("A credential mutation targets an unknown connection.");
    const target = input.currentPath(connection.storageName);
    if (update.data) {
      stageWrite(target, update.data);
      for (const candidate of input.candidates(connection.storageName)) {
        if (input.pathIdentity(candidate) !== input.pathIdentity(target)) stageRemoval(candidate);
      }
    } else {
      retireStorage(connection.storageName);
    }
  }

  return { writes: [...writes.values()], removals: [...removals.values()] };
}
