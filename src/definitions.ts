import type { PluginListenerHandle } from '@capacitor/core';

export type PlaybackStatus = 'playing' | 'paused' | 'stopped';

export type RepeatMode = 'off' | 'one' | 'all';

export interface QueueItem {
    /**
     * Stable identifier used for reconciliation and per-item bookmarks/progress.
     */
    id: string;

    /**
     * Remote URL or app asset path (e.g. `assets/chapter01.mp3`).
     */
    src: string;

    /**
     * Display title for OS notification/lockscreen.
     */
    title: string;

    /**
     * Optional artist name.
     */
    artist?: string | undefined;

    /**
     * Optional album/podcast/book name.
     */
    album?: string | undefined;

    /**
     * Artwork URL or app asset path.
     */
    artwork?: string | undefined;

    /**
     * Optional duration in seconds (streams may be unknown).
     */
    duration?: number | undefined;

    /**
     * Optional metadata update URL + interval (useful for streams/radio).
     */
    metadataUpdateUrl?: string | undefined;
    metadataUpdateInterval?: number | undefined;

    /**
     * Opaque app-defined data (not interpreted by native).
     */
    extras?: Record<string, any> | undefined;
}

export interface ItemProgress {
    itemId: string;
    positionSeconds: number;
    durationSeconds?: number;
    completed?: boolean;
    updatedAtEpochMs: number;
}

export interface PlaybackOptions {
    /**
     * When user presses previous: if current position is above this threshold,
     * seek to 0 instead of going to previous item.
     *
     * @default 7
     */
    previousThresholdSeconds: number;

    /**
     * OS skip buttons (seek +/- fixed seconds) configuration.
     *
     * @default 10
     */
    skipForwardSeconds: number;

    /**
     * OS skip buttons (seek +/- fixed seconds) configuration.
     *
     * @default 10
     */
    skipBackwardSeconds: number;

    /**
     * Whether to expose next/previous track controls in OS UIs when possible.
     *
     * @default true
     */
    enableNextPrev: boolean;

    /**
     * Whether to expose scrubbing (seek-to) controls in OS UIs when possible.
     *
     * @default true
     */
    enableSeekTo: boolean;

    /**
     * Whether to expose stop controls in OS UIs when possible.
     *
     * @default true
     */
    enableStop: boolean;

    /**
     * Android-only: override the drawable name for the notification small icon.
     * (No extension, no `R.drawable.` prefix.)
     */
    androidNotificationSmallIcon?: string;
}

export interface PlayerState {
    /**
     * Monotonic revision that increments on any state change.
     */
    stateRevision: number;

    /**
     * Monotonic revision that increments on any queue topology change.
     */
    queueRevision: number;

    status: PlaybackStatus;
    currentIndex: number;
    currentItemId?: string;
    position: number;
    duration?: number;
    rate: number;
    /**
     * Volume in 0..100.
     */
    volume: number;
    repeatMode: RepeatMode;
    shuffle: boolean;
}

export interface SetQueueParams {
    items: QueueItem[];
    startIndex?: number | undefined;
    startPositionSeconds?: number | undefined;
    autoplay?: boolean | undefined;
}

export type SyncQueueMode = 'replace' | 'patch';

export interface SyncQueueParams extends SetQueueParams {
    mode: SyncQueueMode;
    currentItemId?: string;
    expectedQueueRevision?: number;
    force?: boolean;
}

export interface AddQueueItemsParams {
    items: QueueItem[];
    atIndex?: number;
}

export interface RemoveQueueItemParams {
    itemId: string;
}

export interface MoveQueueItemParams {
    fromIndex: number;
    toIndex: number;
}

export interface SetVolumeParams {
    /**
     * Volume in 0..100.
     */
    volume: number;
}

export interface SetRateParams {
    /**
     * Playback speed (e.g. `1.0` normal).
     */
    rate: number;
}

export interface SeekParams {
    positionSeconds: number;
}

export interface SkipToIndexParams {
    index: number;
    positionSeconds?: number;
}

export interface SetItemProgressParams {
    itemId: string;
    positionSeconds: number;
    durationSeconds?: number;
    completed?: boolean;
}

export interface GetItemProgressParams {
    itemId: string;
}

export interface SetPlaybackOptionsParams extends Partial<PlaybackOptions> {}

export interface SetRepeatModeParams {
    repeatMode: RepeatMode;
}

export interface SetShuffleParams {
    shuffle: boolean;
}

export interface GetQueueResult {
    queueRevision: number;
    items: QueueItem[];
    currentIndex: number;
    currentItemId?: string;
}

export interface SyncQueueResult {
    queueRevision: number;
}

export interface TrackChangeEvent {
    queueRevision: number;
    currentIndex: number;
    item: QueueItem;
}

export interface QueueChangeEvent extends GetQueueResult {}

export interface MetadataChangeEvent {
    stateRevision: number;
    itemId: string;
    metadata: Partial<QueueItem>;
}

export interface AudioPlayerPlugin {
    // Queue
    setQueue(params: SetQueueParams): Promise<void>;
    syncQueue(params: SyncQueueParams): Promise<SyncQueueResult>;
    getQueue(): Promise<GetQueueResult>;
    addQueueItems(params: AddQueueItemsParams): Promise<void>;
    removeQueueItem(params: RemoveQueueItemParams): Promise<void>;
    moveQueueItem(params: MoveQueueItemParams): Promise<void>;
    clearQueue(): Promise<void>;

    // Playback
    play(): Promise<void>;
    pause(): Promise<void>;
    stop(): Promise<void>;
    seek(params: SeekParams): Promise<void>;
    skipToNext(): Promise<void>;
    skipToPrevious(): Promise<void>;
    skipToIndex(params: SkipToIndexParams): Promise<void>;
    setRate(params: SetRateParams): Promise<void>;
    setVolume(params: SetVolumeParams): Promise<void>;

    // State
    getState(): Promise<PlayerState>;

    // Progress / bookmarks
    setItemProgress(params: SetItemProgressParams): Promise<void>;
    getItemProgress(params: GetItemProgressParams): Promise<ItemProgress>;

    // Options
    setPlaybackOptions(params: SetPlaybackOptionsParams): Promise<void>;
    getPlaybackOptions(): Promise<PlaybackOptions>;

    // Playback modes
    setRepeatMode(params: SetRepeatModeParams): Promise<void>;
    setShuffle(params: SetShuffleParams): Promise<void>;

    // Events (standard Capacitor listeners)
    addListener(
        eventName: 'stateChange',
        listenerFunc: (state: PlayerState) => void,
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: 'trackChange',
        listenerFunc: (event: TrackChangeEvent) => void,
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: 'queueChange',
        listenerFunc: (event: QueueChangeEvent) => void,
    ): Promise<PluginListenerHandle>;
    addListener(
        eventName: 'metadataChange',
        listenerFunc: (event: MetadataChangeEvent) => void,
    ): Promise<PluginListenerHandle>;
    removeAllListeners(): Promise<void>;
}
