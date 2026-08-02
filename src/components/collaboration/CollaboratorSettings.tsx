import { useMemo, useState } from 'react';
import { Loader2, RefreshCw, ShieldCheck, Trash2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CollaborationRole, NotebookCollaborator } from '@/lib/collaboration/types';
import {
  canManageNotebookMembers,
  canManageNotebookRoles,
  collaborationRoleLabel,
  collaboratorName,
  collaboratorSecondaryIdentity,
} from './collaboratorUi';

interface CollaboratorSettingsProps {
  collaborators: NotebookCollaborator[];
  loading?: boolean;
  pending?: boolean;
  error?: string | null;
  onAdd: (value: string, role: CollaborationRole) => Promise<void>;
  onChangeRole: (inboxId: string, role: CollaborationRole) => Promise<void>;
  onRemove: (inboxId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

const roleOptions: CollaborationRole[] = ['member', 'admin', 'super-admin'];

export function CollaboratorSettings({
  collaborators,
  loading = false,
  pending = false,
  error,
  onAdd,
  onChangeRole,
  onRemove,
  onRefresh,
}: CollaboratorSettingsProps) {
  const [identity, setIdentity] = useState('');
  const [requestedRole, setRequestedRole] = useState<CollaborationRole>('member');
  const [submitting, setSubmitting] = useState(false);
  const self = useMemo(
    () => collaborators.find((collaborator) => collaborator.isCurrentUser),
    [collaborators],
  );
  const canManageMembers = canManageNotebookMembers(self?.role ?? null);
  const canManageRoles = canManageNotebookRoles(self?.role ?? null);
  const busy = loading || pending || submitting;

  const addCollaborator = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = identity.trim();
    if (!value || busy || !canManageMembers) return;
    setSubmitting(true);
    try {
      await onAdd(value, canManageRoles ? requestedRole : 'member');
      setIdentity('');
      setRequestedRole('member');
    } catch {
      // The owning hook publishes the actionable error through the `error` prop.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="space-y-4" aria-labelledby="notebook-collaborators-heading">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Users className="mt-0.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <div>
            <h3 id="notebook-collaborators-heading" className="text-sm font-medium">
              Collaborators
            </h3>
            <p className="text-xs text-muted-foreground">
              Membership and roles are enforced by the notebook&apos;s XMTP group.
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label="Refresh collaborators"
          title="Refresh collaborators"
          disabled={busy}
          onClick={() => void onRefresh().catch(() => undefined)}
        >
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>

      {canManageMembers ? (
        <form className="space-y-2" onSubmit={addCollaborator}>
          <label htmlFor="collaborator-identity" className="text-xs font-medium">
            Add by ENS name or Ethereum address
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="collaborator-identity"
              value={identity}
              onChange={(event) => setIdentity(event.target.value)}
              placeholder="alice.eth or 0x…"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
            <select
              aria-label="Role for new collaborator"
              value={canManageRoles ? requestedRole : 'member'}
              onChange={(event) => setRequestedRole(event.target.value as CollaborationRole)}
              disabled={busy || !canManageRoles}
              className="h-9 rounded-md border border-zinc-200 bg-transparent px-3 text-sm dark:border-zinc-800"
            >
              {roleOptions.map((role) => (
                <option key={role} value={role}>{collaborationRoleLabel(role)}</option>
              ))}
            </select>
            <Button type="submit" disabled={busy || !identity.trim()}>
              {submitting ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              Add
            </Button>
          </div>
        </form>
      ) : (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          An XMTP admin must add or remove collaborators.
        </p>
      )}

      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}

      <div className="max-h-64 space-y-2 overflow-y-auto" role="list" aria-label="Notebook collaborators">
        {loading && collaborators.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading collaborators…
          </div>
        ) : null}
        {!loading && collaborators.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">No XMTP group members found.</p>
        ) : null}
        {collaborators.map((collaborator) => {
          const name = collaboratorName(collaborator);
          const roleControlLabel = `Role for ${name}`;
          return (
            <div
              key={collaborator.inboxId}
              role="listitem"
              className="flex items-center justify-between gap-3 rounded-md border border-border/70 p-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{name}</span>
                  {collaborator.isCurrentUser ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">You</span>
                  ) : null}
                </div>
                <p
                  className="truncate font-mono text-[11px] text-muted-foreground"
                  title={`Inbox ID: ${collaborator.inboxId}`}
                >
                  {collaboratorSecondaryIdentity(collaborator)}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {canManageRoles && !collaborator.isCurrentUser ? (
                  <select
                    aria-label={roleControlLabel}
                    value={collaborator.role}
                    onChange={(event) => void onChangeRole(
                      collaborator.inboxId,
                      event.target.value as CollaborationRole,
                    ).catch(() => undefined)}
                    disabled={busy}
                    className="h-8 rounded-md border border-zinc-200 bg-transparent px-2 text-xs dark:border-zinc-800"
                  >
                    {roleOptions.map((role) => (
                      <option key={role} value={role}>{collaborationRoleLabel(role)}</option>
                    ))}
                  </select>
                ) : (
                  <span
                    className="inline-flex h-8 items-center gap-1 rounded-md bg-muted px-2 text-xs"
                    aria-label={`${roleControlLabel}: ${collaborationRoleLabel(collaborator.role)}`}
                  >
                    {collaborator.role !== 'member' ? <ShieldCheck className="h-3 w-3" aria-hidden="true" /> : null}
                    {collaborationRoleLabel(collaborator.role)}
                  </span>
                )}

                {canManageMembers && !collaborator.isCurrentUser ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${name}`}
                    title={`Remove ${name}`}
                    disabled={busy}
                    onClick={() => void onRemove(collaborator.inboxId).catch(() => undefined)}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Removing someone rotates access for future XMTP updates. It cannot erase notebook data they already downloaded.
      </p>
    </section>
  );
}
