export const LEGACY_SYNTHETIC_CONVERSATION_PREFIX = 'stormdance:notebook:';

export const XMTP_ENVIRONMENTS = ['dev', 'production'] as const;
export type XmtpEnvironment = (typeof XMTP_ENVIRONMENTS)[number];

export interface NotebookBindingFields {
  xmtpTopic?: string | null;
  xmtpEnv?: XmtpEnvironment | null;
  xmtpBindings?: Partial<Record<XmtpEnvironment, string | null>>;
}

export interface PersistedBindingState {
  conversationId?: string | null;
}

export type PersistedBindingStates = Partial<
  Record<XmtpEnvironment, PersistedBindingState | null>
>;

export interface ResolvedNotebookBinding {
  env: XmtpEnvironment;
  conversationId: string | null;
}

/** Returns only real XMTP conversation IDs, excluding the pre-MLS local topic format. */
export const normalizeConversationId = (value: string | null | undefined): string | null => {
  const normalized = value?.trim();
  if (!normalized || normalized.startsWith(LEGACY_SYNTHETIC_CONVERSATION_PREFIX)) return null;
  return normalized;
};

const environmentLabel = (env: XmtpEnvironment) => env === 'dev' ? 'development' : 'production';

/**
 * Resolves the one environment to which a notebook's local collaborative state
 * belongs. Persisted state counts as an affinity even when group creation was
 * interrupted before a conversation ID was recorded.
 */
export function resolveSoleNotebookBinding(
  notebook: NotebookBindingFields | null | undefined,
  persistedStates: PersistedBindingStates = {},
): ResolvedNotebookBinding | null {
  const affinities = new Map<XmtpEnvironment, Set<string>>();
  const addAffinity = (env: XmtpEnvironment, conversationId?: string | null) => {
    let conversations = affinities.get(env);
    if (!conversations) {
      conversations = new Set();
      affinities.set(env, conversations);
    }
    const normalized = normalizeConversationId(conversationId);
    if (normalized) conversations.add(normalized);
  };

  for (const env of XMTP_ENVIRONMENTS) {
    const explicit = normalizeConversationId(notebook?.xmtpBindings?.[env]);
    if (explicit) addAffinity(env, explicit);

    const persisted = persistedStates[env];
    if (persisted !== undefined && persisted !== null) {
      addAffinity(env, persisted.conversationId);
    }
  }

  const legacyConversationId = normalizeConversationId(notebook?.xmtpTopic);
  if (legacyConversationId) {
    if (notebook?.xmtpEnv) {
      addAffinity(notebook.xmtpEnv, legacyConversationId);
    } else {
      const matchingEnvironments = XMTP_ENVIRONMENTS.filter((env) => (
        affinities.get(env)?.has(legacyConversationId)
      ));
      if (matchingEnvironments.length !== 1) {
        throw new Error(
          'This notebook has an XMTP group without a recorded environment; reconnect it before editing or sharing.',
        );
      }
      addAffinity(matchingEnvironments[0], legacyConversationId);
    }
  }

  if (affinities.size > 1) {
    throw new Error(
      'This notebook has collaboration data in both XMTP environments; storm.dance supports one environment per notebook.',
    );
  }
  if (affinities.size === 0) return null;

  const [env, conversations] = affinities.entries().next().value as [
    XmtpEnvironment,
    Set<string>,
  ];
  if (conversations.size > 1) {
    throw new Error(
      `This notebook is connected to multiple XMTP groups in ${environmentLabel(env)}.`,
    );
  }

  return {
    env,
    conversationId: conversations.values().next().value ?? null,
  };
}

/** Ensures a session or invitation cannot move a notebook across environments or groups. */
export function assertNotebookBindingEnvironment(
  binding: ResolvedNotebookBinding | null,
  requestedEnv: XmtpEnvironment,
  requestedConversationId?: string | null,
): void {
  if (!binding) return;
  if (binding.env !== requestedEnv) {
    throw new Error(
      `This notebook is already connected on XMTP ${environmentLabel(binding.env)}; switch to that environment to collaborate.`,
    );
  }

  const requested = normalizeConversationId(requestedConversationId);
  if (binding.conversationId && requested && binding.conversationId !== requested) {
    throw new Error(
      `This notebook is already connected to a different XMTP group in ${environmentLabel(requestedEnv)}.`,
    );
  }
}

/**
 * Resolves a notebook while accepting an invitation from an already-observed
 * group. An exact legacy topic match is sufficient evidence to fill only the
 * missing environment; all cross-environment and conflicting-group checks
 * still apply.
 */
export function resolveNotebookBindingForInvitation(
  notebook: NotebookBindingFields | null | undefined,
  persistedStates: PersistedBindingStates,
  env: XmtpEnvironment,
  conversationId: string,
): ResolvedNotebookBinding | null {
  const expected = normalizeConversationId(conversationId);
  if (!expected) throw new Error('This invitation does not contain a valid XMTP group ID.');

  const legacyTopic = normalizeConversationId(notebook?.xmtpTopic);
  const notebookWithObservedEnvironment = legacyTopic === expected && !notebook?.xmtpEnv
    ? { ...notebook, xmtpEnv: env }
    : notebook;
  const binding = resolveSoleNotebookBinding(notebookWithObservedEnvironment, persistedStates);
  assertNotebookBindingEnvironment(binding, env, expected);
  return binding;
}

/** Lightweight exact-match check used while discovering recoverable invitations. */
export function hasMatchingNotebookBinding(
  notebook: NotebookBindingFields | null | undefined,
  persistedStates: PersistedBindingStates,
  env: XmtpEnvironment,
  conversationId: string,
): boolean {
  const expected = normalizeConversationId(conversationId);
  if (!expected) return false;
  if (normalizeConversationId(notebook?.xmtpBindings?.[env]) === expected) return true;
  if (
    normalizeConversationId(notebook?.xmtpTopic) === expected
    && notebook?.xmtpEnv === env
  ) return true;
  return normalizeConversationId(persistedStates[env]?.conversationId) === expected;
}
