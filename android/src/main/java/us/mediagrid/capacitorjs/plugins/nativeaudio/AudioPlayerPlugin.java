package ssf.capacitorjs.plugins.nativeaudio;

import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.Nullable;
import androidx.media3.common.Player;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionResult;
import androidx.media3.session.SessionToken;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.MoreExecutors;
import org.json.JSONObject;

@CapacitorPlugin(name = "AudioPlayer")
public class AudioPlayerPlugin extends Plugin {

    private static final String TAG = "AudioPlayerPlugin";

    private ListenableFuture<MediaController> controllerFuture;
    private MediaController controller;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile boolean emitScheduled = false;
    private String lastMetadataFingerprintByCurrentItem = null;
    private String lastMetadataItemId = null;
    private long lastStateRevision = 0;
    private long lastQueueRevision = 0;
    private String lastCurrentItemId = null;

    private BroadcastReceiver audioBecomingNoisyReceiver;
    private boolean audioBecomingNoisyReceiverRegistered;

    @Override
    public void load() {
        super.load();
        ensureController(null);
        registerAudioBecomingNoisyReceiver();
    }

    @Override
    protected void handleOnDestroy() {
        cleanup();
        super.handleOnDestroy();
    }

    private interface ControllerTask {
        void run(MediaController controller) throws Exception;
    }

    private void withController(PluginCall call, String errorPrefix, ControllerTask task) {
        ensureController(call);
        final ListenableFuture<MediaController> cf = controllerFuture;
        if (cf == null) {
            call.reject("Media controller not initialized.");
            return;
        }
        cf.addListener(() -> {
            try {
                MediaController c = cf.get();
                mainHandler.post(() -> {
                    try {
                        task.run(c);
                        call.resolve();
                    } catch (Exception e) {
                        call.reject(errorPrefix, e);
                    }
                });
            } catch (Exception e) {
                call.reject(errorPrefix, e);
            }
        }, MoreExecutors.directExecutor());
    }

    // MARK: - Queue

    @PluginMethod
    public void setQueue(PluginCall call) {
        sendCustom(call, QueuePlayer.CMD_SET_QUEUE, jsonFromCall(call), null);
    }

    @PluginMethod
    public void syncQueue(PluginCall call) {
        sendCustom(call, QueuePlayer.CMD_SYNC_QUEUE, jsonFromCall(call), result -> {
            long queueRevision = result.extras != null ? result.extras.getLong("queueRevision", 0) : 0;
            JSObject out = new JSObject();
            out.put("queueRevision", queueRevision);
            call.resolve(out);
        });
    }

    @PluginMethod
    public void getQueue(PluginCall call) {
        sendCustom(call, QueuePlayer.CMD_GET_QUEUE, new JSONObject(), result -> {
            String json = result.extras != null ? result.extras.getString("queue") : null;
            call.resolve(json != null ? new JSObject(json) : new JSObject());
        });
    }

    @PluginMethod
    public void addQueueItems(PluginCall call) {
        sendCustom(call, QueuePlayer.CMD_ADD_ITEMS, jsonFromCall(call), null);
    }

    @PluginMethod
    public void removeQueueItem(PluginCall call) {
        String itemId = call.getString("itemId");
        if (itemId == null || itemId.trim().isEmpty()) {
            call.reject("Missing required parameter 'itemId'.");
            return;
        }
        JSObject obj = new JSObject();
        obj.put("itemId", itemId);
        sendCustom(call, QueuePlayer.CMD_REMOVE_ITEM, obj, null);
    }

    @PluginMethod
    public void moveQueueItem(PluginCall call) {
        sendCustom(call, QueuePlayer.CMD_MOVE_ITEM, jsonFromCall(call), null);
    }

    @PluginMethod
    public void clearQueue(PluginCall call) {
        sendCustom(call, QueuePlayer.CMD_CLEAR_QUEUE, new JSONObject(), null);
    }

    // MARK: - Playback

    @PluginMethod
    public void play(PluginCall call) {
        withController(call, "Failed to play.", MediaController::play);
    }

    @PluginMethod
    public void pause(PluginCall call) {
        withController(call, "Failed to pause.", MediaController::pause);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        withController(call, "Failed to stop.", c -> {
            c.stop();
            c.seekTo(0);
        });
    }

    @PluginMethod
    public void seek(PluginCall call) {
        Double pos = call.getDouble("positionSeconds");
        if (pos == null) {
            call.reject("positionSeconds is required.");
            return;
        }
        final long ms = (long) (Math.max(0, pos) * 1000);
        withController(call, "Failed to seek.", c -> c.seekTo(ms));
    }

    @PluginMethod
    public void skipToNext(PluginCall call) {
        withController(call, "Failed to skip to next.", MediaController::seekToNextMediaItem);
    }

    @PluginMethod
    public void skipToPrevious(PluginCall call) {
        sendCustom(call, QueuePlayer.CMD_SKIP_TO_PREVIOUS, new JSONObject(), null);
    }

    @PluginMethod
    public void skipToIndex(PluginCall call) {
        sendCustom(call, QueuePlayer.CMD_SKIP_TO_INDEX, jsonFromCall(call), null);
    }

    @PluginMethod
    public void setRate(PluginCall call) {
        Double rate = call.getDouble("rate");
        if (rate == null) {
            call.reject("Missing required parameter 'rate'.");
            return;
        }
        JSObject obj = new JSObject();
        obj.put("rate", rate);
        sendCustom(call, QueuePlayer.CMD_SET_RATE, obj, null);
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        Double volume = call.getDouble("volume");
        if (volume == null) {
            call.reject("Missing required parameter 'volume'.");
            return;
        }
        JSObject obj = new JSObject();
        obj.put("volume", volume);
        sendCustom(call, QueuePlayer.CMD_SET_VOLUME, obj, null);
    }

    // MARK: - State

    @PluginMethod
    public void getState(PluginCall call) {
        sendCustom(call, QueuePlayer.CMD_GET_STATE, new JSONObject(), result -> {
            String json = result.extras != null ? result.extras.getString("state") : null;
            call.resolve(json != null ? new JSObject(json) : new JSObject());
        });
    }

    // MARK: - Progress

    @PluginMethod
    public void setItemProgress(PluginCall call) {
        sendCustom(call, QueuePlayer.CMD_SET_PROGRESS, jsonFromCall(call), null);
    }

    @PluginMethod
    public void getItemProgress(PluginCall call) {
        String itemId = call.getString("itemId");
        if (itemId == null || itemId.trim().isEmpty()) {
            call.reject("Missing required parameter 'itemId'.");
            return;
        }
        JSObject obj = new JSObject();
        obj.put("itemId", itemId);
        sendCustom(call, QueuePlayer.CMD_GET_PROGRESS, obj, result -> {
            String json = result.extras != null ? result.extras.getString("progress") : null;
            call.resolve(json != null ? new JSObject(json) : new JSObject());
        });
    }

    // MARK: - Options

    @PluginMethod
    public void setPlaybackOptions(PluginCall call) {
        sendCustom(call, QueuePlayer.CMD_SET_OPTIONS, jsonFromCall(call), null);
    }

    @PluginMethod
    public void setRepeatMode(PluginCall call) {
        String repeatMode = call.getString("repeatMode");
        if (repeatMode == null || repeatMode.trim().isEmpty()) {
            call.reject("Missing required parameter 'repeatMode'.");
            return;
        }
        JSObject obj = new JSObject();
        obj.put("repeatMode", repeatMode);
        sendCustom(call, QueuePlayer.CMD_SET_REPEAT_MODE, obj, null);
    }

    @PluginMethod
    public void setShuffle(PluginCall call) {
        Boolean shuffle = call.getBoolean("shuffle");
        if (shuffle == null) {
            call.reject("Missing required parameter 'shuffle'.");
            return;
        }
        JSObject obj = new JSObject();
        obj.put("shuffle", shuffle);
        sendCustom(call, QueuePlayer.CMD_SET_SHUFFLE, obj, null);
    }

    @PluginMethod
    public void getPlaybackOptions(PluginCall call) {
        sendCustom(call, QueuePlayer.CMD_GET_OPTIONS, new JSONObject(), result -> {
            String json = result.extras != null ? result.extras.getString("options") : null;
            call.resolve(json != null ? new JSObject(json) : new JSObject());
        });
    }

    // MARK: - Controller plumbing + event emission

    private void ensureController(@Nullable PluginCall callToReject) {
        if (controller != null) return;
        if (controllerFuture != null) return;

        Context context = getContext();
        ComponentName serviceComponent = new ComponentName(context, AudioPlayerService.class);
        SessionToken token = new SessionToken(context, serviceComponent);

        final ListenableFuture<MediaController> future = new MediaController.Builder(context, token).buildAsync();
        controllerFuture = future;
        future.addListener(() -> {
            try {
                MediaController c = future.get();
                controller = c;
                mainHandler.post(() -> c.addListener(playerListener));
            } catch (Exception e) {
                if (callToReject != null) callToReject.reject("Failed to initialize media controller", e);
            }
        }, MoreExecutors.directExecutor());
    }

    private JSONObject jsonFromCall(PluginCall call) {
        try {
            return new JSONObject(call.getData().toString());
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private interface ResultHandler {
        void handle(SessionResult result) throws Exception;
    }

    private void sendCustom(
        PluginCall call,
        String action,
        JSONObject payload,
        @Nullable ResultHandler handler
    ) {
        ensureController(call);
        final ListenableFuture<MediaController> cf = controllerFuture;
        if (cf == null) {
            call.reject("Media controller not initialized.");
            return;
        }

        cf.addListener(() -> {
            try {
                MediaController c = cf.get();
                mainHandler.post(() -> {
                    try {
                        Bundle args = new Bundle();
                        args.putString("json", payload != null ? payload.toString() : "{}");
                        ListenableFuture<SessionResult> future = c.sendCustomCommand(
                            new SessionCommand(action, Bundle.EMPTY),
                            args
                        );
                        future.addListener(() -> {
                            try {
                                SessionResult result = future.get();
                                if (result.resultCode != SessionResult.RESULT_SUCCESS) {
                                    long queueRevision = result.extras != null ? result.extras.getLong("queueRevision", -1) : -1;
                                    if (queueRevision != -1) {
                                        call.reject("Command failed (" + action + "): queueRevision=" + queueRevision);
                                    } else {
                                        call.reject("Command failed (" + action + "), code=" + result.resultCode);
                                    }
                                    return;
                                }
                                if (handler != null) handler.handle(result);
                                else call.resolve();
                                scheduleEmit();
                            } catch (Exception e) {
                                call.reject("Command failed: " + action, e);
                            }
                        }, MoreExecutors.directExecutor());
                    } catch (Exception e) {
                        call.reject("Command failed: " + action, e);
                    }
                });
            } catch (Exception e) {
                call.reject("Command failed: " + action, e);
            }
        }, MoreExecutors.directExecutor());
    }

    private final Player.Listener playerListener = new Player.Listener() {
        @Override
        public void onEvents(Player player, Player.Events events) {
            scheduleEmit();
        }
    };

    private void scheduleEmit() {
        if (emitScheduled) return;
        emitScheduled = true;
        mainHandler.postDelayed(() -> {
            emitScheduled = false;
            emitAll();
        }, 150);
    }

    private interface SnapshotHandler {
        void handle(String json) throws Exception;
    }

    private void fetchSnapshot(String action, String resultKey, SnapshotHandler handler) {
        final ListenableFuture<MediaController> cf = controllerFuture;
        if (cf == null) return;
        cf.addListener(() -> {
            try {
                MediaController c = cf.get();
                mainHandler.post(() -> {
                    try {
                        Bundle args = new Bundle();
                        args.putString("json", "{}");
                        ListenableFuture<SessionResult> future = c.sendCustomCommand(new SessionCommand(action, Bundle.EMPTY), args);
                        future.addListener(() -> {
                            try {
                                SessionResult result = future.get();
                                String json = result.extras != null ? result.extras.getString(resultKey) : null;
                                if (json == null) return;
                                handler.handle(json);
                            } catch (Exception ignored) {}
                        }, MoreExecutors.directExecutor());
                    } catch (Exception ignored) {}
                });
            } catch (Exception ignored) {}
        }, MoreExecutors.directExecutor());
    }

    private void emitAll() {
        // First fetch state; if stateRevision hasn't changed, skip everything else.
        fetchSnapshot(QueuePlayer.CMD_GET_STATE, "state", stateJson -> {
            JSObject stateObj;
            try {
                stateObj = new JSObject(stateJson);
            } catch (Exception e) {
                return;
            }

            Object srAny = stateObj.get("stateRevision");
            long stateRevision = (srAny instanceof Number) ? ((Number) srAny).longValue() : 0;
            if (stateRevision != 0 && stateRevision == lastStateRevision) {
                return;
            }
            lastStateRevision = stateRevision;
            notifyListeners("stateChange", stateObj);

            // Now fetch queue once and derive queue/track/metadata events from it.
            fetchSnapshot(QueuePlayer.CMD_GET_QUEUE, "queue", queueJson -> {
                JSObject queueObj;
                try {
                    queueObj = new JSObject(queueJson);
                } catch (Exception e) {
                    return;
                }

                long queueRevision = queueObj.has("queueRevision") ? queueObj.getLong("queueRevision") : 0;
                if (!(queueRevision != 0 && queueRevision == lastQueueRevision)) {
                    lastQueueRevision = queueRevision;
                    notifyListeners("queueChange", queueObj);
                }

                int idx = queueObj.getInteger("currentIndex", 0);
                Object itemsObj = queueObj.get("items");
                if (!(itemsObj instanceof org.json.JSONArray)) return;
                org.json.JSONArray arr = (org.json.JSONArray) itemsObj;
                if (idx < 0 || idx >= arr.length()) return;

                JSObject item = new JSObject(arr.getJSONObject(idx).toString());
                String itemId = item.getString("id");

                boolean sameItem =
                    (itemId == null && lastCurrentItemId == null) ||
                        (itemId != null && itemId.equals(lastCurrentItemId));

                if (!sameItem) {
                    lastCurrentItemId = itemId;
                    // Reset metadata tracking on track changes.
                    lastMetadataItemId = itemId;
                    lastMetadataFingerprintByCurrentItem = null;

                    JSObject payloadObj = new JSObject();
                    payloadObj.put("queueRevision", queueRevision);
                    payloadObj.put("currentIndex", idx);
                    payloadObj.put("item", item);
                    notifyListeners("trackChange", payloadObj);
                    return;
                }

                // Derive metadataChange by diffing current item metadata from queue snapshot.
                if (itemId == null) return;
                String title = item.getString("title");
                String artist = item.getString("artist");
                String album = item.getString("album");
                String artwork = item.getString("artwork");
                String fp =
                    String.valueOf(title) +
                        "|" +
                        String.valueOf(artist) +
                        "|" +
                        String.valueOf(album) +
                        "|" +
                        String.valueOf(artwork);

                if (!itemId.equals(lastMetadataItemId)) {
                    lastMetadataItemId = itemId;
                    lastMetadataFingerprintByCurrentItem = fp;
                    return;
                }
                if (lastMetadataFingerprintByCurrentItem != null && lastMetadataFingerprintByCurrentItem.equals(fp)) {
                    return;
                }
                lastMetadataFingerprintByCurrentItem = fp;

                JSObject metadata = new JSObject();
                if (title != null) metadata.put("title", title);
                if (artist != null) metadata.put("artist", artist);
                if (album != null) metadata.put("album", album);
                if (artwork != null) metadata.put("artwork", artwork);

                JSObject payloadObj = new JSObject();
                payloadObj.put("stateRevision", stateRevision);
                payloadObj.put("itemId", itemId);
                payloadObj.put("metadata", metadata);
                notifyListeners("metadataChange", payloadObj);
            });
        });
    }

    private void registerAudioBecomingNoisyReceiver() {
        if (audioBecomingNoisyReceiverRegistered) return;
        Context context = getContext();
        if (context == null) return;
        if (audioBecomingNoisyReceiver == null) {
            audioBecomingNoisyReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                        mainHandler.post(() -> notifyListeners("audioBecomingNoisy", new JSObject()));
                    }
                }
            };
        }
        IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            try {
                context.registerReceiver(audioBecomingNoisyReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
                audioBecomingNoisyReceiverRegistered = true;
            } catch (Exception ignored) {
                audioBecomingNoisyReceiver = null;
                audioBecomingNoisyReceiverRegistered = false;
            }
        } else {
            try {
                context.registerReceiver(audioBecomingNoisyReceiver, filter);
                audioBecomingNoisyReceiverRegistered = true;
            } catch (Exception ignored) {
                audioBecomingNoisyReceiver = null;
                audioBecomingNoisyReceiverRegistered = false;
            }
        }
    }

    private void unregisterAudioBecomingNoisyReceiver() {
        if (!audioBecomingNoisyReceiverRegistered || audioBecomingNoisyReceiver == null) return;
        Context context = getContext();
        if (context != null) {
            try {
                context.unregisterReceiver(audioBecomingNoisyReceiver);
            } catch (Exception ignored) {}
        }
        audioBecomingNoisyReceiverRegistered = false;
        audioBecomingNoisyReceiver = null;
    }

    private void cleanup() {
        unregisterAudioBecomingNoisyReceiver();
        // Cancel any pending emit callbacks.
        mainHandler.removeCallbacksAndMessages(null);
        emitScheduled = false;
        lastStateRevision = 0;
        lastQueueRevision = 0;
        lastCurrentItemId = null;
        lastMetadataItemId = null;
        lastMetadataFingerprintByCurrentItem = null;

        // Release controller (best-effort).
        if (controller != null) {
            final MediaController c = controller;
            controller = null;
            mainHandler.post(() -> {
                try {
                    c.removeListener(playerListener);
                } catch (Exception ignored) {}
                try {
                    c.release();
                } catch (Exception ignored) {}
            });
        }

        // Release controller future (best-effort).
        if (controllerFuture != null) {
            try {
                MediaController.releaseFuture(controllerFuture);
            } catch (Exception ignored) {}
            controllerFuture = null;
        }
    }
}

