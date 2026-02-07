package ssf.capacitorjs.plugins.nativeaudio;

import android.app.PendingIntent;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.res.AssetManager;
import android.os.Build;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

public class AudioPlayerService extends MediaSessionService {

    private static final String TAG = "AudioPlayerService";
    public static final String PLAYBACK_CHANNEL_ID = "playback_channel";
    private MediaSession mediaSession = null;
    private QueuePlayer queuePlayer = null;

    @Override
    public void onCreate() {
        Log.i(TAG, "Service being created");
        super.onCreate();

        createNotificationChannelIfNeeded();

        String packageName = getApplicationContext().getPackageName();
        Intent sessionActivityIntent = getPackageManager().getLaunchIntentForPackage(packageName);

        PendingIntent sessionActivityPendingIntent = PendingIntent.getActivity(
            this,
            0,
            sessionActivityIntent,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        ExoPlayer player = new ExoPlayer.Builder(this)
            .setAudioAttributes(
                new AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                    .build(),
                true
            )
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build();
        player.setPlayWhenReady(false);

        queuePlayer = new QueuePlayer(this, player);
        mediaSession = new MediaSession.Builder(this, player)
            .setCallback(new MediaSessionCallback(queuePlayer))
            .setSessionActivity(sessionActivityPendingIntent)
            .build();

        DefaultMediaNotificationProvider provider = new DefaultMediaNotificationProvider(this);
        int iconResId = queuePlayer.getResolvedNotificationSmallIconResId();
        try {
            provider.getClass().getMethod("setSmallIcon", int.class).invoke(provider, iconResId);
        } catch (Exception ignored) {}
        // Optional Media3 notification policies (read from Capacitor config).
        tryApplyNotificationPoliciesFromCapacitorConfig(provider);
        setMediaNotificationProvider(provider);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.i(TAG, "Service starting");

        return super.onStartCommand(intent, flags, startId);
    }

    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return mediaSession;
    }

    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        Log.i(TAG, "Task removed");
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "Service being destroyed");
        if (mediaSession != null) {
            mediaSession.getPlayer().release();
            mediaSession.release();
            mediaSession = null;
        }
        if (queuePlayer != null) {
            try {
                queuePlayer.release();
            } catch (Exception ignored) {}
        }
        queuePlayer = null;

        super.onDestroy();
    }

    private void createNotificationChannelIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel channel = new NotificationChannel(
            PLAYBACK_CHANNEL_ID,
            "Media playback",
            NotificationManager.IMPORTANCE_LOW
        );
        nm.createNotificationChannel(channel);
    }

    private void tryApplyNotificationPoliciesFromCapacitorConfig(DefaultMediaNotificationProvider provider) {
        try {
            JSONObject cfg = readAudioPlayerPluginConfig();
            if (cfg == null) return;

            if (cfg.has("showNotificationForIdlePlayer")) {
                boolean v = cfg.optBoolean("showNotificationForIdlePlayer", true);
                try {
                    provider
                        .getClass()
                        .getMethod("setShowNotificationForIdlePlayer", boolean.class)
                        .invoke(provider, v);
                } catch (Exception ignored) {}
            }

            if (cfg.has("foregroundServiceTimeoutMs")) {
                long ms = Math.max(0, cfg.optLong("foregroundServiceTimeoutMs", 0));
                // Signature changed across Media3 versions; try both.
                try {
                    provider.getClass().getMethod("setForegroundServiceTimeoutMs", long.class).invoke(provider, ms);
                } catch (Exception ignored) {}
                try {
                    provider
                        .getClass()
                        .getMethod("setForegroundServiceTimeoutMs", int.class)
                        .invoke(provider, (int) Math.min(Integer.MAX_VALUE, ms));
                } catch (Exception ignored) {}
            }
        } catch (Exception ignored) {}
    }

    @Nullable
    private JSONObject readAudioPlayerPluginConfig() {
        try {
            AssetManager am = getAssets();
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
            return plugins.optJSONObject("AudioPlayer");
        } catch (Exception e) {
            return null;
        }
    }
}
