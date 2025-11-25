import { ContentCodec, ContentTypeId as ContentTypeId$1, EncodedContent as EncodedContent$1 } from '@xmtp/content-type-primitives';
import * as _xmtp_wasm_bindings from '@xmtp/wasm-bindings';
import { Identifier, Conversations as Conversations$1, ConsentState, Message, Conversation as Conversation$1, ConversationType, Client as Client$1, ConsentEntityType, Consent, UserPreference, SignatureRequestHandle, KeyPackageStatus, PermissionUpdateType, PermissionPolicy, MetadataField, EncodedContent, MessageDisappearingSettings, HmacKey, ConversationDebugInfo, GroupPermissionsOptions, DeliveryStatus, GroupMessageKind, ContentType, SortDirection, PermissionLevel, ContentTypeId, ListMessagesOptions, ListConversationsOptions, PermissionPolicySet, CreateGroupOptions, CreateDMOptions, Installation, InboxState, GroupMember, ApiStats, IdentityStats } from '@xmtp/wasm-bindings';
export { Consent, ConsentEntityType, ConsentState, ContentType, ContentTypeId, ConversationListItem, ConversationType, CreateDMOptions, CreateGroupOptions, DeliveryStatus, EncodedContent, GroupMember, GroupMembershipState, GroupMessageKind, GroupMetadata, GroupPermissions, GroupPermissionsOptions, HmacKey, Identifier, IdentifierKind, InboxState, Installation, ListConversationsOptions, ListMessagesOptions, LogOptions, Message, MessageDisappearingSettings, MetadataField, PermissionLevel, PermissionPolicy, PermissionPolicySet, PermissionUpdateType, SignatureRequestHandle, SortDirection, UserPreference } from '@xmtp/wasm-bindings';
import { GroupUpdatedCodec } from '@xmtp/content-type-group-updated';
import { TextCodec } from '@xmtp/content-type-text';

type ResolveValue<T> = {
    value: T;
    done: boolean;
};
interface AsyncStreamProxy<T> extends AsyncIterable<T> {
    next(): Promise<ResolveValue<T>>;
    return(): Promise<ResolveValue<undefined>>;
    end(): Promise<ResolveValue<undefined>>;
    isDone: boolean;
}

declare const DEFAULT_RETRY_DELAY = 10000;
declare const DEFAULT_RETRY_ATTEMPTS = 6;
type StreamOptions<T = unknown, V = T> = {
    /**
     * Called when the stream ends
     */
    onEnd?: () => void;
    /**
     * Called when a stream error occurs
     */
    onError?: (error: Error) => void;
    /**
     * Called when the stream fails
     */
    onFail?: () => void;
    /**
     * Called when the stream is restarted
     */
    onRestart?: () => void;
    /**
     * Called when the stream is retried
     */
    onRetry?: (attempts: number, maxAttempts: number) => void;
    /**
     * Called when a value is emitted from the stream
     */
    onValue?: (value: V) => void;
    /**
     * The number of times to retry the stream
     * (default: 6)
     */
    retryAttempts?: number;
    /**
     * The delay between retries (in milliseconds)
     * (default: 10000)
     */
    retryDelay?: number;
    /**
     * Whether to retry the stream if it fails
     * (default: true)
     */
    retryOnFail?: boolean;
};
type StreamCallback<T = unknown> = (error: Error | null, value: T | undefined) => void;
type StreamFunction<T = unknown> = (callback: StreamCallback<T>, onFail: () => void) => Promise<() => void>;
type StreamValueMutator<T = unknown, V = T> = (value: T) => V | Promise<V>;
/**
 * Creates a stream from a stream function
 *
 * If the stream fails, an attempt will be made to restart it.
 *
 * This function is not intended to be used directly.
 *
 * @param streamFunction - The stream function to create a stream from
 * @param streamValueMutator - An optional function to mutate the value emitted from the stream
 * @param options - The options for the stream
 * @param args - Additional arguments to pass to the stream function
 * @returns An async iterable stream proxy
 * @throws {StreamInvalidRetryAttemptsError} if the retryAttempts option is less than 0 and retryOnFail is true
 * @throws {StreamFailedError} if the stream fails and can't be restarted
 */
declare const createStream: <T = unknown, V = T>(streamFunction: StreamFunction<T>, streamValueMutator?: StreamValueMutator<T, V>, options?: StreamOptions<T, V>) => Promise<AsyncStreamProxy<V>>;

/**
 * Pre-configured URLs for the XMTP network based on the environment
 *
 * @constant
 * @property {string} local - The local URL for the XMTP network
 * @property {string} dev - The development URL for the XMTP network
 * @property {string} production - The production URL for the XMTP network
 */
declare const ApiUrls: {
    readonly local: "http://localhost:5555";
    readonly dev: "https://dev.xmtp.network";
    readonly production: "https://production.xmtp.network";
};
/**
 * Pre-configured URLs for the XMTP history sync service based on the environment
 *
 * @constant
 * @property {string} local - The local URL for the XMTP history sync service
 * @property {string} dev - The development URL for the XMTP history sync service
 * @property {string} production - The production URL for the XMTP history sync service
 */
declare const HistorySyncUrls: {
    readonly local: "http://localhost:5558";
    readonly dev: "https://message-history.dev.ephemera.network";
    readonly production: "https://message-history.production.ephemera.network";
};

type XmtpEnv = keyof typeof ApiUrls;
/**
 * Network options
 */
type NetworkOptions = {
    /**
     * Specify which XMTP environment to connect to. (default: `dev`)
     */
    env?: XmtpEnv;
    /**
     * apiUrl can be used to override the `env` flag and connect to a
     * specific endpoint
     */
    apiUrl?: string;
    /**
     * historySyncUrl can be used to override the `env` flag and connect to a
     * specific endpoint for syncing history
     */
    historySyncUrl?: string | null;
};
type ContentOptions = {
    /**
     * Allow configuring codecs for additional content types
     */
    codecs?: ContentCodec[];
};
/**
 * Storage options
 */
type StorageOptions = {
    /**
     * Path to the local DB
     *
     * There are 3 value types that can be used to specify the database path:
     *
     * - `undefined` (or excluded from the client options)
     *    The database will be created in the current working directory and is based on
     *    the XMTP environment and client inbox ID.
     *    Example: `xmtp-dev-<inbox-id>.db3`
     *
     * - `null`
     *    No database will be created and all data will be lost once the client disconnects.
     *
     * - `string`
     *    The given path will be used to create the database.
     *    Example: `./my-db.db3`
     */
    dbPath?: string | null;
    /**
     * Encryption key for the local DB
     */
    dbEncryptionKey?: Uint8Array;
};
type OtherOptions = {
    /**
     * Enable structured JSON logging
     */
    structuredLogging?: boolean;
    /**
     * Enable performance metrics
     */
    performanceLogging?: boolean;
    /**
     * Logging level
     */
    loggingLevel?: "off" | "error" | "warn" | "info" | "debug" | "trace";
    /**
     * Disable automatic registration when creating a client
     */
    disableAutoRegister?: boolean;
    /**
     * Disable device sync
     */
    disableDeviceSync?: boolean;
    /**
     * Custom app version
     */
    appVersion?: string;
    /**
     * Should debug events be tracked
     * (default: false)
     */
    debugEventsEnabled?: boolean;
};
type ClientOptions = NetworkOptions & ContentOptions & StorageOptions & OtherOptions;

type SignMessage = (message: string) => Promise<Uint8Array> | Uint8Array;
type GetIdentifier = () => Promise<Identifier> | Identifier;
type GetChainId = () => bigint;
type GetBlockNumber = () => bigint;
type Signer = {
    type: "EOA";
    getIdentifier: GetIdentifier;
    signMessage: SignMessage;
} | {
    type: "SCW";
    getIdentifier: GetIdentifier;
    signMessage: SignMessage;
    getBlockNumber?: GetBlockNumber;
    getChainId: GetChainId;
};
type EOASigner = Extract<Signer, {
    type: "EOA";
}>;
type SCWSigner = Extract<Signer, {
    type: "SCW";
}>;
type SafeSigner = {
    type: "EOA";
    identifier: Identifier;
    signature: Uint8Array;
} | {
    type: "SCW";
    identifier: Identifier;
    signature: Uint8Array;
    chainId: bigint;
    blockNumber?: bigint;
};
declare const toSafeSigner: (signer: Signer, signature: Uint8Array) => Promise<SafeSigner>;

declare class WorkerConversations {
    #private;
    constructor(client: WorkerClient, conversations: Conversations$1);
    sync(): Promise<void>;
    syncAll(consentStates?: ConsentState[]): Promise<number>;
    getConversationById(id: string): WorkerConversation | undefined;
    getMessageById(id: string): Message | undefined;
    getDmByInboxId(inboxId: string): WorkerConversation | undefined;
    list(options?: SafeListConversationsOptions): WorkerConversation[];
    listGroups(options?: Omit<SafeListConversationsOptions, "conversation_type">): WorkerConversation[];
    listDms(options?: Omit<SafeListConversationsOptions, "conversation_type">): WorkerConversation[];
    newGroupOptimistic(options?: SafeCreateGroupOptions): WorkerConversation;
    newGroupWithIdentifiers(identifiers: Identifier[], options?: SafeCreateGroupOptions): Promise<WorkerConversation>;
    newGroup(inboxIds: string[], options?: SafeCreateGroupOptions): Promise<WorkerConversation>;
    newDmWithIdentifier(identifier: Identifier, options?: SafeCreateDmOptions): Promise<WorkerConversation>;
    newDm(inboxId: string, options?: SafeCreateDmOptions): Promise<WorkerConversation>;
    getHmacKeys(): HmacKeys;
    stream(callback: StreamCallback<Conversation$1>, onFail: () => void, conversationType?: ConversationType): _xmtp_wasm_bindings.StreamCloser;
    streamGroups(callback: StreamCallback<Conversation$1>, onFail: () => void): _xmtp_wasm_bindings.StreamCloser;
    streamDms(callback: StreamCallback<Conversation$1>, onFail: () => void): _xmtp_wasm_bindings.StreamCloser;
    streamAllMessages(callback: StreamCallback<Message>, onFail: () => void, conversationType?: ConversationType, consentStates?: ConsentState[]): _xmtp_wasm_bindings.StreamCloser;
}

/**
 * Debug information helpers for the client
 *
 * This class is not intended to be initialized directly.
 */
declare class WorkerDebugInformation {
    #private;
    constructor(client: Client$1, options?: ClientOptions);
    apiStatistics(): _xmtp_wasm_bindings.ApiStats;
    apiIdentityStatistics(): _xmtp_wasm_bindings.IdentityStats;
    apiAggregateStatistics(): string;
    clearAllStatistics(): void;
    uploadDebugArchive(serverUrl?: string): Promise<string>;
}

declare class WorkerPreferences {
    #private;
    constructor(client: Client$1, conversations: Conversations$1);
    sync(): Promise<number>;
    inboxState(refreshFromNetwork: boolean): Promise<_xmtp_wasm_bindings.InboxState>;
    inboxStateFromInboxIds(inboxIds: string[], refreshFromNetwork?: boolean): Promise<_xmtp_wasm_bindings.InboxState[]>;
    getLatestInboxState(inboxId: string): Promise<_xmtp_wasm_bindings.InboxState>;
    setConsentStates(records: SafeConsent[]): Promise<void>;
    getConsentState(entityType: ConsentEntityType, entity: string): Promise<_xmtp_wasm_bindings.ConsentState>;
    streamConsent(callback: StreamCallback<Consent[]>, onFail: () => void): _xmtp_wasm_bindings.StreamCloser;
    streamPreferences(callback: StreamCallback<UserPreference[]>, onFail: () => void): _xmtp_wasm_bindings.StreamCloser;
}

declare class WorkerClient {
    #private;
    constructor(client: Client$1, options?: ClientOptions);
    static create(identifier: Identifier, options?: Omit<ClientOptions, "codecs">): Promise<WorkerClient>;
    get accountIdentifier(): Identifier;
    get inboxId(): string;
    get installationId(): string;
    get installationIdBytes(): Uint8Array<ArrayBufferLike>;
    get isRegistered(): boolean;
    get conversations(): WorkerConversations;
    get debugInformation(): WorkerDebugInformation;
    get preferences(): WorkerPreferences;
    canMessage(identifiers: Identifier[]): Promise<Map<string, boolean>>;
    addSignature(signatureRequest: SignatureRequestHandle, signer: SafeSigner): Promise<void>;
    applySignatureRequest(signatureRequest: SignatureRequestHandle): Promise<void>;
    processSignatureRequest(signer: SafeSigner, signatureRequest: SignatureRequestHandle): Promise<void>;
    createInboxSignatureRequest(): SignatureRequestHandle | undefined;
    addAccountSignatureRequest(newAccountIdentifier: Identifier): Promise<SignatureRequestHandle>;
    removeAccountSignatureRequest(identifier: Identifier): Promise<SignatureRequestHandle>;
    revokeAllOtherInstallationsSignatureRequest(): Promise<SignatureRequestHandle>;
    revokeInstallationsSignatureRequest(installationIds: Uint8Array[]): Promise<SignatureRequestHandle>;
    changeRecoveryIdentifierSignatureRequest(identifier: Identifier): Promise<SignatureRequestHandle>;
    registerIdentity(signer: SafeSigner, signatureRequest: SignatureRequestHandle): Promise<void>;
    findInboxIdByIdentifier(identifier: Identifier): Promise<string | undefined>;
    signWithInstallationKey(signatureText: string): Uint8Array<ArrayBufferLike>;
    verifySignedWithInstallationKey(signatureText: string, signatureBytes: Uint8Array): boolean;
    verifySignedWithPublicKey(signatureText: string, signatureBytes: Uint8Array, publicKey: Uint8Array): boolean;
    getKeyPackageStatusesForInstallationIds(installationIds: string[]): Promise<Map<string, KeyPackageStatus>>;
}

declare class WorkerConversation {
    #private;
    constructor(client: WorkerClient, group: Conversation$1, isCommitLogForked?: boolean);
    get id(): string;
    get name(): string;
    updateName(name: string): Promise<void>;
    get imageUrl(): string;
    updateImageUrl(imageUrl: string): Promise<void>;
    get description(): string;
    updateDescription(description: string): Promise<void>;
    get isActive(): boolean;
    get isCommitLogForked(): boolean | undefined;
    get addedByInboxId(): string;
    get createdAtNs(): bigint;
    lastMessage(): Promise<Message | undefined>;
    metadata(): Promise<{
        creatorInboxId: string;
        conversationType: string;
    }>;
    members(): Promise<SafeGroupMember[]>;
    get admins(): string[];
    get superAdmins(): string[];
    get permissions(): {
        policyType: _xmtp_wasm_bindings.GroupPermissionsOptions;
        policySet: _xmtp_wasm_bindings.PermissionPolicySet;
    };
    updatePermission(permissionType: PermissionUpdateType, policy: PermissionPolicy, metadataField?: MetadataField): Promise<void>;
    isAdmin(inboxId: string): boolean;
    isSuperAdmin(inboxId: string): boolean;
    sync(): Promise<void>;
    addMembersByIdentifiers(identifiers: Identifier[]): Promise<void>;
    addMembers(inboxIds: string[]): Promise<void>;
    removeMembersByIdentifiers(identifiers: Identifier[]): Promise<void>;
    removeMembers(inboxIds: string[]): Promise<void>;
    addAdmin(inboxId: string): Promise<void>;
    removeAdmin(inboxId: string): Promise<void>;
    addSuperAdmin(inboxId: string): Promise<void>;
    removeSuperAdmin(inboxId: string): Promise<void>;
    publishMessages(): Promise<void>;
    sendOptimistic(encodedContent: EncodedContent): string;
    send(encodedContent: EncodedContent): Promise<string>;
    messages(options?: SafeListMessagesOptions): Promise<Message[]>;
    get consentState(): ConsentState;
    updateConsentState(state: ConsentState): void;
    dmPeerInboxId(): string;
    messageDisappearingSettings(): MessageDisappearingSettings | undefined;
    updateMessageDisappearingSettings(fromNs: bigint, inNs: bigint): Promise<void>;
    removeMessageDisappearingSettings(): Promise<void>;
    isMessageDisappearingEnabled(): boolean;
    stream(callback: StreamCallback<Message>, onFail: () => void): _xmtp_wasm_bindings.StreamCloser;
    pausedForVersion(): string | undefined;
    getHmacKeys(): Map<string, HmacKey[]>;
    debugInfo(): Promise<ConversationDebugInfo>;
    getDuplicateDms(): Promise<WorkerConversation[]>;
}

declare const toContentTypeId: (contentTypeId: ContentTypeId) => ContentTypeId$1;
declare const fromContentTypeId: (contentTypeId: ContentTypeId$1) => ContentTypeId;
type SafeContentTypeId = {
    authorityId: string;
    typeId: string;
    versionMajor: number;
    versionMinor: number;
};
declare const toSafeContentTypeId: (contentTypeId: ContentTypeId$1) => SafeContentTypeId;
declare const fromSafeContentTypeId: (contentTypeId: SafeContentTypeId) => ContentTypeId$1;
declare const toEncodedContent: (content: EncodedContent) => EncodedContent$1;
declare const fromEncodedContent: (content: EncodedContent$1) => EncodedContent;
type SafeEncodedContent = {
    type: SafeContentTypeId;
    parameters: Record<string, string>;
    fallback?: string;
    compression?: number;
    content: Uint8Array;
};
declare const toSafeEncodedContent: (content: EncodedContent$1) => SafeEncodedContent;
declare const fromSafeEncodedContent: (content: SafeEncodedContent) => EncodedContent$1;
type SafeMessage = {
    content: SafeEncodedContent;
    convoId: string;
    deliveryStatus: DeliveryStatus;
    id: string;
    kind: GroupMessageKind;
    senderInboxId: string;
    sentAtNs: bigint;
};
declare const toSafeMessage: (message: Message) => SafeMessage;
type SafeListMessagesOptions = {
    contentTypes?: ContentType[];
    deliveryStatus?: DeliveryStatus;
    direction?: SortDirection;
    limit?: bigint;
    sentAfterNs?: bigint;
    sentBeforeNs?: bigint;
};
declare const toSafeListMessagesOptions: (options: ListMessagesOptions) => SafeListMessagesOptions;
declare const fromSafeListMessagesOptions: (options: SafeListMessagesOptions) => ListMessagesOptions;
type SafeListConversationsOptions = {
    consentStates?: ConsentState[];
    conversationType?: ConversationType;
    createdAfterNs?: bigint;
    createdBeforeNs?: bigint;
    includeDuplicateDms?: boolean;
    limit?: bigint;
};
declare const toSafeListConversationsOptions: (options: ListConversationsOptions) => SafeListConversationsOptions;
declare const fromSafeListConversationsOptions: (options: SafeListConversationsOptions) => ListConversationsOptions;
type SafePermissionPolicySet = {
    addAdminPolicy: PermissionPolicy;
    addMemberPolicy: PermissionPolicy;
    removeAdminPolicy: PermissionPolicy;
    removeMemberPolicy: PermissionPolicy;
    updateGroupDescriptionPolicy: PermissionPolicy;
    updateGroupImageUrlSquarePolicy: PermissionPolicy;
    updateGroupNamePolicy: PermissionPolicy;
    updateMessageDisappearingPolicy: PermissionPolicy;
};
declare const toSafePermissionPolicySet: (policySet: PermissionPolicySet) => SafePermissionPolicySet;
declare const fromSafePermissionPolicySet: (policySet: SafePermissionPolicySet) => PermissionPolicySet;
type SafeCreateGroupOptions = {
    customPermissionPolicySet?: SafePermissionPolicySet;
    description?: string;
    imageUrlSquare?: string;
    messageDisappearingSettings?: SafeMessageDisappearingSettings;
    name?: string;
    permissions?: GroupPermissionsOptions;
};
declare const toSafeCreateGroupOptions: (options: CreateGroupOptions) => SafeCreateGroupOptions;
declare const fromSafeCreateGroupOptions: (options: SafeCreateGroupOptions) => CreateGroupOptions;
type SafeCreateDmOptions = {
    messageDisappearingSettings?: SafeMessageDisappearingSettings;
};
declare const toSafeCreateDmOptions: (options: CreateDMOptions) => SafeCreateDmOptions;
declare const fromSafeCreateDmOptions: (options: SafeCreateDmOptions) => CreateDMOptions;
type SafeConversation = {
    id: string;
    name: string;
    imageUrl: string;
    description: string;
    permissions: {
        policyType: GroupPermissionsOptions;
        policySet: {
            addAdminPolicy: PermissionPolicy;
            addMemberPolicy: PermissionPolicy;
            removeAdminPolicy: PermissionPolicy;
            removeMemberPolicy: PermissionPolicy;
            updateGroupDescriptionPolicy: PermissionPolicy;
            updateGroupImageUrlSquarePolicy: PermissionPolicy;
            updateGroupNamePolicy: PermissionPolicy;
            updateMessageDisappearingPolicy: PermissionPolicy;
        };
    };
    addedByInboxId: string;
    metadata: {
        creatorInboxId: string;
        conversationType: string;
    };
    admins: string[];
    superAdmins: string[];
    createdAtNs: bigint;
    isCommitLogForked?: boolean;
};
declare const toSafeConversation: (conversation: WorkerConversation) => Promise<SafeConversation>;
type SafeInstallation = {
    bytes: Uint8Array;
    clientTimestampNs?: bigint;
    id: string;
};
declare const toSafeInstallation: (installation: Installation) => SafeInstallation;
type SafeInboxState = {
    identifiers: Identifier[];
    inboxId: string;
    installations: SafeInstallation[];
    recoveryIdentifier: Identifier;
};
declare const toSafeInboxState: (inboxState: InboxState) => SafeInboxState;
type SafeConsent = {
    entity: string;
    entityType: ConsentEntityType;
    state: ConsentState;
};
declare const toSafeConsent: (consent: Consent) => SafeConsent;
declare const fromSafeConsent: (consent: SafeConsent) => Consent;
type SafeGroupMember = {
    accountIdentifiers: Identifier[];
    consentState: ConsentState;
    inboxId: string;
    installationIds: string[];
    permissionLevel: PermissionLevel;
};
declare const toSafeGroupMember: (member: GroupMember) => SafeGroupMember;
declare const fromSafeGroupMember: (member: SafeGroupMember) => GroupMember;
type SafeHmacKey = {
    key: Uint8Array;
    epoch: bigint;
};
declare const toSafeHmacKey: (hmacKey: HmacKey) => SafeHmacKey;
type HmacKeys = Map<string, HmacKey[]>;
type SafeHmacKeys = Record<string, SafeHmacKey[]>;
type SafeMessageDisappearingSettings = {
    fromNs: bigint;
    inNs: bigint;
};
declare const toSafeMessageDisappearingSettings: (settings: MessageDisappearingSettings) => SafeMessageDisappearingSettings;
declare const fromSafeMessageDisappearingSettings: (settings: SafeMessageDisappearingSettings) => MessageDisappearingSettings;
type SafeKeyPackageStatus = {
    lifetime?: {
        notBefore: bigint;
        notAfter: bigint;
    };
    validationError?: string;
};
declare const toSafeKeyPackageStatus: (status: KeyPackageStatus) => SafeKeyPackageStatus;
type SafeConversationDebugInfo = {
    epoch: bigint;
    maybeForked: boolean;
    forkDetails: string;
    isCommitLogForked?: boolean;
    localCommitLog: string;
    remoteCommitLog: string;
    cursor: bigint;
};
declare const toSafeConversationDebugInfo: (debugInfo: ConversationDebugInfo) => SafeConversationDebugInfo;
type SafeApiStats = {
    fetchKeyPackage: bigint;
    queryGroupMessages: bigint;
    queryWelcomeMessages: bigint;
    sendGroupMessages: bigint;
    sendWelcomeMessages: bigint;
    subscribeMessages: bigint;
    subscribeWelcomes: bigint;
    uploadKeyPackage: bigint;
};
declare const toSafeApiStats: (stats: ApiStats) => SafeApiStats;
type SafeIdentityStats = {
    getIdentityUpdatesV2: bigint;
    getInboxIds: bigint;
    publishIdentityUpdate: bigint;
    verifySmartContractWalletSignature: bigint;
};
declare const toSafeIdentityStats: (stats: IdentityStats) => SafeIdentityStats;

type ClientAction = {
    action: "client.init";
    id: string;
    result: {
        inboxId: string;
        installationId: string;
        installationIdBytes: Uint8Array;
    };
    data: {
        identifier: Identifier;
        options?: ClientOptions;
    };
} | {
    action: "client.applySignatureRequest";
    id: string;
    result: undefined;
    data: {
        signer: SafeSigner;
        signatureRequestId: string;
    };
} | {
    action: "client.createInboxSignatureText";
    id: string;
    result: {
        signatureText?: string;
        signatureRequestId?: string;
    };
    data: {
        signatureRequestId: string;
    };
} | {
    action: "client.addAccountSignatureText";
    id: string;
    result: {
        signatureText: string;
        signatureRequestId: string;
    };
    data: {
        newIdentifier: Identifier;
        signatureRequestId: string;
    };
} | {
    action: "client.removeAccountSignatureText";
    id: string;
    result: {
        signatureText: string;
        signatureRequestId: string;
    };
    data: {
        identifier: Identifier;
        signatureRequestId: string;
    };
} | {
    action: "client.revokeAllOtherInstallationsSignatureText";
    id: string;
    result: {
        signatureText: string;
        signatureRequestId: string;
    };
    data: {
        signatureRequestId: string;
    };
} | {
    action: "client.revokeInstallationsSignatureText";
    id: string;
    result: {
        signatureText: string;
        signatureRequestId: string;
    };
    data: {
        installationIds: Uint8Array[];
        signatureRequestId: string;
    };
} | {
    action: "client.changeRecoveryIdentifierSignatureText";
    id: string;
    result: {
        signatureText: string;
        signatureRequestId: string;
    };
    data: {
        identifier: Identifier;
        signatureRequestId: string;
    };
} | {
    action: "client.registerIdentity";
    id: string;
    result: undefined;
    data: {
        signer: SafeSigner;
        signatureRequestId: string;
    };
} | {
    action: "client.addAccount";
    id: string;
    result: undefined;
    data: {
        identifier: Identifier;
        signer: SafeSigner;
        signatureRequestId: string;
    };
} | {
    action: "client.removeAccount";
    id: string;
    result: undefined;
    data: {
        identifier: Identifier;
        signer: SafeSigner;
        signatureRequestId: string;
    };
} | {
    action: "client.revokeAllOtherInstallations";
    id: string;
    result: undefined;
    data: {
        signer: SafeSigner;
        signatureRequestId: string;
    };
} | {
    action: "client.changeRecoveryIdentifier";
    id: string;
    result: undefined;
    data: {
        identifier: Identifier;
        signer: SafeSigner;
        signatureRequestId: string;
    };
} | {
    action: "client.revokeInstallations";
    id: string;
    result: undefined;
    data: {
        installationIds: Uint8Array[];
        signer: SafeSigner;
        signatureRequestId: string;
    };
} | {
    action: "client.isRegistered";
    id: string;
    result: boolean;
    data: undefined;
} | {
    action: "client.canMessage";
    id: string;
    result: Map<string, boolean>;
    data: {
        identifiers: Identifier[];
    };
} | {
    action: "client.findInboxIdByIdentifier";
    id: string;
    result: string | undefined;
    data: {
        identifier: Identifier;
    };
} | {
    action: "client.signWithInstallationKey";
    id: string;
    result: Uint8Array;
    data: {
        signatureText: string;
    };
} | {
    action: "client.verifySignedWithInstallationKey";
    id: string;
    result: boolean;
    data: {
        signatureText: string;
        signatureBytes: Uint8Array;
    };
} | {
    action: "client.verifySignedWithPublicKey";
    id: string;
    result: boolean;
    data: {
        signatureText: string;
        signatureBytes: Uint8Array;
        publicKey: Uint8Array;
    };
} | {
    action: "client.getKeyPackageStatusesForInstallationIds";
    id: string;
    result: Map<string, SafeKeyPackageStatus>;
    data: {
        installationIds: string[];
    };
};

type ConversationAction = {
    action: "conversation.sync";
    id: string;
    result: SafeConversation;
    data: {
        id: string;
    };
} | {
    action: "conversation.send";
    id: string;
    result: string;
    data: {
        id: string;
        content: SafeEncodedContent;
    };
} | {
    action: "conversation.sendOptimistic";
    id: string;
    result: string;
    data: {
        id: string;
        content: SafeEncodedContent;
    };
} | {
    action: "conversation.publishMessages";
    id: string;
    result: undefined;
    data: {
        id: string;
    };
} | {
    action: "conversation.messages";
    id: string;
    result: SafeMessage[];
    data: {
        id: string;
        options?: SafeListMessagesOptions;
    };
} | {
    action: "conversation.members";
    id: string;
    result: SafeGroupMember[];
    data: {
        id: string;
    };
} | {
    action: "conversation.messageDisappearingSettings";
    id: string;
    result: SafeMessageDisappearingSettings | undefined;
    data: {
        id: string;
    };
} | {
    action: "conversation.updateMessageDisappearingSettings";
    id: string;
    result: undefined;
    data: SafeMessageDisappearingSettings & {
        id: string;
    };
} | {
    action: "conversation.removeMessageDisappearingSettings";
    id: string;
    result: undefined;
    data: {
        id: string;
    };
} | {
    action: "conversation.isMessageDisappearingEnabled";
    id: string;
    result: boolean;
    data: {
        id: string;
    };
} | {
    action: "conversation.stream";
    id: string;
    result: undefined;
    data: {
        groupId: string;
        streamId: string;
    };
} | {
    action: "conversation.pausedForVersion";
    id: string;
    result: string | undefined;
    data: {
        id: string;
    };
} | {
    action: "conversation.getHmacKeys";
    id: string;
    result: Map<string, SafeHmacKey[]>;
    data: {
        id: string;
    };
} | {
    action: "conversation.debugInfo";
    id: string;
    result: SafeConversationDebugInfo;
    data: {
        id: string;
    };
} | {
    action: "conversation.consentState";
    id: string;
    result: ConsentState;
    data: {
        id: string;
    };
} | {
    action: "conversation.updateConsentState";
    id: string;
    result: undefined;
    data: {
        id: string;
        state: ConsentState;
    };
} | {
    action: "conversation.lastMessage";
    id: string;
    result: SafeMessage | undefined;
    data: {
        id: string;
    };
} | {
    action: "conversation.isActive";
    id: string;
    result: boolean;
    data: {
        id: string;
    };
};

type ConversationsAction = {
    action: "conversations.getConversationById";
    id: string;
    result: SafeConversation | undefined;
    data: {
        id: string;
    };
} | {
    action: "conversations.getMessageById";
    id: string;
    result: SafeMessage | undefined;
    data: {
        id: string;
    };
} | {
    action: "conversations.getDmByInboxId";
    id: string;
    result: SafeConversation | undefined;
    data: {
        inboxId: string;
    };
} | {
    action: "conversations.list";
    id: string;
    result: SafeConversation[];
    data: {
        options?: SafeListConversationsOptions;
    };
} | {
    action: "conversations.listGroups";
    id: string;
    result: SafeConversation[];
    data: {
        options?: Omit<SafeListConversationsOptions, "conversation_type">;
    };
} | {
    action: "conversations.listDms";
    id: string;
    result: SafeConversation[];
    data: {
        options?: Omit<SafeListConversationsOptions, "conversation_type">;
    };
} | {
    action: "conversations.newGroupOptimistic";
    id: string;
    result: SafeConversation;
    data: {
        options?: SafeCreateGroupOptions;
    };
} | {
    action: "conversations.newGroupWithIdentifiers";
    id: string;
    result: SafeConversation;
    data: {
        identifiers: Identifier[];
        options?: SafeCreateGroupOptions;
    };
} | {
    action: "conversations.newGroup";
    id: string;
    result: SafeConversation;
    data: {
        inboxIds: string[];
        options?: SafeCreateGroupOptions;
    };
} | {
    action: "conversations.newDmWithIdentifier";
    id: string;
    result: SafeConversation;
    data: {
        identifier: Identifier;
        options?: SafeCreateDmOptions;
    };
} | {
    action: "conversations.newDm";
    id: string;
    result: SafeConversation;
    data: {
        inboxId: string;
        options?: SafeCreateDmOptions;
    };
} | {
    action: "conversations.sync";
    id: string;
    result: undefined;
    data: undefined;
} | {
    action: "conversations.syncAll";
    id: string;
    result: undefined;
    data: {
        consentStates?: ConsentState[];
    };
} | {
    action: "conversations.getHmacKeys";
    id: string;
    result: SafeHmacKeys;
    data: undefined;
} | {
    action: "conversations.stream";
    id: string;
    result: undefined;
    data: {
        streamId: string;
        conversationType?: ConversationType;
    };
} | {
    action: "conversations.streamAllMessages";
    id: string;
    result: undefined;
    data: {
        streamId: string;
        conversationType?: ConversationType;
        consentStates?: ConsentState[];
    };
};

type DebugInformationAction = {
    action: "debugInformation.apiStatistics";
    id: string;
    result: SafeApiStats;
    data: undefined;
} | {
    action: "debugInformation.apiIdentityStatistics";
    id: string;
    result: SafeIdentityStats;
    data: undefined;
} | {
    action: "debugInformation.apiAggregateStatistics";
    id: string;
    result: string;
    data: undefined;
} | {
    action: "debugInformation.clearAllStatistics";
    id: string;
    result: undefined;
    data: undefined;
} | {
    action: "debugInformation.uploadDebugArchive";
    id: string;
    result: string;
    data: {
        serverUrl?: string;
    };
};

type DmAction = {
    action: "dm.peerInboxId";
    id: string;
    result: string;
    data: {
        id: string;
    };
} | {
    action: "dm.getDuplicateDms";
    id: string;
    result: SafeConversation[];
    data: {
        id: string;
    };
};

type GroupAction = {
    action: "group.listAdmins";
    id: string;
    result: string[];
    data: {
        id: string;
    };
} | {
    action: "group.listSuperAdmins";
    id: string;
    result: string[];
    data: {
        id: string;
    };
} | {
    action: "group.isAdmin";
    id: string;
    result: boolean;
    data: {
        id: string;
        inboxId: string;
    };
} | {
    action: "group.isSuperAdmin";
    id: string;
    result: boolean;
    data: {
        id: string;
        inboxId: string;
    };
} | {
    action: "group.addMembersByIdentifiers";
    id: string;
    result: undefined;
    data: {
        id: string;
        identifiers: Identifier[];
    };
} | {
    action: "group.removeMembersByIdentifiers";
    id: string;
    result: undefined;
    data: {
        id: string;
        identifiers: Identifier[];
    };
} | {
    action: "group.addMembers";
    id: string;
    result: undefined;
    data: {
        id: string;
        inboxIds: string[];
    };
} | {
    action: "group.removeMembers";
    id: string;
    result: undefined;
    data: {
        id: string;
        inboxIds: string[];
    };
} | {
    action: "group.addAdmin";
    id: string;
    result: undefined;
    data: {
        id: string;
        inboxId: string;
    };
} | {
    action: "group.removeAdmin";
    id: string;
    result: undefined;
    data: {
        id: string;
        inboxId: string;
    };
} | {
    action: "group.addSuperAdmin";
    id: string;
    result: undefined;
    data: {
        id: string;
        inboxId: string;
    };
} | {
    action: "group.removeSuperAdmin";
    id: string;
    result: undefined;
    data: {
        id: string;
        inboxId: string;
    };
} | {
    action: "group.updateName";
    id: string;
    result: undefined;
    data: {
        id: string;
        name: string;
    };
} | {
    action: "group.updateDescription";
    id: string;
    result: undefined;
    data: {
        id: string;
        description: string;
    };
} | {
    action: "group.updateImageUrl";
    id: string;
    result: undefined;
    data: {
        id: string;
        imageUrl: string;
    };
} | {
    action: "group.updatePermission";
    id: string;
    result: undefined;
    data: {
        id: string;
        permissionType: PermissionUpdateType;
        policy: PermissionPolicy;
        metadataField?: MetadataField;
    };
} | {
    action: "group.permissions";
    id: string;
    result: SafeConversation["permissions"];
    data: {
        id: string;
    };
};

type PreferencesAction = {
    action: "preferences.inboxState";
    id: string;
    result: SafeInboxState;
    data: {
        refreshFromNetwork: boolean;
    };
} | {
    action: "preferences.inboxStateFromInboxIds";
    id: string;
    result: SafeInboxState[];
    data: {
        inboxIds: string[];
        refreshFromNetwork: boolean;
    };
} | {
    action: "preferences.getLatestInboxState";
    id: string;
    result: SafeInboxState;
    data: {
        inboxId: string;
    };
} | {
    action: "preferences.setConsentStates";
    id: string;
    result: undefined;
    data: {
        records: SafeConsent[];
    };
} | {
    action: "preferences.getConsentState";
    id: string;
    result: ConsentState;
    data: {
        entityType: ConsentEntityType;
        entity: string;
    };
} | {
    action: "preferences.sync";
    id: string;
    result: number;
    data: undefined;
} | {
    action: "preferences.streamConsent";
    id: string;
    result: undefined;
    data: {
        streamId: string;
    };
} | {
    action: "preferences.streamPreferences";
    id: string;
    result: undefined;
    data: {
        streamId: string;
    };
};

type UnknownAction = {
    action: string;
    id: string;
    result: unknown;
    data: unknown;
};
type ClientWorkerAction = {
    action: "endStream";
    id: string;
    result: undefined;
    data: {
        streamId: string;
    };
} | ClientAction | ConversationAction | ConversationsAction | DmAction | GroupAction | PreferencesAction | DebugInformationAction;
type ActionName<T extends UnknownAction> = T["action"];
type ExtractAction<T extends UnknownAction, A extends ActionName<T>> = Extract<T, {
    action: A;
}>;
type ExtractActionData<T extends UnknownAction, A extends ActionName<T>> = ExtractAction<T, A>["data"];
type ExtractActionResult<T extends UnknownAction, A extends ActionName<T>> = ExtractAction<T, A>["result"];
type ActionWithoutData<T extends UnknownAction> = {
    [A in T["action"]]: Omit<Extract<T, {
        action: A;
    }>, "data">;
}[T["action"]];
type ActionErrorData<T extends UnknownAction> = {
    id: string;
    action: ActionName<T>;
    error: Error;
};

type StreamAction = {
    action: "stream.message";
    streamId: string;
    result: SafeMessage | undefined;
} | {
    action: "stream.conversation";
    streamId: string;
    result: SafeConversation | undefined;
} | {
    action: "stream.consent";
    streamId: string;
    result: SafeConsent[] | undefined;
} | {
    action: "stream.preferences";
    streamId: string;
    result: UserPreference[] | undefined;
} | {
    action: "stream.fail";
    streamId: string;
    result: undefined;
};

/**
 * Class that sets up a worker and provides communications for client functions
 *
 * This class is not meant to be used directly, it is extended by the Client class
 * to provide an interface to the worker.
 *
 * @param worker - The worker to use for the client class
 * @param enableLogging - Whether to enable logging in the worker
 * @returns A new ClientWorkerClass instance
 */
declare class ClientWorkerClass {
    #private;
    constructor(worker: Worker, enableLogging: boolean);
    /**
     * Sends an action message to the client worker
     *
     * @param action - The action to send to the worker
     * @param data - The data to send to the worker
     * @returns A promise that resolves when the action is completed
     */
    sendMessage<A extends ActionName<ClientWorkerAction>>(action: A, data: ExtractActionData<ClientWorkerAction, A>): [ExtractActionResult<ClientWorkerAction, A>] extends [undefined] ? Promise<void> : Promise<ExtractActionResult<ClientWorkerAction, A>>;
    /**
     * Handles a message from the client worker
     *
     * @param event - The event to handle
     */
    handleMessage: (event: MessageEvent<ActionWithoutData<ClientWorkerAction> | ActionErrorData<ClientWorkerAction>>) => void;
    /**
     * Handles a stream message from the client worker
     *
     * @param streamId - The ID of the stream to handle
     * @param callback - The callback to handle the stream message
     * @returns A function to remove the stream handler
     */
    handleStreamMessage: <T extends StreamAction["result"], V = T>(streamId: string, callback: (error: Error | null, value: T | undefined) => void, options?: StreamOptions<T, V>) => () => Promise<void>;
    /**
     * Removes all event listeners and terminates the worker
     */
    close(): void;
}

type MessageKind = "application" | "membership_change";
type MessageDeliveryStatus = "unpublished" | "published" | "failed";
/**
 * Represents a decoded XMTP message
 *
 * This class transforms network messages into a structured format with
 * content decoding.
 *
 * @class
 * @property {any} content - The decoded content of the message
 * @property {ContentTypeId} contentType - The content type of the message content
 * @property {string} conversationId - Unique identifier for the conversation
 * @property {MessageDeliveryStatus} deliveryStatus - Current delivery status of the message ("unpublished" | "published" | "failed")
 * @property {string} [fallback] - Optional fallback text for the message
 * @property {number} [compression] - Optional compression level applied to the message
 * @property {string} id - Unique identifier for the message
 * @property {MessageKind} kind - Type of message ("application" | "membership_change")
 * @property {Map<string, string>} parameters - Additional parameters associated with the message
 * @property {SafeMessage["content"]} encodedContent - Raw encoded content of the message
 * @property {string} senderInboxId - Identifier for the sender's inbox
 * @property {bigint} sentAtNs - Timestamp when the message was sent (in nanoseconds)
 */
declare class DecodedMessage<ContentTypes = unknown> {
    #private;
    content: ContentTypes | undefined;
    contentType: ContentTypeId$1;
    conversationId: string;
    deliveryStatus: MessageDeliveryStatus;
    fallback?: string;
    compression?: number;
    id: string;
    kind: MessageKind;
    parameters: Map<string, string>;
    encodedContent: SafeMessage["content"];
    senderInboxId: string;
    sentAtNs: bigint;
    constructor(client: Client<ContentTypes>, message: SafeMessage);
}

/**
 * Represents a conversation
 *
 * This class is not intended to be initialized directly.
 */
declare class Conversation<ContentTypes = unknown> {
    #private;
    /**
     * Creates a new conversation instance
     *
     * @param client - The client instance managing the conversation
     * @param id - The unique identifier for this conversation
     * @param data - Optional conversation data to initialize with
     */
    constructor(client: Client<ContentTypes>, id: string, data?: SafeConversation);
    get id(): string;
    get isCommitLogForked(): boolean | undefined;
    get addedByInboxId(): string | undefined;
    get createdAtNs(): bigint | undefined;
    get createdAt(): Date | undefined;
    get metadata(): {
        creatorInboxId: string;
        conversationType: string;
    } | undefined;
    lastMessage(): Promise<DecodedMessage<ContentTypes> | undefined>;
    isActive(): Promise<boolean>;
    /**
     * Gets the conversation members
     *
     * @returns Promise that resolves with the conversation members
     */
    members(): Promise<SafeGroupMember[]>;
    /**
     * Synchronizes conversation data from the network
     *
     * @returns Promise that resolves with the updated conversation data
     */
    sync(): Promise<SafeConversation>;
    /**
     * Publishes pending messages that were sent optimistically
     *
     * @returns Promise that resolves when publishing is complete
     */
    publishMessages(): Promise<void>;
    /**
     * Prepares a message to be published
     *
     * @param content - The content to send
     * @param contentType - Optional content type of the message content
     * @returns Promise that resolves with the message ID
     * @throws {MissingContentTypeError} if content type is required but not provided
     */
    sendOptimistic(content: ContentTypes, contentType?: ContentTypeId$1): Promise<string>;
    /**
     * Publishes a new message
     *
     * @param content - The content to send
     * @param contentType - Optional content type of the message content
     * @returns Promise that resolves with the message ID after it has been sent
     * @throws {MissingContentTypeError} if content type is required but not provided
     */
    send(content: ContentTypes, contentType?: ContentTypeId$1): Promise<string>;
    /**
     * Lists messages in this conversation
     *
     * @param options - Optional filtering and pagination options
     * @returns Promise that resolves with an array of decoded messages
     */
    messages(options?: SafeListMessagesOptions): Promise<DecodedMessage<ContentTypes>[]>;
    /**
     * Gets the consent state for this conversation
     *
     * @returns Promise that resolves with the current consent state
     */
    consentState(): Promise<ConsentState>;
    /**
     * Updates the consent state for this conversation
     *
     * @param state - The new consent state to set
     * @returns Promise that resolves when the update is complete
     */
    updateConsentState(state: ConsentState): Promise<void>;
    /**
     * Gets the message disappearing settings for this conversation
     *
     * @returns Promise that resolves with the current message disappearing settings
     */
    messageDisappearingSettings(): Promise<SafeMessageDisappearingSettings | undefined>;
    /**
     * Updates message disappearing settings for this conversation
     *
     * @param fromNs - The timestamp from which messages should start disappearing
     * @param inNs - The duration after which messages should disappear
     * @returns Promise that resolves when the update is complete
     */
    updateMessageDisappearingSettings(fromNs: bigint, inNs: bigint): Promise<void>;
    /**
     * Removes message disappearing settings from this conversation
     *
     * @returns Promise that resolves when the settings are removed
     */
    removeMessageDisappearingSettings(): Promise<void>;
    /**
     * Checks if message disappearing is enabled for this conversation
     *
     * @returns Promise that resolves with whether message disappearing is enabled
     */
    isMessageDisappearingEnabled(): Promise<boolean>;
    /**
     * Creates a stream for new messages in this conversation
     *
     * @param callback - Optional callback function for handling new stream values
     * @returns Stream instance for new messages
     */
    stream(options?: StreamOptions<SafeMessage, DecodedMessage<ContentTypes>>): Promise<AsyncStreamProxy<DecodedMessage<ContentTypes>>>;
    pausedForVersion(): Promise<string | undefined>;
    /**
     * Retrieves HMAC keys for this conversation
     *
     * @returns Promise that resolves with the HMAC keys
     */
    getHmacKeys(): Promise<Map<string, SafeHmacKey[]>>;
    /**
     * Retrieves information for this conversation to help with debugging
     *
     * @returns The debug information for this conversation
     */
    debugInfo(): Promise<SafeConversationDebugInfo>;
}

/**
 * Represents a direct message conversation between two inboxes
 *
 * This class is not intended to be initialized directly.
 */
declare class Dm<ContentTypes = unknown> extends Conversation<ContentTypes> {
    #private;
    /**
     * Creates a new direct message conversation instance
     *
     * @param client - The client instance managing this direct message conversation
     * @param id - Identifier for the direct message conversation
     * @param data - Optional conversation data to initialize with
     */
    constructor(client: Client<ContentTypes>, id: string, data?: SafeConversation);
    /**
     * Retrieves the inbox ID of the other participant in the DM
     *
     * @returns Promise that resolves with the peer's inbox ID
     */
    peerInboxId(): Promise<string>;
    getDuplicateDms(): Promise<SafeConversation[]>;
}

/**
 * Represents a group conversation between multiple inboxes
 *
 * This class is not intended to be initialized directly.
 */
declare class Group<ContentTypes = unknown> extends Conversation<ContentTypes> {
    #private;
    /**
     * Creates a new group conversation instance
     *
     * @param client - The client instance managing this group conversation
     * @param id - Identifier for the group conversation
     * @param data - Optional conversation data to initialize with
     */
    constructor(client: Client<ContentTypes>, id: string, data?: SafeConversation);
    /**
     * Synchronizes the group's data with the network
     *
     * @returns Updated group data
     */
    sync(): Promise<SafeConversation>;
    /**
     * The name of the group
     */
    get name(): string | undefined;
    /**
     * Updates the group's name
     *
     * @param name The new name for the group
     */
    updateName(name: string): Promise<void>;
    /**
     * The image URL of the group
     */
    get imageUrl(): string | undefined;
    /**
     * Updates the group's image URL
     *
     * @param imageUrl The new image URL for the group
     */
    updateImageUrl(imageUrl: string): Promise<void>;
    /**
     * The description of the group
     */
    get description(): string | undefined;
    /**
     * Updates the group's description
     *
     * @param description The new description for the group
     */
    updateDescription(description: string): Promise<void>;
    /**
     * The list of admins of the group by inbox ID
     */
    get admins(): string[];
    /**
     * The list of super admins of the group by inbox ID
     */
    get superAdmins(): string[];
    /**
     * Fetches and updates the list of group admins from the server
     *
     * @returns Array of admin inbox IDs
     */
    listAdmins(): Promise<string[]>;
    /**
     * Fetches and updates the list of group super admins from the server
     *
     * @returns Array of super admin inbox IDs
     */
    listSuperAdmins(): Promise<string[]>;
    /**
     * Retrieves the group's permissions
     *
     * @returns The group's permissions
     */
    permissions(): Promise<{
        policyType: _xmtp_wasm_bindings.GroupPermissionsOptions;
        policySet: {
            addAdminPolicy: PermissionPolicy;
            addMemberPolicy: PermissionPolicy;
            removeAdminPolicy: PermissionPolicy;
            removeMemberPolicy: PermissionPolicy;
            updateGroupDescriptionPolicy: PermissionPolicy;
            updateGroupImageUrlSquarePolicy: PermissionPolicy;
            updateGroupNamePolicy: PermissionPolicy;
            updateMessageDisappearingPolicy: PermissionPolicy;
        };
    }>;
    /**
     * Updates a specific permission policy for the group
     *
     * @param permissionType The type of permission to update
     * @param policy The new permission policy
     * @param metadataField Optional metadata field for the permission
     */
    updatePermission(permissionType: PermissionUpdateType, policy: PermissionPolicy, metadataField?: MetadataField): Promise<void>;
    /**
     * Checks if an inbox is an admin of the group
     *
     * @param inboxId The inbox ID to check
     * @returns Boolean indicating if the inbox is an admin
     */
    isAdmin(inboxId: string): Promise<boolean>;
    /**
     * Checks if an inbox is a super admin of the group
     *
     * @param inboxId The inbox ID to check
     * @returns Boolean indicating if the inbox is a super admin
     */
    isSuperAdmin(inboxId: string): Promise<boolean>;
    /**
     * Adds members to the group using identifiers
     *
     * @param identifiers Array of member identifiers to add
     */
    addMembersByIdentifiers(identifiers: Identifier[]): Promise<void>;
    /**
     * Adds members to the group using inbox IDs
     *
     * @param inboxIds Array of inbox IDs to add
     */
    addMembers(inboxIds: string[]): Promise<void>;
    /**
     * Removes members from the group using identifiers
     *
     * @param identifiers Array of member identifiers to remove
     */
    removeMembersByIdentifiers(identifiers: Identifier[]): Promise<void>;
    /**
     * Removes members from the group using inbox IDs
     *
     * @param inboxIds Array of inbox IDs to remove
     */
    removeMembers(inboxIds: string[]): Promise<void>;
    /**
     * Promotes a group member to admin status
     *
     * @param inboxId The inbox ID of the member to promote
     */
    addAdmin(inboxId: string): Promise<void>;
    /**
     * Removes admin status from a group member
     *
     * @param inboxId The inbox ID of the admin to demote
     */
    removeAdmin(inboxId: string): Promise<void>;
    /**
     * Promotes a group member to super admin status
     *
     * @param inboxId The inbox ID of the member to promote
     */
    addSuperAdmin(inboxId: string): Promise<void>;
    /**
     * Removes super admin status from a group member
     *
     * @param inboxId The inbox ID of the super admin to demote
     */
    removeSuperAdmin(inboxId: string): Promise<void>;
}

/**
 * Manages conversations
 *
 * This class is not intended to be initialized directly.
 */
declare class Conversations<ContentTypes = unknown> {
    #private;
    /**
     * Creates a new conversations instance
     *
     * @param client - The client instance managing the conversations
     */
    constructor(client: Client<ContentTypes>);
    /**
     * Synchronizes conversations for the current client from the network
     *
     * @returns Promise that resolves when sync is complete
     */
    sync(): Promise<void>;
    /**
     * Synchronizes all conversations and messages from the network with optional
     * consent state filtering, then uploads conversation and message history to
     * the history sync server
     *
     * @param consentStates - Optional array of consent states to filter by
     * @returns Promise that resolves when sync is complete
     */
    syncAll(consentStates?: ConsentState[]): Promise<void>;
    /**
     * Retrieves a conversation by its ID
     *
     * @param id - The conversation ID to look up
     * @returns Promise that resolves with the conversation, if found
     */
    getConversationById(id: string): Promise<Group<ContentTypes> | Dm<ContentTypes> | undefined>;
    /**
     * Retrieves a message by its ID
     *
     * @param id - The message ID to look up
     * @returns Promise that resolves with the decoded message, if found
     */
    getMessageById(id: string): Promise<DecodedMessage<ContentTypes> | undefined>;
    /**
     * Retrieves a DM by inbox ID
     *
     * @param inboxId - The inbox ID to look up
     * @returns Promise that resolves with the DM, if found
     */
    getDmByInboxId(inboxId: string): Promise<Dm<ContentTypes> | undefined>;
    /**
     * Retrieves a DM by identifier
     *
     * @param identifier - The identifier to look up
     * @returns Promise that resolves with the DM, if found
     */
    getDmByIdentifier(identifier: Identifier): Promise<Dm<ContentTypes> | undefined>;
    /**
     * Lists all conversations with optional filtering
     *
     * @param options - Optional filtering and pagination options
     * @returns Promise that resolves with an array of conversations
     */
    list(options?: SafeListConversationsOptions): Promise<(Group<ContentTypes> | Dm<ContentTypes>)[]>;
    /**
     * Lists all group conversations with optional filtering
     *
     * @param options - Optional filtering and pagination options
     * @returns Promise that resolves with an array of groups
     */
    listGroups(options?: Omit<SafeListConversationsOptions, "conversation_type">): Promise<Group<ContentTypes>[]>;
    /**
     * Lists all DM conversations with optional filtering
     *
     * @param options - Optional filtering and pagination options
     * @returns Promise that resolves with an array of DMs
     */
    listDms(options?: Omit<SafeListConversationsOptions, "conversation_type">): Promise<Dm<ContentTypes>[]>;
    /**
     * Creates a new group without syncing to the network
     *
     * @param options - Optional group creation options
     * @returns Promise that resolves with the new group
     */
    newGroupOptimistic(options?: SafeCreateGroupOptions): Promise<Group<ContentTypes>>;
    /**
     * Creates a new group conversation with the specified identifiers
     *
     * @param identifiers - Array of identifiers for group members
     * @param options - Optional group creation options
     * @returns Promise that resolves with the new group
     */
    newGroupWithIdentifiers(identifiers: Identifier[], options?: SafeCreateGroupOptions): Promise<Group<ContentTypes>>;
    /**
     * Creates a new group conversation with the specified inbox IDs
     *
     * @param inboxIds - Array of inbox IDs for group members
     * @param options - Optional group creation options
     * @returns Promise that resolves with the new group
     */
    newGroup(inboxIds: string[], options?: SafeCreateGroupOptions): Promise<Group<ContentTypes>>;
    /**
     * Creates a new DM conversation with the specified identifier
     *
     * @param identifier - Identifier for the DM recipient
     * @param options - Optional DM creation options
     * @returns Promise that resolves with the new DM
     */
    newDmWithIdentifier(identifier: Identifier, options?: SafeCreateDmOptions): Promise<Dm<ContentTypes>>;
    /**
     * Creates a new DM conversation with the specified inbox ID
     *
     * @param inboxId - Inbox ID for the DM recipient
     * @param options - Optional DM creation options
     * @returns Promise that resolves with the new DM
     */
    newDm(inboxId: string, options?: SafeCreateDmOptions): Promise<Dm<ContentTypes>>;
    /**
     * Retrieves HMAC keys for all conversations
     *
     * @returns Promise that resolves with the HMAC keys for all conversations
     */
    getHmacKeys(): Promise<SafeHmacKeys>;
    /**
     * Creates a stream for new conversations
     *
     * @param options - Optional stream options
     * @param options.conversationType - Optional type to filter conversations
     * @returns Stream instance for new conversations
     */
    stream<T extends Group<ContentTypes> | Dm<ContentTypes> = Group<ContentTypes> | Dm<ContentTypes>>(options?: StreamOptions<SafeConversation, T> & {
        conversationType?: ConversationType;
    }): Promise<AsyncStreamProxy<T>>;
    /**
     * Creates a stream for new group conversations
     *
     * @param options - Optional stream options
     * @returns Stream instance for new group conversations
     */
    streamGroups(options?: StreamOptions<SafeConversation, Group<ContentTypes>>): Promise<AsyncStreamProxy<Group<ContentTypes>>>;
    /**
     * Creates a stream for new DM conversations
     *
     * @param options - Optional stream options
     * @returns Stream instance for new DM conversations
     */
    streamDms(options?: StreamOptions<SafeConversation, Dm<ContentTypes>>): Promise<AsyncStreamProxy<Dm<ContentTypes>>>;
    /**
     * Creates a stream for all new messages
     *
     * @param options - Optional stream options
     * @param options.conversationType - Optional conversation type to filter messages
     * @param options.consentStates - Optional consent states to filter messages
     * @returns Stream instance for new messages
     */
    streamAllMessages(options?: StreamOptions<SafeMessage, DecodedMessage<ContentTypes>> & {
        conversationType?: ConversationType;
        consentStates?: ConsentState[];
    }): Promise<AsyncStreamProxy<DecodedMessage<ContentTypes>>>;
    /**
     * Creates a stream for all new group messages
     *
     * @param options - Optional stream options
     * @param options.consentStates - Optional consent states to filter messages
     * @returns Stream instance for new group messages
     */
    streamAllGroupMessages(options?: StreamOptions<SafeMessage, DecodedMessage<ContentTypes>> & {
        consentStates?: ConsentState[];
    }): Promise<AsyncStreamProxy<DecodedMessage<ContentTypes>>>;
    /**
     * Creates a stream for all new DM messages
     *
     * @param options - Optional stream options
     * @param options.consentStates - Optional consent states to filter messages
     * @returns Stream instance for new DM messages
     */
    streamAllDmMessages(options?: StreamOptions<SafeMessage, DecodedMessage<ContentTypes>> & {
        consentStates?: ConsentState[];
    }): Promise<AsyncStreamProxy<DecodedMessage<ContentTypes>>>;
}

/**
 * Debug information helpers for the client
 *
 * This class is not intended to be initialized directly.
 */
declare class DebugInformation<ContentTypes = unknown> {
    #private;
    constructor(client: Client<ContentTypes>);
    apiStatistics(): Promise<SafeApiStats>;
    apiIdentityStatistics(): Promise<SafeIdentityStats>;
    apiAggregateStatistics(): Promise<string>;
    clearAllStatistics(): Promise<void>;
    uploadDebugArchive(serverUrl?: string): Promise<string>;
}

/**
 * Manages user preferences and consent states
 *
 * This class is not intended to be initialized directly.
 */
declare class Preferences<ContentTypes = unknown> {
    #private;
    /**
     * Creates a new preferences instance
     *
     * @param client - The client instance managing preferences
     */
    constructor(client: Client<ContentTypes>);
    sync(): Promise<number>;
    /**
     * Retrieves the current inbox state
     *
     * @param refreshFromNetwork - Optional flag to force refresh from network
     * @returns Promise that resolves with the inbox state
     */
    inboxState(refreshFromNetwork?: boolean): Promise<SafeInboxState>;
    /**
     * Retrieves inbox state for specific inbox IDs
     *
     * @param inboxIds - Array of inbox IDs to get state for
     * @param refreshFromNetwork - Optional flag to force refresh from network
     * @returns Promise that resolves with the inbox state for the inbox IDs
     */
    inboxStateFromInboxIds(inboxIds: string[], refreshFromNetwork?: boolean): Promise<SafeInboxState[]>;
    /**
     * Gets the latest inbox state for a specific inbox
     *
     * @param inboxId - The inbox ID to get state for
     * @returns Promise that resolves with the latest inbox state
     */
    getLatestInboxState(inboxId: string): Promise<SafeInboxState>;
    /**
     * Updates consent states for multiple records
     *
     * @param records - Array of consent records to update
     * @returns Promise that resolves when consent states are updated
     */
    setConsentStates(records: SafeConsent[]): Promise<void>;
    /**
     * Retrieves consent state for a specific entity
     *
     * @param entityType - Type of entity to get consent for
     * @param entity - Entity identifier
     * @returns Promise that resolves with the consent state
     */
    getConsentState(entityType: ConsentEntityType, entity: string): Promise<_xmtp_wasm_bindings.ConsentState>;
    /**
     * Creates a stream of consent state updates
     *
     * @param options - Optional stream options
     * @returns Stream instance for consent updates
     */
    streamConsent(options?: StreamOptions<SafeConsent[]>): Promise<AsyncStreamProxy<SafeConsent[]>>;
    /**
     * Creates a stream of user preference updates
     *
     * @param options - Optional stream options
     * @returns Stream instance for preference updates
     */
    streamPreferences(options?: StreamOptions<UserPreference[]>): Promise<AsyncStreamProxy<UserPreference[]>>;
}

type ExtractCodecContentTypes<C extends ContentCodec[] = []> = [
    ...C,
    GroupUpdatedCodec,
    TextCodec
][number] extends ContentCodec<infer T> ? T : never;
/**
 * Client for interacting with the XMTP network
 */
declare class Client<ContentTypes = ExtractCodecContentTypes> extends ClientWorkerClass {
    #private;
    /**
     * Creates a new XMTP client instance
     *
     * This class is not intended to be initialized directly.
     * Use `Client.create` or `Client.build` instead.
     *
     * @param options - Optional configuration for the client
     */
    constructor(options?: ClientOptions);
    /**
     * Initializes the client with the provided identifier
     *
     * This is not meant to be called directly.
     * Use `Client.create` or `Client.build` instead.
     *
     * @param identifier - The identifier to initialize the client with
     */
    init(identifier: Identifier): Promise<void>;
    /**
     * Creates a new client instance with a signer
     *
     * @param signer - The signer to use for authentication
     * @param options - Optional configuration for the client
     * @returns A new client instance
     */
    static create<ContentCodecs extends ContentCodec[] = []>(signer: Signer, options?: Omit<ClientOptions, "codecs"> & {
        codecs?: ContentCodecs;
    }): Promise<Client<ExtractCodecContentTypes<ContentCodecs>>>;
    /**
     * Creates a new client instance with an identifier
     *
     * Clients created with this method must already be registered.
     * Any methods called that require a signer will throw an error.
     *
     * @param identifier - The identifier to use
     * @param options - Optional configuration for the client
     * @returns A new client instance
     */
    static build<ContentCodecs extends ContentCodec[] = []>(identifier: Identifier, options?: Omit<ClientOptions, "codecs"> & {
        codecs?: ContentCodecs;
    }): Promise<Client<ExtractCodecContentTypes<ContentCodecs>>>;
    /**
     * Gets the client options
     */
    get options(): ClientOptions | undefined;
    /**
     * Gets the signer associated with this client
     */
    get signer(): Signer | undefined;
    /**
     * Gets whether the client has been initialized
     */
    get isReady(): boolean;
    /**
     * Gets the inbox ID associated with this client
     */
    get inboxId(): string | undefined;
    /**
     * Gets the account identifier for this client
     */
    get accountIdentifier(): Identifier | undefined;
    /**
     * Gets the installation ID for this client
     */
    get installationId(): string | undefined;
    /**
     * Gets the installation ID bytes for this client
     */
    get installationIdBytes(): Uint8Array<ArrayBufferLike> | undefined;
    /**
     * Gets the conversations manager for this client
     */
    get conversations(): Conversations<ContentTypes>;
    /**
     * Gets the debug information helpers for this client
     */
    get debugInformation(): DebugInformation<ContentTypes>;
    /**
     * Gets the preferences manager for this client
     */
    get preferences(): Preferences<ContentTypes>;
    /**
     * Creates signature text for creating a new inbox
     *
     * WARNING: This function should be used with caution. It is only provided
     * for use in special cases where the provided workflows do not meet the
     * requirements of an application.
     *
     * It is highly recommended to use the `register` method instead.
     *
     * @returns The signature text and signature request ID
     */
    unsafe_createInboxSignatureText(): Promise<{
        signatureText?: string;
        signatureRequestId?: string;
    }>;
    /**
     * Creates signature text for adding a new account to the client's inbox
     *
     * WARNING: This function should be used with caution. It is only provided
     * for use in special cases where the provided workflows do not meet the
     * requirements of an application.
     *
     * It is highly recommended to use the `unsafe_addAccount` method instead.
     *
     * @param newIdentifier - The identifier of the new account
     * @param allowInboxReassign - Whether to allow inbox reassignment
     * @throws {InboxReassignError} if `allowInboxReassign` is false
     * @returns The signature text and signature request ID
     */
    unsafe_addAccountSignatureText(newIdentifier: Identifier, allowInboxReassign?: boolean): Promise<{
        signatureText: string;
        signatureRequestId: string;
    }>;
    /**
     * Creates signature text for removing an account from the client's inbox
     *
     * WARNING: This function should be used with caution. It is only provided
     * for use in special cases where the provided workflows do not meet the
     * requirements of an application.
     *
     * It is highly recommended to use the `removeAccount` method instead.
     *
     * @param identifier - The identifier of the account to remove
     * @returns The signature text and signature request ID
     */
    unsafe_removeAccountSignatureText(identifier: Identifier): Promise<{
        signatureText: string;
        signatureRequestId: string;
    }>;
    /**
     * Creates signature text for revoking all other installations of the
     * client's inbox
     *
     * WARNING: This function should be used with caution. It is only provided
     * for use in special cases where the provided workflows do not meet the
     * requirements of an application.
     *
     * It is highly recommended to use the `revokeAllOtherInstallations` method instead.
     *
     * @returns The signature text and signature request ID
     */
    unsafe_revokeAllOtherInstallationsSignatureText(): Promise<{
        signatureText: string;
        signatureRequestId: string;
    }>;
    /**
     * Creates signature text for revoking specific installations of the
     * client's inbox
     *
     * WARNING: This function should be used with caution. It is only provided
     * for use in special cases where the provided workflows do not meet the
     * requirements of an application.
     *
     * It is highly recommended to use the `revokeInstallations` method instead.
     *
     * @param installationIds - The installation IDs to revoke
     * @returns The signature text and signature request ID
     */
    unsafe_revokeInstallationsSignatureText(installationIds: Uint8Array[]): Promise<{
        signatureText: string;
        signatureRequestId: string;
    }>;
    /**
     * Creates signature text for changing the recovery identifier for this
     * client's inbox
     *
     * WARNING: This function should be used with caution. It is only provided
     * for use in special cases where the provided workflows do not meet the
     * requirements of an application.
     *
     * It is highly recommended to use the `changeRecoveryIdentifier` method instead.
     *
     * @param identifier - The new recovery identifier
     * @returns The signature text and signature request ID
     */
    unsafe_changeRecoveryIdentifierSignatureText(identifier: Identifier): Promise<{
        signatureText: string;
        signatureRequestId: string;
    }>;
    /**
     * Applies a signature request to the client
     *
     * WARNING: This function should be used with caution. It is only provided
     * for use in special cases where the provided workflows do not meet the
     * requirements of an application.
     *
     * It is highly recommended to use the `register`, `unsafe_addAccount`,
     * `removeAccount`, `revokeAllOtherInstallations`, `revokeInstallations`,
     * or `changeRecoveryIdentifier` method instead.
     *
     * @param signer - The signer to use
     * @param signatureRequestId - The ID of the signature request to apply
     */
    unsafe_applySignatureRequest(signer: SafeSigner, signatureRequestId: string): Promise<void>;
    /**
     * Registers the client with the XMTP network
     *
     * Requires a signer, use `Client.create` to create a client with a signer.
     *
     * @throws {SignerUnavailableError} if no signer is available
     */
    register(): Promise<void>;
    /**
     * Adds a new account to the client inbox
     *
     * WARNING: This function should be used with caution. Adding a wallet already
     * associated with an inbox ID will cause the wallet to lose access to
     * that inbox.
     *
     * The `allowInboxReassign` parameter must be true to reassign an inbox
     * already associated with a different account.
     *
     * Requires a signer, use `Client.create` to create a client with a signer.
     *
     * @param newAccountSigner - The signer for the new account
     * @param allowInboxReassign - Whether to allow inbox reassignment
     * @throws {SignerUnavailableError} if no signer is available
     * @throws {InboxReassignError} if `allowInboxReassign` is false
     * @throws {AccountAlreadyAssociatedError} if the account is already associated with an inbox ID
     */
    unsafe_addAccount(newAccountSigner: Signer, allowInboxReassign?: boolean): Promise<void>;
    /**
     * Removes an account from the client's inbox
     *
     * Requires a signer, use `Client.create` to create a client with a signer.
     *
     * @param accountIdentifier - The identifier of the account to remove
     * @throws {SignerUnavailableError} if no signer is available
     */
    removeAccount(identifier: Identifier): Promise<void>;
    /**
     * Revokes all other installations of the client's inbox
     *
     * Requires a signer, use `Client.create` to create a client with a signer.
     *
     * @throws {SignerUnavailableError} if no signer is available
     */
    revokeAllOtherInstallations(): Promise<void>;
    /**
     * Revokes specific installations of the client's inbox
     *
     * Requires a signer, use `Client.create` to create a client with a signer.
     *
     * @param installationIds - The installation IDs to revoke
     * @throws {SignerUnavailableError} if no signer is available
     */
    revokeInstallations(installationIds: Uint8Array[]): Promise<void>;
    /**
     * Revokes specific installations of the client's inbox without a client
     *
     * @param env - The environment to use
     * @param signer - The signer to use
     * @param inboxId - The inbox ID to revoke installations for
     * @param installationIds - The installation IDs to revoke
     */
    static revokeInstallations(signer: Signer, inboxId: string, installationIds: Uint8Array[], env?: XmtpEnv, enableLogging?: boolean): Promise<void>;
    /**
     * Gets the inbox state for the specified inbox IDs without a client
     *
     * @param inboxIds - The inbox IDs to get the state for
     * @param env - The environment to use
     * @returns The inbox state for the specified inbox IDs
     */
    static inboxStateFromInboxIds(inboxIds: string[], env?: XmtpEnv, enableLogging?: boolean): Promise<SafeInboxState[]>;
    /**
     * Changes the recovery identifier for the client's inbox
     *
     * Requires a signer, use `Client.create` to create a client with a signer.
     *
     * @param identifier - The new recovery identifier
     * @throws {SignerUnavailableError} if no signer is available
     */
    changeRecoveryIdentifier(identifier: Identifier): Promise<void>;
    /**
     * Checks if the client is registered with the XMTP network
     *
     * @returns Whether the client is registered
     */
    isRegistered(): Promise<boolean>;
    /**
     * Checks if the client can message the specified identifiers
     *
     * @param identifiers - The identifiers to check
     * @returns Whether the client can message the identifiers
     */
    canMessage(identifiers: Identifier[]): Promise<Map<string, boolean>>;
    /**
     * Checks if the specified identifiers can be messaged
     *
     * @param identifiers - The identifiers to check
     * @param env - Optional XMTP environment
     * @returns Map of identifiers to whether they can be messaged
     */
    static canMessage(identifiers: Identifier[], env?: XmtpEnv): Promise<Map<string, boolean>>;
    /**
     * Finds the inbox ID for a given identifier
     *
     * @param identifier - The identifier to look up
     * @returns The inbox ID, if found
     */
    findInboxIdByIdentifier(identifier: Identifier): Promise<string | undefined>;
    /**
     * Gets the codec for a given content type
     *
     * @param contentType - The content type to get the codec for
     * @returns The codec, if found
     */
    codecFor<ContentType = unknown>(contentType: ContentTypeId$1): ContentCodec<ContentType> | undefined;
    /**
     * Encodes content for a given content type
     *
     * @param content - The content to encode
     * @param contentType - The content type to encode for
     * @returns The encoded content
     * @throws {CodecNotFoundError} if no codec is found for the content type
     */
    encodeContent(content: ContentTypes, contentType: ContentTypeId$1): SafeEncodedContent;
    /**
     * Decodes a message for a given content type
     *
     * @param message - The message to decode
     * @param contentType - The content type to decode for
     * @returns The decoded content
     * @throws {CodecNotFoundError} if no codec is found for the content type
     * @throws {InvalidGroupMembershipChangeError} if the message is an invalid group membership change
     */
    decodeContent<ContentType = unknown>(message: SafeMessage, contentType: ContentTypeId$1): ContentType;
    /**
     * Signs a message with the installation key
     *
     * @param signatureText - The text to sign
     * @returns The signature
     */
    signWithInstallationKey(signatureText: string): Promise<Uint8Array<ArrayBufferLike>>;
    /**
     * Verifies a signature was made with the installation key
     *
     * @param signatureText - The text that was signed
     * @param signatureBytes - The signature bytes to verify
     * @returns Whether the signature is valid
     */
    verifySignedWithInstallationKey(signatureText: string, signatureBytes: Uint8Array): Promise<boolean>;
    /**
     * Verifies a signature was made with a public key
     *
     * @param signatureText - The text that was signed
     * @param signatureBytes - The signature bytes to verify
     * @param publicKey - The public key to verify against
     * @returns Whether the signature is valid
     */
    verifySignedWithPublicKey(signatureText: string, signatureBytes: Uint8Array, publicKey: Uint8Array): Promise<boolean>;
    /**
     * Gets the key package statuses for the specified installation IDs
     *
     * @param installationIds - The installation IDs to check
     * @returns The key package statuses
     */
    getKeyPackageStatusesForInstallationIds(installationIds: string[]): Promise<Map<string, SafeKeyPackageStatus>>;
}

type UtilsWorkerAction = {
    action: "utils.init";
    id: string;
    result: undefined;
    data: {
        enableLogging: boolean;
    };
} | {
    action: "utils.generateInboxId";
    id: string;
    result: string;
    data: {
        identifier: Identifier;
    };
} | {
    action: "utils.getInboxIdForIdentifier";
    id: string;
    result: string | undefined;
    data: {
        identifier: Identifier;
        env?: XmtpEnv;
    };
} | {
    action: "utils.revokeInstallationsSignatureText";
    id: string;
    result: {
        signatureText: string;
        signatureRequestId: string;
    };
    data: {
        env?: XmtpEnv;
        identifier: Identifier;
        inboxId: string;
        installationIds: Uint8Array[];
        signatureRequestId: string;
    };
} | {
    action: "utils.revokeInstallations";
    id: string;
    result: undefined;
    data: {
        env?: XmtpEnv;
        signer: SafeSigner;
        signatureRequestId: string;
    };
} | {
    action: "utils.inboxStateFromInboxIds";
    id: string;
    result: SafeInboxState[];
    data: {
        inboxIds: string[];
        env?: XmtpEnv;
    };
};

/**
 * Class that sets up a worker and provides communications for utility functions
 *
 * This class is not meant to be used directly, it is extended by the Utils class
 * to provide an interface to the worker.
 *
 * @param worker - The worker to use for the utils class
 * @param enableLogging - Whether to enable logging in the worker
 * @returns A new UtilsWorkerClass instance
 */
declare class UtilsWorkerClass {
    #private;
    constructor(worker: Worker, enableLogging: boolean);
    /**
     * Initializes the utils worker
     *
     * @param enableLogging - Whether to enable logging in the worker
     * @returns A promise that resolves when the worker is initialized
     */
    init(): Promise<void>;
    /**
     * Sends an action message to the utils worker
     *
     * @param action - The action to send to the worker
     * @param data - The data to send to the worker
     * @returns A promise that resolves when the action is completed
     */
    sendMessage<A extends ActionName<UtilsWorkerAction>>(action: A, data: ExtractActionData<UtilsWorkerAction, A>): [ExtractActionResult<UtilsWorkerAction, A>] extends [undefined] ? Promise<void> : Promise<ExtractActionResult<UtilsWorkerAction, A>>;
    /**
     * Handles a message from the utils worker
     *
     * @param event - The event to handle
     */
    handleMessage: (event: MessageEvent<ActionWithoutData<UtilsWorkerAction> | ActionErrorData<UtilsWorkerAction>>) => void;
    /**
     * Removes all event listeners and terminates the worker
     */
    close(): void;
}

/**
 * Utility class that provides helper functions for XMTP inbox IDs
 */
declare class Utils extends UtilsWorkerClass {
    /**
     * Creates a new Utils instance
     *
     * @param enableLogging - Optional flag to enable logging
     */
    constructor(enableLogging?: boolean);
    /**
     * Generates an inbox ID for a given identifier
     *
     * @param identifier - The identifier to generate an inbox ID for
     * @returns Promise that resolves with the generated inbox ID
     */
    generateInboxId(identifier: Identifier): Promise<string>;
    /**
     * Gets the inbox ID for a specific identifier and optional environment
     *
     * @param identifier - The identifier to get the inbox ID for
     * @param env - Optional XMTP environment configuration (default: "dev")
     * @returns Promise that resolves with the inbox ID for the identifier
     */
    getInboxIdForIdentifier(identifier: Identifier, env?: XmtpEnv): Promise<string | undefined>;
    /**
     * Creates signature text for revoking installations
     *
     * WARNING: This function should be used with caution. It is only provided
     * for use in special cases where the provided workflows do not meet the
     * requirements of an application.
     *
     * It is highly recommended to use the `revokeInstallations` method instead.
     *
     * @param env - The environment to use
     * @param identifier - The identifier to revoke installations for
     * @param inboxId - The inbox ID to revoke installations for
     * @param installationIds - The installation IDs to revoke
     * @returns The signature text and signature request ID
     */
    revokeInstallationsSignatureText(identifier: Identifier, inboxId: string, installationIds: Uint8Array[], env?: XmtpEnv): Promise<{
        signatureText: string;
        signatureRequestId: string;
    }>;
    /**
     * Revokes installations for a given inbox ID
     *
     * @param env - The environment to use
     * @param signer - The signer to use
     * @param inboxId - The inbox ID to revoke installations for
     * @param installationIds - The installation IDs to revoke
     * @returns Promise that resolves with the result of the revoke installations operation
     */
    revokeInstallations(signer: Signer, inboxId: string, installationIds: Uint8Array[], env?: XmtpEnv): Promise<void>;
    /**
     * Gets the inbox state for the specified inbox IDs without a client
     *
     * @param inboxIds - The inbox IDs to get the state for
     * @param env - The environment to use
     * @returns The inbox state for the specified inbox IDs
     */
    inboxStateFromInboxIds(inboxIds: string[], env?: XmtpEnv): Promise<SafeInboxState[]>;
}

declare class ClientNotInitializedError extends Error {
    constructor();
}
declare class SignerUnavailableError extends Error {
    constructor();
}
declare class CodecNotFoundError extends Error {
    constructor(contentType: ContentTypeId$1);
}
declare class InboxReassignError extends Error {
    constructor();
}
declare class AccountAlreadyAssociatedError extends Error {
    constructor(inboxId: string);
}
declare class GroupNotFoundError extends Error {
    constructor(groupId: string);
}
declare class StreamNotFoundError extends Error {
    constructor(streamId: string);
}
declare class InvalidGroupMembershipChangeError extends Error {
    constructor(messageId: string);
}
declare class MissingContentTypeError extends Error {
    constructor();
}
declare class StreamFailedError extends Error {
    constructor(retryAttempts: number);
}
declare class StreamInvalidRetryAttemptsError extends Error {
    constructor();
}

export { AccountAlreadyAssociatedError, ApiUrls, Client, ClientNotInitializedError, CodecNotFoundError, Conversation, Conversations, DEFAULT_RETRY_ATTEMPTS, DEFAULT_RETRY_DELAY, DecodedMessage, Dm, Group, GroupNotFoundError, HistorySyncUrls, InboxReassignError, InvalidGroupMembershipChangeError, MissingContentTypeError, SignerUnavailableError, StreamFailedError, StreamInvalidRetryAttemptsError, StreamNotFoundError, Utils, createStream, fromContentTypeId, fromEncodedContent, fromSafeConsent, fromSafeContentTypeId, fromSafeCreateDmOptions, fromSafeCreateGroupOptions, fromSafeEncodedContent, fromSafeGroupMember, fromSafeListConversationsOptions, fromSafeListMessagesOptions, fromSafeMessageDisappearingSettings, fromSafePermissionPolicySet, toContentTypeId, toEncodedContent, toSafeApiStats, toSafeConsent, toSafeContentTypeId, toSafeConversation, toSafeConversationDebugInfo, toSafeCreateDmOptions, toSafeCreateGroupOptions, toSafeEncodedContent, toSafeGroupMember, toSafeHmacKey, toSafeIdentityStats, toSafeInboxState, toSafeInstallation, toSafeKeyPackageStatus, toSafeListConversationsOptions, toSafeListMessagesOptions, toSafeMessage, toSafeMessageDisappearingSettings, toSafePermissionPolicySet, toSafeSigner };
export type { AsyncStreamProxy, ClientOptions, ContentOptions, EOASigner, ExtractCodecContentTypes, HmacKeys, MessageDeliveryStatus, MessageKind, NetworkOptions, OtherOptions, SCWSigner, SafeApiStats, SafeConsent, SafeContentTypeId, SafeConversation, SafeConversationDebugInfo, SafeCreateDmOptions, SafeCreateGroupOptions, SafeEncodedContent, SafeGroupMember, SafeHmacKey, SafeHmacKeys, SafeIdentityStats, SafeInboxState, SafeInstallation, SafeKeyPackageStatus, SafeListConversationsOptions, SafeListMessagesOptions, SafeMessage, SafeMessageDisappearingSettings, SafePermissionPolicySet, SafeSigner, Signer, StorageOptions, StreamCallback, StreamFunction, StreamOptions, StreamValueMutator, XmtpEnv };
