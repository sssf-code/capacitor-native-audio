package us.mediagrid.capacitorjs.plugins.nativeaudio;

import android.content.ComponentName;
import android.content.Context;
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

    @Override
    public void load() {
        super.load();
        ensureController(null);
    }

    @Override
    protected void handleOnDestroy() {
        cleanup();
        super.handleOnDestroy();
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
        if (itemId == null || itemId.isEmpty()) {
            call.reject("Missing required parameter 'itemId'");
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
        ensureController(call);
        final ListenableFuture<MediaController> cf = controllerFuture;
        if (cf == null) {
            call.reject("Media controller not initialized.");
            return;
        }
        cf.addListener(() -> {
            try {
                MediaController c = cf.get();
                c.play();
                call.resolve();
            } catch (Exception e) {
                call.reject("Failed to play", e);
            }
        }, MoreExecutors.directExecutor());
    }

    @PluginMethod
    public void pause(PluginCall call) {
        ensureController(call);
        final ListenableFuture<MediaController> cf = controllerFuture;
        if (cf == null) {
            call.reject("Media controller not initialized.");
            return;
        }
        cf.addListener(() -> {
            try {
                MediaController c = cf.get();
                c.pause();
                call.resolve();
            } catch (Exception e) {
                call.reject("Failed to pause", e);
            }
        }, MoreExecutors.directExecutor());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ensureController(call);
        final ListenableFuture<MediaController> cf = controllerFuture;
        if (cf == null) {
            call.reject("Media controller not initialized.");
            return;
        }
        cf.addListener(() -> {
            try {
                MediaController c = cf.get();
                c.stop();
                c.seekTo(0);
                call.resolve();
            } catch (Exception e) {
                call.reject("Failed to stop", e);
            }
        }, MoreExecutors.directExecutor());
    }

    @PluginMethod
    public void seek(PluginCall call) {
        ensureController(call);
        Double pos = call.getDouble("positionSeconds");
        if (pos == null) {
            call.reject("positionSeconds is required.");
            return;
        }
        final ListenableFuture<MediaController> cf = controllerFuture;
        if (cf == null) {
            call.reject("Media controller not initialized.");
            return;
        }
        cf.addListener(() -> {
            try {
                MediaController c = cf.get();
                c.seekTo((long) (Math.max(0, pos) * 1000));
                call.resolve();
            } catch (Exception e) {
                call.reject("Failed to seek", e);
            }
        }, MoreExecutors.directExecutor());
    }

    @PluginMethod
    public void skipToNext(PluginCall call) {
        ensureController(call);
        final ListenableFuture<MediaController> cf = controllerFuture;
        if (cf == null) {
            call.reject("Media controller not initialized.");
            return;
        }
        cf.addListener(() -> {
            try {
                MediaController c = cf.get();
                c.seekToNextMediaItem();
                call.resolve();
            } catch (Exception e) {
                call.reject("Failed to skip to next", e);
            }
        }, MoreExecutors.directExecutor());
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
            call.reject("Missing required parameter 'rate'");
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
            call.reject("Missing required parameter 'volume'");
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
        if (itemId == null || itemId.isEmpty()) {
            call.reject("Missing required parameter 'itemId'");
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
        if (repeatMode == null || repeatMode.isEmpty()) {
            call.reject("Missing required parameter 'repeatMode'");
            return;
        }
        JSObject obj = new JSObject();
        obj.put("repeatMode", repeatMode);
        sendCustom(call, QueuePlayer.CMD_SET_REPEAT_MODE, obj, null);
    }

    @PluginMethod
    public void setShuffle(PluginCall call) {
        JSObject obj = new JSObject();
        obj.put("shuffle", call.getBoolean("shuffle", false));
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
                c.addListener(playerListener);
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
            emitStateChange();
            emitQueueChange();
            emitTrackChange();
            emitMetadataChange();
        }, 150);
    }

    private void emitStateChange() {
        sendCustomCommandInternal(QueuePlayer.CMD_GET_STATE, "state", "stateChange");
    }

    private void emitQueueChange() {
        sendCustomCommandInternal(QueuePlayer.CMD_GET_QUEUE, "queue", "queueChange");
    }

    private void emitTrackChange() {
        sendCustomCommandInternal(QueuePlayer.CMD_GET_QUEUE, "queue", "trackChange");
    }

    private void emitMetadataChange() {
        // Derive metadataChange by diffing current item metadata from queue snapshot.
        sendCustomCommandInternal(QueuePlayer.CMD_GET_QUEUE, "queue", "metadataChange");
    }

    private void sendCustomCommandInternal(String action, String resultKey, String eventName) {
        final ListenableFuture<MediaController> cf = controllerFuture;
        if (cf == null) return;
        cf.addListener(() -> {
            try {
                MediaController c = cf.get();
                Bundle args = new Bundle();
                args.putString("json", "{}");
                ListenableFuture<SessionResult> future = c.sendCustomCommand(new SessionCommand(action, Bundle.EMPTY), args);
                future.addListener(() -> {
                    try {
                        SessionResult result = future.get();
                        String json = result.extras != null ? result.extras.getString(resultKey) : null;
                        if (json == null) return;

                        if ("trackChange".equals(eventName)) {
                            JSObject queueObj = new JSObject(json);
                            int idx = queueObj.getInteger("currentIndex", 0);
                            Object itemsObj = queueObj.get("items");
                            if (!(itemsObj instanceof org.json.JSONArray)) return;
                            org.json.JSONArray arr = (org.json.JSONArray) itemsObj;
                            if (idx < 0 || idx >= arr.length()) return;
                            JSObject item = new JSObject(arr.getJSONObject(idx).toString());
                            JSObject payloadObj = new JSObject();
                            long queueRevision = queueObj.has("queueRevision") ? queueObj.getLong("queueRevision") : 0;
                            payloadObj.put("queueRevision", queueRevision);
                            payloadObj.put("currentIndex", idx);
                            payloadObj.put("item", item);
                            notifyListeners("trackChange", payloadObj);
                            return;
                        }

                        if ("stateChange".equals(eventName)) {
                            try {
                                JSObject stateObj = new JSObject(json);
                                Object sr = stateObj.get("stateRevision");
                                if (sr instanceof Number) {
                                    lastStateRevision = ((Number) sr).longValue();
                                }
                                notifyListeners("stateChange", stateObj);
                            } catch (Exception ignored) {}
                            return;
                        }

                        if ("metadataChange".equals(eventName)) {
                            JSObject queueObj = new JSObject(json);
                            int stateRevision = queueObj.getInteger("stateRevision", lastStateRevision);
                            int idx = queueObj.getInteger("currentIndex", 0);
                            Object itemsObj = queueObj.get("items");
                            if (!(itemsObj instanceof org.json.JSONArray)) return;
                            org.json.JSONArray arr = (org.json.JSONArray) itemsObj;
                            if (idx < 0 || idx >= arr.length()) return;
                            JSObject item = new JSObject(arr.getJSONObject(idx).toString());
                            String itemId = item.getString("id");
                            if (itemId == null) return;
                            String title = item.getString("title");
                            String artist = item.getString("artist");
                            String album = item.getString("album");
                            String artwork = item.getString("artwork");
                            String fp = String.valueOf(title) + "|" + String.valueOf(artist) + "|" + String.valueOf(album) + "|" + String.valueOf(artwork);

                            boolean changed = false;
                            if (!itemId.equals(lastMetadataItemId)) {
                                lastMetadataItemId = itemId;
                                lastMetadataFingerprintByCurrentItem = fp;
                                return;
                            }
                            if (lastMetadataFingerprintByCurrentItem == null || !lastMetadataFingerprintByCurrentItem.equals(fp)) {
                                lastMetadataFingerprintByCurrentItem = fp;
                                changed = true;
                            }
                            if (!changed) return;

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
                            return;
                        }

                        notifyListeners(eventName, new JSObject(json));
                    } catch (Exception ignored) {}
                }, MoreExecutors.directExecutor());
            } catch (Exception ignored) {}
        }, MoreExecutors.directExecutor());
    }

    private void cleanup() {
        // Cancel any pending emit callbacks.
        mainHandler.removeCallbacksAndMessages(null);
        emitScheduled = false;

        // Release controller (best-effort).
        if (controller != null) {
            try {
                controller.removeListener(playerListener);
            } catch (Exception ignored) {}
            try {
                controller.release();
            } catch (Exception ignored) {}
            controller = null;
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

