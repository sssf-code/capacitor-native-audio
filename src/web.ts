import { WebPlugin } from '@capacitor/core';

import type {
    AudioPlayerPlugin,
    AddQueueItemsParams,
    GetItemProgressParams,
    GetQueueResult,
    ItemProgress,
    PlaybackOptions,
    PlayerState,
    RemoveQueueItemParams,
    SeekParams,
    SetItemProgressParams,
    SetPlaybackOptionsParams,
    SetQueueParams,
    SetRateParams,
    SetVolumeParams,
    SkipToIndexParams,
    SyncQueueParams,
    SyncQueueResult,
    MoveQueueItemParams,
} from './definitions';

export class AudioPlayerWeb extends WebPlugin implements AudioPlayerPlugin {
    setQueue(params: SetQueueParams): Promise<void> {
        throw this.unimplemented('Not implemented on web.');
    }

    syncQueue(params: SyncQueueParams): Promise<SyncQueueResult> {
        throw this.unimplemented('Not implemented on web.');
    }

    getQueue(): Promise<GetQueueResult> {
        throw this.unimplemented('Not implemented on web.');
    }

    addQueueItems(params: AddQueueItemsParams): Promise<void> {
        throw this.unimplemented('Not implemented on web.');
    }

    removeQueueItem(params: RemoveQueueItemParams): Promise<void> {
        throw this.unimplemented('Not implemented on web.');
    }

    moveQueueItem(params: MoveQueueItemParams): Promise<void> {
        throw this.unimplemented('Not implemented on web.');
    }

    clearQueue(): Promise<void> {
        throw this.unimplemented('Not implemented on web.');
    }

    play(): Promise<void> {
        throw this.unimplemented('Not implemented on web.');
    }

    pause(): Promise<void> {
        throw this.unimplemented('Not implemented on web.');
    }

    stop(): Promise<void> {
        throw this.unimplemented('Not implemented on web.');
    }

    seek(params: SeekParams): Promise<void> {
        throw this.unimplemented('Not implemented on web.');
    }

    skipToNext(): Promise<void> {
        throw this.unimplemented('Not implemented on web.');
    }

    skipToPrevious(): Promise<void> {
        throw this.unimplemented('Not implemented on web.');
    }

    skipToIndex(params: SkipToIndexParams): Promise<void> {
        throw this.unimplemented('Not implemented on web.');
    }

    setRate(params: SetRateParams): Promise<void> {
        throw this.unimplemented('Not implemented on web.');
    }

    setVolume(params: SetVolumeParams): Promise<void> {
        throw this.unimplemented('Not implemented on web.');
    }

    getState(): Promise<PlayerState> {
        throw this.unimplemented('Not implemented on web.');
    }

    setItemProgress(params: SetItemProgressParams): Promise<void> {
        throw this.unimplemented('Not implemented on web.');
    }

    getItemProgress(params: GetItemProgressParams): Promise<ItemProgress> {
        throw this.unimplemented('Not implemented on web.');
    }

    setPlaybackOptions(params: SetPlaybackOptionsParams): Promise<void> {
        throw this.unimplemented('Not implemented on web.');
    }

    getPlaybackOptions(): Promise<PlaybackOptions> {
        throw this.unimplemented('Not implemented on web.');
    }

    setRepeatMode(): Promise<void> {
        throw this.unimplemented('Not implemented on web.');
    }

    setShuffle(): Promise<void> {
        throw this.unimplemented('Not implemented on web.');
    }
}
