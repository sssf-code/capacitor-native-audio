import { registerPlugin } from '@capacitor/core';

import type { AudioPlayerPlugin } from './definitions';

const AudioPlayer = registerPlugin<AudioPlayerPlugin>('AudioPlayer', {
    web: () => import('./web').then(m => new m.AudioPlayerWeb()),
});

export type {
    AddQueueItemsParams,
    AudioPlayerPlugin,
    GetItemProgressParams,
    GetQueueResult,
    ItemProgress,
    MetadataChangeEvent,
    MoveQueueItemParams,
    PlaybackOptions,
    PlaybackStatus,
    PlayerState,
    QueueChangeEvent,
    QueueItem,
    RemoveQueueItemParams,
    RepeatMode,
    SeekParams,
    SetItemProgressParams,
    SetPlaybackOptionsParams,
    SetQueueParams,
    SetRateParams,
    SetRepeatModeParams,
    SetShuffleParams,
    SetVolumeParams,
    SkipToIndexParams,
    SyncQueueMode,
    SyncQueueParams,
    SyncQueueResult,
    TrackChangeEvent,
} from './definitions';
export { AudioPlayer };
