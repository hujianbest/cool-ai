const FIXTURE_LEASE_AT = "2099-01-01T00:00:00.000Z";

export function workItemLeaseColumns(
  status: string,
  assigneeId: string | null | undefined,
  options?: { at?: string; token?: string },
): {
  lastHeartbeatAt: string | null;
  leaseExpiresAt: string | null;
  leaseToken: string | null;
} {
  if (status === "in_progress" && assigneeId) {
    const at = options?.at ?? FIXTURE_LEASE_AT;
    return {
      lastHeartbeatAt: at,
      leaseExpiresAt: at,
      leaseToken: options?.token ?? `${assigneeId}-lease`,
    };
  }
  return {
    lastHeartbeatAt: null,
    leaseExpiresAt: null,
    leaseToken: null,
  };
}

export function workItemLeaseBind(
  status: string,
  assigneeId: string | null | undefined,
  options?: { at?: string; token?: string },
): [string | null, string | null, string | null] {
  const lease = workItemLeaseColumns(status, assigneeId, options);
  return [lease.leaseToken, lease.leaseExpiresAt, lease.lastHeartbeatAt];
}

export function workItemLeaseSqlValues(
  status: string,
  assigneeId: string | null | undefined,
  options?: { at?: string; token?: string },
): string {
  const [token, expiresAt, heartbeat] = workItemLeaseBind(status, assigneeId, options);
  const quote = (value: string | null) => (value === null ? "NULL" : `'${value}'`);
  return `${quote(token)},${quote(expiresAt)},${quote(heartbeat)}`;
}
