package ssf.capacitorjs.plugins.nativeaudio;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.MediaSession;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionResult;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class QueuePlayer implements Player.Listener {
    private static final String TAG = "QueuePlayer";

    // Custom commands (plugin -> service)
    static final String CMD_SET_QUEUE = "mg.audio.setQueue";
    static final String CMD_SYNC_QUEUE = "mg.audio.syncQueue";
    static final String CMD_GET_QUEUE = "mg.audio.getQueue";
    static final String CMD_ADD_ITEMS = "mg.audio.addItems";
    static final String CMD_REMOVE_ITEM = "mg.audio.removeItem";
    static final String CMD_MOVE_ITEM = "mg.audio.moveItem";
    static final String CMD_CLEAR_QUEUE = "mg.audio.clearQueue";
    static final String CMD_GET_STATE = "mg.audio.getState";
    static final String CMD_SET_PROGRESS = "mg.audio.setProgress";
    static final String CMD_GET_PROGRESS = "mg.audio.getProgress";
    static final String CMD_SET_OPTIONS = "mg.audio.setOptions";
    static final String CMD_GET_OPTIONS = "mg.audio.getOptions";
    static final String CMD_SET_VOLUME = "mg.audio.setVolume";
    static final String CMD_SET_RATE = "mg.audio.setRate";
    static final String CMD_SET_REPEAT_MODE = "mg.audio.setRepeatMode";
    static final String CMD_SET_SHUFFLE = "mg.audio.setShuffle";
    static final String CMD_SKIP_TO_PREVIOUS = "mg.audio.skipToPrevious";
    static final String CMD_SKIP_TO_INDEX = "mg.audio.skipToIndex";

    private final Context context;
    private final ExoPlayer player;
    private final QueueStore store;

    private final List<QueueModels.QueueItem> queue = new ArrayList<>();
    private final Map<String, QueueModels.ItemProgress> progressByItemId = new HashMap<>();

    private long stateRevision = 0;
    private long queueRevision = 0;
    private String status = "stopped";
    private String repeatMode = "off";
    private boolean shuffle = false;

    private QueueModels.PlaybackOptions options = QueueModels.PlaybackOptions.defaults();

    private boolean isRestoring = false;
    private boolean isStopped = true;

    private final ScheduledExecutorService metadataScheduler = Executors.newSingleThreadScheduledExecutor();
    private @Nullable ScheduledFuture<?> metadataTask;
    private @Nullable String lastMetadataFingerprint;

    private final ScheduledExecutorService progressScheduler = Executors.newSingleThreadScheduledExecutor();
    private @Nullable ScheduledFuture<?> progressTask;
    private @Nullable String lastProgressItemId;
    private long lastProgressPositionMs = 0;
    private long lastProgressDurationMs = C.TIME_UNSET;

    QueuePlayer(Context context, ExoPlayer player) {
        this.context = context.getApplicationContext();
        this.player = player;
        this.store = new QueueStore(this.context);
        this.player.addListener(this);

        // Best-effort: default notification small icon from capacitor config.
        String cfgIcon = readSmallIconFromCapacitorConfig(this.context);
        if (cfgIcon != null && options.androidNotificationSmallIcon == null) {
            options.androidNotificationSmallIcon = cfgIcon;
        }

        restoreIfAvailable();
    }

    QueueModels.PlaybackOptions getOptionsSnapshot() {
        return options;
    }

    void release() {
        try {
            stopMetadataPolling();
            metadataScheduler.shutdownNow();
        } catch (Exception ignored) {}
        try {
            stopProgressUpdates();
            progressScheduler.shutdownNow();
        } catch (Exception ignored) {}
        try {
            player.removeListener(this);
        } catch (Exception ignored) {}
    }

    ExoPlayer getPlayer() {
        return player;
    }

    @Nullable
    String getConfiguredNotificationSmallIconName() {
        return options.androidNotificationSmallIcon;
    }

    int getResolvedNotificationSmallIconResId() {
        String name = options.androidNotificationSmallIcon;
        if (name == null || name.trim().isEmpty()) {
            name = "ic_media_play";
        }
        int resId = context.getResources().getIdentifier(name, "drawable", context.getPackageName());
        if (resId == 0) {
            resId = context.getResources().getIdentifier("ic_media_play", "drawable", context.getPackageName());
        }
        if (resId == 0) {
            resId = context.getApplicationInfo().icon;
        }
        return resId;
    }

    // MARK: - Custom command handler (MediaSessionCallback delegates here)

    ListenableFuture<SessionResult> handleCustomCommand(MediaSession session, SessionCommand cmd, JSONObject args) {
        try {
            String action = cmd.customAction;
            if (CMD_SET_QUEUE.equals(action)) {
                setQueueFromArgs(args);
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            }
            if (CMD_SYNC_QUEUE.equals(action)) {
                long expected = args != null && args.has("expectedQueueRevision")
                    ? args.optLong("expectedQueueRevision", -1)
                    : -1;
                boolean force = args != null && args.optBoolean("force", false);
                if (expected != -1 && expected != queueRevision && !force) {
                    BundleJson bundle = new BundleJson();
                    bundle.putLong("queueRevision", queueRevision);
                    return Futures.immediateFuture(
                        new SessionResult(SessionResult.RESULT_ERROR_BAD_VALUE, bundle.toBundle())
                    );
                }

                setQueueFromArgs(args);
                BundleJson bundle = new BundleJson();
                bundle.putLong("queueRevision", queueRevision);
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS, bundle.toBundle()));
            }
            if (CMD_GET_QUEUE.equals(action)) {
                BundleJson bundle = new BundleJson();
                bundle.putJSONObject("queue", getQueueJson());
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS, bundle.toBundle()));
            }
            if (CMD_ADD_ITEMS.equals(action)) {
                addItemsFromArgs(args);
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            }
            if (CMD_REMOVE_ITEM.equals(action)) {
                removeItemFromArgs(args);
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            }
            if (CMD_MOVE_ITEM.equals(action)) {
                moveItemFromArgs(args);
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            }
            if (CMD_CLEAR_QUEUE.equals(action)) {
                clearQueueInternal();
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            }
            if (CMD_GET_STATE.equals(action)) {
                BundleJson bundle = new BundleJson();
                bundle.putJSONObject("state", getStateJson());
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS, bundle.toBundle()));
            }
            if (CMD_SET_PROGRESS.equals(action)) {
                setProgressFromArgs(args);
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            }
            if (CMD_GET_PROGRESS.equals(action)) {
                BundleJson bundle = new BundleJson();
                bundle.putJSONObject("progress", getProgressFromArgs(args));
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS, bundle.toBundle()));
            }
            if (CMD_SET_OPTIONS.equals(action)) {
                setOptionsFromArgs(args);
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            }
            if (CMD_GET_OPTIONS.equals(action)) {
                BundleJson bundle = new BundleJson();
                bundle.putJSONObject("options", getOptionsJson());
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS, bundle.toBundle()));
            }
            if (CMD_SET_VOLUME.equals(action)) {
                double vol = args != null ? args.optDouble("volume", 100.0) : 100.0;
                setVolume(vol);
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            }
            if (CMD_SET_RATE.equals(action)) {
                double rate = args != null ? args.optDouble("rate", 1.0) : 1.0;
                setRate(rate);
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            }
            if (CMD_SET_REPEAT_MODE.equals(action)) {
                String mode = args != null ? args.optString("repeatMode", "off") : "off";
                setRepeatMode(mode);
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            }
            if (CMD_SET_SHUFFLE.equals(action)) {
                boolean enabled = args != null && args.optBoolean("shuffle", false);
                setShuffle(enabled);
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            }
            if (CMD_SKIP_TO_PREVIOUS.equals(action)) {
                skipToPreviousWithThreshold();
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            }
            if (CMD_SKIP_TO_INDEX.equals(action)) {
                int index = args != null ? args.optInt("index", C.INDEX_UNSET) : C.INDEX_UNSET;
                long posMs = args != null ? (long) (args.optDouble("positionSeconds", 0) * 1000) : 0;
                if (index != C.INDEX_UNSET) {
                    player.seekTo(index, posMs);
                    isStopped = false;
                }
                bumpStateRevision();
                persist();
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            }
        } catch (Exception e) {
            Log.w(TAG, "custom command failed", e);
        }
        return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_ERROR_UNKNOWN));
    }

    // MARK: - Queue operations

    private void setQueueFromArgs(JSONObject args) throws JSONException {
        JSONArray arr = args != null ? args.optJSONArray("items") : null;
        List<QueueModels.QueueItem> items = parseItems(arr);
        String mode = args != null ? args.optString("mode", "replace") : "replace";
        boolean hasExplicitStart = args != null && (args.has("startIndex") || args.has("startPositionSeconds"));
        int startIndex = args != null && args.has("startIndex") ? args.optInt("startIndex", 0) : 0;
        double startPosSeconds = args != null ? args.optDouble("startPositionSeconds", 0) : 0;
        boolean autoplay = args != null && args.optBoolean("autoplay", false);
        String currentItemId = args != null ? args.optString("currentItemId", null) : null;

        if ("patch".equals(mode) && !hasExplicitStart) {
            // Preserve current position if possible.
            String desiredId = currentItemId != null ? currentItemId : getCurrentItemId();
            long posMs = player.getCurrentPosition();
            boolean playWhenReady = player.getPlayWhenReady();
            int idx = 0;
            if (desiredId != null) {
                for (int i = 0; i < items.size(); i++) {
                    if (desiredId.equals(items.get(i).id)) {
                        idx = i;
                        break;
                    }
                }
            }
            rebuildQueue(items, desiredId, idx, posMs / 1000.0, true);
            player.setPlayWhenReady(playWhenReady);
            if (autoplay) {
                player.play();
                isStopped = false;
            }
            startMetadataPollingIfNeeded();
            return;
        }

        rebuildQueue(items, currentItemId, startIndex, startPosSeconds, true);
        if (autoplay) {
            player.play();
            isStopped = false;
        }
        startMetadataPollingIfNeeded();
    }

    private void addItemsFromArgs(JSONObject args) throws JSONException {
        JSONArray arr = args != null ? args.optJSONArray("items") : null;
        List<QueueModels.QueueItem> items = parseItems(arr);
        int atIndex = args != null && args.has("atIndex") ? args.optInt("atIndex", queue.size()) : queue.size();
        int insertion = Math.max(0, Math.min(atIndex, queue.size()));
        List<QueueModels.QueueItem> updated = new ArrayList<>(queue);
        updated.addAll(insertion, items);
        rebuildQueue(updated, getCurrentItemId(), player.getCurrentMediaItemIndex(), player.getCurrentPosition() / 1000.0, true);
    }

    private void removeItemFromArgs(JSONObject args) {
        String itemId = args != null ? args.optString("itemId", null) : null;
        if (itemId == null) return;
        List<QueueModels.QueueItem> updated = new ArrayList<>();
        for (QueueModels.QueueItem qi : queue) {
            if (!itemId.equals(qi.id)) updated.add(qi);
        }
        rebuildQueue(updated, getCurrentItemId(), player.getCurrentMediaItemIndex(), player.getCurrentPosition() / 1000.0, true);
    }

    private void moveItemFromArgs(JSONObject args) {
        int fromIndex = args != null ? args.optInt("fromIndex", -1) : -1;
        int toIndex = args != null ? args.optInt("toIndex", -1) : -1;
        if (fromIndex < 0 || fromIndex >= queue.size()) return;
        List<QueueModels.QueueItem> updated = new ArrayList<>(queue);
        QueueModels.QueueItem item = updated.remove(fromIndex);
        int insertion = Math.max(0, Math.min(toIndex, updated.size()));
        updated.add(insertion, item);
        rebuildQueue(updated, getCurrentItemId(), player.getCurrentMediaItemIndex(), player.getCurrentPosition() / 1000.0, true);
    }

    private void rebuildQueue(
        List<QueueModels.QueueItem> items,
        @Nullable String desiredItemId,
        int desiredIndex,
        double desiredPositionSeconds,
        boolean bumpQueueRevision
    ) {
        stopMetadataPolling();
        stopProgressUpdates();
        queue.clear();
        queue.addAll(items);

        // Handle empty queue explicitly (avoid setMediaItems edge cases on some devices).
        if (items.isEmpty()) {
            try {
                player.setPlayWhenReady(false);
            } catch (Exception ignored) {}
            try {
                player.stop();
            } catch (Exception ignored) {}
            player.clearMediaItems();

            isStopped = true;
            status = "stopped";

            if (bumpQueueRevision) bumpQueueRevision();
            bumpStateRevision();
            persist();
            return;
        }

        List<MediaItem> mediaItems = new ArrayList<>();
        for (QueueModels.QueueItem qi : items) {
            mediaItems.add(qi.toMediaItem());
        }

        int resolvedIndex = 0;
        if (desiredItemId != null) {
            for (int i = 0; i < items.size(); i++) {
                if (desiredItemId.equals(items.get(i).id)) {
                    resolvedIndex = i;
                    break;
                }
            }
        } else if (desiredIndex >= 0 && desiredIndex < items.size()) {
            resolvedIndex = desiredIndex;
        } else if (player.getCurrentMediaItemIndex() != C.INDEX_UNSET && player.getCurrentMediaItemIndex() < items.size()) {
            resolvedIndex = Math.max(0, player.getCurrentMediaItemIndex());
        }

        long posMs = (long) (Math.max(0, desiredPositionSeconds) * 1000);
        player.setMediaItems(mediaItems, resolvedIndex, posMs);
        player.prepare();

        isStopped = true;
        status = "stopped";

        if (bumpQueueRevision) bumpQueueRevision();
        bumpStateRevision();
        persist();
        startMetadataPollingIfNeeded();
        startProgressUpdatesIfNeeded();
    }

    private void clearQueueInternal() {
        stopMetadataPolling();
        stopProgressUpdates();
        queue.clear();
        player.clearMediaItems();
        isStopped = true;
        status = "stopped";
        bumpQueueRevision();
        persist();
    }

    // MARK: - Playback helpers

    private void skipToPreviousWithThreshold() {
        double posSeconds = player.getCurrentPosition() / 1000.0;
        if (posSeconds > options.previousThresholdSeconds) {
            player.seekTo(0);
            bumpStateRevision();
            persist();
            return;
        }
        if (player.hasPreviousMediaItem()) {
            player.seekToPreviousMediaItem();
            isStopped = false;
            bumpStateRevision();
            persist();
            return;
        }
        player.seekTo(0);
        bumpStateRevision();
        persist();
    }

    private void setVolume(double volume0to100) {
        double v = Math.max(0, Math.min(volume0to100, 100));
        player.setVolume((float) (v / 100.0));
        bumpStateRevision();
        persist();
    }

    private void setRate(double rate) {
        float r = (float) Math.max(0.25, Math.min(rate, 4.0));
        player.setPlaybackSpeed(r);
        bumpStateRevision();
        persist();
    }

    private void setRepeatMode(String mode) {
        repeatMode = mode != null ? mode : "off";
        int media3Mode = Player.REPEAT_MODE_OFF;
        if ("one".equals(repeatMode)) media3Mode = Player.REPEAT_MODE_ONE;
        else if ("all".equals(repeatMode)) media3Mode = Player.REPEAT_MODE_ALL;
        player.setRepeatMode(media3Mode);
        bumpStateRevision();
        persist();
    }

    private void setShuffle(boolean enabled) {
        shuffle = enabled;
        player.setShuffleModeEnabled(enabled);
        bumpStateRevision();
        persist();
    }

    // MARK: - Progress

    private void setProgressFromArgs(JSONObject args) {
        if (args == null) return;
        String itemId = args.optString("itemId", null);
        if (itemId == null) return;
        double pos = Math.max(0, args.optDouble("positionSeconds", 0));
        Double dur = args.has("durationSeconds") && !args.isNull("durationSeconds") ? args.optDouble("durationSeconds", 0) : null;
        Boolean completed = args.has("completed") && !args.isNull("completed") ? args.optBoolean("completed", false) : null;
        long now = System.currentTimeMillis();
        progressByItemId.put(itemId, new QueueModels.ItemProgress(itemId, pos, dur, completed, now));
        bumpStateRevision();
        persist();
    }

    private JSONObject getProgressFromArgs(JSONObject args) throws JSONException {
        String itemId = args != null ? args.optString("itemId", null) : null;
        if (itemId == null) itemId = "";
        QueueModels.ItemProgress p = progressByItemId.get(itemId);
        if (p != null) return p.toJson();
        return new QueueModels.ItemProgress(itemId, 0, null, null, System.currentTimeMillis()).toJson();
    }

    // MARK: - Options

    private void setOptionsFromArgs(JSONObject args) throws JSONException {
        if (args == null) return;
        options = QueueModels.PlaybackOptions.fromPartialJson(args, options);
        // Update skip increments for OS skip buttons
        applySeekIncrements();
        bumpStateRevision();
        persist();
    }

    private void applySeekIncrements() {
        long backMs = Math.max(0, options.skipBackwardSeconds) * 1000L;
        long fwdMs = Math.max(0, options.skipForwardSeconds) * 1000L;
        try {
            player.getClass().getMethod("setSeekBackIncrementMs", long.class).invoke(player, backMs);
        } catch (Exception ignored) {}
        try {
            player.getClass().getMethod("setSeekForwardIncrementMs", long.class).invoke(player, fwdMs);
        } catch (Exception ignored) {}
    }

    JSONObject getOptionsJson() throws JSONException {
        return options.toJson();
    }

    // MARK: - State / Queue JSON

    private @Nullable String getCurrentItemId() {
        MediaItem item = player.getCurrentMediaItem();
        if (item == null) return null;
        return item.mediaId;
    }

    JSONObject getQueueJson() throws JSONException {
        JSONObject obj = new JSONObject();
        obj.put("queueRevision", queueRevision);
        JSONArray items = new JSONArray();
        for (QueueModels.QueueItem qi : queue) {
            items.put(qi.toJson());
        }
        obj.put("items", items);
        int idx = player.getCurrentMediaItemIndex();
        obj.put("currentIndex", idx == C.INDEX_UNSET ? 0 : idx);
        String currentId = getCurrentItemId();
        if (currentId != null) obj.put("currentItemId", currentId);
        return obj;
    }

    JSONObject getStateJson() throws JSONException {
        JSONObject obj = new JSONObject();
        obj.put("stateRevision", stateRevision);
        obj.put("queueRevision", queueRevision);
        obj.put("status", status);
        int idx = player.getCurrentMediaItemIndex();
        obj.put("currentIndex", idx == C.INDEX_UNSET ? 0 : idx);
        String currentId = getCurrentItemId();
        if (currentId != null) obj.put("currentItemId", currentId);
        obj.put("position", player.getCurrentPosition() / 1000.0);
        long durMs = player.getDuration();
        if (durMs != C.TIME_UNSET && durMs > 0) obj.put("duration", durMs / 1000.0);
        obj.put("rate", player.getPlaybackParameters().speed);
        obj.put("volume", player.getVolume() * 100.0);
        obj.put("repeatMode", repeatMode);
        obj.put("shuffle", shuffle);
        return obj;
    }

    // MARK: - Persistence

    private void persist() {
        if (isRestoring) return;
        try {
            JSONObject root = new JSONObject();
            root.put("schemaVersion", QueueStore.SCHEMA_VERSION);

            JSONArray items = new JSONArray();
            for (QueueModels.QueueItem qi : queue) items.put(qi.toJson());
            root.put("queue", items);

            root.put("progressByItemId", QueueModels.progressMapToJson(progressByItemId));
            root.put("options", options.toJson());
            root.put("state", getStateJson());
            store.save(root);
        } catch (Exception e) {
            // ignore
        }
    }

    private void restoreIfAvailable() {
        JSONObject root = store.load();
        if (root == null) return;
        if (root.optInt("schemaVersion", -1) != QueueStore.SCHEMA_VERSION) return;
        isRestoring = true;
        try {
            options = QueueModels.PlaybackOptions.fromPartialJson(root.optJSONObject("options"), options);
            applySeekIncrements();
            progressByItemId.clear();
            progressByItemId.putAll(QueueModels.progressMapFromJson(root.optJSONObject("progressByItemId")));

            JSONArray q = root.optJSONArray("queue");
            List<QueueModels.QueueItem> items = parseItems(q);
            JSONObject st = root.optJSONObject("state");
            int idx = st != null ? st.optInt("currentIndex", 0) : 0;
            double pos = st != null ? st.optDouble("position", 0) : 0;
            String desiredId = st != null ? st.optString("currentItemId", null) : null;
            // Restore revisions if present
            stateRevision = st != null ? st.optLong("stateRevision", 0) : 0;
            queueRevision = st != null ? st.optLong("queueRevision", 0) : 0;
            repeatMode = st != null ? st.optString("repeatMode", "off") : "off";
            shuffle = st != null && st.optBoolean("shuffle", false);
            status = st != null ? st.optString("status", "stopped") : "stopped";
            isStopped = "stopped".equals(status);

            rebuildQueue(items, desiredId, idx, pos, false);
            // Apply restored playback modes directly (avoid persisting while restoring).
            try {
                int media3Mode = Player.REPEAT_MODE_OFF;
                if ("one".equals(repeatMode)) media3Mode = Player.REPEAT_MODE_ONE;
                else if ("all".equals(repeatMode)) media3Mode = Player.REPEAT_MODE_ALL;
                player.setRepeatMode(media3Mode);
                player.setShuffleModeEnabled(shuffle);
            } catch (Exception ignored) {}
        } catch (Exception e) {
            Log.w(TAG, "restore failed", e);
        } finally {
            isRestoring = false;
        }
    }

    // MARK: - Revisions

    private void bumpStateRevision() {
        if (isRestoring) return;
        stateRevision++;
    }

    private void bumpQueueRevision() {
        if (isRestoring) return;
        queueRevision++;
        stateRevision++;
    }

    // MARK: - Player.Listener

    @Override
    public void onEvents(Player player, Player.Events events) {
        // Keep persisted state in sync; JS should explicitly resync on foreground.
        if (events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) || events.contains(Player.EVENT_PLAY_WHEN_READY_CHANGED)) {
            if (player.getPlaybackState() == Player.STATE_ENDED) {
                status = "stopped";
                isStopped = true;
            } else if (player.getPlayWhenReady()) {
                status = "playing";
                isStopped = false;
            } else if (!isStopped) {
                status = "paused";
            }
            bumpStateRevision();
            persist();

            if (player.getPlayWhenReady()) {
                startProgressUpdatesIfNeeded();
                startMetadataPollingIfNeeded();
            } else {
                stopProgressUpdates();
                stopMetadataPolling();
                snapshotProgressOnce();
            }
        }

        if (events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION)) {
            // If we auto-advanced, mark the previous item completed (best-effort).
            // We do this before snapshotting the new item.
            // Note: transition event fires after the transition, so we use the last snapshot values.
            // Completion heuristic: last position is within 1s of duration (when known).
            // If duration unknown, we don't mark completed.
            markCompletedIfLikelyEnded();
            bumpStateRevision();
            persist();
            startMetadataPollingIfNeeded();
            startProgressUpdatesIfNeeded();
        }
    }

    private void startProgressUpdatesIfNeeded() {
        if (progressTask != null) return;
        if (!player.getPlayWhenReady()) return;
        if (queue.isEmpty()) return;
        progressTask =
            progressScheduler.scheduleAtFixedRate(() -> {
                try {
                    snapshotProgressOnce();
                } catch (Exception ignored) {}
            }, 1, 1, TimeUnit.SECONDS);
    }

    private void stopProgressUpdates() {
        if (progressTask != null) {
            try {
                progressTask.cancel(true);
            } catch (Exception ignored) {}
        }
        progressTask = null;
    }

    private void snapshotProgressOnce() {
        String itemId = getCurrentItemId();
        if (itemId == null) return;
        long posMs = Math.max(0, player.getCurrentPosition());
        long durMs = player.getDuration();
        if (durMs <= 0) durMs = C.TIME_UNSET;

        lastProgressItemId = itemId;
        lastProgressPositionMs = posMs;
        lastProgressDurationMs = durMs;

        Double durSeconds = (durMs != C.TIME_UNSET) ? (durMs / 1000.0) : null;
        progressByItemId.put(
            itemId,
            new QueueModels.ItemProgress(
                itemId,
                posMs / 1000.0,
                durSeconds,
                null,
                System.currentTimeMillis()
            )
        );
        persist();
    }

    private void markCompletedIfLikelyEnded() {
        if (lastProgressItemId == null) return;
        if (lastProgressDurationMs == C.TIME_UNSET) return;
        long remainingMs = Math.abs(lastProgressDurationMs - lastProgressPositionMs);
        if (remainingMs > 1200) return;

        String itemId = lastProgressItemId;
        progressByItemId.put(
            itemId,
            new QueueModels.ItemProgress(
                itemId,
                lastProgressDurationMs / 1000.0,
                lastProgressDurationMs / 1000.0,
                true,
                System.currentTimeMillis()
            )
        );
        persist();
    }

    // MARK: - Stream metadata polling

    private void startMetadataPollingIfNeeded() {
        stopMetadataPolling();
        if (!player.getPlayWhenReady()) return;
        int idx = player.getCurrentMediaItemIndex();
        if (idx == C.INDEX_UNSET || idx < 0 || idx >= queue.size()) return;
        QueueModels.QueueItem item = queue.get(idx);
        if (item.metadataUpdateUrl == null || item.metadataUpdateUrl.trim().isEmpty()) return;

        int intervalSeconds = item.metadataUpdateInterval != null ? item.metadataUpdateInterval : 15;
        intervalSeconds = Math.max(5, intervalSeconds);
        String url = item.metadataUpdateUrl;

        metadataTask = metadataScheduler.scheduleAtFixedRate(() -> fetchAndApplyMetadata(idx, item.id, url), intervalSeconds, intervalSeconds, TimeUnit.SECONDS);
    }

    private void stopMetadataPolling() {
        if (metadataTask != null) {
            try {
                metadataTask.cancel(true);
            } catch (Exception ignored) {}
        }
        metadataTask = null;
        lastMetadataFingerprint = null;
    }

    private void fetchAndApplyMetadata(int indexHint, String itemId, String urlStr) {
        try {
            URL url = new URL(urlStr);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.connect();
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                conn.disconnect();
                return;
            }
            BufferedReader r = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            r.close();
            conn.disconnect();

            JSONObject obj = new JSONObject(sb.toString());
            String title = obj.optString("title", null);
            String artist = obj.optString("artist", null);
            String album = obj.optString("album", null);
            String artwork = obj.optString("artwork", null);

            if (title == null && artist == null && album == null && artwork == null) return;

            String fingerprint = String.valueOf(title) + "|" + String.valueOf(artist) + "|" + String.valueOf(album) + "|" + String.valueOf(artwork);
            if (fingerprint.equals(lastMetadataFingerprint)) return;
            lastMetadataFingerprint = fingerprint;

            int idx = resolveIndexById(itemId, indexHint);
            if (idx < 0 || idx >= queue.size()) return;
            QueueModels.QueueItem current = queue.get(idx);
            QueueModels.QueueItem updated = current.withUpdatedMetadata(title, artist, album, artwork);
            queue.set(idx, updated);

            // Update player metadata without restarting playback.
            try {
                player.replaceMediaItem(idx, updated.toMediaItem());
            } catch (Exception ignored) {}

            bumpStateRevision();
            persist();
        } catch (Exception e) {
            // ignore
        }
    }

    private int resolveIndexById(String itemId, int indexHint) {
        if (indexHint >= 0 && indexHint < queue.size() && itemId.equals(queue.get(indexHint).id)) return indexHint;
        for (int i = 0; i < queue.size(); i++) {
            if (itemId.equals(queue.get(i).id)) return i;
        }
        return -1;
    }

    // MARK: - Parsing helpers

    private static List<QueueModels.QueueItem> parseItems(@Nullable JSONArray arr) throws JSONException {
        List<QueueModels.QueueItem> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject obj = arr.getJSONObject(i);
            out.add(QueueModels.QueueItem.fromJson(obj));
        }
        return out;
    }

    @Nullable
    private static String readSmallIconFromCapacitorConfig(Context context) {
        try {
            AssetManager am = context.getAssets();
            // Capacitor typically writes `capacitor.config.json` into assets.
            BufferedReader r = new BufferedReader(
                new InputStreamReader(am.open("capacitor.config.json"), StandardCharsets.UTF_8)
            );
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            r.close();
            JSONObject root = new JSONObject(sb.toString());
            JSONObject plugins = root.optJSONObject("plugins");
            if (plugins == null) return null;
            JSONObject cfg = plugins.optJSONObject("AudioPlayer");
            if (cfg == null) return null;
            String smallIcon = cfg.optString("smallIcon", null);
            if (smallIcon == null || smallIcon.trim().isEmpty()) return null;
            return smallIcon;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Small helper to avoid direct dependency on android.os.Bundle <-> JSON conversion libs.
     */
    private static final class BundleJson {
        private final android.os.Bundle b = new android.os.Bundle();

        void putJSONObject(String key, JSONObject obj) {
            if (obj == null) return;
            b.putString(key, obj.toString());
        }

        void putLong(String key, long value) {
            b.putLong(key, value);
        }

        android.os.Bundle toBundle() {
            return b;
        }
    }
}

