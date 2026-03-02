import { WebPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

import type {
    AddQueueItemsParams,
    GetItemProgressParams,
    GetQueueResult,
    ItemProgress,
    MetadataChangeEvent,
    PlaybackOptions,
    PlayerState,
    QueueChangeEvent,
    QueueItem,
    RemoveQueueItemParams,
    SeekParams,
    SetItemProgressParams,
    SetPlaybackOptionsParams,
    SetQueueParams,
    SetRateParams,
    SetRepeatModeParams,
    SetShuffleParams,
    SetVolumeParams,
    SkipToIndexParams,
    SyncQueueParams,
    SyncQueueResult,
    MoveQueueItemParams,
    PlaybackStatus,
    RepeatMode,
    TrackChangeEvent,
} from './definitions';

const DEFAULT_PLAYBACK_OPTIONS: PlaybackOptions = {
    previousThresholdSeconds: 7,
    skipForwardSeconds: 10,
    skipBackwardSeconds: 10,
    enableNextPrev: true,
    enableSeekTo: true,
    enableSkipForwardBackward: true,
    enableStop: true,
};

const STATE_POLL_MS = 600;

export class AudioPlayerWeb extends WebPlugin {
    private items: QueueItem[] = [];
    private currentIndex = 0;
    private queueRevision = 0;
    private stateRevision = 0;
    private status: PlaybackStatus = 'stopped';
    private rate = 1;
    private volumePercent = 100;
    private repeatMode: RepeatMode = 'off';
    private shuffle = false;
    private playbackOptions: PlaybackOptions = { ...DEFAULT_PLAYBACK_OPTIONS };
    private progressMap = new Map<string, ItemProgress>();

    private audio: HTMLAudioElement | null = null;
    private statePollTimer: ReturnType<typeof setInterval> | null = null;

    private stateChangeListeners: ((state: PlayerState) => void)[] = [];
    private trackChangeListeners: ((event: TrackChangeEvent) => void)[] = [];
    private queueChangeListeners: ((event: QueueChangeEvent) => void)[] = [];
    private metadataChangeListeners: ((event: MetadataChangeEvent) => void)[] = [];
    private audioBecomingNoisyListeners: (() => void)[] = [];

    constructor() {
        super();
        this.ensureAudio();
    }

    private ensureAudio(): HTMLAudioElement {
        if (this.audio) return this.audio;
        const audio = new Audio();
        audio.preload = 'auto';
        audio.addEventListener('ended', () => this.onAudioEnded());
        audio.addEventListener('play', () => this.setStatus('playing'));
        audio.addEventListener('pause', () => {
            if (audio.currentTime === 0 && !audio.src) return;
            this.setStatus('paused');
        });
        audio.addEventListener('error', () => this.setStatus('stopped'));
        this.audio = audio;
        return audio;
    }

    private setStatus(status: PlaybackStatus): void {
        if (this.status === status) return;
        this.status = status;
        this.emitStateChange();
        if (status === 'playing') {
            this.startStatePolling();
        } else {
            this.stopStatePolling();
        }
    }

    private onAudioEnded(): void {
        const item = this.items[this.currentIndex];
        if (!item) {
            this.setStatus('stopped');
            return;
        }
        if (this.repeatMode === 'one') {
            const audio = this.audio;
            if (audio) {
                audio.currentTime = 0;
                void audio.play();
            }
            return;
        }
        const hasNext = this.currentIndex < this.items.length - 1;
        if (this.repeatMode === 'all' && !hasNext && this.items.length > 0) {
            this.loadItemByIndex(0);
            this.emitTrackChange();
            void this.audio?.play();
            return;
        }
        if (hasNext) {
            this.loadItemByIndex(this.currentIndex + 1);
            this.emitTrackChange();
            void this.audio?.play();
        } else {
            this.setStatus('stopped');
        }
    }

    private loadItemByIndex(index: number): void {
        if (index < 0 || index >= this.items.length) return;
        this.currentIndex = index;
        const item = this.items[index];
        const audio = this.ensureAudio();
        audio.pause();
        audio.src = item.src;
        audio.load();
        this.updateMediaSessionMetadata(item);
        this.emitStateChange();
    }

    private updateMediaSessionMetadata(item: QueueItem): void {
        if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: item.title || '',
                artist: item.artist || '',
                album: item.album || '',
                artwork: item.artwork
                    ? [{ src: item.artwork, sizes: '512x512', type: 'image/png' }]
                    : [],
            });
        } catch {
            // ignore
        }
    }

    private setupMediaSessionHandlers(): void {
        if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
        const opts = this.playbackOptions;
        try {
            navigator.mediaSession.setActionHandler('play', () => {
                void this.play();
            });
            navigator.mediaSession.setActionHandler('pause', () => {
                void this.pause();
            });
            if (opts.enableStop) {
                navigator.mediaSession.setActionHandler('stop', () => {
                    void this.stop();
                });
            }
            if (opts.enableSeekTo) {
                navigator.mediaSession.setActionHandler('seekto', (details) => {
                    if (this.audio && typeof details?.seekTime === 'number') {
                        this.audio.currentTime = details.seekTime;
                        this.emitStateChange();
                    }
                });
            }
            if (opts.enableSkipForwardBackward) {
                const fwd = opts.skipForwardSeconds ?? 10;
                const bwd = opts.skipBackwardSeconds ?? 10;
                navigator.mediaSession.setActionHandler('seekforward', (details) => {
                    if (this.audio) {
                        const offset = typeof details?.seekOffset === 'number' ? details.seekOffset : fwd;
                        this.audio.currentTime = Math.min(
                            this.audio.duration || Number.MAX_SAFE_INTEGER,
                            this.audio.currentTime + offset
                        );
                        this.emitStateChange();
                    }
                });
                navigator.mediaSession.setActionHandler('seekbackward', (details) => {
                    if (this.audio) {
                        const offset = typeof details?.seekOffset === 'number' ? details.seekOffset : bwd;
                        this.audio.currentTime = Math.max(0, this.audio.currentTime - offset);
                        this.emitStateChange();
                    }
                });
            }
            if (opts.enableNextPrev) {
                navigator.mediaSession.setActionHandler('nexttrack', () => {
                    void this.skipToNext();
                });
                navigator.mediaSession.setActionHandler('previoustrack', () => {
                    void this.skipToPrevious();
                });
            }
        } catch {
            // some handlers may not be supported
        }
    }

    private getPosition(): number {
        return this.audio?.currentTime ?? 0;
    }

    private getDuration(): number {
        const d = this.audio?.duration;
        if (d != null && isFinite(d)) return d;
        const item = this.items[this.currentIndex];
        return item?.duration ?? 0;
    }

    private buildPlayerState(): PlayerState {
        return {
            stateRevision: this.stateRevision,
            queueRevision: this.queueRevision,
            status: this.status,
            currentIndex: this.currentIndex,
            currentItemId: this.items[this.currentIndex]?.id,
            position: this.getPosition(),
            duration: this.getDuration(),
            rate: this.rate,
            volume: this.volumePercent,
            repeatMode: this.repeatMode,
            shuffle: this.shuffle,
        };
    }

    private emitStateChange(): void {
        this.stateRevision++;
        const state = this.buildPlayerState();
        this.stateChangeListeners.forEach((fn) => {
            try {
                fn(state);
            } catch {
                // ignore
            }
        });
    }

    private emitTrackChange(): void {
        const item = this.items[this.currentIndex];
        if (!item) return;
        const event: TrackChangeEvent = {
            queueRevision: this.queueRevision,
            currentIndex: this.currentIndex,
            item,
        };
        this.trackChangeListeners.forEach((fn) => {
            try {
                fn(event);
            } catch {
                // ignore
            }
        });
    }

    private emitQueueChange(): void {
        const event: QueueChangeEvent = {
            queueRevision: this.queueRevision,
            items: [...this.items],
            currentIndex: this.currentIndex,
            currentItemId: this.items[this.currentIndex]?.id,
        };
        this.queueChangeListeners.forEach((fn) => {
            try {
                fn(event);
            } catch {
                // ignore
            }
        });
    }

    private startStatePolling(): void {
        if (this.statePollTimer) return;
        this.statePollTimer = setInterval(() => {
            if (this.status === 'playing') this.emitStateChange();
        }, STATE_POLL_MS);
    }

    private stopStatePolling(): void {
        if (this.statePollTimer) {
            clearInterval(this.statePollTimer);
            this.statePollTimer = null;
        }
    }

    private createListenerHandle<T>(
        listeners: T[],
        fn: T
    ): PluginListenerHandle {
        listeners.push(fn);
        return {
            remove: async () => {
                const i = listeners.indexOf(fn);
                if (i !== -1) listeners.splice(i, 1);
            },
        };
    }

    // --- Queue ---

    async setQueue(params: SetQueueParams): Promise<void> {
        this.items = params.items?.length ? [...params.items] : [];
        this.queueRevision++;
        const startIndex = Math.min(
            params.startIndex ?? 0,
            Math.max(0, this.items.length - 1)
        );
        this.currentIndex = startIndex;
        const audio = this.ensureAudio();
        audio.pause();
        if (this.items.length) {
            const item = this.items[this.currentIndex];
            audio.src = item.src;
            audio.load();
            if (params.startPositionSeconds != null && params.startPositionSeconds > 0) {
                audio.currentTime = params.startPositionSeconds;
            }
            this.updateMediaSessionMetadata(item);
            this.setupMediaSessionHandlers();
            if (params.autoplay) {
                this.setStatus('playing');
                void audio.play();
            } else {
                this.setStatus('stopped');
            }
        } else {
            audio.src = '';
            this.setStatus('stopped');
        }
        this.emitStateChange();
        this.emitQueueChange();
    }

    async syncQueue(params: SyncQueueParams): Promise<SyncQueueResult> {
        if (params.mode === 'replace') {
            await this.setQueue(params);
            return { queueRevision: this.queueRevision };
        }
        if (params.mode === 'patch' && params.expectedQueueRevision === this.queueRevision) {
            await this.setQueue(params);
            return { queueRevision: this.queueRevision };
        }
        return { queueRevision: this.queueRevision };
    }

    async getQueue(): Promise<GetQueueResult> {
        return {
            queueRevision: this.queueRevision,
            items: [...this.items],
            currentIndex: this.currentIndex,
            currentItemId: this.items[this.currentIndex]?.id,
        };
    }

    async addQueueItems(params: AddQueueItemsParams): Promise<void> {
        const beforeLength = this.items.length;
        const beforeCurrentItemId = this.items[this.currentIndex]?.id;
        const insertItems = params.items ?? [];
        const atRaw = params.atIndex ?? this.items.length;
        const at = Math.max(0, Math.min(atRaw, this.items.length));

        this.items.splice(at, 0, ...insertItems);

        // Keep pointing at the same current item when inserting at/before it.
        if (beforeLength > 0 && beforeCurrentItemId && at <= this.currentIndex) {
            this.currentIndex += insertItems.length;
        }

        // If queue was empty and now has items, initialize the current item (without autoplay).
        if (beforeLength === 0 && this.items.length > 0) {
            this.currentIndex = 0;
            this.loadItemByIndex(0);
            this.setStatus('stopped');
        }

        this.queueRevision++;
        this.emitQueueChange();
        this.emitStateChange();
    }

    async removeQueueItem(params: RemoveQueueItemParams): Promise<void> {
        const statusBefore = this.status;
        const beforeCurrentItemId = this.items[this.currentIndex]?.id;

        const i = this.items.findIndex((x) => x.id === params.itemId);
        if (i === -1) return;
        this.items.splice(i, 1);
        this.queueRevision++;

        // Keep currentIndex pointing at the same logical item where possible.
        if (i === this.currentIndex) {
            // Current item removed: keep the same numeric index to play the next item (or clamp to last).
            if (this.items.length === 0) {
                if (this.audio) {
                    this.audio.pause();
                    this.audio.src = '';
                }
                this.currentIndex = 0;
                this.setStatus('stopped');
            } else {
                this.currentIndex = Math.min(this.currentIndex, this.items.length - 1);
                this.loadItemByIndex(this.currentIndex);
                this.setStatus(statusBefore);
                if (statusBefore === 'playing') {
                    void this.audio?.play();
                }
            }
        } else if (this.currentIndex >= this.items.length) {
            this.currentIndex = Math.max(0, this.items.length - 1);
            if (this.items.length) {
                this.loadItemByIndex(this.currentIndex);
            } else {
                if (this.audio) {
                    this.audio.pause();
                    this.audio.src = '';
                }
                this.setStatus('stopped');
            }
        } else if (this.currentIndex > i) {
            this.currentIndex--;
        }

        const afterCurrentItemId = this.items[this.currentIndex]?.id;
        if (beforeCurrentItemId && afterCurrentItemId && beforeCurrentItemId !== afterCurrentItemId) {
            this.emitTrackChange();
        }
        this.emitQueueChange();
        this.emitStateChange();
    }

    async moveQueueItem(params: MoveQueueItemParams): Promise<void> {
        const { fromIndex, toIndex } = params;
        if (fromIndex < 0 || fromIndex >= this.items.length || toIndex < 0 || toIndex >= this.items.length) return;
        const [item] = this.items.splice(fromIndex, 1);
        this.items.splice(toIndex, 0, item);
        this.queueRevision++;
        if (this.currentIndex === fromIndex) {
            this.currentIndex = toIndex;
        } else if (fromIndex < this.currentIndex && toIndex >= this.currentIndex) {
            this.currentIndex--;
        } else if (fromIndex > this.currentIndex && toIndex <= this.currentIndex) {
            this.currentIndex++;
        }
        this.emitQueueChange();
        this.emitStateChange();
    }

    async clearQueue(): Promise<void> {
        this.items = [];
        this.currentIndex = 0;
        this.queueRevision++;
        const audio = this.audio;
        if (audio) {
            audio.pause();
            audio.src = '';
        }
        this.setStatus('stopped');
        this.emitQueueChange();
        this.emitStateChange();
    }

    // --- Playback ---

    async play(): Promise<void> {
        const audio = this.ensureAudio();
        if (this.items.length && !audio.src) {
            const item = this.items[this.currentIndex];
            if (item) {
                audio.src = item.src;
                audio.load();
                this.updateMediaSessionMetadata(item);
            }
        }
        this.setStatus('playing');
        await audio.play();
    }

    async pause(): Promise<void> {
        this.audio?.pause();
        this.setStatus('paused');
    }

    async stop(): Promise<void> {
        const audio = this.audio;
        if (audio) {
            audio.pause();
            audio.currentTime = 0;
        }
        this.setStatus('stopped');
        this.emitStateChange();
    }

    async seek(params: SeekParams): Promise<void> {
        const audio = this.audio;
        if (!audio) return;
        audio.currentTime = Math.max(0, params.positionSeconds);
        this.emitStateChange();
    }

    async skipToNext(): Promise<void> {
        if (this.items.length === 0) return;
        const nextIndex =
            this.currentIndex < this.items.length - 1
                ? this.currentIndex + 1
                : this.repeatMode === 'all'
                  ? 0
                  : this.currentIndex;
        if (nextIndex !== this.currentIndex) {
            this.loadItemByIndex(nextIndex);
            this.emitTrackChange();
            if (this.status === 'playing') void this.audio?.play();
        }
    }

    async skipToPrevious(): Promise<void> {
        if (this.items.length === 0) return;
        const audio = this.audio;
        const threshold = this.playbackOptions.previousThresholdSeconds ?? 7;
        const atStart = (audio?.currentTime ?? 0) <= threshold;
        const prevIndex =
            atStart && this.currentIndex > 0
                ? this.currentIndex - 1
                : this.currentIndex;
        if (prevIndex < this.currentIndex) {
            this.loadItemByIndex(prevIndex);
            this.emitTrackChange();
            if (this.status === 'playing') void this.audio?.play();
        } else if (audio) {
            audio.currentTime = 0;
            this.emitStateChange();
        }
    }

    async skipToIndex(params: SkipToIndexParams): Promise<void> {
        const index = Math.max(0, Math.min(params.index, this.items.length - 1));
        if (index === this.currentIndex) {
            if (params.positionSeconds != null && this.audio) {
                this.audio.currentTime = params.positionSeconds;
                this.emitStateChange();
            }
            return;
        }
        this.loadItemByIndex(index);
        if (params.positionSeconds != null && this.audio) {
            this.audio.currentTime = params.positionSeconds;
        }
        this.emitTrackChange();
        if (this.status === 'playing') void this.audio?.play();
    }

    async setRate(params: SetRateParams): Promise<void> {
        this.rate = Math.max(0.5, Math.min(2, params.rate));
        if (this.audio) this.audio.playbackRate = this.rate;
        this.emitStateChange();
    }

    async setVolume(params: SetVolumeParams): Promise<void> {
        this.volumePercent = Math.max(0, Math.min(100, params.volume));
        if (this.audio) this.audio.volume = this.volumePercent / 100;
        this.emitStateChange();
    }

    // --- State ---

    async getState(): Promise<PlayerState> {
        return this.buildPlayerState();
    }

    // --- Progress / bookmarks (in-memory on web) ---

    async setItemProgress(params: SetItemProgressParams): Promise<void> {
        const progress: ItemProgress = {
            itemId: params.itemId,
            positionSeconds: params.positionSeconds,
            durationSeconds: params.durationSeconds,
            completed: params.completed,
            updatedAtEpochMs: Date.now(),
        };
        this.progressMap.set(params.itemId, progress);
    }

    async getItemProgress(params: GetItemProgressParams): Promise<ItemProgress> {
        const stored = this.progressMap.get(params.itemId);
        if (stored) return stored;
        const item = this.items.find((x) => x.id === params.itemId);
        const pos = item && this.items[this.currentIndex]?.id === params.itemId ? this.getPosition() : 0;
        const dur = item?.duration;
        return {
            itemId: params.itemId,
            positionSeconds: pos,
            durationSeconds: dur,
            completed: false,
            updatedAtEpochMs: Date.now(),
        };
    }

    // --- Options ---

    async setPlaybackOptions(params: SetPlaybackOptionsParams): Promise<void> {
        this.playbackOptions = { ...DEFAULT_PLAYBACK_OPTIONS, ...this.playbackOptions, ...params };
        this.setupMediaSessionHandlers();
    }

    async getPlaybackOptions(): Promise<PlaybackOptions> {
        return { ...this.playbackOptions };
    }

    async setRepeatMode(params: SetRepeatModeParams): Promise<void> {
        this.repeatMode = params.repeatMode;
        this.emitStateChange();
    }

    async setShuffle(params: SetShuffleParams): Promise<void> {
        this.shuffle = params.shuffle;
        this.emitStateChange();
    }

    // --- Events ---

    async addListener(
        eventName: 'stateChange',
        listenerFunc: (state: PlayerState) => void
    ): Promise<PluginListenerHandle>;
    async addListener(
        eventName: 'trackChange',
        listenerFunc: (event: TrackChangeEvent) => void
    ): Promise<PluginListenerHandle>;
    async addListener(
        eventName: 'queueChange',
        listenerFunc: (event: QueueChangeEvent) => void
    ): Promise<PluginListenerHandle>;
    async addListener(
        eventName: 'metadataChange',
        listenerFunc: (event: MetadataChangeEvent) => void
    ): Promise<PluginListenerHandle>;
    async addListener(
        eventName: 'audioBecomingNoisy',
        listenerFunc: () => void
    ): Promise<PluginListenerHandle>;
    async addListener(
        eventName: string,
        listenerFunc: (...args: any[]) => void
    ): Promise<PluginListenerHandle> {
        if (eventName === 'stateChange') {
            return this.createListenerHandle(this.stateChangeListeners, listenerFunc as (state: PlayerState) => void);
        }
        if (eventName === 'trackChange') {
            return this.createListenerHandle(this.trackChangeListeners, listenerFunc as (event: TrackChangeEvent) => void);
        }
        if (eventName === 'queueChange') {
            return this.createListenerHandle(this.queueChangeListeners, listenerFunc as (event: QueueChangeEvent) => void);
        }
        if (eventName === 'metadataChange') {
            return this.createListenerHandle(this.metadataChangeListeners, listenerFunc as (event: MetadataChangeEvent) => void);
        }
        if (eventName === 'audioBecomingNoisy') {
            return this.createListenerHandle(this.audioBecomingNoisyListeners, listenerFunc as () => void);
        }
        return Promise.reject(new Error(`Unknown event: ${eventName}`));
    }

    async removeAllListeners(): Promise<void> {
        this.stateChangeListeners = [];
        this.trackChangeListeners = [];
        this.queueChangeListeners = [];
        this.metadataChangeListeners = [];
        this.audioBecomingNoisyListeners = [];
    }
}
