package ssf.capacitorjs.plugins.nativeaudio;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.annotation.Nullable;
import org.json.JSONException;
import org.json.JSONObject;

final class QueueStore {
    private static final String PREFS = "SsfCapacitorNativeAudio";
    private static final String KEY = "persisted_state_v1";
    static final int SCHEMA_VERSION = 1;

    private final SharedPreferences prefs;

    QueueStore(Context context) {
        this.prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @Nullable
    JSONObject load() {
        String raw = prefs.getString(KEY, null);
        if (raw == null) return null;
        try {
            return new JSONObject(raw);
        } catch (JSONException e) {
            return null;
        }
    }

    void save(JSONObject obj) {
        if (obj == null) return;
        prefs.edit().putString(KEY, obj.toString()).apply();
    }

    void clear() {
        prefs.edit().remove(KEY).apply();
    }
}

