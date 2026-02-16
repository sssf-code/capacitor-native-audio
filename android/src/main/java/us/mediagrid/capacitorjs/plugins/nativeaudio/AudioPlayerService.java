package ssf.capacitorjs.plugins.nativeaudio;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.res.AssetManager;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.CommandButton;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.session.SessionCommand;
import com.google.common.collect.ImmutableList;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

public class AudioPlayerService extends MediaSessionService implements QueuePlayer.CustomLayoutUpdater {

    private static final String TAG = "AudioPlayerService";
    public static final String PLAYBACK_CHANNEL_ID = "playback_channel";
    private MediaSession mediaSession = null;
    private QueuePlayer queuePlayer = null;
    private BecomingNoisyReceiver becomingNoisyReceiver = null;

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
        queuePlayer.setCustomLayoutUpdater(this);
        Player sessionPlayer = buildSessionPlayer(player);
        ImmutableList<CommandButton> customLayout = buildPrevNextLayout();
        MediaSession.Builder sessionBuilder = new MediaSession.Builder(this, sessionPlayer)
            .setCallback(new MediaSessionCallback(queuePlayer))
            .setSessionActivity(sessionActivityPendingIntent);
        if (!customLayout.isEmpty()) {
            sessionBuilder.setCustomLayout(customLayout);
        }
        mediaSession = sessionBuilder.build();

        DefaultMediaNotificationProvider provider = new DefaultMediaNotificationProvider(this);
        int iconResId = queuePlayer.getResolvedNotificationSmallIconResId();
        try {
            provider.getClass().getMethod("setSmallIcon", int.class).invoke(provider, iconResId);
        } catch (Exception ignored) {}
        // Optional Media3 notification policies (read from Capacitor config).
        tryApplyNotificationPoliciesFromCapacitorConfig(provider);
        setMediaNotificationProvider(provider);

        becomingNoisyReceiver = new BecomingNoisyReceiver();
        IntentFilter noisyFilter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(becomingNoisyReceiver, noisyFilter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(becomingNoisyReceiver, noisyFilter);
        }
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
        if (becomingNoisyReceiver != null) {
            try {
                unregisterReceiver(becomingNoisyReceiver);
            } catch (Exception ignored) {}
            becomingNoisyReceiver = null;
        }
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

    @UnstableApi
    private Player buildSessionPlayer(ExoPlayer player) {
        if (!queuePlayer.getOptionsSnapshot().enableNextPrev) {
            return player;
        }
        return new androidx.media3.common.ForwardingPlayer(player) {
            @Override
            public Player.Commands getAvailableCommands() {
                return super
                    .getAvailableCommands()
                    .buildUpon()
                    .remove(Player.COMMAND_SEEK_TO_NEXT)
                    .remove(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                    .remove(Player.COMMAND_SEEK_TO_PREVIOUS)
                    .remove(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                    .build();
            }

            @Override
            public boolean isCommandAvailable(int command) {
                if (
                    command == Player.COMMAND_SEEK_TO_NEXT ||
                    command == Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM ||
                    command == Player.COMMAND_SEEK_TO_PREVIOUS ||
                    command == Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM
                ) {
                    return false;
                }
                return super.isCommandAvailable(command);
            }
        };
    }

    @UnstableApi
    private ImmutableList<CommandButton> buildPrevNextLayout() {
        if (!queuePlayer.getOptionsSnapshot().enableNextPrev || queuePlayer.getQueueSize() <= 1) {
            return ImmutableList.of();
        }
        int prevIcon = getDrawableResId(
            "ic_skip_previous",
            getDrawableResId("ic_media_previous", android.R.drawable.ic_media_previous)
        );
        int nextIcon = getDrawableResId(
            "ic_skip_next",
            getDrawableResId("ic_media_next", android.R.drawable.ic_media_next)
        );
        return ImmutableList.of(
            new CommandButton.Builder()
                .setDisplayName("Previous")
                .setIconResId(prevIcon)
                .setSessionCommand(
                    new SessionCommand(QueuePlayer.CMD_SKIP_TO_PREVIOUS, Bundle.EMPTY)
                )
                .build(),
            new CommandButton.Builder()
                .setDisplayName("Next")
                .setIconResId(nextIcon)
                .setSessionCommand(new SessionCommand(QueuePlayer.CMD_SKIP_TO_NEXT, Bundle.EMPTY))
                .build()
        );
    }

    private int getDrawableResId(String name, int fallback) {
        try {
            int id = getResources().getIdentifier(name, "drawable", getPackageName());
            if (id != 0) return id;
        } catch (Exception ignored) {}
        return fallback;
    }

    @UnstableApi
    @Override
    public void updateCustomLayout() {
        if (mediaSession == null) return;
        ImmutableList<CommandButton> newLayout = buildPrevNextLayout();
        mediaSession.setCustomLayout(newLayout);
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

    private void tryApplyNotificationPoliciesFromCapacitorConfig(
        DefaultMediaNotificationProvider provider
    ) {
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
                    provider
                        .getClass()
                        .getMethod("setForegroundServiceTimeoutMs", long.class)
                        .invoke(provider, ms);
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

    private class BecomingNoisyReceiver extends BroadcastReceiver {

        @Override
        public void onReceive(Context context, Intent intent) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                Log.i(TAG, "Audio becoming noisy, pausing playback");
                if (mediaSession != null) {
                    Player player = mediaSession.getPlayer();
                    if (player != null && player.getPlayWhenReady()) {
                        player.pause();
                    }
                }
            }
        }
    }
}
