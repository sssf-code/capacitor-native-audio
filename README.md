# @mediagrid/capacitor-native-audio

## Description

Unified **native queue player** (playlist + media session) for Capacitor apps.

- Native owns playback + OS media controls (works while WebView is suspended)
- React/JS owns the queue definition while foregrounded
- Queue + position + options are persisted so state survives restarts
- Foreground UI reconciles via `getState()` / `getQueue()`

## Install

### For Capacitor 8

```bash
npm install @mediagrid/capacitor-native-audio
npx cap sync
```

### For Capacitor 7

```bash
npm install @mediagrid/capacitor-native-audio@^2.0.0
npx cap sync
```

## Android

### `AndroidManifest.xml` required changes

Located at `android/app/src/main/AndroidManifest.xml`

```xml
<application>
    <!-- OTHER STUFF -->

    <!-- Add service used for background play -->
    <service
        android:name="us.mediagrid.capacitorjs.plugins.nativeaudio.AudioPlayerService"
        android:description="@string/audio_player_service_description"
        android:foregroundServiceType="mediaPlayback"
        android:exported="true">
        <intent-filter>
            <action android:name="androidx.media3.session.MediaSessionService"/>
        </intent-filter>
    </service>

    <!-- OTHER STUFF -->
</application>

<!-- Add required permissions -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
```

### Android 13+ notification permission

If your app targets Android 13+ (API 33+), request notification permission (app-side):

- `android.permission.POST_NOTIFICATIONS`

### Notification small icon (recommended)

Set the notification small icon drawable name via Capacitor config:

```json
{
  "plugins": {
    "AudioPlayer": {
      "smallIcon": "ic_media_play"
    }
  }
}
```

### `strings.xml` required changes

Located at `android/app/src/main/res/values/strings.xml`

```xml
<resources>
    <!-- OTHER STUFF -->

    <!-- Describes the service in your app settings once installed -->
    <string name="audio_player_service_description">Allows for audio to play in the background.</string>
</resources>
```

# iOS

## Enable Audio Background Mode

This can be done in XCode or by editing `Info.plist` directly.

```xml
<!-- ios/App/App/Info.plist -->

<dict>
    <!-- OTHER STUFF -->

    <key>UIBackgroundModes</key>
    <array>
        <string>audio</string>
    </array>

    <!-- OTHER STUFF -->
</dict>
```

# API

<docgen-index>

* [`setQueue(...)`](#setqueue)
* [`syncQueue(...)`](#syncqueue)
* [`getQueue()`](#getqueue)
* [`addQueueItems(...)`](#addqueueitems)
* [`removeQueueItem(...)`](#removequeueitem)
* [`moveQueueItem(...)`](#movequeueitem)
* [`clearQueue()`](#clearqueue)
* [`play()`](#play)
* [`pause()`](#pause)
* [`stop()`](#stop)
* [`seek(...)`](#seek)
* [`skipToNext()`](#skiptonext)
* [`skipToPrevious()`](#skiptoprevious)
* [`skipToIndex(...)`](#skiptoindex)
* [`setRate(...)`](#setrate)
* [`setVolume(...)`](#setvolume)
* [`getState()`](#getstate)
* [`setItemProgress(...)`](#setitemprogress)
* [`getItemProgress(...)`](#getitemprogress)
* [`setPlaybackOptions(...)`](#setplaybackoptions)
* [`getPlaybackOptions()`](#getplaybackoptions)
* [`setRepeatMode(...)`](#setrepeatmode)
* [`setShuffle(...)`](#setshuffle)
* [`addListener('stateChange', ...)`](#addlistenerstatechange-)
* [`addListener('trackChange', ...)`](#addlistenertrackchange-)
* [`addListener('queueChange', ...)`](#addlistenerqueuechange-)
* [`addListener('metadataChange', ...)`](#addlistenermetadatachange-)
* [`removeAllListeners()`](#removealllisteners)
* [Interfaces](#interfaces)
* [Type Aliases](#type-aliases)

</docgen-index>

<docgen-api>
<!--Update the source file JSDoc comments and rerun docgen to update the docs below-->

### setQueue(...)

```typescript
setQueue(params: SetQueueParams) => Promise<void>
```

| Param        | Type                                                      |
| ------------ | --------------------------------------------------------- |
| **`params`** | <code><a href="#setqueueparams">SetQueueParams</a></code> |

--------------------


### syncQueue(...)

```typescript
syncQueue(params: SyncQueueParams) => Promise<SyncQueueResult>
```

| Param        | Type                                                        |
| ------------ | ----------------------------------------------------------- |
| **`params`** | <code><a href="#syncqueueparams">SyncQueueParams</a></code> |

**Returns:** <code>Promise&lt;<a href="#syncqueueresult">SyncQueueResult</a>&gt;</code>

--------------------


### getQueue()

```typescript
getQueue() => Promise<GetQueueResult>
```

**Returns:** <code>Promise&lt;<a href="#getqueueresult">GetQueueResult</a>&gt;</code>

--------------------


### addQueueItems(...)

```typescript
addQueueItems(params: AddQueueItemsParams) => Promise<void>
```

| Param        | Type                                                                |
| ------------ | ------------------------------------------------------------------- |
| **`params`** | <code><a href="#addqueueitemsparams">AddQueueItemsParams</a></code> |

--------------------


### removeQueueItem(...)

```typescript
removeQueueItem(params: RemoveQueueItemParams) => Promise<void>
```

| Param        | Type                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| **`params`** | <code><a href="#removequeueitemparams">RemoveQueueItemParams</a></code> |

--------------------


### moveQueueItem(...)

```typescript
moveQueueItem(params: MoveQueueItemParams) => Promise<void>
```

| Param        | Type                                                                |
| ------------ | ------------------------------------------------------------------- |
| **`params`** | <code><a href="#movequeueitemparams">MoveQueueItemParams</a></code> |

--------------------


### clearQueue()

```typescript
clearQueue() => Promise<void>
```

--------------------


### play()

```typescript
play() => Promise<void>
```

--------------------


### pause()

```typescript
pause() => Promise<void>
```

--------------------


### stop()

```typescript
stop() => Promise<void>
```

--------------------


### seek(...)

```typescript
seek(params: SeekParams) => Promise<void>
```

| Param        | Type                                              |
| ------------ | ------------------------------------------------- |
| **`params`** | <code><a href="#seekparams">SeekParams</a></code> |

--------------------


### skipToNext()

```typescript
skipToNext() => Promise<void>
```

--------------------


### skipToPrevious()

```typescript
skipToPrevious() => Promise<void>
```

--------------------


### skipToIndex(...)

```typescript
skipToIndex(params: SkipToIndexParams) => Promise<void>
```

| Param        | Type                                                            |
| ------------ | --------------------------------------------------------------- |
| **`params`** | <code><a href="#skiptoindexparams">SkipToIndexParams</a></code> |

--------------------


### setRate(...)

```typescript
setRate(params: SetRateParams) => Promise<void>
```

| Param        | Type                                                    |
| ------------ | ------------------------------------------------------- |
| **`params`** | <code><a href="#setrateparams">SetRateParams</a></code> |

--------------------


### setVolume(...)

```typescript
setVolume(params: SetVolumeParams) => Promise<void>
```

| Param        | Type                                                        |
| ------------ | ----------------------------------------------------------- |
| **`params`** | <code><a href="#setvolumeparams">SetVolumeParams</a></code> |

--------------------


### getState()

```typescript
getState() => Promise<PlayerState>
```

**Returns:** <code>Promise&lt;<a href="#playerstate">PlayerState</a>&gt;</code>

--------------------


### setItemProgress(...)

```typescript
setItemProgress(params: SetItemProgressParams) => Promise<void>
```

| Param        | Type                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| **`params`** | <code><a href="#setitemprogressparams">SetItemProgressParams</a></code> |

--------------------


### getItemProgress(...)

```typescript
getItemProgress(params: GetItemProgressParams) => Promise<ItemProgress>
```

| Param        | Type                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| **`params`** | <code><a href="#getitemprogressparams">GetItemProgressParams</a></code> |

**Returns:** <code>Promise&lt;<a href="#itemprogress">ItemProgress</a>&gt;</code>

--------------------


### setPlaybackOptions(...)

```typescript
setPlaybackOptions(params: SetPlaybackOptionsParams) => Promise<void>
```

| Param        | Type                                                                          |
| ------------ | ----------------------------------------------------------------------------- |
| **`params`** | <code><a href="#setplaybackoptionsparams">SetPlaybackOptionsParams</a></code> |

--------------------


### getPlaybackOptions()

```typescript
getPlaybackOptions() => Promise<PlaybackOptions>
```

**Returns:** <code>Promise&lt;<a href="#playbackoptions">PlaybackOptions</a>&gt;</code>

--------------------


### setRepeatMode(...)

```typescript
setRepeatMode(params: SetRepeatModeParams) => Promise<void>
```

| Param        | Type                                                                |
| ------------ | ------------------------------------------------------------------- |
| **`params`** | <code><a href="#setrepeatmodeparams">SetRepeatModeParams</a></code> |

--------------------


### setShuffle(...)

```typescript
setShuffle(params: SetShuffleParams) => Promise<void>
```

| Param        | Type                                                          |
| ------------ | ------------------------------------------------------------- |
| **`params`** | <code><a href="#setshuffleparams">SetShuffleParams</a></code> |

--------------------


### addListener('stateChange', ...)

```typescript
addListener(eventName: 'stateChange', listenerFunc: (state: PlayerState) => void) => Promise<PluginListenerHandle>
```

| Param              | Type                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| **`eventName`**    | <code>'stateChange'</code>                                              |
| **`listenerFunc`** | <code>(state: <a href="#playerstate">PlayerState</a>) =&gt; void</code> |

**Returns:** <code>Promise&lt;<a href="#pluginlistenerhandle">PluginListenerHandle</a>&gt;</code>

--------------------


### addListener('trackChange', ...)

```typescript
addListener(eventName: 'trackChange', listenerFunc: (event: TrackChangeEvent) => void) => Promise<PluginListenerHandle>
```

| Param              | Type                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| **`eventName`**    | <code>'trackChange'</code>                                                        |
| **`listenerFunc`** | <code>(event: <a href="#trackchangeevent">TrackChangeEvent</a>) =&gt; void</code> |

**Returns:** <code>Promise&lt;<a href="#pluginlistenerhandle">PluginListenerHandle</a>&gt;</code>

--------------------


### addListener('queueChange', ...)

```typescript
addListener(eventName: 'queueChange', listenerFunc: (event: QueueChangeEvent) => void) => Promise<PluginListenerHandle>
```

| Param              | Type                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| **`eventName`**    | <code>'queueChange'</code>                                                        |
| **`listenerFunc`** | <code>(event: <a href="#queuechangeevent">QueueChangeEvent</a>) =&gt; void</code> |

**Returns:** <code>Promise&lt;<a href="#pluginlistenerhandle">PluginListenerHandle</a>&gt;</code>

--------------------


### addListener('metadataChange', ...)

```typescript
addListener(eventName: 'metadataChange', listenerFunc: (event: MetadataChangeEvent) => void) => Promise<PluginListenerHandle>
```

| Param              | Type                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------- |
| **`eventName`**    | <code>'metadataChange'</code>                                                           |
| **`listenerFunc`** | <code>(event: <a href="#metadatachangeevent">MetadataChangeEvent</a>) =&gt; void</code> |

**Returns:** <code>Promise&lt;<a href="#pluginlistenerhandle">PluginListenerHandle</a>&gt;</code>

--------------------


### removeAllListeners()

```typescript
removeAllListeners() => Promise<void>
```

--------------------


### Interfaces


#### SetQueueParams

| Prop                       | Type                     |
| -------------------------- | ------------------------ |
| **`items`**                | <code>QueueItem[]</code> |
| **`startIndex`**           | <code>number \| undefined</code>      |
| **`startPositionSeconds`** | <code>number \| undefined</code>      |
| **`autoplay`**             | <code>boolean \| undefined</code>     |


#### QueueItem

| Prop                         | Type                                                         | Description                                                                |
| ---------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| **`id`**                     | <code>string</code>                                          | Stable identifier used for reconciliation and per-item bookmarks/progress. |
| **`src`**                    | <code>string</code>                                          | Remote URL or app asset path (e.g. `assets/chapter01.mp3`).                |
| **`title`**                  | <code>string</code>                                          | Display title for OS notification/lockscreen.                              |
| **`artist`**                 | <code>string \| undefined</code>                                          | Optional artist name.                                                      |
| **`album`**                  | <code>string \| undefined</code>                                          | Optional album/podcast/book name.                                          |
| **`artwork`**                | <code>string \| undefined</code>                                          | Artwork URL or app asset path.                                             |
| **`duration`**               | <code>number \| undefined</code>                                          | Optional duration in seconds (streams may be unknown).                     |
| **`metadataUpdateUrl`**      | <code>string \| undefined</code>                                          | Optional metadata update URL + interval (useful for streams/radio).        |
| **`metadataUpdateInterval`** | <code>number \| undefined</code>                                          |                                                                            |
| **`extras`**                 | <code><a href="#record">Record</a>&lt;string, any&gt; \| undefined</code> | Opaque app-defined data (not interpreted by native).                       |


#### SyncQueueResult

| Prop                | Type                |
| ------------------- | ------------------- |
| **`queueRevision`** | <code>number</code> |


#### SyncQueueParams

| Prop                        | Type                                                    |
| --------------------------- | ------------------------------------------------------- |
| **`mode`**                  | <code><a href="#syncqueuemode">SyncQueueMode</a></code> |
| **`currentItemId`**         | <code>string</code>                                     |
| **`expectedQueueRevision`** | <code>number</code>                                     |
| **`force`**                 | <code>boolean</code>                                    |


#### GetQueueResult

| Prop                | Type                     |
| ------------------- | ------------------------ |
| **`queueRevision`** | <code>number</code>      |
| **`items`**         | <code>QueueItem[]</code> |
| **`currentIndex`**  | <code>number</code>      |
| **`currentItemId`** | <code>string</code>      |


#### AddQueueItemsParams

| Prop          | Type                     |
| ------------- | ------------------------ |
| **`items`**   | <code>QueueItem[]</code> |
| **`atIndex`** | <code>number</code>      |


#### RemoveQueueItemParams

| Prop         | Type                |
| ------------ | ------------------- |
| **`itemId`** | <code>string</code> |


#### MoveQueueItemParams

| Prop            | Type                |
| --------------- | ------------------- |
| **`fromIndex`** | <code>number</code> |
| **`toIndex`**   | <code>number</code> |


#### SeekParams

| Prop                  | Type                |
| --------------------- | ------------------- |
| **`positionSeconds`** | <code>number</code> |


#### SkipToIndexParams

| Prop                  | Type                |
| --------------------- | ------------------- |
| **`index`**           | <code>number</code> |
| **`positionSeconds`** | <code>number</code> |


#### SetRateParams

| Prop       | Type                | Description                         |
| ---------- | ------------------- | ----------------------------------- |
| **`rate`** | <code>number</code> | Playback speed (e.g. `1.0` normal). |


#### SetVolumeParams

| Prop         | Type                | Description       |
| ------------ | ------------------- | ----------------- |
| **`volume`** | <code>number</code> | Volume in 0..100. |


#### PlayerState

| Prop                | Type                                                      | Description                                                      |
| ------------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| **`stateRevision`** | <code>number</code>                                       | Monotonic revision that increments on any state change.          |
| **`queueRevision`** | <code>number</code>                                       | Monotonic revision that increments on any queue topology change. |
| **`status`**        | <code><a href="#playbackstatus">PlaybackStatus</a></code> |                                                                  |
| **`currentIndex`**  | <code>number</code>                                       |                                                                  |
| **`currentItemId`** | <code>string</code>                                       |                                                                  |
| **`position`**      | <code>number</code>                                       |                                                                  |
| **`duration`**      | <code>number</code>                                       |                                                                  |
| **`rate`**          | <code>number</code>                                       |                                                                  |
| **`volume`**        | <code>number</code>                                       | Volume in 0..100.                                                |
| **`repeatMode`**    | <code><a href="#repeatmode">RepeatMode</a></code>         |                                                                  |
| **`shuffle`**       | <code>boolean</code>                                      |                                                                  |


#### SetItemProgressParams

| Prop                  | Type                 |
| --------------------- | -------------------- |
| **`itemId`**          | <code>string</code>  |
| **`positionSeconds`** | <code>number</code>  |
| **`durationSeconds`** | <code>number</code>  |
| **`completed`**       | <code>boolean</code> |


#### ItemProgress

| Prop                   | Type                 |
| ---------------------- | -------------------- |
| **`itemId`**           | <code>string</code>  |
| **`positionSeconds`**  | <code>number</code>  |
| **`durationSeconds`**  | <code>number</code>  |
| **`completed`**        | <code>boolean</code> |
| **`updatedAtEpochMs`** | <code>number</code>  |


#### GetItemProgressParams

| Prop         | Type                |
| ------------ | ------------------- |
| **`itemId`** | <code>string</code> |


#### SetPlaybackOptionsParams


#### PlaybackOptions

| Prop                               | Type                 | Description                                                                                                           | Default           |
| ---------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **`previousThresholdSeconds`**     | <code>number</code>  | When user presses previous: if current position is above this threshold, seek to 0 instead of going to previous item. | <code>7</code>    |
| **`skipForwardSeconds`**           | <code>number</code>  | OS skip buttons (seek +/- fixed seconds) configuration.                                                               | <code>10</code>   |
| **`skipBackwardSeconds`**          | <code>number</code>  | OS skip buttons (seek +/- fixed seconds) configuration.                                                               | <code>10</code>   |
| **`enableNextPrev`**               | <code>boolean</code> | Whether to expose next/previous track controls in OS UIs when possible.                                               | <code>true</code> |
| **`enableSeekTo`**                 | <code>boolean</code> | Whether to expose scrubbing (seek-to) controls in OS UIs when possible.                                               | <code>true</code> |
| **`enableStop`**                   | <code>boolean</code> | Whether to expose stop controls in OS UIs when possible.                                                              | <code>true</code> |
| **`androidNotificationSmallIcon`** | <code>string</code>  | Android-only: override the drawable name for the notification small icon. (No extension, no `R.drawable.` prefix.)    |                   |


#### SetRepeatModeParams

| Prop             | Type                                              |
| ---------------- | ------------------------------------------------- |
| **`repeatMode`** | <code><a href="#repeatmode">RepeatMode</a></code> |


#### SetShuffleParams

| Prop          | Type                 |
| ------------- | -------------------- |
| **`shuffle`** | <code>boolean</code> |


#### PluginListenerHandle

| Prop         | Type                                      |
| ------------ | ----------------------------------------- |
| **`remove`** | <code>() =&gt; Promise&lt;void&gt;</code> |


#### TrackChangeEvent

| Prop                | Type                                            |
| ------------------- | ----------------------------------------------- |
| **`queueRevision`** | <code>number</code>                             |
| **`currentIndex`**  | <code>number</code>                             |
| **`item`**          | <code><a href="#queueitem">QueueItem</a></code> |


#### QueueChangeEvent


#### MetadataChangeEvent

| Prop                | Type                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------- |
| **`stateRevision`** | <code>number</code>                                                                   |
| **`itemId`**        | <code>string</code>                                                                   |
| **`metadata`**      | <code><a href="#partial">Partial</a>&lt;<a href="#queueitem">QueueItem</a>&gt;</code> |


### Type Aliases


#### Record

Construct a type with a set of properties K of type T

<code>{ [P in K]: T; }</code>


#### SyncQueueMode

<code>'replace' | 'patch'</code>


#### PlaybackStatus

<code>'playing' | 'paused' | 'stopped'</code>


#### RepeatMode

<code>'off' | 'one' | 'all'</code>


#### Partial

Make all properties in T optional

<code>{ [P in keyof T]?: T[P]; }</code>

</docgen-api>
