package us.mediagrid.capacitorjs.plugins.nativeaudio;

import android.net.Uri;
import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Data models mirroring {@code src/definitions.ts}.
 *
 * <p>JSON-first to avoid adding a JSON library dependency.
 */
final class QueueModels {

    private QueueModels() {}

    static final class QueueItem {
        final String id;
        final String src;
        final String title;
        final @Nullable String artist;
        final @Nullable String album;
        final @Nullable String artwork;
        final @Nullable Double duration;
        final @Nullable String metadataUpdateUrl;
        final @Nullable Integer metadataUpdateInterval;
        final @Nullable JSONObject extras;

        QueueItem(
            String id,
            String src,
            String title,
            @Nullable String artist,
            @Nullable String album,
            @Nullable String artwork,
            @Nullable Double duration,
            @Nullable String metadataUpdateUrl,
            @Nullable Integer metadataUpdateInterval,
            @Nullable JSONObject extras
        ) {
            this.id = id;
            this.src = src;
            this.title = title;
            this.artist = artist;
            this.album = album;
            this.artwork = artwork;
            this.duration = duration;
            this.metadataUpdateUrl = metadataUpdateUrl;
            this.metadataUpdateInterval = metadataUpdateInterval;
            this.extras = extras;
        }

        static QueueItem fromJson(JSONObject obj) throws JSONException {
            return new QueueItem(
                obj.getString("id"),
                obj.getString("src"),
                obj.getString("title"),
                obj.optString("artist", null),
                obj.optString("album", null),
                obj.optString("artwork", null),
                obj.has("duration") && !obj.isNull("duration") ? obj.getDouble("duration") : null,
                obj.optString("metadataUpdateUrl", null),
                obj.has("metadataUpdateInterval") && !obj.isNull("metadataUpdateInterval")
                    ? obj.getInt("metadataUpdateInterval")
                    : null,
                obj.has("extras") && !obj.isNull("extras") ? obj.getJSONObject("extras") : null
            );
        }

        JSONObject toJson() throws JSONException {
            JSONObject obj = new JSONObject();
            obj.put("id", id);
            obj.put("src", src);
            obj.put("title", title);
            if (artist != null) obj.put("artist", artist);
            if (album != null) obj.put("album", album);
            if (artwork != null) obj.put("artwork", artwork);
            if (duration != null) obj.put("duration", duration);
            if (metadataUpdateUrl != null) obj.put("metadataUpdateUrl", metadataUpdateUrl);
            if (metadataUpdateInterval != null) obj.put("metadataUpdateInterval", metadataUpdateInterval);
            if (extras != null) obj.put("extras", extras);
            return obj;
        }

        MediaItem toMediaItem() {
            MediaMetadata.Builder meta = new MediaMetadata.Builder().setTitle(title);
            if (artist != null) meta.setArtist(artist);
            if (album != null) meta.setAlbumTitle(album);
            if (artwork != null) {
                try {
                    meta.setArtworkUri(Uri.parse(artwork));
                } catch (Exception ignored) {}
            }

            return new MediaItem.Builder()
                .setMediaId(id)
                .setUri(src)
                .setMediaMetadata(meta.build())
                .build();
        }

        QueueItem withUpdatedMetadata(
            @Nullable String title,
            @Nullable String artist,
            @Nullable String album,
            @Nullable String artwork
        ) {
            return new QueueItem(
                id,
                src,
                title != null ? title : this.title,
                artist != null ? artist : this.artist,
                album != null ? album : this.album,
                artwork != null ? artwork : this.artwork,
                duration,
                metadataUpdateUrl,
                metadataUpdateInterval,
                extras
            );
        }
    }

    static final class PlaybackOptions {
        int previousThresholdSeconds = 7;
        int skipForwardSeconds = 10;
        int skipBackwardSeconds = 10;
        boolean enableNextPrev = true;
        boolean enableSeekTo = true;
        boolean enableStop = true;
        @Nullable String androidNotificationSmallIcon = null;

        static PlaybackOptions defaults() {
            return new PlaybackOptions();
        }

        static PlaybackOptions fromPartialJson(JSONObject obj, PlaybackOptions base) {
            PlaybackOptions out = base != null ? base : defaults();
            if (obj == null) return out;
            if (obj.has("previousThresholdSeconds")) out.previousThresholdSeconds = obj.optInt("previousThresholdSeconds", out.previousThresholdSeconds);
            if (obj.has("skipForwardSeconds")) out.skipForwardSeconds = obj.optInt("skipForwardSeconds", out.skipForwardSeconds);
            if (obj.has("skipBackwardSeconds")) out.skipBackwardSeconds = obj.optInt("skipBackwardSeconds", out.skipBackwardSeconds);
            if (obj.has("enableNextPrev")) out.enableNextPrev = obj.optBoolean("enableNextPrev", out.enableNextPrev);
            if (obj.has("enableSeekTo")) out.enableSeekTo = obj.optBoolean("enableSeekTo", out.enableSeekTo);
            if (obj.has("enableStop")) out.enableStop = obj.optBoolean("enableStop", out.enableStop);
            if (obj.has("androidNotificationSmallIcon")) out.androidNotificationSmallIcon = obj.optString("androidNotificationSmallIcon", null);
            return out;
        }

        JSONObject toJson() throws JSONException {
            JSONObject obj = new JSONObject();
            obj.put("previousThresholdSeconds", previousThresholdSeconds);
            obj.put("skipForwardSeconds", skipForwardSeconds);
            obj.put("skipBackwardSeconds", skipBackwardSeconds);
            obj.put("enableNextPrev", enableNextPrev);
            obj.put("enableSeekTo", enableSeekTo);
            obj.put("enableStop", enableStop);
            if (androidNotificationSmallIcon != null) obj.put("androidNotificationSmallIcon", androidNotificationSmallIcon);
            return obj;
        }
    }

    static final class ItemProgress {
        final String itemId;
        final double positionSeconds;
        final @Nullable Double durationSeconds;
        final @Nullable Boolean completed;
        final long updatedAtEpochMs;

        ItemProgress(
            String itemId,
            double positionSeconds,
            @Nullable Double durationSeconds,
            @Nullable Boolean completed,
            long updatedAtEpochMs
        ) {
            this.itemId = itemId;
            this.positionSeconds = positionSeconds;
            this.durationSeconds = durationSeconds;
            this.completed = completed;
            this.updatedAtEpochMs = updatedAtEpochMs;
        }

        static ItemProgress fromJson(JSONObject obj) throws JSONException {
            return new ItemProgress(
                obj.getString("itemId"),
                obj.getDouble("positionSeconds"),
                obj.has("durationSeconds") && !obj.isNull("durationSeconds") ? obj.getDouble("durationSeconds") : null,
                obj.has("completed") && !obj.isNull("completed") ? obj.getBoolean("completed") : null,
                obj.getLong("updatedAtEpochMs")
            );
        }

        JSONObject toJson() throws JSONException {
            JSONObject obj = new JSONObject();
            obj.put("itemId", itemId);
            obj.put("positionSeconds", positionSeconds);
            if (durationSeconds != null) obj.put("durationSeconds", durationSeconds);
            if (completed != null) obj.put("completed", completed);
            obj.put("updatedAtEpochMs", updatedAtEpochMs);
            return obj;
        }
    }

    static JSONObject progressMapToJson(Map<String, ItemProgress> map) throws JSONException {
        JSONObject out = new JSONObject();
        for (Map.Entry<String, ItemProgress> e : map.entrySet()) {
            out.put(e.getKey(), e.getValue().toJson());
        }
        return out;
    }

    static Map<String, ItemProgress> progressMapFromJson(JSONObject obj) {
        Map<String, ItemProgress> out = new HashMap<>();
        if (obj == null) return out;
        Iterator<String> keys = obj.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            try {
                out.put(k, ItemProgress.fromJson(obj.getJSONObject(k)));
            } catch (Exception ignored) {}
        }
        return out;
    }
}

